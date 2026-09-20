/** Spawns one headless Pi child for a council member and collects its answer. */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "./members.ts";

export const WEB_TOOLS = ["web_search", "source_check", "fetch_content", "get_search_content"] as const;
const MAX_OUTPUT_BYTES = 24 * 1024;
const MAX_STDERR_CHARS = 4_000;

export interface ChildRunOptions {
  cwd: string;
  model: string;
  thinking: ThinkingLevel;
  systemPrompt: string;
  task: string;
  /** Extra extensions the child must load, e.g. provider auth or web access. */
  extensionPaths?: string[];
  /** Tool allowlist. Omit to run the child with no tools at all. */
  tools?: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  onToolActivity?: (label: string) => void;
}

export interface ChildRunResult {
  ok: boolean;
  output: string;
  failure?: string;
  usage: Usage;
  searches: number;
  durationMs: number;
}

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function addUsage(total: Usage, value: unknown): void {
  if (!value || typeof value !== "object") return;
  const usage = value as Partial<Usage>;
  total.input += usage.input ?? 0;
  total.output += usage.output ?? 0;
  total.cacheRead += usage.cacheRead ?? 0;
  total.cacheWrite += usage.cacheWrite ?? 0;
  total.totalTokens += usage.totalTokens ?? 0;
  const cost = usage.cost;
  if (!cost) return;
  total.cost.input += cost.input ?? 0;
  total.cost.output += cost.output ?? 0;
  total.cost.cacheRead += cost.cacheRead ?? 0;
  total.cost.cacheWrite += cost.cacheWrite ?? 0;
  total.cost.total += cost.total ?? 0;
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) end--;
  return `${text.slice(0, end)}\n\n[council answer truncated]`;
}

/** Entry-point filenames the Pi CLI is actually published under. */
const PI_ENTRY_NAME = /^pi(?:\.[cm]?js)?$/i;

/**
 * True only when `scriptPath` is the Pi CLI itself.
 *
 * `process.argv[1]` is whatever script the runtime was started with, which is the
 * Pi entry point only when this module runs inside Pi. When another script imports
 * this module directly, argv[1] is *that* script, and relaunching it would spawn a
 * copy of the caller, which spawns another, until the machine dies. Note that the
 * PI_CODING_AGENT env var cannot be used for this test: scripts started from Pi's
 * own bash tool inherit it.
 */
function looksLikePiEntry(scriptPath: string): boolean {
  if (PI_ENTRY_NAME.test(basename(scriptPath))) return true;
  return /\/(?:@[^/]+\/)?pi-coding-agent\//.test(scriptPath.replace(/\\/g, "/"));
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const bunVirtual = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !bunVirtual && looksLikePiEntry(currentScript) && existsSync(currentScript)) {
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

export async function runCouncilChild(options: ChildRunOptions): Promise<ChildRunResult> {
  const startedAt = Date.now();

  // A council member must never convene its own council. The command entry point
  // refuses to register inside a member, but that check is bypassed when this
  // module is imported directly, so the spawn path needs its own guard.
  if (process.env.PI_COUNCIL_MEMBER === "1") {
    return {
      ok: false,
      output: "",
      failure: "refusing to spawn a nested council child (PI_COUNCIL_MEMBER=1)",
      usage: emptyUsage(),
      searches: 0,
      durationMs: 0,
    };
  }

  const promptDir = await mkdtemp(join(tmpdir(), "pi-council-"));
  const promptFile = join(promptDir, "member-prompt.md");
  await writeFile(promptFile, options.systemPrompt, { encoding: "utf8", mode: 0o600 });

  const args = [
    "--mode", "json",
    "--print",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--append-system-prompt", promptFile,
    "--model", options.model,
    "--thinking", options.thinking,
  ];
  for (const extensionPath of options.extensionPaths ?? []) args.push("--extension", extensionPath);
  if (options.tools && options.tools.length > 0) args.push("--tools", options.tools.join(","));
  else args.push("--no-tools");
  args.push(options.task);

  const usage = emptyUsage();
  let output = "";
  let stderr = "";
  let searches = 0;
  let failure: string | undefined;
  let timedOut = false;
  let aborted = false;

  try {
    const exitCode = await new Promise<number>((resolveExit) => {
      const invocation = getPiInvocation(args);
      const child = spawn(invocation.command, invocation.args, {
        cwd: options.cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PI_COUNCIL_MEMBER: "1", PI_PROJECT_SUBAGENT: "1" },
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
          if (event.toolName === "web_search") searches++;
          const args = event.args as { query?: unknown; url?: unknown } | undefined;
          const detail = typeof args?.query === "string"
            ? args.query
            : typeof args?.url === "string"
              ? args.url
              : "";
          options.onToolActivity?.(detail ? `${event.toolName}: ${detail}` : event.toolName);
          return;
        }
        if (event.type === "message_end" && event.message && typeof event.message === "object") {
          const message = event.message as { role?: string; errorMessage?: string; usage?: unknown };
          if (message.role !== "assistant") return;
          const text = messageText(message);
          if (text) output = text;
          addUsage(usage, message.usage);
          if (message.errorMessage) failure = message.errorMessage;
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-MAX_STDERR_CHARS);
      });
      child.once("error", (error) => {
        stderr = `${stderr}\n${error.message}`.trim().slice(-MAX_STDERR_CHARS);
      });

      const timer = setTimeout(() => {
        if (closed) return;
        timedOut = true;
        stopProcessTree(child);
      }, options.timeoutMs);
      timer.unref?.();

      const abort = (): void => {
        if (closed) return;
        aborted = true;
        stopProcessTree(child);
      };
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });

      child.once("close", (code) => {
        closed = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (buffer.trim()) processLine(buffer);
        resolveExit(code ?? 1);
      });
    });

    if (timedOut) failure = `timed out after ${Math.round(options.timeoutMs / 1000)}s`;
    else if (aborted) failure = "cancelled";
    else if (exitCode !== 0 && !failure) failure = stderr.trim() || `exited with code ${exitCode}`;
    else if (!output.trim() && !failure) failure = "returned no answer";

    return {
      ok: !failure,
      output: truncateBytes(output.trim(), MAX_OUTPUT_BYTES),
      failure,
      usage,
      searches,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await rm(promptDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
