import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { homedir } from "node:os";
import { lstat, rm } from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";

const PURGE_PARAMS = Type.Object({
  path: Type.String({ minLength: 1, description: "File or directory to permanently remove" }),
  confirm: Type.Boolean({ description: "Must be true: permanent deletion has been explicitly authorized" }),
  recursive: Type.Optional(Type.Boolean({ description: "Required when path is a directory" })),
});

export function resolvePurgePath(rawPath: string, cwd: string, home = homedir()): string {
  let value = rawPath.trim();
  if (value.startsWith("@")) value = value.slice(1);
  if (value === "~") return resolve(home);
  if (value.startsWith("~/") || value.startsWith("~\\")) value = join(home, value.slice(2));
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

export function assertSafePurgeTarget(target: string, home = homedir(), agentDir = process.env.PI_CODING_AGENT_DIR): void {
  const absoluteTarget = resolve(target);
  const root = parse(absoluteTarget).root;
  if (absoluteTarget === root) throw new Error("Refusing to purge a filesystem root.");
  if (absoluteTarget === resolve(home)) throw new Error("Refusing to purge the home directory.");
  if (agentDir && absoluteTarget === resolve(agentDir)) throw new Error("Refusing to purge the Pi agent directory.");
}

export default function purge(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "purge",
    label: "Purge Path",
    description: "Permanently delete one explicitly named file or directory. Requires confirm:true; never starts background cleanup or writes a temporary script.",
    promptSnippet: "Permanently remove an explicitly approved file or directory",
    promptGuidelines: [
      "Use purge for permanent cleanup only after the user explicitly authorizes deleting the exact path.",
      "Set confirm:true only when that authorization is present; do not use bash or temporary scripts for cleanup.",
      "If purge reports a locked path, tell the user which process must be stopped and call purge again after it is released.",
    ],
    parameters: PURGE_PARAMS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!params.confirm) throw new Error("Purge requires confirm:true after explicit user authorization.");
      if (signal?.aborted) return { content: [{ type: "text", text: "Purge cancelled." }], details: { cancelled: true } };

      const target = resolvePurgePath(params.path, ctx.cwd);
      assertSafePurgeTarget(target);

      let kind: "file" | "directory";
      try {
        kind = (await lstat(target)).isDirectory() ? "directory" : "file";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { content: [{ type: "text", text: `Nothing to purge: ${target}` }], details: { path: target, existed: false } };
        }
        throw error;
      }

      if (kind === "directory" && params.recursive !== true) {
        throw new Error(`Refusing to purge directory without recursive:true: ${target}`);
      }

      try {
        await rm(target, { force: true, recursive: params.recursive === true, maxRetries: 2, retryDelay: 250 });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not purge ${target}. No background retry was started. ${reason}`);
      }

      return {
        content: [{ type: "text", text: `Purged ${kind}: ${target}` }],
        details: { path: target, existed: true, kind },
      };
    },
  });
}
