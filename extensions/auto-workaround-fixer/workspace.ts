import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export const WORKSPACE_MANIFEST_VERSION = 1;
export const MAX_AUTOMATIC_CHANGE_FILES = 24;
export const MAX_AUTOMATIC_CHANGE_BYTES = 2 * 1024 * 1024;

const WRITABLE_DIRECTORIES = new Set([
  "agents",
  "docs",
  "extensions",
  "patches",
  "scripts",
  "skills",
  "tests",
  "themes",
]);

const WRITABLE_ROOT_FILES = new Set([
  ".gitignore",
  "APPEND_SYSTEM.md",
  "HARNESS.md",
  "README.md",
  "RECOVER.md",
  "keybindings.json",
  "package-lock.json",
  "package.json",
  "pi-lsp.json",
  "settings.json",
  "tsconfig.json",
  "vitest.config.ts",
]);

const SELF_PROTECTED_PATHS = new Set([
  "APPEND_SYSTEM.md",
  "agents/workaround-fixer.md",
  "vitest.config.ts",
]);

const SELF_PROTECTED_PREFIXES = ["extensions/auto-workaround-fixer/"];

const WALK_SKIP_DIRECTORIES = new Set([".git", "git", "node_modules", "npm", "state"]);

export interface ManifestFile {
  sha256: string;
  size: number;
  mode: number;
}

export interface WorkspaceManifest {
  version: typeof WORKSPACE_MANIFEST_VERSION;
  files: Record<string, ManifestFile>;
  protectedPaths: string[];
}

export interface FileSnapshot extends ManifestFile {
  content: Buffer;
}

export type SnapshotMap = Map<string, FileSnapshot>;

export interface WorkspaceChange {
  path: string;
  kind: "create" | "modify" | "delete";
  size: number;
}

export interface WorkaroundFingerprintInput {
  summary: string;
  missingCapability: string;
  workaround: string;
}

export interface AttemptForCooldown {
  status: "running" | "completed" | "no-change" | "failed";
  finishedAt?: number;
  startedAt: number;
}

export function normalizeRepoPath(value: string): string | undefined {
  if (!value || value.includes("\0") || isAbsolute(value) || win32.isAbsolute(value)) return undefined;
  const normalized = posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    return undefined;
  }
  return normalized;
}

function isSelfProtectedPath(path: string): boolean {
  return SELF_PROTECTED_PATHS.has(path) || SELF_PROTECTED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function isWritableHarnessPath(value: string): boolean {
  const normalized = normalizeRepoPath(value);
  if (!normalized || isSelfProtectedPath(normalized)) return false;
  if (!normalized.includes("/")) return WRITABLE_ROOT_FILES.has(normalized);
  const [topLevel] = normalized.split("/");
  return WRITABLE_DIRECTORIES.has(topLevel);
}

export function isProtectedHarnessPath(value: string, protectedPaths: Iterable<string>): boolean {
  const normalized = normalizeRepoPath(value);
  if (!normalized || isSelfProtectedPath(normalized)) return true;
  for (const candidate of protectedPaths) {
    const protectedPath = normalizeRepoPath(candidate);
    if (!protectedPath) continue;
    if (normalized === protectedPath || normalized.startsWith(`${protectedPath}/`)) return true;
  }
  return false;
}

export function isWithinPath(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate));
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

export async function canonicalPathForWrite(target: string): Promise<string> {
  let current = resolve(target);
  while (true) {
    try {
      const canonicalParent = await realpath(current);
      return resolve(canonicalParent, relative(current, resolve(target)));
    } catch {
      const parent = dirname(current);
      if (parent === current) throw new Error(`No existing parent for ${target}`);
      current = parent;
    }
  }
}

export function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function fingerprintWorkaround(input: WorkaroundFingerprintInput): string {
  const canonical = [input.summary, input.missingCapability, input.workaround]
    .map((value) => value.toLowerCase().replace(/\s+/g, " ").trim())
    .join("\n");
  return sha256(canonical).slice(0, 20);
}

export function cooldownRemainingMs(attempt: AttemptForCooldown | undefined, now = Date.now()): number {
  if (!attempt) return 0;
  const anchor = attempt.finishedAt ?? attempt.startedAt;
  const cooldown = attempt.status === "completed"
    ? 7 * 24 * 60 * 60 * 1000
    : attempt.status === "no-change"
      ? 24 * 60 * 60 * 1000
      : attempt.status === "failed"
        ? 30 * 60 * 1000
        : 30 * 60 * 1000;
  return Math.max(0, anchor + cooldown - now);
}

export function manifestFromSnapshots(files: SnapshotMap, protectedPaths: Iterable<string>): WorkspaceManifest {
  return {
    version: WORKSPACE_MANIFEST_VERSION,
    files: Object.fromEntries([...files].map(([path, file]) => [path, {
      sha256: file.sha256,
      size: file.size,
      mode: file.mode,
    }])),
    protectedPaths: [...new Set([...protectedPaths].map((path) => normalizeRepoPath(path)).filter((path): path is string => Boolean(path)))].sort(),
  };
}

