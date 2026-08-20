import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { patchCodexProvider, patchResponsesShared } from "../scripts/responses-compaction-patch.mjs";

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piAiApi = join(harnessRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "api");

describe("Responses server-compaction patch", () => {
  it("adds a 200K server threshold and unsupported-parameter fallback idempotently", async () => {
    const source = await readFile(join(piAiApi, "openai-codex-responses.js"), "utf8");
    const patched = patchCodexProvider(source);
    expect(patched).toContain("PI_HARNESS_SERVER_COMPACTION_V1");
    expect(patched).toContain('compact_threshold: SERVER_COMPACTION_THRESHOLD');
    expect(patched).toContain("isUnsupportedServerCompactionError");
    expect(patchCodexProvider(patched)).toBe(patched);
  });

  it("captures, replays, and prunes before the latest encrypted compaction item", async () => {
    const source = await readFile(join(piAiApi, "openai-responses-shared.js"), "utf8");
    const patched = patchResponsesShared(source);
    expect(patched).toContain('item.type === "compaction"');
    expect(patched).toContain("latestCompaction");
    expect(patched).toContain("compactionBlocksById");
    expect(patchResponsesShared(patched)).toBe(patched);
  });
});
