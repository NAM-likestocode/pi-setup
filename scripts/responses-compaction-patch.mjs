import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CODING_AGENT_DIR = process.env.PI_CODING_AGENT_PACKAGE
  || join(process.env.LOCALAPPDATA || "", "pi-node", "current", "node_modules", "@earendil-works", "pi-coding-agent");
const PI_AI_DIR = join(CODING_AGENT_DIR, "node_modules", "@earendil-works", "pi-ai");
const EXPECTED_VERSION = "0.82.1";
const PATCH_MARKER = "PI_HARNESS_SERVER_COMPACTION_V1";
const BACKUP_DIR = join(HARNESS_DIR, "patches", `pi-ai-${EXPECTED_VERSION}`, "original");
const FILES = {
  codex: join(PI_AI_DIR, "dist", "api", "openai-codex-responses.js"),
  shared: join(PI_AI_DIR, "dist", "api", "openai-responses-shared.js"),
};

function replaceOnce(source, oldText, newText, label) {
  const first = source.indexOf(oldText);
  if (first < 0) throw new Error(`Patch anchor not found: ${label}`);
  if (source.indexOf(oldText, first + oldText.length) >= 0) throw new Error(`Patch anchor is not unique: ${label}`);
  return source.slice(0, first) + newText + source.slice(first + oldText.length);
}

export function patchCodexProvider(source) {
  if (source.includes(PATCH_MARKER)) return source;

  source = replaceOnce(
    source,
    'const PREVIOUS_RESPONSE_NOT_FOUND_CODE = "previous_response_not_found";\n',
    'const PREVIOUS_RESPONSE_NOT_FOUND_CODE = "previous_response_not_found";\nconst SERVER_COMPACTION_THRESHOLD = 200_000;\nconst SERVER_COMPACTION_UNSUPPORTED = new Set();\nconst PI_HARNESS_SERVER_COMPACTION_V1 = true;\n',
    "Codex constants",
  );

  source = replaceOnce(
    source,
    'class RetryDelayExceededError extends Error {\n}\n',
    `class RetryDelayExceededError extends Error {\n}\nfunction serverCompactionKey(model) {\n    return \`${'${model.baseUrl}|${model.id}'}\`;\n}\nfunction shouldEnableServerCompaction(model, options) {\n    const configured = options?.env?.PI_CODEX_SERVER_COMPACTION\n        ?? (typeof process !== "undefined" ? process.env?.PI_CODEX_SERVER_COMPACTION : undefined);\n    if (/^(?:0|false|off|no)$/i.test(configured ?? ""))\n        return false;\n    return model.contextWindow > SERVER_COMPACTION_THRESHOLD && !SERVER_COMPACTION_UNSUPPORTED.has(serverCompactionKey(model));\n}\nfunction isUnsupportedServerCompactionError(error) {\n    const detail = typeof error === "string" ? error : formatThrownValue(error);\n    return /(?:context_management|compact_threshold).*(?:unknown|unsupported|invalid|unrecognized|not (?:allowed|supported))|(?:unknown|unsupported|invalid|unrecognized).*(?:context_management|compact_threshold)/i.test(detail);\n}\nfunction disableServerCompaction(model, body) {\n    if (!body.context_management)\n        return false;\n    delete body.context_management;\n    SERVER_COMPACTION_UNSUPPORTED.add(serverCompactionKey(model));\n    return true;\n}\n`,
    "Codex fallback helpers",
  );

  source = replaceOnce(
    source,
    '        parallel_tool_calls: true,\n    };\n',
    '        parallel_tool_calls: true,\n    };\n    if (shouldEnableServerCompaction(model, options)) {\n        body.context_management = [{ type: "compaction", compact_threshold: SERVER_COMPACTION_THRESHOLD }];\n    }\n',
    "Codex request context management",
  );

  source = replaceOnce(source, '            const bodyJson = JSON.stringify(body);\n', '            let bodyJson = JSON.stringify(body);\n', "mutable Codex request body");

  source = replaceOnce(
    source,
    '                let retriedMissingWebSocketContinuation = false;\n',
    '                let retriedMissingWebSocketContinuation = false;\n                let retriedUnsupportedServerCompaction = false;\n',
    "WebSocket fallback state",
  );

  source = replaceOnce(
    source,
    '                        const previousResponseNotFound = isPreviousResponseNotFoundError(error);\n                        if (!aborted && previousResponseNotFound && !retriedMissingWebSocketContinuation) {\n',
    '                        const previousResponseNotFound = isPreviousResponseNotFoundError(error);\n                        if (!aborted && !websocketStarted && !retriedUnsupportedServerCompaction && isUnsupportedServerCompactionError(error) && disableServerCompaction(model, body)) {\n                            retriedUnsupportedServerCompaction = true;\n                            bodyJson = JSON.stringify(body);\n                            continue;\n                        }\n                        if (!aborted && previousResponseNotFound && !retriedMissingWebSocketContinuation) {\n',
    "WebSocket unsupported-parameter fallback",
  );

  source = replaceOnce(
    source,
    `            const compressedBody = compressRequestBodyZstd(bodyJson);\n            if (compressedBody) {\n                sseHeaders.set("content-encoding", "zstd");\n            }\n            const sseBody = compressedBody ?? bodyJson;\n`,
    `            let sseBody;\n            const refreshSseBody = () => {\n                const compressedBody = compressRequestBodyZstd(bodyJson);\n                if (compressedBody)\n                    sseHeaders.set("content-encoding", "zstd");\n                else\n                    sseHeaders.delete("content-encoding");\n                sseBody = compressedBody ?? bodyJson;\n            };\n            refreshSseBody();\n`,
    "refreshable SSE body",
  );

  source = replaceOnce(
    source,
    '                    const errorText = await response.text();\n                    if (attempt < maxRetries && isRetryableError(response.status, errorText)) {\n',
    '                    const errorText = await response.text();\n                    if (isUnsupportedServerCompactionError(errorText) && disableServerCompaction(model, body)) {\n                        bodyJson = JSON.stringify(body);\n                        refreshSseBody();\n                        attempt--;\n                        continue;\n                    }\n                    if (attempt < maxRetries && isRetryableError(response.status, errorText)) {\n',
    "SSE unsupported-parameter fallback",
  );

  return source;
}