export async function snapshotListedFiles(root: string, paths: Iterable<string>): Promise<SnapshotMap> {
  const snapshots: SnapshotMap = new Map();
  for (const rawPath of paths) {
    const path = normalizeRepoPath(rawPath);
    if (!path || snapshots.has(path)) continue;
    const absolutePath = join(root, ...path.split("/"));
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (metadata.isSymbolicLink()) throw new Error(`Automatic fixer does not stage symbolic links: ${path}`);
    if (!metadata.isFile()) continue;
    const content = await readFile(absolutePath);
    snapshots.set(path, {
      content,
      sha256: sha256(content),
      size: content.byteLength,
      mode: metadata.mode,
    });
  }
  return snapshots;
}

async function walkFiles(root: string, current: string, snapshots: SnapshotMap): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.isDirectory() && WALK_SKIP_DIRECTORIES.has(entry.name)) continue;
    const absolutePath = join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await walkFiles(root, absolutePath, snapshots);
      continue;
    }
    if (!entry.isFile()) continue;
    const path = normalizeRepoPath(relative(root, absolutePath));
    if (!path) continue;
    const [content, metadata] = await Promise.all([readFile(absolutePath), stat(absolutePath)]);
    snapshots.set(path, {
      content,
      sha256: sha256(content),
      size: content.byteLength,
      mode: metadata.mode,
    });
  }
}

export async function snapshotWorkspace(root: string): Promise<SnapshotMap> {
  const snapshots: SnapshotMap = new Map();
  await walkFiles(root, root, snapshots);
  return snapshots;
}

export function diffSnapshots(before: SnapshotMap, after: SnapshotMap): WorkspaceChange[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  const changes: WorkspaceChange[] = [];
  for (const path of [...paths].sort()) {
    const prior = before.get(path);
    const next = after.get(path);
    if (!prior && next) changes.push({ path, kind: "create", size: next.size });
    else if (prior && !next) changes.push({ path, kind: "delete", size: 0 });
    else if (prior && next && (prior.sha256 !== next.sha256 || prior.mode !== next.mode)) {
      changes.push({ path, kind: "modify", size: next.size });
    }
  }
  return changes;
}

export function validateAutomaticChanges(changes: WorkspaceChange[], protectedPaths: Iterable<string>): void {
  if (changes.length > MAX_AUTOMATIC_CHANGE_FILES) {
    throw new Error(`Automatic fix changed ${changes.length} files; limit is ${MAX_AUTOMATIC_CHANGE_FILES}.`);
  }
  const totalBytes = changes.reduce((total, change) => total + change.size, 0);
  if (totalBytes > MAX_AUTOMATIC_CHANGE_BYTES) {
    throw new Error(`Automatic fix changed ${totalBytes} bytes; limit is ${MAX_AUTOMATIC_CHANGE_BYTES}.`);
  }
  for (const change of changes) {
    if (change.kind === "delete") throw new Error(`Automatic fixes may not delete files: ${change.path}`);
    if (!isWritableHarnessPath(change.path)) throw new Error(`Automatic fix attempted an out-of-scope path: ${change.path}`);
    if (isProtectedHarnessPath(change.path, protectedPaths)) {
      throw new Error(`Automatic fix attempted a protected or pre-existing dirty path: ${change.path}`);
    }
  }
}

async function currentFile(root: string, path: string): Promise<FileSnapshot | undefined> {
  const snapshots = await snapshotListedFiles(root, [path]);
  return snapshots.get(path);
}

async function writeAtomically(path: string, content: Buffer, mode: number): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporaryPath, content, { flag: "wx", mode });
    await rename(temporaryPath, path);
    await chmod(path, mode);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function applyWorkspaceChanges(
  targetRoot: string,
  baseline: SnapshotMap,
  staged: SnapshotMap,
  changes: WorkspaceChange[],
): Promise<void> {
  for (const change of changes) {
    const expected = baseline.get(change.path);
    const current = await currentFile(targetRoot, change.path);
    if (!expected && current) throw new Error(`Target appeared while the fix was staged: ${change.path}`);
    if (expected && (!current || current.sha256 !== expected.sha256 || current.mode !== expected.mode)) {
      throw new Error(`Target changed while the fix was staged: ${change.path}`);
    }
  }

  const applied: WorkspaceChange[] = [];
  try {
    for (const change of changes) {
      const target = join(targetRoot, ...change.path.split("/"));
      const next = staged.get(change.path);
      if (!next) throw new Error(`Staged content is missing: ${change.path}`);
      await withFileMutationQueue(target, async () => {
        const expected = baseline.get(change.path);
        const current = await currentFile(targetRoot, change.path);
        if (!expected && current) throw new Error(`Target appeared before apply: ${change.path}`);
        if (expected && (!current || current.sha256 !== expected.sha256 || current.mode !== expected.mode)) {
          throw new Error(`Target changed before apply: ${change.path}`);
        }
        await writeAtomically(target, next.content, next.mode);
      });
      applied.push(change);
    }
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const change of [...applied].reverse()) {
      const target = join(targetRoot, ...change.path.split("/"));
      try {
        await withFileMutationQueue(target, async () => {
          const prior = baseline.get(change.path);
          const appliedVersion = staged.get(change.path);
          const current = await currentFile(targetRoot, change.path);
          if (!appliedVersion || !current || current.sha256 !== appliedVersion.sha256 || current.mode !== appliedVersion.mode) {
            throw new Error(`Target changed before rollback: ${change.path}`);
          }
          if (prior) await writeAtomically(target, prior.content, prior.mode);
          else await rm(target, { force: true });
        });
      } catch {
        rollbackFailures.push(change.path);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} Rollback also failed for: ${rollbackFailures.join(", ")}`);
    }
    throw error;
  }
}
