import { describe, expect, it } from "vitest";
import {
  MAX_MEMORIES_PER_SCOPE,
  MAX_MEMORY_CHARS,
  normalizeMemory,
  renderMemoryDocument,
  validateMemoryAddition,
} from "../extensions/memory.ts";

describe("memory limits", () => {
  it("normalizes multiline notes", () => {
    expect(normalizeMemory("  keep\nthis   concise ")).toBe("keep this concise");
  });

  it("rejects oversized notes and full scopes", () => {
    expect(validateMemoryAddition([], "x".repeat(MAX_MEMORY_CHARS + 1))).toMatch(/too long/i);
    expect(validateMemoryAddition(Array.from({ length: MAX_MEMORIES_PER_SCOPE }, (_, i) => `note ${i}`), "another"))
      .toMatch(/already has/i);
  });

  it("adds and replaces only the managed AGENTS block", () => {
    const initial = "# Project instructions\n\nKeep this text.\n";
    const added = renderMemoryDocument(initial, ["first"]);
    expect(added).toContain("Keep this text.");
    expect(added).toContain("- first");
    const replaced = renderMemoryDocument(added, ["second"]);
    expect(replaced).toContain("Keep this text.");
    expect(replaced).toContain("- second");
    expect(replaced).not.toContain("- first");
  });
});
