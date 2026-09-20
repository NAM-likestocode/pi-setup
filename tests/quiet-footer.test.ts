import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  filterStatuses,
  formatCwd,
  formatTokens,
  loadFooterConfig,
  parseVerboseArg,
  renderQuietFooter,
  saveFooterConfig,
  type QuietFooterInput,
} from "../extensions/quiet-footer.ts";

const plain = { fg: (_color: string, text: string) => text };
const marked = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };

function input(overrides: Partial<QuietFooterInput> = {}): QuietFooterInput {
  return {
    cwd: "/home/tester/Projects/demo",
    home: "/home/tester",
    sessionName: undefined,
    contextPercent: 42.4,
    contextWindow: 200_000,
    modelId: "claude-opus-5",
    reasoning: true,
    thinkingLevel: "xhigh",
    statuses: new Map(),
    ...overrides,
  };
}

describe("quiet footer", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("parses command arguments", () => {
    expect(parseVerboseArg("")).toBe("status");
    expect(parseVerboseArg(" OFF ")).toBe("off");
    expect(parseVerboseArg("toggle")).toBe("toggle");
    expect(parseVerboseArg("loud")).toBeUndefined();
  });

  it("defaults to verbose and round-trips the saved preference", () => {
    const dir = mkdtempSync(join(tmpdir(), "quiet-footer-"));
    dirs.push(dir);
    const path = join(dir, "footer.json");
    expect(loadFooterConfig(path)).toEqual({ verbose: true });
    saveFooterConfig({ verbose: false }, path);
    expect(loadFooterConfig(path)).toEqual({ verbose: false });
  });

  it("formats paths and token counts compactly", () => {
    expect(formatCwd("/home/tester/Projects/demo", "/home/tester")).toBe("~/Projects/demo");
    expect(formatCwd("/srv/app", "/home/tester")).toBe("/srv/app");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(200_000)).toBe("200k");
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });

  it("drops informational statuses and keeps active-mode ones in key order", () => {
    const statuses = new Map([
      ["project-subagents", "⚙ 2 subagents"],
      ["mcp", "MCP: 1 server enabled"],
      ["braintrust", "Braintrust tracing"],
      ["autopilot", "✦ AUTOPILOT"],
      ["anywhere", "Pimo connected"],
      ["pi-lsp", "biome diagnostics"],
      ["delegation-toggle", "⛔ DELEGATION OFF"],
    ]);
    expect(filterStatuses(statuses)).toEqual(["✦ AUTOPILOT", "⛔ DELEGATION OFF", "⚙ 2 subagents"]);
  });

  it("renders path, context and model without token or cost stats", () => {
    const lines = renderQuietFooter(input({ statuses: new Map([["mcp", "MCP: 1 server enabled"]]) }), plain, 80);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("~/Projects/demo");
    expect(lines[1].startsWith("42%/200k")).toBe(true);
    expect(lines[1].endsWith("claude-opus-5 • xhigh")).toBe(true);
    expect(lines[1]).not.toMatch(/\$|↑|↓/);
  });

  it("adds a third line only when an actionable status exists", () => {
    const lines = renderQuietFooter(input({ statuses: new Map([["autopilot", "✦ AUTOPILOT"]]) }), plain, 80);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("✦ AUTOPILOT");
  });

  it("colours high context usage and shows unknown usage after compaction", () => {
    expect(renderQuietFooter(input({ contextPercent: 85 }), marked, 80)[1]).toContain("<warning>85%/200k</warning>");
    expect(renderQuietFooter(input({ contextPercent: 95 }), marked, 80)[1]).toContain("<error>95%/200k</error>");
    expect(renderQuietFooter(input({ contextPercent: null }), plain, 80)[1].startsWith("?/200k")).toBe(true);
  });

  it("includes the session name and handles models without thinking", () => {
    const lines = renderQuietFooter(input({ sessionName: "footer work", reasoning: false, modelId: "gpt-4.1" }), plain, 80);
    expect(lines[0]).toBe("~/Projects/demo • footer work");
    expect(lines[1].endsWith("gpt-4.1")).toBe(true);
    expect(lines[1]).not.toContain("thinking");
  });
});
