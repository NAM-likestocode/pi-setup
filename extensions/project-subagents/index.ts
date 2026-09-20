/**
 * Project subagents: delegate bounded tasks to isolated child Pi processes.
 *
 * - Runs in the **background** by default: the tool returns immediately and the
 *   child's report is delivered to this session as a follow-up message when it
 *   finishes, so the parent can keep working on something else meanwhile.
 * - Several children may run at once (`maxConcurrent`), and children can
 *   delegate too (`maxDepth`), because they load this same extension.
 * - Profiles come from `~/.pi/agent/agents/*.md` and `<project>/.pi/agents/*.md`,
 *   plus the built-in general-purpose `worker`. Any run may override tools,
 *   model, thinking and add instructions.
 * - Every child's full `--mode json` event stream is written to
 *   `<transcriptDir>/<runId>.jsonl` so front-ends (pi-desk) can show it live.
 * - Policy lives in `~/.pi/agent/subagents.json` (see `SubagentConfig`).
 *   Approval prompts are off by default.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, statSync, type WriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message, Usage } from "@earendil-works/pi-ai";
import {
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  DASHBOARD_ACTIVITY_CHANNEL,
  DASHBOARD_ACTIVITY_VERSION,
  dashboardActivityForTool,
  type DashboardActivity,
} from "../_shared/dashboard-activity.ts";
import {
  applyOverrides,
  discoverProjectAgents,
  loadSubagentConfig,
  poolEntry,
  poolFallbackOrder,
  WORKER_AGENT,
  type ExtraChildExtension,
  type PoolModel,
  type ProjectAgent,
  type RunMode,
  type SubagentConfig,
} from "./agents.ts";

const PROMPT_PROTOCOL_VERSION = 2;
const PROMPT_OPEN_CHANNEL = "anywhere:prompt:v2:open";
const PROMPT_CLOSE_CHANNEL = "anywhere:prompt:v2:close";
const PROMPT_PROBE_CHANNEL = "anywhere:prompt:v2:probe";
const MAX_TASK_CHARS = 12_000;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_STDERR_CHARS = 12_000;
const MAX_ACTIVITY_ITEMS = 100;
const MAX_FINISHED_RUNS = 50;
const STATUS_ID = "project-subagents";
const THIS_EXTENSION = fileURLToPath(import.meta.url);
/** Event-bus channels other extensions may use to inspect or stop runs. */
export const SUBAGENT_QUERY_CHANNEL = "pi-subagents:query:v1";
export const SUBAGENT_STOP_CHANNEL = "pi-subagents:stop:v1";

interface ActivitySummary {
  label: string;
  category: DashboardActivity["category"];
  command?: string;
  path?: string;
  isError?: boolean;
}

export type SubagentStatus = "awaiting-approval" | "running" | "completed" | "cancelled" | "failed";

/** Progress / result payload attached to the tool call (`details`). Consumed by the TUI renderer and by pi-desk. */
export interface SubagentDetails {
  runId: string;
  status: SubagentStatus;
  /** Profile name (`worker`, `scout`, …). */
  agent: string;
  /** Display name for this run (from the `name` parameter, else the profile). */
  name: string;
  mode: RunMode;
  source: ProjectAgent["source"];
  activation: ProjectAgent["activation"];
  access: ProjectAgent["access"];
  reason: string;
  task: string;
  agentFile: string;
  tools: string[];
  model?: string;
  thinking?: string;
  cwd: string;
  depth: number;
  parentRunId?: string;
  /** Full child event stream (`--mode json`), one JSON object per line. */
  transcriptPath?: string;
  startedAt?: number;
  durationMs?: number;
  activities: ActivitySummary[];
  usage: Usage;
  output?: string;
  errorMessage?: string;
}

interface ChildRunResult {
  exitCode: number;
  output: string;
  stderr: string;
  stopReason?: string;
  errorMessage?: string;
  usage: Usage;
  activities: ActivitySummary[];
  model?: string;
}

interface Run {
  details: SubagentDetails;
  child?: ChildProcess;
  abort: AbortController;
  done: Promise<ChildRunResult>;
}

interface RemoteAnswer {
  kind: "selection" | "freeform";
  selections?: string[];
  text?: string;
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(total: Usage, value: unknown): void {
  if (!value || typeof value !== "object") return;
  const usage = value as Partial<Usage>;
  total.input += usage.input ?? 0;
  total.output += usage.output ?? 0;
  total.cacheRead += usage.cacheRead ?? 0;
  total.cacheWrite += usage.cacheWrite ?? 0;
  total.totalTokens += usage.totalTokens ?? 0;
  const cost = usage.cost;
  if (cost) {
    total.cost.input += cost.input ?? 0;
    total.cost.output += cost.output ?? 0;
    total.cost.cacheRead += cost.cacheRead ?? 0;
    total.cost.cacheWrite += cost.cacheWrite ?? 0;
    total.cost.total += cost.total ?? 0;
  }
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text"
      ? String((part as { text?: unknown }).text ?? "")
      : "")
    .filter(Boolean)
    .join("\n");
}

function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) end--;
  return `${text.slice(0, end)}\n\n[Subagent output truncated for the parent session]`;
}

function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `… [earlier stderr omitted]\n${text.slice(-maxChars)}`;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const bunVirtual = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !bunVirtual && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const executable = basename(process.execPath).toLowerCase();
  if (!/^(?:node|bun)(?:\.exe)?$/.test(executable)) return { command: process.execPath, args };
  return { command: "pi", args };
}

function stopProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
    return;
  }
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 5_000).unref();
}

function emitActivity(pi: ExtensionAPI, activity: DashboardActivity): void {
  pi.events.emit(DASHBOARD_ACTIVITY_CHANNEL, activity);
}

function lifecycleActivity(
  runId: string,
  phase: "start" | "end",
  name: string,
  task: string,
  isError = false,
  detail?: string,
): DashboardActivity {
  return {
    version: DASHBOARD_ACTIVITY_VERSION,
    id: runId,
    phase,
    source: "subagent",
    category: "subagent",
    label: `${name} subagent`,
    timestamp: Date.now(),
    agent: name,
    runId,
    task,
    detail,
    isError,
  };
}

function summaryFromActivity(activity: DashboardActivity): ActivitySummary {
  return {
    label: activity.label,
    category: activity.category,
    command: activity.command,
    path: activity.path,
    isError: activity.isError,
  };
}

function currentDepth(): number {
  const raw = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
}

/** Describe the model pool for the tool description / system prompt. */
function describePool(pool: PoolModel[]): string {
  return pool.map((entry) => `"${entry.label}" = ${entry.id}${entry.thinking ? ` (thinking ${entry.thinking})` : ""}: ${entry.use || "no guidance"}`).join("; ");
}

interface ResolvedModel {
  model?: string;
  thinking?: string;
  note?: string;
}

/**
 * Final model + thinking for a run. With a pool, prefer the chosen entry but skip
 * providers that have no configured auth in this session (falling through the
 * pool in order); the pool entry's thinking wins when it sets one.
 */
function resolveRunModel(ctx: ExtensionContext, pi: ExtensionAPI, agent: ProjectAgent, config: SubagentConfig): ResolvedModel {
  const inherit = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  const baseThinking = agent.thinking === "inherit" ? pi.getThinkingLevel() : agent.thinking;
  const chosen = agent.model === "inherit" ? inherit : agent.model;

  if (config.models.length === 0) return { model: chosen, thinking: baseThinking };

  const wanted = poolEntry(config.models, chosen) ?? config.models[0];
  for (const entry of poolFallbackOrder(config.models, wanted.id)) {
    const [provider, ...rest] = entry.id.split("/");
    const model = ctx.modelRegistry.find(provider, rest.join("/"));
    const authed = model ? ctx.modelRegistry.hasConfiguredAuth(model) : false;
    if (!authed) continue;
    const note = entry.id !== wanted.id ? `${wanted.label} (${wanted.id}) has no configured auth; used ${entry.label} instead` : undefined;
    return { model: entry.id, thinking: entry.thinking ?? baseThinking, note };
  }
  // Nothing in the pool is usable: fall back to the parent's own model so the run still starts.
  return { model: inherit, thinking: baseThinking, note: `no model in the subagent pool has configured auth; used the parent's model ${inherit ?? "(unknown)"}` };
}

function describeProfile(agent: ProjectAgent): string {
  return `${agent.name} [${agent.access}; ${agent.model}, ${agent.thinking}; ${agent.tools.join(", ") || "no tools"}]`;
}

// --- approval (only when `approval: "always"` is configured) --------------

function remotePromptAvailable(pi: ExtensionAPI): boolean {
  let available = false;
  pi.events.emit(PROMPT_PROBE_CHANNEL, {
    version: PROMPT_PROTOCOL_VERSION,
    report: (capability: unknown) => {
      if (!capability || typeof capability !== "object") return;
      const record = capability as { version?: unknown; remotePrompt?: unknown };
      if (record.version === PROMPT_PROTOCOL_VERSION && record.remotePrompt === true) available = true;
    },
  });
  return available;
}

function approvalMessage(agent: ProjectAgent, reason: string, task: string): string {
  return [
    agent.description,
    `Why Pi recommends it: ${reason}`,
    `Source: ${agent.source} — ${agent.filePath}`,
    `Access: ${agent.access}`,
    `Tools: ${agent.tools.join(", ") || "none"}`,
    `Model: ${agent.model}`,
    `Thinking: ${agent.thinking}`,
    "",
    `Exact task:\n${task}`,
    "",
    "No child process has started. The main Pi agent remains responsible for checking the result.",
  ].join("\n");
}

