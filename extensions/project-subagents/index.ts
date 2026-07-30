import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
import { discoverProjectAgents, type ProjectAgent } from "./agents.ts";

const ASK_PROTOCOL_VERSION = 1;
const ASK_REQUEST_CHANNEL = "anywhere:ask:v1:request";
const ASK_CANCEL_CHANNEL = "anywhere:ask:v1:cancel";
const MAX_TASK_CHARS = 12_000;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_STDERR_CHARS = 12_000;
const MAX_ACTIVITY_ITEMS = 100;
const STATUS_ID = "project-subagents";

interface ActivitySummary {
  label: string;
  category: DashboardActivity["category"];
  command?: string;
  path?: string;
  isError?: boolean;
}

interface SubagentDetails {
  runId: string;
  status: "awaiting-approval" | "running" | "completed" | "cancelled" | "failed";
  agent: string;
  task: string;
  agentFile: string;
  tools: string[];
  model?: string;
  startedAt?: number;
  durationMs?: number;
  activities: ActivitySummary[];
  usage: Usage;
  output?: string;
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
  agent: ProjectAgent,
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
    label: `${agent.name} subagent`,
    timestamp: Date.now(),
    agent: agent.name,
    runId,
    task,
    detail,
    isError,
  };
}

function requestRemoteApproval(
  pi: ExtensionAPI,
  runId: string,
  agent: ProjectAgent,
  task: string,
  signal: AbortSignal | undefined,
): Promise<boolean> | undefined {
  if (signal?.aborted) return Promise.resolve(false);
  let claimed = false;
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
    pi.events.emit(ASK_CANCEL_CHANNEL, { version: ASK_PROTOCOL_VERSION, id: runId });
    finish(false);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  pi.events.emit(ASK_REQUEST_CHANNEL, {
    version: ASK_PROTOCOL_VERSION,
    id: runId,
    question: `Run project subagent “${agent.name}”?`,
    context: [
      agent.description,
      `Source: ${agent.filePath}`,
      `Tools: ${agent.tools.join(", ") || "none"}`,
      "",
      `Task:\n${task}`,
      "",
      "No child process has started yet.",
    ].join("\n"),
    options: [
      { title: "Run subagent", description: "Approve this one project-specific run" },
      { title: "Cancel", description: "Do not start any subagent work" },
    ],
    allowMultiple: false,
    allowFreeform: false,
    allowComment: false,
    signal,
    claim: () => {
      if (claimed || settled) return false;
      claimed = true;
      return true;
    },
    respond: (value: RemoteAnswer | null) => {
      const approved = value?.kind === "selection" && value.selections?.includes("Run subagent") === true;
      return finish(approved);
    },
  });

  if (!claimed) {
    signal?.removeEventListener("abort", onAbort);
    settled = true;
    return undefined;
  }
  return answer;
}

