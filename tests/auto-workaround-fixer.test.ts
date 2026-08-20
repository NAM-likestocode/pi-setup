import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRestrictedCheck } from "../extensions/auto-workaround-fixer/restricted-check.ts";
import {
  applyWorkspaceChanges,
  cooldownRemainingMs,
  diffSnapshots,
  type FileSnapshot,
  fingerprintWorkaround,
  isProtectedHarnessPath,
  isWritableHarnessPath,
  type SnapshotMap,
  sha256,
  snapshotListedFiles,
  validateAutomaticChanges,
} from "../extensions/auto-workaround-fixer/workspace.ts";

const temporaryDirectories: string[] = [];

async function tempDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-auto-fixer-test-"));
  temporaryDirectories.push(path);
  return path;
}

function file(content: string, mode = 0o100644): FileSnapshot {
  const buffer = Buffer.from(content);
  return { content: buffer, sha256: sha256(buffer), size: buffer.byteLength, mode };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("automatic workaround-fixer scope", () => {
  it("allows durable harness artifacts but blocks project, runtime, and safety-boundary writes", () => {
    expect(isWritableHarnessPath("extensions/powershell/index.ts")).toBe(true);
    expect(isWritableHarnessPath("skills/powershell/SKILL.md")).toBe(true);
    expect(isWritableHarnessPath("tests/powershell.test.ts")).toBe(true);
    expect(isWritableHarnessPath("settings.json")).toBe(true);

    expect(isWritableHarnessPath("source/user-project/file.ts")).toBe(false);
    expect(isWritableHarnessPath("node_modules/package/index.js")).toBe(false);
    expect(isWritableHarnessPath("auth.json")).toBe(false);
    expect(isWritableHarnessPath("../outside.ts")).toBe(false);
    expect(isWritableHarnessPath("extensions/auto-workaround-fixer/child-guard.ts")).toBe(false);
    expect(isWritableHarnessPath("extensions/auto-workaround-fixer/index.ts")).toBe(false);
    expect(isWritableHarnessPath("extensions/auto-workaround-fixer/new-policy.ts")).toBe(false);
    expect(isWritableHarnessPath("agents/workaround-fixer.md")).toBe(false);
    expect(isWritableHarnessPath("APPEND_SYSTEM.md")).toBe(false);
    expect(isWritableHarnessPath("vitest.config.ts")).toBe(false);
  });

  it("protects pre-existing dirty files and their descendants", () => {
    expect(isProtectedHarnessPath("extensions/existing.ts", ["extensions/existing.ts"])).toBe(true);
    expect(isProtectedHarnessPath("skills/dirty/new.md", ["skills/dirty"])).toBe(true);
    expect(isProtectedHarnessPath("extensions/new.ts", ["extensions/existing.ts"])).toBe(false);
  });

  it("fingerprints equivalent reports and cools down prior automatic runs", () => {
    const first = fingerprintWorkaround({
      summary: "  Repeated shell detour ",
      missingCapability: "PowerShell interaction",
      workaround: "Create a script, then launch it",
    });
    const second = fingerprintWorkaround({
      summary: "repeated   SHELL detour",
      missingCapability: "powershell interaction",
      workaround: "create a script, then launch it",
    });
    expect(first).toBe(second);

    const now = Date.now();
    expect(cooldownRemainingMs({ status: "completed", startedAt: now - 1_000, finishedAt: now }, now)).toBe(7 * 24 * 60 * 60 * 1000);
    expect(cooldownRemainingMs({ status: "failed", startedAt: now - 31 * 60 * 1000, finishedAt: now - 31 * 60 * 1000 }, now)).toBe(0);
  });

  it("rejects deletion, dirty-path changes, and changes outside the harness allowlist", () => {
    expect(() => validateAutomaticChanges([{ path: "extensions/new.ts", kind: "create", size: 10 }], [])).not.toThrow();
    expect(() => validateAutomaticChanges([{ path: "extensions/dirty.ts", kind: "modify", size: 10 }], ["extensions/dirty.ts"])).toThrow(/protected/);
    expect(() => validateAutomaticChanges([{ path: "project/file.ts", kind: "create", size: 10 }], [])).toThrow(/out-of-scope/);
    expect(() => validateAutomaticChanges([{ path: "extensions/old.ts", kind: "delete", size: 0 }], [])).toThrow(/may not delete/);
  });
});

describe.skipIf(process.env.PI_RESTRICTED_HARNESS_CHECK === "1")("automatic workaround-fixer restricted validation", () => {
  it("runs TypeScript with staged source read-only", async () => {
    const root = await tempDirectory();
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "sample.ts"), 'const value: string = "checked";\n');
    await writeFile(join(workspace, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true }, files: ["sample.ts"] }));

    const result = await runRestrictedCheck({
      action: "typecheck",
      workspace,
      agentDir: "C:/Users/Fool/.pi/agent",
      codingAgentRoot: "C:/Users/Fool/AppData/Local/pi-node/current/node_modules/@earendil-works/pi-coding-agent",
      tempRoot: root,
    });

    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it("denies generated tests external writes and child processes", async () => {
    const root = await tempDirectory();
    const workspace = join(root, "workspace");
    const outside = join(root, "outside.txt");
    await mkdir(join(workspace, "tests"), { recursive: true });
    await writeFile(join(workspace, "package.json"), "{\"type\":\"module\"}\n");
    await writeFile(join(workspace, "tsconfig.json"), "{}\n");
    await writeFile(join(workspace, "vitest.config.ts"), "export default { resolve: { preserveSymlinks: true }, test: { globals: true } };\n");
    await writeFile(join(workspace, "tests", "restricted.test.ts"), [
      'import { spawnSync } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'import { tmpdir } from "node:os";',
      'import { join } from "node:path";',
      'import { Worker } from "node:worker_threads";',
      'import { expect, test } from "vitest";',
      `const outside = ${JSON.stringify(outside)};`,
      'test("native Node permissions hold", () => {',
      '  expect(() => writeFileSync(outside, "blocked")).toThrow(/permission|access/i);',
      '  expect(() => spawnSync(process.execPath, ["-e", ""])).toThrow(/permission|access/i);',
      '  expect(() => new Worker("", { eval: true })).toThrow(/permission|access/i);',
      '  writeFileSync(join(tmpdir(), "allowed.txt"), "ok");',
      '});',
      '',
    ].join("\n"));

    const result = await runRestrictedCheck({
      action: "test",
      workspace,
      agentDir: "C:/Users/Fool/.pi/agent",
      codingAgentRoot: "C:/Users/Fool/AppData/Local/pi-node/current/node_modules/@earendil-works/pi-coding-agent",
      tempRoot: root,
      testFiles: ["tests/restricted.test.ts"],
    });

    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    await expect(readFile(outside, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("automatic workaround-fixer staged apply", () => {
  it("applies only the validated staged create and modify set", async () => {
    const root = await tempDirectory();
    await mkdir(join(root, "extensions"), { recursive: true });
    await writeFile(join(root, "extensions", "existing.ts"), "before\n");

    const baseline = await snapshotListedFiles(root, ["extensions/existing.ts"]);
    const staged: SnapshotMap = new Map<string, FileSnapshot>([
      ["extensions/existing.ts", file("after\n")],
      ["skills/shell/SKILL.md", file("---\nname: shell\ndescription: shell\n---\n")],
    ]);
    const changes = diffSnapshots(baseline, staged);
    validateAutomaticChanges(changes, []);
    await applyWorkspaceChanges(root, baseline, staged, changes);

    expect(await readFile(join(root, "extensions", "existing.ts"), "utf8")).toBe("after\n");
    expect(await readFile(join(root, "skills", "shell", "SKILL.md"), "utf8")).toContain("name: shell");
  });

  it("refuses to overwrite a target changed after staging", async () => {
    const root = await tempDirectory();
    await mkdir(join(root, "extensions"), { recursive: true });
    await writeFile(join(root, "extensions", "existing.ts"), "before\n");
    const baseline = await snapshotListedFiles(root, ["extensions/existing.ts"]);
    const staged: SnapshotMap = new Map([["extensions/existing.ts", file("automatic\n")]]);
    const changes = diffSnapshots(baseline, staged);

    await writeFile(join(root, "extensions", "existing.ts"), "external edit\n");
    await expect(applyWorkspaceChanges(root, baseline, staged, changes)).rejects.toThrow(/changed while the fix was staged/);
    expect(await readFile(join(root, "extensions", "existing.ts"), "utf8")).toBe("external edit\n");
  });
});