export function patchResponsesShared(source) {
  if (source.includes(PATCH_MARKER)) return source;

  source = replaceOnce(
    source,
    '    return messages;\n}\n// =============================================================================\n// Tool conversion\n',
    `    const latestCompaction = messages.findLastIndex((item) => item?.type === "compaction");\n    if (latestCompaction < 0)\n        return messages;\n    const instructionPrefix = messages.slice(0, latestCompaction).filter((item) => item?.role === "system" || item?.role === "developer");\n    return [...instructionPrefix, ...messages.slice(latestCompaction)];\n}\n// ${PATCH_MARKER}\n// =============================================================================\n// Tool conversion\n`,
    "prune before latest compaction item",
  );

  source = replaceOnce(
    source,
    '    const reasoningBlocksById = new Map();\n',
    '    const reasoningBlocksById = new Map();\n    const compactionBlocksById = new Map();\n',
    "compaction block registry",
  );

  source = replaceOnce(
    source,
    '        if (item.type === "message") {\n',
    `        if (item.type === "compaction") {\n            const block = { type: "thinking", thinking: "", thinkingSignature: JSON.stringify(item) };\n            output.content.push(block);\n            const slot = { type: "compaction", block, contentIndex: output.content.length - 1 };\n            outputSlots.set(outputIndex, slot);\n            if (item.id)\n                compactionBlocksById.set(item.id, block);\n            return slot;\n        }\n        if (item.type === "message") {\n`,
    "capture compaction output item",
  );

  source = replaceOnce(
    source,
    '            if (item.type !== "reasoning" || !item.encrypted_content)\n                continue;\n',
    `            if (item.type === "compaction" && item.encrypted_content) {\n                const block = compactionBlocksById.get(item.id);\n                if (block)\n                    block.thinkingSignature = JSON.stringify(item);\n                continue;\n            }\n            if (item.type !== "reasoning" || !item.encrypted_content)\n                continue;\n`,
    "backfill compaction signatures",
  );

  source = replaceOnce(
    source,
    '            if (item.type === "reasoning" && slot?.type === "thinking") {\n',
    `            if (item.type === "compaction" && slot?.type === "compaction") {\n                slot.block.thinkingSignature = JSON.stringify(item);\n                if (item.id)\n                    compactionBlocksById.set(item.id, slot.block);\n                outputSlots.delete(event.output_index);\n            }\n            else if (item.type === "reasoning" && slot?.type === "thinking") {\n`,
    "finalize compaction output item",
  );

  return source;
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function atomicWrite(path, content) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

async function assertVersion() {
  const manifest = JSON.parse(await readFile(join(PI_AI_DIR, "package.json"), "utf8"));
  if (manifest.version !== EXPECTED_VERSION) {
    throw new Error(`Refusing to patch pi-ai ${manifest.version}; expected ${EXPECTED_VERSION}`);
  }
}

async function apply() {
  await assertVersion();
  await mkdir(BACKUP_DIR, { recursive: true });
  for (const [name, path] of Object.entries(FILES)) {
    const backup = join(BACKUP_DIR, `${name}.js`);
    const source = await readFile(path, "utf8");
    if (!(await exists(backup))) await copyFile(path, backup);
    const patched = name === "codex" ? patchCodexProvider(source) : patchResponsesShared(source);
    await atomicWrite(path, patched);
    console.log(`${name}: ${patched === source ? "already patched" : "patched"}`);
  }
}

async function check() {
  await assertVersion();
  for (const [name, path] of Object.entries(FILES)) {
    const source = await readFile(path, "utf8");
    if (!source.includes(PATCH_MARKER)) throw new Error(`${name}: server compaction patch is missing`);
    console.log(`${name}: patch present`);
  }
}

async function revert() {
  await assertVersion();
  for (const [name, path] of Object.entries(FILES)) {
    const backup = join(BACKUP_DIR, `${name}.js`);
    if (!(await exists(backup))) throw new Error(`${name}: original backup is missing`);
    await copyFile(backup, path);
    console.log(`${name}: restored original`);
  }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const mode = process.argv[2] || "--apply";
  const operation = mode === "--check" ? check : mode === "--revert" ? revert : apply;
  operation().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
