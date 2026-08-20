import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Message, Usage } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  parseFrontmatter,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { ENFORCED_SUBAGENT_MODEL, ENFORCED_SUBAGENT_THINKING } from "../project-subagents/agents.ts";
import { runRestrictedCheck } from "./restricted-check.ts";
import {
  applyWorkspaceChanges,
  cooldownRemainingMs,
  diffSnapshots,
  fingerprintWorkaround,
  manifestFromSnapshots,
  normalizeRepoPath,
  type SnapshotMap,
  snapshotListedFiles,
  snapshotWorkspace,
  validateAutomaticChanges,
} from "./workspace.ts";

const TOOL_NAME = "fix_pi_workaround";
const STATUS_ID = "auto-workaround-fixer";
const STATE_VERSION = 1;
const MAX_STATE_ATTEMPTS = 100;
const MAX_STAGE_BYTES = 64 * 1024 * 1024;
const MAX_CHILD_OUTPUT_BYTES = 50 * 1024;
const MAX_STDERR_CHARS = 12_000;
const RUN_TIMEOUT_MS = 20 * 60 * 1000;
const RECURRENCE = ["repeated", "required-each-time"] as const;

const require = createRequire(import.meta.url);

const FixParams = Type.Object({
  summary: Type.String({
    minLength: 10,
    maxLength: 500,
    description: "Plain description of the operational friction the main Pi agent actually encountered",
  }),
  missingCapability: Type.String({
    minLength: 5,
    maxLength: 500,
    description: "The direct Pi, tool, shell, or harness capability that was missing or broken",
  }),
  workaround: Type.String({
    minLength: 10,
    maxLength: 2_000,
    description: "The detour the main Pi agent had to perform instead",
  }),
  evidence: Type.String({
    minLength: 10,
    maxLength: 4_000,
    description: "Concrete tool calls, errors, or observations from this task proving the detour",
  }),
  recurrence: StringEnum(RECURRENCE, {
    description: "Whether the detour has repeated already or is required every time the capability is used",
  }),
});

type FixInput = Static<typeof FixParams>;
type AttemptStatus = "running" | "completed" | "no-change" | "failed";

interface FixerAttempt {
  id: string;
  fingerprint: string;
  summary: string;
  status: AttemptStatus;
  startedAt: number;
  finishedAt?: number;
  changedPaths?: string[];
  error?: string;
}

interface FixerState {
  version: typeof STATE_VERSION;
  attempts: FixerAttempt[];
}

interface FixerAgentDefinition {
  body: string;
  path: string;
}

interface Stage {
  tempRoot: string;
  workspace: string;
  manifestPath: string;
  baseline: SnapshotMap;
  protectedPaths: string[];
}

interface ChildResult {
  exitCode: number;
  output: string;
  stderr: string;
  stopReason?: string;
  errorMessage?: string;
  usage: Usage;
  model?: string;
  timedOut: boolean;
  aborted: boolean;
}

interface FixerDetails {
  id: string;
  status: AttemptStatus | "suppressed";
  summary: string;
  fingerprint: string;
  changedPaths: string[];
  checks: string[];
  output?: string;
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
  if (!usage.cost) return;
  total.cost.input += usage.cost.input ?? 0;
  total.cost.output += usage.cost.output ?? 0;
  total.cost.cacheRead += usage.cost.cacheRead ?? 0;
  total.cost.cacheWrite += usage.cost.cacheWrite ?? 0;
  total.cost.total += usage.cost.total ?? 0;
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
  return `${text.slice(0, end)}\n\n[Automatic fixer output truncated]`;
}

function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `… [earlier output omitted]\n${text.slice(-maxChars)}`;
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

function codingAgentRoot(): string {
  const entry = require.resolve("@earendil-works/pi-coding-agent");
  return resolve(dirname(entry), "..");
}

function statePaths(agentDir: string): { state: string; lock: string } {
  const directory = join(agentDir, "state");
  return {
    state: join(directory, "auto-workaround-fixer.json"),
    lock: join(directory, "auto-workaround-fixer.lock"),
  };
}

