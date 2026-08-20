import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_DIR = process.env.PI_VOICE_STT_PACKAGE
  || join(HARNESS_DIR, "npm", "node_modules", "pi-voice-stt");
const EXPECTED_VERSION = "0.6.0";
const PATCH_MARKER = "PI_HARNESS_FFMPEG_GRACEFUL_STOP_V1";
const SOURCE_PATH = join(PACKAGE_DIR, "src", "audio", "ffmpeg-recorder.ts");
const BACKUP_PATH = join(
  HARNESS_DIR,
  "patches",
  `pi-voice-stt-${EXPECTED_VERSION}`,
  "original",
  "ffmpeg-recorder.ts",
);

function replaceOnce(source, oldText, newText, label) {
  const first = source.indexOf(oldText);
  if (first < 0) throw new Error(`Patch anchor not found: ${label}`);
  if (source.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error(`Patch anchor is not unique: ${label}`);
  }
  return source.slice(0, first) + newText + source.slice(first + oldText.length);
}

export function patchFfmpegRecorder(source) {
  if (source.includes(PATCH_MARKER)) return source;

  source = replaceOnce(
    source,
    "const MAX_STDERR_BYTES = 24 * 1024;\n",
    `const MAX_STDERR_BYTES = 24 * 1024;\nconst ${PATCH_MARKER} = true;\n`,
    "patch marker",
  );

  source = replaceOnce(
    source,
    '      "-nostdin",\n',
    "",
    "enable FFmpeg control input",
  );

  source = replaceOnce(
    source,
    '      stdio: ["ignore", "ignore", "pipe"],\n',
    '      stdio: ["pipe", "ignore", "pipe"],\n',
    "pipe FFmpeg stdin",
  );

  source = replaceOnce(
    source,
    `    const getStderr = collectStderr(process.stderr);\n    const exited = waitForExit(process);\n`,
    `    const getStderr = collectStderr(process.stderr);\n    let controlError = "";\n    process.stdin?.on("error", (error) => {\n      controlError = \`ffmpeg control input error: \${formatError(error)}\`;\n    });\n    const getDiagnostics = () => [getStderr(), controlError].filter(Boolean).join(" ");\n    const exited = waitForExit(process);\n`,
    "capture FFmpeg control errors",
  );

  source = replaceOnce(
    source,
    `    const terminate = () => {\n      if (process.exitCode !== null) return;\n      try { process.kill("SIGINT"); } catch { /* already dead */ }\n    };\n\n    const forceKill = () => {\n      if (process.exitCode !== null) return;\n      try { process.kill("SIGKILL"); } catch { /* already dead */ }\n    };\n`,
    `    const terminate = () => {\n      if (process.exitCode !== null || process.signalCode !== null) return;\n      const input = process.stdin;\n      if (!input || input.destroyed || input.writableEnded) return;\n      try {\n        input.write("q");\n      } catch (error) {\n        controlError = \`ffmpeg control input error: \${formatError(error)}\`;\n      }\n    };\n\n    const forceKill = () => {\n      if (process.exitCode !== null || process.signalCode !== null) return;\n      try { process.kill("SIGKILL"); } catch { /* already dead */ }\n    };\n`,
    "graceful FFmpeg shutdown",
  );

  source = replaceOnce(
    source,
    "      const stderrText = getStderr();\n",
    "      const stderrText = getDiagnostics();\n",
    "include control diagnostics",
  );

  return source;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(path, content) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

async function assertVersion() {
  const manifest = JSON.parse(await readFile(join(PACKAGE_DIR, "package.json"), "utf8"));
  if (manifest.version !== EXPECTED_VERSION) {
    throw new Error(`Refusing to patch pi-voice-stt ${manifest.version}; expected ${EXPECTED_VERSION}`);
  }
}

async function apply() {
  await assertVersion();
  await mkdir(dirname(BACKUP_PATH), { recursive: true });
  const source = await readFile(SOURCE_PATH, "utf8");
  if (!(await exists(BACKUP_PATH))) await copyFile(SOURCE_PATH, BACKUP_PATH);
  const patched = patchFfmpegRecorder(source);
  await atomicWrite(SOURCE_PATH, patched);
  console.log(patched === source ? "pi-voice-stt: already patched" : "pi-voice-stt: patched");
}

async function check() {
  await assertVersion();
  const source = await readFile(SOURCE_PATH, "utf8");
  if (!source.includes(PATCH_MARKER)) throw new Error("pi-voice-stt: graceful FFmpeg shutdown patch is missing");
  if (source.includes('"-nostdin"') || !source.includes('input.write("q")')) {
    throw new Error("pi-voice-stt: graceful FFmpeg shutdown patch is incomplete");
  }
  console.log("pi-voice-stt: graceful FFmpeg shutdown patch present");
}

async function revert() {
  await assertVersion();
  if (!(await exists(BACKUP_PATH))) throw new Error("pi-voice-stt: original backup is missing");
  await copyFile(BACKUP_PATH, SOURCE_PATH);
  console.log("pi-voice-stt: restored original");
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const mode = process.argv[2] || "--apply";
  const operation = mode === "--check" ? check : mode === "--revert" ? revert : apply;
  operation().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