async function confirmRun(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runId: string,
  agent: ProjectAgent,
  task: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const remote = requestRemoteApproval(pi, runId, agent, task, signal);
  if (remote) return await remote;
  if (!ctx.hasUI) return false;
  return await ctx.ui.confirm(
    `Run project subagent “${agent.name}”?`,
    [
      agent.description,
      `Source: ${agent.filePath}`,
      `Tools: ${agent.tools.join(", ") || "none"}`,
      "",
      `Task:\n${task}`,
      "",
      "No child process has started yet.",
    ].join("\n"),
    signal ? { signal } : undefined,
  );
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

async function runChild(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runId: string,
  agent: ProjectAgent,
  task: string,
  signal: AbortSignal | undefined,
  onProgress: (details: SubagentDetails) => void,
): Promise<ChildRunResult> {
  const promptDir = await mkdtemp(join(tmpdir(), "pi-project-subagent-"));
  const promptFile = join(promptDir, `${agent.name}-prompt.md`);
  const systemPrompt = [
    `You are the project-defined subagent “${agent.name}”.`,
    agent.systemPrompt,
    "",
    "Run boundary: complete only the delegated task. Do not broaden the scope, launch other agents, or add review/planning work unless the task explicitly asks for it.",
    "Report what you did, commands or checks that matter, and any files changed.",
  ].join("\n");
  await writeFile(promptFile, systemPrompt, { encoding: "utf8", mode: 0o600 });

  const selectedModel = agent.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
  const selectedThinking = agent.thinking ?? ctx.thinkingLevel;
  const args = [
    "--mode", "json",
    "--print",
    "--no-session",
    "--no-extensions",
    "--approve",
    "--append-system-prompt", promptFile,
  ];
  if (agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
  else args.push("--no-tools");
  if (selectedModel) args.push("--model", selectedModel);
  if (selectedThinking) args.push("--thinking", selectedThinking);
  args.push(`Task delegated by the main Pi agent:\n\n${task}`);

  const usage = emptyUsage();
  const activities: ActivitySummary[] = [];
  const activeArgs = new Map<string, unknown>();
  let stderr = "";
  let output = "";
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  let childModel = selectedModel;
  let aborted = false;

  const baseDetails = (): SubagentDetails => ({
    runId,
    status: "running",
    agent: agent.name,
    task,
    agentFile: agent.filePath,
    tools: agent.tools,
    model: childModel,
    activities: [...activities],
    usage: { ...usage, cost: { ...usage.cost } },
  });

  try {
    const exitCode = await new Promise<number>((resolveExit) => {
      const invocation = getPiInvocation(args);
      const child = spawn(invocation.command, invocation.args, {
        cwd: ctx.cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PI_PROJECT_SUBAGENT: "1", PI_SUBAGENT_RUN_ID: runId },
      });
      let buffer = "";
      let closed = false;

      const processLine = (line: string): void => {
        if (!line.trim()) return;
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
          onProgress(baseDetails());
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
          onProgress(baseDetails());
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
            onProgress(baseDetails());
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
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      child.once("close", () => signal?.removeEventListener("abort", abort));
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

const SubagentParams = Type.Object({
  agent: Type.String({ description: "Name of an agent defined in the current project's .pi/agents directory" }),
  task: Type.String({ minLength: 1, maxLength: MAX_TASK_CHARS, description: "The exact project-specific task the user asked to delegate" }),
});

export default function projectSubagents(pi: ExtensionAPI): void {
  if (process.env.PI_PROJECT_SUBAGENT === "1") return;

  let activeRunId: string | undefined;

  pi.registerTool({
    name: "subagent",
    label: "Project Subagent",
    description: "Ask one project-defined subagent to perform one explicitly user-requested task in an isolated Pi process. Agents are loaded only from the nearest .pi/agents directory. Every run requires user approval before the child process starts. There are no built-in agents, automatic reviews, chains, or workflows.",
    promptSnippet: "Run one explicitly requested project-local subagent after user approval",
    promptGuidelines: [
      "Use subagent only when the user explicitly asks the main Pi agent to delegate work to a subagent.",
      "Never use subagent for automatic review, planning, scouting, validation, or follow-up work that the user did not request.",
      "Call subagent once per requested task; do not create chains or swarms. Every call is shown to the user for approval before work starts.",
    ],
    parameters: SubagentParams,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const task = params.task.trim();
      if (!task) throw new Error("Subagent task cannot be empty.");
      if (!ctx.isProjectTrusted()) throw new Error("Project subagents are disabled because this project is not trusted.");
      if (activeRunId) throw new Error("A project subagent is already active. Wait for it to finish before requesting another run.");

      const discovery = discoverProjectAgents(ctx.cwd);
      const agent = discovery.agents.find((candidate) => candidate.name === params.agent);
      if (!agent) {
        const available = discovery.agents.map((candidate) => candidate.name).join(", ") || "none";
        const diagnostics = discovery.diagnostics.length > 0 ? `\nConfiguration issues: ${discovery.diagnostics.join("; ")}` : "";
        throw new Error(`Unknown project agent “${params.agent}”. Available agents: ${available}.${diagnostics}`);
      }

      const runId = `subagent-${toolCallId || randomUUID()}`;
      activeRunId = runId;
      const initialDetails: SubagentDetails = {
        runId,
        status: "awaiting-approval",
        agent: agent.name,
        task,
        agentFile: agent.filePath,
        tools: agent.tools,
        model: agent.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
        activities: [],
        usage: emptyUsage(),
      };
      onUpdate?.({ content: [{ type: "text", text: `Waiting for approval to run ${agent.name}…` }], details: initialDetails });

      try {
        const approved = await confirmRun(pi, ctx, runId, agent, task, signal);
        if (!approved) {
          return {
            content: [{ type: "text", text: `Subagent ${agent.name} was not started because the user did not approve this run.` }],
            details: { ...initialDetails, status: "cancelled" },
          };
        }

        const startedAt = Date.now();
        ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("warning", `subagent: ${agent.name}`));
        emitActivity(pi, lifecycleActivity(runId, "start", agent, task, false, "Approved; isolated child Pi started."));

        const update = (details: SubagentDetails): void => {
          onUpdate?.({
            content: [{ type: "text", text: `${agent.name} is running (${details.activities.length} tool call${details.activities.length === 1 ? "" : "s"})…` }],
            details: { ...details, startedAt },
          });
        };
        let child: ChildRunResult;
        try {
          child = await runChild(pi, ctx, runId, agent, task, signal, update);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          emitActivity(pi, lifecycleActivity(runId, "end", agent, task, true, detail));
          throw error;
        }
        const failed = child.exitCode !== 0 || child.stopReason === "error" || child.stopReason === "aborted";
        const durationMs = Date.now() - startedAt;
        const failure = child.errorMessage || child.stderr || `child Pi exited with code ${child.exitCode}`;
        emitActivity(pi, lifecycleActivity(
          runId,
          "end",
          agent,
          task,
          failed,
          failed ? failure : `Completed in ${(durationMs / 1000).toFixed(1)}s.`,
        ));

        if (failed) throw new Error(`${agent.name} subagent failed: ${failure}`);
        const output = child.output || "(Subagent completed without a text response.)";
        return {
          content: [{ type: "text", text: output }],
          details: {
            runId,
            status: "completed",
            agent: agent.name,
            task,
            agentFile: agent.filePath,
            tools: agent.tools,
            model: child.model,
            startedAt,
            durationMs,
            activities: child.activities,
            usage: child.usage,
            output,
          },
          usage: child.usage,
        };
      } finally {
        activeRunId = undefined;
        ctx.ui.setStatus(STATUS_ID, undefined);
      }
    },

    renderCall(args, theme) {
      const task = typeof args.task === "string" ? args.task : "…";
      const preview = task.length > 100 ? `${task.slice(0, 100)}…` : task;
      return new Text(
        `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", String(args.agent ?? "…"))}\n${theme.fg("dim", preview)}`,
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
      let header = `${statusIcon} ${theme.fg("accent", theme.bold(details.agent))} ${theme.fg("muted", details.status)}`;
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
      container.addChild(new Text(theme.fg("dim", `Agent file: ${details.agentFile}`), 0, 0));
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
    description: "List project-local subagents and configuration issues",
    handler: async (_args, ctx) => {
      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("Project subagents are unavailable until this project is trusted.", "warning");
        return;
      }
      const discovery = discoverProjectAgents(ctx.cwd);
      if (!discovery.agentsDir) {
        ctx.ui.notify(`No project agents directory found. Create .pi/agents inside this project.`, "info");
        return;
      }
      const lines = discovery.agents.map((agent) => `${agent.name} — ${agent.description} [${agent.tools.join(", ") || "no tools"}]`);
      if (discovery.diagnostics.length > 0) lines.push(`Issues: ${discovery.diagnostics.join("; ")}`);
      ctx.ui.notify(lines.length > 0 ? lines.join("\n") : `No valid agents in ${discovery.agentsDir}.`, discovery.diagnostics.length > 0 ? "warning" : "info");
    },
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (!ctx.isProjectTrusted()) return;
    const discovery = discoverProjectAgents(ctx.cwd);
    if (discovery.agents.length === 0) return;
    const prompt = event.prompt.toLowerCase();
    const explicitlyMentionsDelegation = /\b(?:sub[ -]?agents?|delegat(?:e|ion)|another agent)\b/.test(prompt)
      || discovery.agents.some((agent) => prompt.includes(agent.name.toLowerCase()));
    if (!explicitlyMentionsDelegation) return;
    const list = discovery.agents.map((agent) => `- ${agent.name}: ${agent.description}`).join("\n");
    return {
      systemPrompt: `${event.systemPrompt}\n\nProject-local subagents available for this explicit delegation request:\n${list}\nDo not call the subagent tool for work beyond what the user requested.`,
    };
  });
}
