import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_CAPTURE_CHARS = 100_000;
const TYPECHECK_TIMEOUT_MS = 3 * 60 * 1000;
const TEST_TIMEOUT_MS = 10 * 60 * 1000;
const PROCESS_REQUIRED_TESTS = ["tests/pi-voice-stt-windows-patch.test.ts"];

export type RestrictedCheckAction = "typecheck" | "test";

export interface RestrictedCheckOptions {
  action: RestrictedCheckAction;
  workspace: string;
  agentDir: string;
  codingAgentRoot: string;
  tempRoot: string;
  testFiles?: string[];
  signal?: AbortSignal;
}

export interface RestrictedCheckResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

function tail(value: string): string {
  return value.length <= MAX_CAPTURE_CHARS ? value : `… [earlier output omitted]\n${value.slice(-MAX_CAPTURE_CHARS)}`;
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

function readablePaths(options: RestrictedCheckOptions, checkTemp: string): string[] {
  return [
    options.workspace,
    options.tempRoot,
    checkTemp,
    options.codingAgentRoot,
    join(options.agentDir, "node_modules"),
    join(options.agentDir, "npm"),
    join(options.agentDir, "git"),
    join(options.agentDir, "patches"),
  ].filter((path) => existsSync(path));
}

function workerPermissionArguments(options: RestrictedCheckOptions, checkTemp: string): string[] {
  return [
    "--permission",
    ...readablePaths(options, checkTemp).map((path) => `--allow-fs-read=${path}`),
    `--allow-fs-write=${checkTemp}`,
  ];
}

function parentPermissionArguments(
  options: RestrictedCheckOptions,
  workerPermissions: string[],
): string[] {
  if (options.action === "typecheck") return workerPermissions;
  return [
    ...workerPermissions,
    "--allow-addons",
    "--allow-child-process",
    "--allow-worker",
  ];
}

function sanitizedEnvironment(
  options: RestrictedCheckOptions,
  checkTemp: string,
  workerPermissions: string[],
): NodeJS.ProcessEnv {
  const keep = ["COMSPEC", "LOCALAPPDATA", "NUMBER_OF_PROCESSORS", "OS", "PATH", "PATHEXT", "SystemDrive", "SystemRoot", "WINDIR"];
  const env: NodeJS.ProcessEnv = {};
  for (const name of keep) if (process.env[name] !== undefined) env[name] = process.env[name];
  return {
    ...env,
    APPDATA: checkTemp,
    CI: "1",
    HOME: checkTemp,
    NO_COLOR: "1",
    NODE_ENV: "test",
    NODE_OPTIONS: workerPermissions.join(" "),
    PI_HARNESS_TEST_ROOT: options.workspace,
    PI_RESTRICTED_HARNESS_CHECK: "1",
    TEMP: checkTemp,
    TMP: checkTemp,
    TMPDIR: checkTemp,
    USERPROFILE: checkTemp,
  };
}

async function writeTrustedVitestConfig(options: RestrictedCheckOptions, checkTemp: string): Promise<string> {
  const configPath = join(checkTemp, "vitest.restricted.config.mjs");
  const aliases = {
    "@earendil-works/pi-coding-agent": join(options.codingAgentRoot, "dist", "index.js"),
    "@earendil-works/pi-agent-core": join(options.codingAgentRoot, "node_modules", "@earendil-works", "pi-agent-core", "dist", "index.js"),
    "@earendil-works/pi-ai": join(options.codingAgentRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js"),
    "@earendil-works/pi-tui": join(options.codingAgentRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
    typebox: join(options.codingAgentRoot, "node_modules", "typebox", "build", "index.mjs"),
  };
  const config = {
    root: options.workspace,
    resolve: { alias: aliases, preserveSymlinks: true },
    test: {
      include: ["tests/**/*.test.ts"],
      exclude: ["node_modules/**", "npm/**", "git/**", "sessions/**", ...PROCESS_REQUIRED_TESTS],
      testTimeout: 10_000,
      pool: "threads",
      maxWorkers: 1,
      fileParallelism: false,
      cache: false,
    },
  };
  await writeFile(configPath, `export default ${JSON.stringify(config, null, 2)};\n`, { flag: "wx" });
  return configPath;
}

async function commandArguments(
  options: RestrictedCheckOptions,
  checkTemp: string,
  workerPermissions: string[],
): Promise<string[]> {
  if (options.action === "typecheck") {
    return [
      join(options.agentDir, "node_modules", "typescript", "bin", "tsc"),
      "--noEmit",
      "-p",
      join(options.workspace, "tsconfig.json"),
    ];
  }

  const configPath = await writeTrustedVitestConfig(options, checkTemp);
  return [
    join(options.agentDir, "node_modules", "vitest", "vitest.mjs"),
    "run",
    "--config",
    configPath,
    "--configLoader=runner",
    "--pool=threads",
    "--maxWorkers=1",
    "--no-fileParallelism",
    "--no-cache",
    ...workerPermissions.map((argument) => `--execArgv=${argument}`),
    ...(options.testFiles ?? []),
  ];
}

export async function runRestrictedCheck(options: RestrictedCheckOptions): Promise<RestrictedCheckResult> {
  const checkTemp = join(options.tempRoot, `check-${options.action}-${randomUUID()}`);
  await mkdir(checkTemp, { recursive: true });
  await writeFile(join(options.tempRoot, "pnpm-workspace.yaml"), "packages: []\n", { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const timeoutMs = options.action === "typecheck" ? TYPECHECK_TIMEOUT_MS : TEST_TIMEOUT_MS;

  try {
    const workerPermissions = workerPermissionArguments(options, checkTemp);
    const parentPermissions = parentPermissionArguments(options, workerPermissions);
    const command = await commandArguments(options, checkTemp, workerPermissions);
    return await new Promise<RestrictedCheckResult>((resolveResult) => {
      const child = spawn(process.execPath, [...parentPermissions, ...command], {
        cwd: options.workspace,
        env: sanitizedEnvironment(options, checkTemp, workerPermissions),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let killed = false;
      let closed = false;
      const timeout = setTimeout(() => {
        if (closed) return;
        killed = true;
        stopProcessTree(child);
      }, timeoutMs);
      timeout.unref();

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = tail(stdout + chunk.toString("utf8"));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = tail(stderr + chunk.toString("utf8"));
      });
      child.once("error", (error) => {
        stderr = tail(`${stderr}\n${error.message}`.trim());
      });
      child.once("close", (code) => {
        closed = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        resolveResult({ stdout, stderr, code: code ?? 1, killed });
      });

      const abort = () => {
        if (closed) return;
        killed = true;
        stopProcessTree(child);
      };
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
    });
  } finally {
    await rm(checkTemp, { recursive: true, force: true }).catch(() => undefined);
  }
}