function requestRemoteApproval(
  pi: ExtensionAPI,
  runId: string,
  agent: ProjectAgent,
  reason: string,
  task: string,
  signal: AbortSignal | undefined,
): Promise<boolean> | undefined {
  if (signal?.aborted || !remotePromptAvailable(pi)) return signal?.aborted ? Promise.resolve(false) : undefined;
  let settled = false;
  let resolveAnswer!: (approved: boolean) => void;
  const answer = new Promise<boolean>((resolve) => { resolveAnswer = resolve; });
  const finish = (approved: boolean): boolean => {
    if (settled) return false;
    settled = true;
    signal?.removeEventListener("abort", onAbort);
    resolveAnswer(approved);
    return true;
  };
  const onAbort = () => {
    pi.events.emit(PROMPT_CLOSE_CHANNEL, { version: PROMPT_PROTOCOL_VERSION, id: runId, reason: "aborted" });
    finish(false);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  pi.events.emit(PROMPT_OPEN_CHANNEL, {
    version: PROMPT_PROTOCOL_VERSION,
    id: runId,
    kind: "specialist",
    question: `Run specialist “${agent.name}”?`,
    context: approvalMessage(agent, reason, task),
    options: [
      { title: "Run subagent", description: "Approve this one project-specific run" },
      { title: "Cancel", description: "Do not start any subagent work" },
    ],
    allowMultiple: false,
    allowFreeform: false,
    allowComment: false,
    openedAt: Date.now(),
    signal,
    respond: (value: RemoteAnswer | null) => {
      const approved = value?.kind === "selection" && value.selections?.includes("Run subagent") === true;
      return finish(approved);
    },
  });
  return answer;
}

async function confirmRun(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runId: string,
  agent: ProjectAgent,
  reason: string,
  task: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const localAbort = new AbortController();
  const onAbort = () => localAbort.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const remote = requestRemoteApproval(pi, runId, agent, reason, task, localAbort.signal);
  const local = ctx.hasUI
    ? ctx.ui.confirm(`Run specialist “${agent.name}”?`, approvalMessage(agent, reason, task), { signal: localAbort.signal })
    : Promise.resolve(false);
  if (!remote) {
    const result = await local;
    signal?.removeEventListener("abort", onAbort);
    return result;
  }
  const winner = await Promise.race([
    remote.then((value) => ({ source: "remote" as const, value })),
    local.then((value) => ({ source: "local" as const, value })),
  ]);
  localAbort.abort();
  signal?.removeEventListener("abort", onAbort);
  return winner.value;
}

// --- child process ----------------------------------------------------------

interface ChildOptions {
  agent: ProjectAgent;
  task: string;
  cwd: string;
  depth: number;
  maxDepth: number;
  /** Extra extension files every child loads (provider auth shims etc.). */
  childExtensions: string[];
  /** Harness extensions children also load, with the tools they contribute (see `extraChildExtensions`). */
  extraChildExtensions: ExtraChildExtension[];
  model?: string;
  thinking?: string;
  transcript?: WriteStream;
  signal: AbortSignal;
  onProgress: (update: { activities: ActivitySummary[]; usage: Usage; model?: string }) => void;
}

async function runChild(pi: ExtensionAPI, runId: string, options: ChildOptions): Promise<ChildRunResult> {
  const { agent, task, cwd, depth, maxDepth, transcript, signal } = options;
  const promptDir = await mkdtemp(join(tmpdir(), "pi-project-subagent-"));
  const promptFile = join(promptDir, `${agent.name}-prompt.md`);
  const canDelegate = depth + 1 < maxDepth;
  const systemPrompt = [
    `You are the ${agent.source}-level agent “${agent.name}” (delegation depth ${depth + 1}).`,
    agent.systemPrompt,
    "",
    "Run boundary: complete only the exact delegated task. Do not broaden the scope or make changes outside it.",
    canDelegate
      ? "You may delegate a genuinely separable sub-part with the subagent tool, but prefer doing the work yourself."
      : "Do not launch other agents.",
    "Keep the final report short and plain. Lead with the answer, include only useful evidence, and clearly label uncertainty.",
    "Do not claim that you edited, executed, or verified anything your available tools could not actually do.",
  ].join("\n");
  await writeFile(promptFile, systemPrompt, { encoding: "utf8", mode: 0o600 });

  const args = [
    "--mode", "json",
    "--print",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--approve",
    "--append-system-prompt", promptFile,
  ];
  for (const extensionPath of options.childExtensions) args.push("--extension", extensionPath);
  for (const extra of options.extraChildExtensions) args.push("--extension", extra.path);
  if (canDelegate) args.push("--extension", THIS_EXTENSION);
  for (const extensionPath of agent.extensionPaths) args.push("--extension", extensionPath);
  // `--tools` is a strict allowlist for every tool, so extra extensions' tools must be listed too.
  const extraTools = options.extraChildExtensions.flatMap((extra) => extra.tools);
  if (agent.tools.length > 0) args.push("--tools", [...new Set([...agent.tools, ...extraTools])].join(","));
  else args.push("--no-tools");
  if (options.model) args.push("--model", options.model);
  if (options.thinking) args.push("--thinking", options.thinking);
  args.push(`Task delegated by the parent Pi agent:\n\n${task}`);

  const usage = emptyUsage();
  const activities: ActivitySummary[] = [];
  const activeArgs = new Map<string, unknown>();
  let stderr = "";
  let output = "";
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  let childModel = options.model;
  let aborted = false;

  const progress = () => options.onProgress({ activities: [...activities], usage: { ...usage, cost: { ...usage.cost } }, model: childModel });

  try {
    const exitCode = await new Promise<number>((resolveExit) => {
      const invocation = getPiInvocation(args);
      const child = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PI_PROJECT_SUBAGENT: "1",
          PI_SUBAGENT_RUN_ID: runId,
          PI_SUBAGENT_DEPTH: String(depth + 1),
        },
      });
      let buffer = "";
      let closed = false;

      const processLine = (line: string): void => {
        if (!line.trim()) return;
        transcript?.write(`${line}\n`);
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }

        if (event.type === "tool_execution_start" && typeof event.toolCallId === "string" && typeof event.toolName === "string") {
          activeArgs.set(event.toolCallId, event.args);
          const activity = dashboardActivityForTool({
            id: `${runId}:${event.toolCallId}`,
            phase: "start",
            source: "subagent",
            toolName: event.toolName,
            args: event.args,
            agent: agent.name,
            runId,
          });
          activities.push(summaryFromActivity(activity));
          if (activities.length > MAX_ACTIVITY_ITEMS) activities.shift();
          emitActivity(pi, activity);
          progress();
          return;
        }

        if (event.type === "tool_execution_end" && typeof event.toolCallId === "string" && typeof event.toolName === "string") {
          const activity = dashboardActivityForTool({
            id: `${runId}:${event.toolCallId}`,
            phase: "end",
            source: "subagent",
            toolName: event.toolName,
            args: event.args ?? activeArgs.get(event.toolCallId),
            result: event.result,
            isError: event.isError === true,
            agent: agent.name,
            runId,
          });
          activeArgs.delete(event.toolCallId);
          const prior = activities.findLast((item) => item.label === activity.label && item.category === activity.category);
          if (prior) prior.isError = activity.isError;
          emitActivity(pi, activity);
          progress();
          return;
        }

        if (event.type === "message_end" && event.message && typeof event.message === "object") {
          const message = event.message as Message;
          if (message.role === "assistant") {
            const text = messageText(message);
            if (text) output = text;
            addUsage(usage, message.usage);
            childModel = message.model || childModel;
            stopReason = message.stopReason;
            errorMessage = message.errorMessage;
            progress();
          }
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = tail(stderr + chunk.toString("utf8"), MAX_STDERR_CHARS);
      });
      child.once("error", (error) => {
        stderr = tail(`${stderr}\n${error.message}`.trim(), MAX_STDERR_CHARS);
      });
      child.once("close", (code) => {
        closed = true;
        if (buffer.trim()) processLine(buffer);
        resolveExit(code ?? 1);
      });

      const abort = () => {
        if (closed) return;
        aborted = true;
        stopProcessTree(child);
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      child.once("close", () => signal.removeEventListener("abort", abort));
    });

    if (aborted) {
      stopReason = "aborted";
      errorMessage = "Subagent run was cancelled.";
    }
    return {
      exitCode,
      output: truncateBytes(output, MAX_OUTPUT_BYTES),
      stderr,
      stopReason,
      errorMessage,
      usage,
      activities,
      model: childModel,
    };
  } finally {
    await rm(promptDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// --- formatting ---------------------------------------------------------------

function formatUsage(usage: Usage): string {
  const parts: string[] = [];
  if (usage.input) parts.push(`↑${usage.input}`);
  if (usage.output) parts.push(`↓${usage.output}`);
  if (usage.cacheRead) parts.push(`cache ${usage.cacheRead}`);
  if (usage.cost.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
  return parts.join(" · ");
}

function resultText(result: AgentToolResult<SubagentDetails>): string {
  return result.content
    .map((part) => part.type === "text" ? part.text : "")
    .filter(Boolean)
    .join("\n");
}

function touchedPaths(activities: ActivitySummary[]): string[] {
  return [...new Set(activities.filter((item) => item.category === "edit" && item.path).map((item) => item.path as string))];
}

function completionReport(details: SubagentDetails): string {
  const seconds = details.durationMs !== undefined ? `${(details.durationMs / 1000).toFixed(1)}s` : "";
  const head = `[Subagent "${details.name}" ${details.status}${seconds ? ` in ${seconds}` : ""} · ${details.activities.length} tool call${details.activities.length === 1 ? "" : "s"}${details.usage.cost.total ? ` · $${details.usage.cost.total.toFixed(4)}` : ""} · id ${details.runId}]`;
  const files = touchedPaths(details.activities);
  const body = details.status === "completed"
    ? details.output || "(no text report)"
    : `It did not complete: ${details.errorMessage ?? details.status}.${details.output ? `\n\nLast report:\n${details.output}` : ""}`;
  return [
    head,
    "",
    body,
    files.length > 0 ? `\nFiles it edited: ${files.join(", ")}` : "",
    "",
    "Treat this as evidence, not authority: verify what matters before relying on it, then continue.",
  ].filter((line) => line !== "").join("\n");
}

// --- tool ---------------------------------------------------------------------

const SubagentParams = Type.Object({
  task: Type.String({ minLength: 1, maxLength: MAX_TASK_CHARS, description: "A bounded, exact task with a clear expected result. Include the file paths, commands, and acceptance criteria the child needs; it does not see this conversation." }),
  reason: Type.String({ minLength: 1, maxLength: 500, description: "One plain sentence explaining why delegating this is worthwhile" }),
  agent: Type.Optional(Type.String({ description: `Profile to use: "${WORKER_AGENT}" (default; full tools) or a named specialist listed in the system prompt` })),
  name: Type.Optional(Type.String({ maxLength: 60, description: "Short label for this run, e.g. \"auth-feature\" (defaults to the profile name)" })),
  mode: Type.Optional(Type.Union([Type.Literal("background"), Type.Literal("wait")], { description: "background (default): return immediately, the report arrives later as a message. wait: block until the child finishes and return its report." })),
  tools: Type.Optional(Type.Array(Type.String(), { description: "Restrict or change the child's tools (subset of read, bash, edit, write, grep, find, ls, and web tools when available)" })),
  model: Type.Optional(Type.String({ description: "Which model the child runs on. Choose per task from the pool listed in the tool description (use its short label), or give provider/id when no pool is configured." })),
  thinking: Type.Optional(Type.String({ description: "Override thinking level: off, minimal, low, medium, high, xhigh, max" })),
  instructions: Type.Optional(Type.String({ maxLength: 4000, description: "Extra system-prompt instructions for this run (conventions, constraints, style)" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the child (absolute, or relative to the current one)" })),
});

export default function projectSubagents(pi: ExtensionAPI): void {
  const depth = currentDepth();
  const runs = new Map<string, Run>();
  const order: string[] = [];
  let lastUiContext: ExtensionContext | undefined;

  const running = () => [...runs.values()].filter((run) => run.details.status === "running" || run.details.status === "awaiting-approval");

  function remember(run: Run): void {
    runs.set(run.details.runId, run);
    order.push(run.details.runId);
    while (order.length > MAX_FINISHED_RUNS) {
      const oldest = order[0];
      const candidate = runs.get(oldest);
      if (candidate && (candidate.details.status === "running" || candidate.details.status === "awaiting-approval")) break;
      order.shift();
      if (oldest) runs.delete(oldest);
    }
  }

  function refreshStatus(ctx: ExtensionContext | undefined): void {
    const target = ctx ?? lastUiContext;
    if (!target?.hasUI) return;
    const active = running();
    if (active.length === 0) {
      target.ui.setStatus(STATUS_ID, undefined);
      return;
    }
    const parts = active.map((run) => {
      const last = run.details.activities.at(-1);
      const doing = last ? ` (${(last.command ?? last.path ?? last.label).slice(0, 40)})` : "";
      return `${run.details.name}${doing}`;
    });
    target.ui.setStatus(STATUS_ID, target.ui.theme.fg("warning", `⚙ ${active.length} subagent${active.length === 1 ? "" : "s"}: ${parts.join(", ")}`));
  }

  function finish(run: Run, result: ChildRunResult): SubagentDetails {
    const details = run.details;
    const failed = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
    details.durationMs = details.startedAt !== undefined ? Date.now() - details.startedAt : undefined;
    details.activities = result.activities;
    details.usage = result.usage;
    details.model = result.model ?? details.model;
    details.output = result.output || undefined;
    if (result.stopReason === "aborted") {
      details.status = "cancelled";
      details.errorMessage = result.errorMessage ?? "cancelled";
    } else if (failed) {
      details.status = "failed";
      details.errorMessage = result.errorMessage || result.stderr || `child Pi exited with code ${result.exitCode}`;
    } else {
      details.status = "completed";
    }
    return details;
  }

  async function startRun(
    ctx: ExtensionContext,
    config: SubagentConfig,
    details: SubagentDetails,
    agent: ProjectAgent,
    signal: AbortSignal | undefined,
    onProgress: (details: SubagentDetails) => void,
  ): Promise<Run> {
    const abort = new AbortController();
    const onParentAbort = () => abort.abort();
    // In wait mode the parent's abort cancels the child; in background mode the child keeps going.
    if (details.mode === "wait") signal?.addEventListener("abort", onParentAbort, { once: true });

    let transcript: WriteStream | undefined;
    try {
      await mkdir(config.transcriptDir, { recursive: true });
      const path = join(config.transcriptDir, `${details.runId}.jsonl`);
      transcript = createWriteStream(path, { flags: "w", mode: 0o600 });
      details.transcriptPath = path;
      transcript.write(`${JSON.stringify({ type: "subagent_start", ...details, activities: [], usage: undefined })}\n`);
    } catch {
      transcript = undefined;
    }

    details.status = "running";
    details.startedAt = Date.now();
    const run: Run = { details, abort, done: Promise.resolve() as unknown as Promise<ChildRunResult> };

    run.done = runChild(pi, details.runId, {
      agent,
      task: details.task,
      cwd: details.cwd,
      depth,
      maxDepth: config.maxDepth,
      childExtensions: config.childExtensions,
      extraChildExtensions: config.extraChildExtensions,
      model: details.model,
      thinking: details.thinking,
      transcript,
      signal: abort.signal,
      onProgress: (update) => {
        details.activities = update.activities;
        details.usage = update.usage;
        if (update.model) details.model = update.model;
        onProgress(details);
        refreshStatus(ctx);
      },
    }).then((result) => {
      finish(run, result);
      transcript?.write(`${JSON.stringify({
        type: "subagent_exit",
        runId: details.runId,
        status: details.status,
        exitCode: result.exitCode,
        durationMs: details.durationMs,
        usage: details.usage,
        activities: details.activities,
        model: details.model,
        output: details.output,
        errorMessage: details.errorMessage,
      })}\n`);
      transcript?.end();
      signal?.removeEventListener("abort", onParentAbort);
      refreshStatus(ctx);
      return result;
    }, (error) => {
      details.status = "failed";
      details.errorMessage = error instanceof Error ? error.message : String(error);
      details.durationMs = details.startedAt !== undefined ? Date.now() - details.startedAt : undefined;
      transcript?.write(`${JSON.stringify({ type: "subagent_exit", runId: details.runId, status: "failed", errorMessage: details.errorMessage })}\n`);
      transcript?.end();
      signal?.removeEventListener("abort", onParentAbort);
      refreshStatus(ctx);
      throw error;
    });

    remember(run);
    refreshStatus(ctx);
    emitActivity(pi, lifecycleActivity(details.runId, "start", details.name, details.task, false, `${details.mode} run started (${details.model ?? "inherited model"}).`));
    return run;
  }

  const startupConfig = loadSubagentConfig();
  if (depth >= startupConfig.maxDepth) return;
  const poolText = startupConfig.models.length > 0
    ? ` Model pool — pick one per task with the "model" parameter: ${describePool(startupConfig.models)}. If you omit it, "${startupConfig.models[0].label}" is used.`
    : "";

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: `Delegate a bounded task to an isolated child Pi that runs in the background while you continue. Default profile "${WORKER_AGENT}" has full tools; named specialists may also be available. The child does not see this conversation, so put everything it needs into the task. Its report arrives later as a message beginning with [Subagent "<name>" …]; use mode "wait" if you need the result before you can continue.${poolText}`,
    promptSnippet: "Delegate separable work to background subagents by default and keep working meanwhile",
    promptGuidelines: [
      "Delegate by default, not as a last resort: whenever a task has separable parts (a feature or module, a broad investigation, a review, verification, research), start subagents for them and keep working on the rest yourself.",
      "Do not delegate trivial steps, single small edits, quick answers, or anything that needs this conversation's context the child cannot be given in the task text.",
      "Give each child a self-contained task with paths, commands, and acceptance criteria; several children may run at once on disjoint scopes. Avoid two children editing the same files.",
      "After a [Subagent …] report arrives, verify what matters (diff, tests) before building on it.",
    ],
    parameters: SubagentParams,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      lastUiContext = ctx;
      const reason = params.reason.trim();
      const task = params.task.trim();
      if (!reason) throw new Error("Explain in one sentence why delegating is worth it.");
      if (!task) throw new Error("Subagent task cannot be empty.");
      if (!ctx.isProjectTrusted()) throw new Error("Subagents are disabled because this project is not trusted.");

      const config = loadSubagentConfig();
      const active = running();
      if (active.length >= config.maxConcurrent) {
        throw new Error(`${active.length} subagents are already running (maxConcurrent=${config.maxConcurrent}). Wait for a report or stop one with /subagents stop <id>.`);
      }

      const discovery = discoverProjectAgents(ctx.cwd);
      const profileName = params.agent?.trim() || WORKER_AGENT;
      const base = discovery.agents.find((candidate) => candidate.name === profileName);
      if (!base) {
        const available = discovery.agents.map((candidate) => candidate.name).join(", ");
        const diagnostics = discovery.diagnostics.length > 0 ? `\nConfiguration issues: ${discovery.diagnostics.join("; ")}` : "";
        throw new Error(`Unknown subagent profile “${profileName}”. Available: ${available}.${diagnostics}`);
      }
      const diagnostics: string[] = [];
      const agent = applyOverrides(base, {
        tools: params.tools,
        model: params.model?.trim(),
        thinking: params.thinking?.trim(),
        instructions: params.instructions,
      }, config, diagnostics);
      if (agent.tools.length === 0 && (params.tools?.length ?? 0) > 0) {
        throw new Error(`None of the requested tools are available to a child: ${params.tools?.join(", ")}`);
      }

      const cwd = params.cwd?.trim() ? (isAbsolute(params.cwd.trim()) ? params.cwd.trim() : resolve(ctx.cwd, params.cwd.trim())) : ctx.cwd;
      let isDir = false;
      try { isDir = statSync(cwd).isDirectory(); } catch { isDir = false; }
      if (!isDir) throw new Error(`Working directory does not exist: ${cwd}`);

      const resolved = resolveRunModel(ctx, pi, agent, config);
      const model = resolved.model;
      const thinking = resolved.thinking;
      if (resolved.note) diagnostics.push(resolved.note);
      const mode: RunMode = params.mode ?? config.defaultMode;
      const runId = `subagent-${toolCallId || randomUUID()}`;
      const name = params.name?.trim() || agent.name;

      const details: SubagentDetails = {
        runId,
        status: config.approval === "always" ? "awaiting-approval" : "running",
        agent: agent.name,
        name,
        mode,
        source: agent.source,
        activation: agent.activation,
        access: agent.access,
        reason,
        task,
        agentFile: agent.filePath,
        tools: agent.tools,
        model,
        thinking,
        cwd,
        depth,
        parentRunId: process.env.PI_SUBAGENT_RUN_ID || undefined,
        activities: [],
        usage: emptyUsage(),
      };
      const progressText = (d: SubagentDetails) => `${d.name} is running (${d.activities.length} tool call${d.activities.length === 1 ? "" : "s"})…`;
      onUpdate?.({ content: [{ type: "text", text: details.status === "awaiting-approval" ? `Waiting for approval to run ${name}…` : progressText(details) }], details: { ...details } });

      if (config.approval === "always") {
        const approved = await confirmRun(pi, ctx, runId, agent, reason, task, signal);
        if (!approved) {
          return {
            content: [{ type: "text", text: `Subagent ${name} was not started because the user did not approve this run.` }],
            details: { ...details, status: "cancelled" },
          };
        }
      }

      const run = await startRun(ctx, config, details, agent, signal, (d) => {
        onUpdate?.({ content: [{ type: "text", text: progressText(d) }], details: { ...d } });
      });

      if (mode === "wait") {
        let result: ChildRunResult;
        try {
          result = await run.done;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          emitActivity(pi, lifecycleActivity(runId, "end", name, task, true, detail));
          throw error;
        }
        const final = run.details;
        emitActivity(pi, lifecycleActivity(runId, "end", name, task, final.status !== "completed", final.status === "completed" ? `Completed in ${((final.durationMs ?? 0) / 1000).toFixed(1)}s.` : (final.errorMessage ?? final.status)));
        if (final.status !== "completed") throw new Error(`${name} subagent ${final.status}: ${final.errorMessage ?? "no details"}`);
        return {
          content: [{ type: "text", text: final.output || "(Subagent completed without a text response.)" }],
          details: { ...final },
          usage: result.usage,
        };
      }

      // Background: report later via a follow-up message; the tool call itself returns now.
      run.done.then(() => {
        const final = run.details;
        emitActivity(pi, lifecycleActivity(runId, "end", name, task, final.status !== "completed", final.status === "completed" ? `Completed in ${((final.durationMs ?? 0) / 1000).toFixed(1)}s.` : (final.errorMessage ?? final.status)));
        pi.sendUserMessage(completionReport(final), { deliverAs: "followUp" });
      }, () => {
        emitActivity(pi, lifecycleActivity(runId, "end", name, task, true, run.details.errorMessage));
        pi.sendUserMessage(completionReport(run.details), { deliverAs: "followUp" });
      });

      const notes = diagnostics.length > 0 ? `\nNotes: ${diagnostics.join("; ")}` : "";
      return {
        content: [{
          type: "text",
          text: `Started subagent "${name}" (${describeProfile(agent)}) in the background, id ${runId}.\nIts report will arrive as a message beginning with [Subagent "${name}" …] when it finishes. Continue with other work now; do not wait or poll for it.${notes}`,
        }],
        details: { ...run.details },
      };
    },

    renderCall(args, theme) {
      const task = typeof args.task === "string" ? args.task : "…";
      const preview = task.length > 100 ? `${task.slice(0, 100)}…` : task;
      const label = typeof args.name === "string" && args.name ? args.name : String(args.agent ?? WORKER_AGENT);
      const mode = args.mode === "wait" ? theme.fg("muted", " (wait)") : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", label)}${mode}\n${theme.fg("dim", preview)}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as SubagentDetails | undefined;
      if (!details) return new Text(resultText(result as AgentToolResult<SubagentDetails>), 0, 0);
      const statusIcon = details.status === "completed"
        ? theme.fg("success", "✓")
        : details.status === "failed"
          ? theme.fg("error", "✗")
          : details.status === "cancelled"
            ? theme.fg("muted", "○")
            : theme.fg("warning", "⏳");
      let header = `${statusIcon} ${theme.fg("accent", theme.bold(details.name))} ${theme.fg("muted", details.status)}`;
      if (details.mode === "background" && details.status === "running") header += theme.fg("dim", " · background, report follows");
      if (details.durationMs !== undefined) header += theme.fg("dim", ` · ${(details.durationMs / 1000).toFixed(1)}s`);

      if (!expanded || isPartial) {
        const recent = details.activities.slice(-6).map((activity) => {
          const icon = activity.isError ? theme.fg("error", "✗") : theme.fg("muted", "→");
          const value = activity.command ?? activity.path ?? activity.label;
          const preview = value.length > 100 ? `${value.slice(0, 100)}…` : value;
          return `${icon} ${theme.fg("toolOutput", preview)}`;
        });
        const usage = formatUsage(details.usage);
        return new Text([header, ...recent, usage ? theme.fg("dim", usage) : ""].filter(Boolean).join("\n"), 0, 0);
      }

      const container = new Container();
      container.addChild(new Text(header, 0, 0));
      container.addChild(new Text(theme.fg("dim", `Why: ${details.reason}`), 0, 0));
      container.addChild(new Text(theme.fg("dim", `Profile: ${details.agent} (${details.source}) · Access: ${details.access} · ${details.model ?? "inherited model"}`), 0, 0));
      if (details.transcriptPath) container.addChild(new Text(theme.fg("dim", `Transcript: ${details.transcriptPath}`), 0, 0));
      if (details.activities.length > 0) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "Tool activity"), 0, 0));
        for (const activity of details.activities) {
          container.addChild(new Text(
            `${activity.isError ? theme.fg("error", "✗") : theme.fg("muted", "→")} ${theme.fg("toolOutput", activity.command ?? activity.path ?? activity.label)}`,
            0,
            0,
          ));
        }
      }
      const output = details.output ?? resultText(result as AgentToolResult<SubagentDetails>);
      if (output) {
        container.addChild(new Spacer(1));
        container.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
      }
      const usage = formatUsage(details.usage);
      if (usage) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", usage), 0, 0));
      }
      return container;
    },
  });

  pi.registerCommand("subagents", {
    description: "Subagents: list profiles and runs; /subagents stop <id|all>; /subagents report <id>",
    handler: async (args, ctx) => {
      lastUiContext = ctx;
      const [action, target] = args.trim().split(/\s+/);
      if (action === "stop") {
        const targets = target === "all" ? running() : [runs.get(target ?? "")].filter((run): run is Run => !!run);
        if (targets.length === 0) {
          ctx.ui.notify(target ? `No running subagent with id ${target}.` : "Usage: /subagents stop <id|all>", "warning");
          return;
        }
        for (const run of targets) run.abort.abort();
        ctx.ui.notify(`Stopping ${targets.map((run) => run.details.name).join(", ")}…`, "info");
        return;
      }
      if (action === "report") {
        const run = runs.get(target ?? "");
        if (!run) {
          ctx.ui.notify(`No subagent with id ${target}.`, "warning");
          return;
        }
        pi.sendUserMessage(completionReport(run.details), { deliverAs: ctx.isIdle() ? undefined : "followUp" });
        return;
      }

      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("Subagents are unavailable until this project is trusted.", "warning");
        return;
      }
      const config = loadSubagentConfig();
      const discovery = discoverProjectAgents(ctx.cwd);
      const lines = [
        `Policy: approval ${config.approval}, default mode ${config.defaultMode}, max ${config.maxConcurrent} concurrent, depth ${config.maxDepth}${config.enforceModel ? `, enforced model ${config.enforceModel}` : ""}`,
        ...(config.models.length > 0 ? [`Model pool: ${describePool(config.models)}`] : []),
        ...discovery.agents.map((agent) => `${describeProfile(agent)} — ${agent.description}`),
      ];
      const known = order.map((id) => runs.get(id)).filter((run): run is Run => !!run);
      if (known.length > 0) {
        lines.push("Runs:");
        for (const run of known.slice(-10)) {
          const d = run.details;
          lines.push(`  ${d.status.padEnd(9)} ${d.name} · ${d.activities.length} tools${d.durationMs !== undefined ? ` · ${(d.durationMs / 1000).toFixed(1)}s` : ""} · ${d.runId}`);
        }
      }
      if (discovery.diagnostics.length > 0) lines.push(`Issues: ${discovery.diagnostics.join("; ")}`);
      ctx.ui.notify(lines.join("\n"), discovery.diagnostics.length > 0 ? "warning" : "info");
    },
  });

  pi.on("session_shutdown", async () => {
    for (const run of running()) run.abort.abort();
  });

  // Event-bus hooks for other harness extensions (query a run's live status, or stop a
  // stuck run). Both reply synchronously.
  pi.events.on(SUBAGENT_QUERY_CHANNEL, (data) => {
    const request = data as { runId?: string; reply?: (details: SubagentDetails | undefined) => void } | undefined;
    if (!request || typeof request.reply !== "function") return;
    const run = typeof request.runId === "string" ? runs.get(request.runId) : undefined;
    request.reply(run ? { ...run.details, activities: [...run.details.activities] } : undefined);
  });
  pi.events.on(SUBAGENT_STOP_CHANNEL, (data) => {
    const request = data as { runId?: string; reply?: (result: { stopped: boolean; message: string }) => void } | undefined;
    if (!request || typeof request.reply !== "function") return;
    const run = typeof request.runId === "string" ? runs.get(request.runId) : undefined;
    if (!run) {
      request.reply({ stopped: false, message: `No subagent with id ${request.runId ?? "(none)"} in this session.` });
      return;
    }
    if (run.details.status !== "running" && run.details.status !== "awaiting-approval") {
      request.reply({ stopped: false, message: `Subagent "${run.details.name}" (${run.details.runId}) is already ${run.details.status}.` });
      return;
    }
    run.abort.abort();
    refreshStatus(lastUiContext);
    request.reply({ stopped: true, message: `Stopping subagent "${run.details.name}" (${run.details.runId}) after ${run.details.activities.length} tool calls.` });
  });

  pi.on("before_agent_start", (event, ctx) => {
    lastUiContext = ctx;
    if (!ctx.isProjectTrusted()) return;
    // The tool is always active; the policy below goes with it on every turn so
    // delegation is a default habit rather than something the prompt must hint at.
    if (!pi.getActiveTools().includes("subagent")) return;
    const discovery = discoverProjectAgents(ctx.cwd);

    const prompt = event.prompt.toLowerCase();
    // Profiles with `activation: explicit` are only listed when the user names them or asks for delegation.
    const explicitlyMentionsDelegation = /\b(?:sub[ -]?agents?|delegat(?:e|ion)|another agent|in the background|in parallel|worker)\b/.test(prompt)
      || discovery.agents.some((agent) => agent.name !== WORKER_AGENT && prompt.includes(agent.name.toLowerCase()));

    const eligible = explicitlyMentionsDelegation
      ? discovery.agents
      : discovery.agents.filter((agent) => agent.activation === "propose");
    if (eligible.length === 0) return;
    const list = eligible.map((agent) => `- ${agent.name} [${agent.access}]: ${agent.description}`).join("\n");
    const config = loadSubagentConfig();
    const poolLine = config.models.length > 0
      ? `\nModels for children (pass the label as "model"): ${describePool(config.models)}.`
      : "";
    const active = running();
    const activeLine = active.length > 0
      ? `\nCurrently running: ${active.map((run) => `${run.details.name} (${run.details.runId})`).join(", ")}. Their reports will arrive as messages.`
      : "";
    return {
      systemPrompt: `${event.systemPrompt}\n\nSubagent profiles available:\n${list}${poolLine}${activeLine}\n\nDelegation policy:\n- Delegate by default, not as a last resort. Before starting any task with more than one separable part, split it and hand each separable part to a subagent: a feature or module, a broad investigation, an independent review, verification, research. Keep working on the rest yourself; several children may run at once on disjoint scopes.\n- Subagents run in the background; you get a message beginning with [Subagent "<name>" …] when one finishes. Never poll or idle for it. If nothing else remains, end your turn and the report will arrive on its own; for long runs also arm a defer trigger as a guard so a stalled child is noticed. Use mode "wait" only when the result is needed before you can take the next step.\n- Give the child every path, command, and acceptance criterion it needs; it cannot see this conversation. Avoid two children editing the same files.\n- Keep for yourself: trivial steps, single small edits, quick answers, and work that needs context you cannot write down.\n- Treat reports as evidence, not authority: check the diff and run the relevant tests before building on them.${config.models.length > 0 ? "\n- Choose the child's model deliberately per task using the pool guidance above." : ""}`,
    };
  });
}