async function loadState(path: string): Promise<{ state: FixerState; warning?: string }> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<FixerState>;
    if (parsed.version !== STATE_VERSION || !Array.isArray(parsed.attempts)) throw new Error("unsupported state format");
    return { state: { version: STATE_VERSION, attempts: parsed.attempts.slice(-MAX_STATE_ATTEMPTS) as FixerAttempt[] } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: { version: STATE_VERSION, attempts: [] } };
    return {
      state: { version: STATE_VERSION, attempts: [] },
      warning: `Automatic fixer state was reset in memory: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function saveState(path: string, state: FixerState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ ...state, attempts: state.attempts.slice(-MAX_STATE_ATTEMPTS) }, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

interface LockOwner {
  pid: number;
  token: string;
  createdAt: number;
}

function parseLockOwner(value: string): LockOwner | undefined {
  try {
    const owner = JSON.parse(value) as Partial<LockOwner>;
    if (!Number.isInteger(owner.pid) || typeof owner.token !== "string" || typeof owner.createdAt !== "number") return undefined;
    return owner as LockOwner;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function removeOwnedLock(path: string, token: string): Promise<boolean> {
  const current = await readFile(path, "utf8").catch(() => undefined);
  if (!current || parseLockOwner(current)?.token !== token) return false;
  await rm(path, { force: true });
  return true;
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  const owner: LockOwner = { pid: process.pid, token: randomUUID(), createdAt: Date.now() };
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Another automatic workaround-fixer run owns the global lock. Use /workaround-fixer unlock only after that Pi process has stopped.");
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
  } catch (error) {
    await handle.close().catch(() => undefined);
    await removeOwnedLock(path, owner.token).catch(() => undefined);
    throw error;
  }
  return async () => {
    await handle.close().catch(() => undefined);
    await removeOwnedLock(path, owner.token).catch(() => undefined);
  };
}

async function unlockStoppedOwner(path: string): Promise<"missing" | "removed"> {
  const first = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!first) return "missing";
  const owner = parseLockOwner(first);
  if (!owner) throw new Error(`Lock file is invalid and was not removed: ${path}`);
  if (processIsAlive(owner.pid)) throw new Error(`Pi process ${owner.pid} still owns the automatic fixer lock.`);
  const current = await readFile(path, "utf8").catch(() => undefined);
  if (!current) return "missing";
  if (parseLockOwner(current)?.token !== owner.token) throw new Error("Automatic fixer lock ownership changed; nothing was removed.");
  await rm(path);
  return "removed";
}

function nulPaths(output: string): string[] {
  return output.split("\0").map((path) => normalizeRepoPath(path)).filter((path): path is string => Boolean(path));
}

async function gitPaths(
  pi: ExtensionAPI,
  agentDir: string,
  args: string[],
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const result = await pi.exec("git", ["-C", agentDir, ...args], { signal, timeout: 30_000 });
  if (result.code !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed with code ${result.code}`);
  return nulPaths(result.stdout);
}

async function verifyHarnessWorktree(
  pi: ExtensionAPI,
  agentDir: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const rootResult = await pi.exec("git", ["-C", agentDir, "rev-parse", "--show-toplevel"], { signal, timeout: 30_000 });
  if (rootResult.code !== 0 || resolve(rootResult.stdout.trim()) !== resolve(agentDir)) {
    throw new Error("Automatic self-repair requires the global Pi harness to be the root of a Git worktree.");
  }
}

async function discoverSourcePaths(
  pi: ExtensionAPI,
  agentDir: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const source = await gitPaths(pi, agentDir, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], signal);
  return [...new Set(source)].sort();
}

async function discoverProtectedPaths(
  pi: ExtensionAPI,
  agentDir: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const [unstaged, staged, untracked] = await Promise.all([
    gitPaths(pi, agentDir, ["diff", "--name-only", "-z"], signal),
    gitPaths(pi, agentDir, ["diff", "--cached", "--name-only", "-z"], signal),
    gitPaths(pi, agentDir, ["ls-files", "--others", "--exclude-standard", "-z"], signal),
  ]);
  return [...new Set([...unstaged, ...staged, ...untracked])].sort();
}

