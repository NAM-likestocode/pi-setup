import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSize, truncateTail } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runRestrictedCheck } from "./restricted-check.ts";
import {
  canonicalPathForWrite,
  diffSnapshots,
  isProtectedHarnessPath,
  isWithinPath,
  isWritableHarnessPath,
  normalizeRepoPath,
  snapshotWorkspace,
  WORKSPACE_MANIFEST_VERSION,
  type WorkspaceManifest,
} from "./workspace.ts";

const CHECK_ACTIONS = ["changes", "typecheck", "test"] as const;
const MAX_CHECK_OUTPUT_BYTES = 24 * 1024;
const MAX_CHECK_OUTPUT_LINES = 800;

const CheckParams = Type.Object({
  action: StringEnum(CHECK_ACTIONS),
  testFiles: Type.Optional(Type.Array(Type.String({ maxLength: 240 }), { maxItems: 12 })),
});

interface CheckDetails {
  changes?: ReturnType<typeof diffSnapshots>;
  code?: number;
  tests?: string[];
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the automatic workaround-fixer child.`);
  return resolve(value);
}

function pathArgument(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const path = (input as { path?: unknown }).path;
  return typeof path === "string" ? path.replace(/^@(?=[./\\A-Za-z]:?)/, "") : undefined;
}

function resolveToolPath(workspace: string, value: string | undefined): string {
  if (!value) return workspace;
  return isAbsolute(value) || win32.isAbsolute(value) ? resolve(value) : resolve(workspace, value);
}

async function canonicalPathForRead(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return resolve(target);
  }
}

function relativeWorkspacePath(workspace: string, target: string): string | undefined {
  if (!isWithinPath(workspace, target)) return undefined;
  return normalizeRepoPath(relative(workspace, target));
}

function normalizedTestFiles(values: string[] | undefined): string[] {
  if (!values) return [];
  return values.map((value) => {
    const path = normalizeRepoPath(value);
    if (!path || !/^tests\/[A-Za-z0-9_./-]+\.test\.ts$/.test(path)) {
      throw new Error(`Focused tests must be paths under tests/ ending in .test.ts: ${value}`);
    }
    return path;
  });
}

function formatCommandResult(label: string, result: { stdout: string; stderr: string; code: number; killed: boolean }): string {
  const raw = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  const truncation = truncateTail(raw || "(no output)", {
    maxBytes: MAX_CHECK_OUTPUT_BYTES,
    maxLines: MAX_CHECK_OUTPUT_LINES,
  });
  const suffix = truncation.truncated
    ? `\n[Output truncated to ${formatSize(truncation.outputBytes)} and ${truncation.outputLines} lines.]`
    : "";
  return `${label} exited with code ${result.code}${result.killed ? " (killed)" : ""}.\n${truncation.content}${suffix}`;
}

export default function automaticFixerChildGuard(pi: ExtensionAPI): void {
  if (process.env.PI_AUTO_WORKAROUND_FIXER_CHILD !== "1") return;

  const workspace = requiredEnvironment("PI_AUTO_FIXER_WORKSPACE");
  const realAgentDir = requiredEnvironment("PI_AUTO_FIXER_REAL_AGENT_DIR");
  const codingAgentRoot = requiredEnvironment("PI_AUTO_FIXER_CODING_AGENT_ROOT");
  const installedPackageRoots = ["node_modules", "npm", "git"].map((directory) => join(realAgentDir, directory));
  const manifestPath = requiredEnvironment("PI_AUTO_FIXER_MANIFEST");
  let manifestPromise: Promise<WorkspaceManifest> | undefined;

  const loadManifest = async (): Promise<WorkspaceManifest> => {
    manifestPromise ??= readFile(manifestPath, "utf8").then((text) => JSON.parse(text) as WorkspaceManifest);
    const manifest = await manifestPromise;
    if (manifest.version !== WORKSPACE_MANIFEST_VERSION || !manifest.files || !Array.isArray(manifest.protectedPaths)) {
      throw new Error("Automatic fixer workspace manifest is invalid.");
    }
    return manifest;
  };

  pi.on("tool_call", async (event) => {
    if (event.toolName === "bash") {
      return { block: true, reason: "The automatic fixer cannot run arbitrary shell commands. Use harness_check for validation." };
    }

    const filesystemTools = new Set(["read", "grep", "find", "ls", "edit", "write"]);
    if (!filesystemTools.has(event.toolName)) return;

    const target = resolveToolPath(workspace, pathArgument(event.input));
    if (event.toolName === "edit" || event.toolName === "write") {
      const canonical = await canonicalPathForWrite(target);
      if (!isWithinPath(workspace, canonical)) {
        return { block: true, reason: "The automatic fixer may write only inside its staged harness workspace." };
      }
      const path = relativeWorkspacePath(workspace, target);
      const manifest = await loadManifest();
      if (!path || !isWritableHarnessPath(path)) {
        return { block: true, reason: `The automatic fixer may not modify this harness path: ${path ?? target}` };
      }
      if (isProtectedHarnessPath(path, manifest.protectedPaths)) {
        return { block: true, reason: `The automatic fixer may not modify its safety boundary or a pre-existing dirty path: ${path}` };
      }
      return;
    }

    const canonical = await canonicalPathForRead(target);
    const readable = isWithinPath(workspace, canonical)
      || isWithinPath(codingAgentRoot, canonical)
      || installedPackageRoots.some((root) => isWithinPath(root, canonical));
    if (!readable) {
      return { block: true, reason: "The automatic fixer may read only the staged harness and installed Pi/package documentation or source." };
    }
  });

  pi.registerTool({
    name: "harness_check",
    label: "Harness Check",
    description: "Inspect staged changes or run the harness TypeScript and Vitest checks. This is the automatic fixer's only command runner.",
    promptSnippet: "Inspect and validate staged global Pi harness changes",
    promptGuidelines: [
      "Use harness_check changes while implementing an automatic Pi harness fix, then run both harness_check typecheck and harness_check test before finishing.",
    ],
    parameters: CheckParams,
    async execute(_toolCallId, params, signal) {
      const manifest = await loadManifest();
      if (params.action === "changes") {
        const baseline = new Map(Object.entries(manifest.files).map(([path, file]) => [path, { ...file, content: Buffer.alloc(0) }]));
        const current = await snapshotWorkspace(workspace);
        const changes = diffSnapshots(baseline, current);
        return {
          content: [{ type: "text", text: changes.length > 0
            ? changes.map((change) => `${change.kind.padEnd(6)} ${change.path}`).join("\n")
            : "No staged source changes." }],
          details: { changes } as CheckDetails,
        };
      }

      if (params.action === "typecheck") {
        const result = await runRestrictedCheck({
          action: "typecheck",
          workspace,
          agentDir: realAgentDir,
          codingAgentRoot,
          tempRoot: dirname(manifestPath),
          signal,
        });
        const output = formatCommandResult("Typecheck", result);
        if (result.code !== 0) throw new Error(output);
        return { content: [{ type: "text", text: output }], details: { code: result.code } as CheckDetails };
      }

      const tests = normalizedTestFiles(params.testFiles);
      const result = await runRestrictedCheck({
        action: "test",
        workspace,
        agentDir: realAgentDir,
        codingAgentRoot,
        tempRoot: dirname(manifestPath),
        testFiles: tests,
        signal,
      });
      const output = formatCommandResult(tests.length > 0 ? `Focused tests (${tests.join(", ")})` : "Tests", result);
      if (result.code !== 0) throw new Error(output);
      return { content: [{ type: "text", text: output }], details: { code: result.code, tests } as CheckDetails };
    },
  });
}