async function createStage(
  pi: ExtensionAPI,
  agentDir: string,
  signal: AbortSignal | undefined,
): Promise<Stage> {
  await verifyHarnessWorktree(pi, agentDir, signal);
  const sourcePaths = await discoverSourcePaths(pi, agentDir, signal);
  const baseline = await snapshotListedFiles(agentDir, sourcePaths);
  const protectedPaths = await discoverProtectedPaths(pi, agentDir, signal);
  const totalBytes = [...baseline.values()].reduce((total, file) => total + file.size, 0);
  if (totalBytes > MAX_STAGE_BYTES) {
    throw new Error(`Harness source is too large to stage safely (${totalBytes} bytes; limit ${MAX_STAGE_BYTES}).`);
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "pi-auto-workaround-fixer-"));
  const workspace = join(tempRoot, "harness");
  const manifestPath = join(tempRoot, "manifest.json");
  try {
    await mkdir(workspace, { recursive: true });
    for (const [path, file] of baseline) {
      signal?.throwIfAborted();
      const target = join(workspace, ...path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, { mode: file.mode });
      await chmod(target, file.mode);
    }

    const nodeModules = join(agentDir, "node_modules");
    if (!existsSync(nodeModules)) throw new Error("Harness node_modules is missing; run npm install before automatic self-repair.");
    for (const directory of ["node_modules", "npm", "git"]) {
      const source = join(agentDir, directory);
      if (!existsSync(source)) continue;
      await symlink(source, join(workspace, directory), process.platform === "win32" ? "junction" : "dir");
    }
    await writeFile(manifestPath, `${JSON.stringify(manifestFromSnapshots(baseline, protectedPaths), null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return { tempRoot, workspace, manifestPath, baseline, protectedPaths };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function loadFixerAgent(agentDir: string): Promise<FixerAgentDefinition> {
  const path = join(agentDir, "agents", "workaround-fixer.md");
  const source = await readFile(path, "utf8");
  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(source);
  const automatic = frontmatter.automatic === true || String(frontmatter.automatic).toLowerCase() === "true";
  if (!automatic || frontmatter.scope !== "pi-harness" || !body.trim()) {
    throw new Error(`${path} must declare automatic: true, scope: pi-harness, and non-empty instructions.`);
  }
  return { path, body: body.trim() };
}

function formatReport(params: FixInput): string {
  return [
    `Summary: ${params.summary.trim()}`,
    `Missing direct capability: ${params.missingCapability.trim()}`,
    `Workaround used by the main Pi agent: ${params.workaround.trim()}`,
    `Recurrence: ${params.recurrence}`,
    `Concrete evidence:\n${params.evidence.trim()}`,
  ].join("\n\n");
}

function childSystemPrompt(
  definition: FixerAgentDefinition,
  stage: Stage,
  agentDir: string,
  docsRoot: string,
  report: string,
): string {
  const protectedList = stage.protectedPaths.length > 0
    ? stage.protectedPaths.map((path) => `- ${path}`).join("\n")
    : "- (none)";
  return [
    "You are the automatic Pi operational-workaround fixer.",
    definition.body,
    "",
    "Hard run boundary:",
    `- The writable workspace is a staged copy at ${stage.workspace}. Never target the real harness at ${agentDir}.`,
    "- First classify the report. It is in scope only if the main Pi agent itself was forced into a recurring operational detour because a Pi tool, shell integration, skill, extension, or harness capability was missing or broken.",
    "- It is out of scope if it concerns compatibility or fallback code in the user's project, a normal task-specific script, a one-off agent mistake, speculative convenience, or a workaround requested by the user for their product.",
    "- If out of scope or not proven by the evidence, make no changes and explain why.",
    "- Prefer, in order: a supported Pi/configuration/API fix; a focused extension or custom tool for runtime capability; a skill for repeatable knowledge/workflow. Do not replace one detour with another helper-script ritual.",
    "- Installed Pi and package source is available read-only for root-cause inspection. Do not patch it, add monkey patches, add silent fallbacks, add dependencies without a reviewed need, or modify project code.",
    `- Read the relevant Pi documentation completely under ${docsRoot}/docs and the related examples under ${docsRoot}/examples before implementing. Follow their Markdown cross-references.`,
    "- Use exact, minimal edits. Add focused regression tests. You cannot run arbitrary shell commands; use harness_check.",
    "- Run harness_check changes, harness_check typecheck, and harness_check test before finishing. If checks cannot pass, leave the staged files as evidence but clearly report failure; the parent will not apply them.",
    "- Never modify any part of the automatic fixer, its agent definition, or APPEND_SYSTEM.md activation policy. Those are protected by enforcement.",
    "",
    "Pre-existing dirty paths are read-only so unrelated user work cannot be overwritten:",
    protectedList,
    "",
    "Observed report:",
    report,
    "",
    "Finish with: scope verdict, root cause, supported harness artifact chosen, changed files, and checks. Keep it concise.",
  ].join("\n");
}

async function runChild(
  stage: Stage,
  agentDir: string,
  docsRoot: string,
  definition: FixerAgentDefinition,
  report: string,
  signal: AbortSignal | undefined,
  onProgress: (message: string) => void,
): Promise<ChildResult> {
  const systemPromptPath = join(stage.tempRoot, "system-prompt.md");
  await writeFile(systemPromptPath, childSystemPrompt(definition, stage, agentDir, docsRoot, report), {
    encoding: "utf8",
    mode: 0o600,
  });

  const guardPath = join(agentDir, "extensions", "auto-workaround-fixer", "child-guard.ts");
  const webPath = join(agentDir, "npm", "node_modules", "pi-web-access", "index.ts");
  const tools = ["read", "grep", "find", "ls", "edit", "write", "harness_check"];
  const args = [
    "--mode", "json",
    "--print",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--approve",
    "--append-system-prompt", systemPromptPath,
    "--extension", guardPath,
  ];
  if (existsSync(webPath)) {
    args.push("--extension", webPath);
    tools.push("web_search", "source_check", "fetch_content", "get_search_content");
  }
  args.push(
    "--tools", tools.join(","),
    "--model", ENFORCED_SUBAGENT_MODEL,
    "--thinking", ENFORCED_SUBAGENT_THINKING,
    `Automatically repair this verified Pi operational workaround if and only if it is in scope:\n\n${report}`,
  );

  const usage = emptyUsage();
  let output = "";
  let stderr = "";
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  let childModel: string | undefined = ENFORCED_SUBAGENT_MODEL;
  let timedOut = false;
  let aborted = false;
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, RUN_TIMEOUT_MS);
  timeout.unref();
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;

  try {
    const exitCode = await new Promise<number>((resolveExit) => {
      const invocation = getPiInvocation(args);
      const child = spawn(invocation.command, invocation.args, {
        cwd: stage.workspace,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PI_AUTO_WORKAROUND_FIXER_CHILD: "1",
          PI_AUTO_FIXER_WORKSPACE: stage.workspace,
          PI_AUTO_FIXER_REAL_AGENT_DIR: agentDir,
          PI_AUTO_FIXER_CODING_AGENT_ROOT: docsRoot,
          PI_AUTO_FIXER_MANIFEST: stage.manifestPath,
          PI_PROJECT_SUBAGENT: "1",
        },
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
        if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
          onProgress(`Automatic fixer is using ${event.toolName}…`);
          return;
        }
        if (event.type === "message_end" && event.message && typeof event.message === "object") {
          const message = event.message as Message;
          if (message.role !== "assistant") return;
          const text = messageText(message);
          if (text) output = text;
          addUsage(usage, message.usage);
          childModel = message.model || childModel;
          stopReason = message.stopReason;
          errorMessage = message.errorMessage;
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
        aborted = signal?.aborted === true;
        stopProcessTree(child);
      };
      if (combinedSignal.aborted) abort();
      else combinedSignal.addEventListener("abort", abort, { once: true });
      child.once("close", () => combinedSignal.removeEventListener("abort", abort));
    });

    return {
      exitCode,
      output: truncateBytes(output, MAX_CHILD_OUTPUT_BYTES),
      stderr,
      stopReason,
      errorMessage,
      usage,
      model: childModel,
      timedOut,
      aborted,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function checkOutput(label: string, result: { stdout: string; stderr: string; code: number; killed: boolean }): string {
  const raw = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n") || "(no output)";
  const truncated = truncateTail(raw, { maxBytes: 24 * 1024, maxLines: 800 });
  const formatted = `${label} exited with code ${result.code}${result.killed ? " (killed)" : ""}.\n${truncated.content}`;
  if (result.code !== 0) throw new Error(formatted);
  return `${label}: passed`;
}

async function validateStage(
  stage: Stage,
  agentDir: string,
  docsRoot: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const typecheck = await runRestrictedCheck({
    action: "typecheck",
    workspace: stage.workspace,
    agentDir,
    codingAgentRoot: docsRoot,
    tempRoot: stage.tempRoot,
    signal,
  });
  const checks = [checkOutput("Typecheck", typecheck)];

  const tests = await runRestrictedCheck({
    action: "test",
    workspace: stage.workspace,
    agentDir,
    codingAgentRoot: docsRoot,
    tempRoot: stage.tempRoot,
    signal,
  });
  checks.push(checkOutput("Tests", tests));
  return checks;
}

function updateAttempt(
  state: FixerState,
  id: string,
  status: AttemptStatus,
  fields: Partial<Pick<FixerAttempt, "changedPaths" | "error">> = {},
): void {
  const attempt = state.attempts.find((candidate) => candidate.id === id);
  if (!attempt) return;
  Object.assign(attempt, fields, { status, finishedAt: Date.now() });
}

function humanDuration(milliseconds: number): string {
  if (milliseconds < 60_000) return `${Math.max(1, Math.ceil(milliseconds / 1000))}s`;
  if (milliseconds < 3_600_000) return `${Math.ceil(milliseconds / 60_000)}m`;
  if (milliseconds < 86_400_000) return `${Math.ceil(milliseconds / 3_600_000)}h`;
  return `${Math.ceil(milliseconds / 86_400_000)}d`;
}

export default function automaticWorkaroundFixer(pi: ExtensionAPI): void {
  if (process.env.PI_AUTO_WORKAROUND_FIXER_CHILD === "1") return;

  const agentDir = getAgentDir();
  const paths = statePaths(agentDir);
  let enabled = process.env.PI_AUTO_WORKAROUND_FIXER?.toLowerCase() !== "off";
  let activeRunId: string | undefined;

  const updateStatus = (ctx: ExtensionContext): void => {
    const text = activeRunId
      ? ctx.ui.theme.fg("warning", "self-fixer running")
      : !enabled
        ? ctx.ui.theme.fg("muted", "self-fixer off")
        : undefined;
    ctx.ui.setStatus(STATUS_ID, text);
  };

  pi.registerTool({
    name: TOOL_NAME,
    label: "Fix Pi Workaround",
    description: "Automatically repair a recurring operational workaround that the main Pi agent itself had to use because a direct Pi, shell, tool, skill, extension, or harness capability was missing or broken. This launches a no-approval child that may update only the staged global Pi harness after checks. Never use it for workaround or fallback code in the user's project.",
    promptSnippet: "Automatically repair a recurring workaround forced on the main Pi agent itself",
    promptGuidelines: [
      "Call fix_pi_workaround automatically, without asking the user first, only after the main Pi agent itself has concrete evidence that a missing or broken Pi/harness capability forced a recurring operational detour.",
      "Never call fix_pi_workaround for compatibility code, fallbacks, shims, scripts, or temporary fixes in the user's project; never call it for a normal task-specific script, a one-off command mistake, or a speculative convenience.",
      "Call fix_pi_workaround alone in its tool batch, provide exact evidence, and continue the user's original task after the scoped fixer returns.",
    ],
    parameters: FixParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!enabled) throw new Error("Automatic Pi workaround fixing is disabled. Use /workaround-fixer on to enable it.");
      if (!ctx.isProjectTrusted()) {
        throw new Error("Automatic Pi self-repair is blocked in an untrusted project because it can change the global harness.");
      }
      if (activeRunId) throw new Error("An automatic Pi workaround-fixer run is already active.");

      const fingerprint = fingerprintWorkaround(params);
      const id = `auto-fix-${toolCallId || randomUUID()}`;
      activeRunId = id;
      updateStatus(ctx);
      onUpdate?.({
        content: [{ type: "text", text: "Staging the global Pi harness for automatic self-repair…" }],
        details: { id, status: "running", summary: params.summary, fingerprint, changedPaths: [], checks: [] } satisfies FixerDetails,
      });

      let releaseLock: (() => Promise<void>) | undefined;
      let stage: Stage | undefined;
      let state: FixerState | undefined;
      let stateWarning: string | undefined;
      let usage = emptyUsage();
      try {
        releaseLock = await acquireLock(paths.lock);
        const loaded = await loadState(paths.state);
        state = loaded.state;
        stateWarning = loaded.warning;
        const prior = [...state.attempts].reverse().find((attempt) => attempt.fingerprint === fingerprint);
        const remaining = cooldownRemainingMs(prior);
        if (remaining > 0) {
          const details: FixerDetails = {
            id,
            status: "suppressed",
            summary: params.summary,
            fingerprint,
            changedPaths: prior?.changedPaths ?? [],
            checks: [],
          };
          return {
            content: [{ type: "text", text: `This same Pi workaround was handled recently (${prior?.status ?? "unknown"}); retry is suppressed for ${humanDuration(remaining)}. Use /workaround-fixer reset only if a new run is genuinely needed.` }],
            details,
          };
        }

        state.attempts.push({
          id,
          fingerprint,
          summary: params.summary.trim(),
          status: "running",
          startedAt: Date.now(),
        });
        await saveState(paths.state, state);

        const definition = await loadFixerAgent(agentDir);
        stage = await createStage(pi, agentDir, signal);
        const report = formatReport(params);
        const docsRoot = codingAgentRoot();
        const child = await runChild(stage, agentDir, docsRoot, definition, report, signal, (message) => {
          onUpdate?.({
            content: [{ type: "text", text: message }],
            details: { id, status: "running", summary: params.summary, fingerprint, changedPaths: [], checks: [] } satisfies FixerDetails,
          });
        });
        usage = child.usage;

        if (child.timedOut || child.aborted || child.exitCode !== 0 || child.stopReason === "error" || child.stopReason === "aborted") {
          const failure = child.timedOut
            ? "Automatic fixer timed out."
            : child.aborted
              ? "Automatic fixer was cancelled."
              : child.errorMessage || child.stderr || `Child Pi exited with code ${child.exitCode}.`;
          throw new Error(failure);
        }

        const staged = await snapshotWorkspace(stage.workspace);
        const changes = diffSnapshots(stage.baseline, staged);
        validateAutomaticChanges(changes, stage.protectedPaths);
        if (changes.length === 0) {
          updateAttempt(state, id, "no-change");
          await saveState(paths.state, state);
          const prefix = stateWarning ? `${stateWarning}\n\n` : "";
          return {
            content: [{ type: "text", text: `${prefix}${child.output || "The automatic fixer found no justified Pi harness change."}` }],
            details: {
              id,
              status: "no-change",
              summary: params.summary,
              fingerprint,
              changedPaths: [],
              checks: [],
              output: child.output,
            } satisfies FixerDetails,
            usage,
          };
        }

        onUpdate?.({
          content: [{ type: "text", text: `Validating ${changes.length} staged harness file${changes.length === 1 ? "" : "s"}…` }],
          details: {
            id,
            status: "running",
            summary: params.summary,
            fingerprint,
            changedPaths: changes.map((change) => change.path),
            checks: [],
          } satisfies FixerDetails,
        });
        const checks = await validateStage(stage, agentDir, docsRoot, signal);
        const validated = await snapshotWorkspace(stage.workspace);
        const validationMutations = diffSnapshots(staged, validated);
        if (validationMutations.length > 0) {
          throw new Error(`Restricted validation changed staged source: ${validationMutations.map((change) => change.path).join(", ")}`);
        }
        await applyWorkspaceChanges(agentDir, stage.baseline, validated, changes);
        const changedPaths = changes.map((change) => change.path);
        updateAttempt(state, id, "completed", { changedPaths });
        await saveState(paths.state, state);
        ctx.ui.notify(`Automatic Pi self-repair applied ${changedPaths.length} checked file change${changedPaths.length === 1 ? "" : "s"}. Run /reload after the current task.`, "info");

        const summary = [
          stateWarning,
          child.output,
          "",
          `Applied to the global Pi harness: ${changedPaths.join(", ")}`,
          `Checks: ${checks.join("; ")}`,
          "Tell the user exactly what changed and ask them to run /reload after the current task.",
        ].filter((value): value is string => Boolean(value)).join("\n");
        return {
          content: [{ type: "text", text: summary }],
          details: {
            id,
            status: "completed",
            summary: params.summary,
            fingerprint,
            changedPaths,
            checks,
            output: child.output,
          } satisfies FixerDetails,
          usage,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (state?.attempts.some((attempt) => attempt.id === id)) {
          updateAttempt(state, id, "failed", { error: message.slice(0, 2_000) });
          await saveState(paths.state, state).catch(() => undefined);
        }
        throw error;
      } finally {
        if (stage) await rm(stage.tempRoot, { recursive: true, force: true }).catch(() => undefined);
        await releaseLock?.();
        activeRunId = undefined;
        updateStatus(ctx);
      }
    },
  });

  pi.registerCommand("workaround-fixer", {
    description: "Control automatic Pi operational-workaround repair: /workaround-fixer status|on|off|reset|unlock",
    getArgumentCompletions: (prefix) => {
      const options = ["status", "on", "off", "reset", "unlock"];
      const matches = options
        .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
        .map((value) => ({ value, label: value }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
      if (action === "on" || action === "off") {
        enabled = action === "on";
        updateStatus(ctx);
        ctx.ui.notify(`Automatic Pi workaround fixing is ${enabled ? "enabled" : "disabled"} for this session.`, "info");
        return;
      }
      if (action === "unlock") {
        if (activeRunId) {
          ctx.ui.notify("Cannot unlock while this session has an active automatic fixer run.", "warning");
          return;
        }
        const result = await unlockStoppedOwner(paths.lock);
        ctx.ui.notify(result === "removed" ? "Removed the stopped automatic fixer owner's lock." : "No automatic fixer lock exists.", "info");
        return;
      }
      if (action === "reset") {
        if (activeRunId) {
          ctx.ui.notify("Cannot reset automatic fixer history while a run is active.", "warning");
          return;
        }
        const release = await acquireLock(paths.lock);
        try {
          await saveState(paths.state, { version: STATE_VERSION, attempts: [] });
        } finally {
          await release();
        }
        ctx.ui.notify("Automatic workaround-fixer cooldown history reset.", "info");
        return;
      }
      if (action !== "status") {
        ctx.ui.notify("Usage: /workaround-fixer [status|on|off|reset|unlock]", "warning");
        return;
      }
      const loaded = await loadState(paths.state);
      const recent = loaded.state.attempts.slice(-5).reverse();
      const lines = [
        `Automatic Pi workaround fixing: ${enabled ? "on" : "off"}${activeRunId ? `; active=${activeRunId}` : ""}`,
        ...recent.map((attempt) => `${attempt.status.padEnd(9)} ${attempt.summary}${attempt.changedPaths?.length ? ` (${attempt.changedPaths.join(", ")})` : ""}`),
      ];
      if (loaded.warning) lines.push(loaded.warning);
      ctx.ui.notify(lines.join("\n"), loaded.warning ? "warning" : "info");
    },
  });

  pi.on("session_start", (_event, ctx) => updateStatus(ctx));
  pi.on("session_shutdown", (_event, ctx) => ctx.ui.setStatus(STATUS_ID, undefined));
}
