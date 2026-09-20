import { describe, expect, it } from "vitest";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { isDynamicTool, searchDynamicTools } from "../extensions/00-dynamic-tool-loader.ts";

const tools = [
  { name: "read", description: "Read a file" },
  { name: "web_search", description: "Search the web" },
  { name: "source_check", description: "Verify claims with sources" },
  { name: "subagent", description: "Run a project agent" },
  { name: "mcp", description: "Connect to MCP servers" },
] as ToolInfo[];

describe("dynamic tool loader", () => {
  it("limits dynamic loading to reviewed tool families", () => {
    expect(isDynamicTool("web_search")).toBe(true);
    expect(isDynamicTool("read")).toBe(false);
    expect(isDynamicTool("edit")).toBe(false);
  });

  it("keeps the subagent tool always active rather than on-demand", () => {
    expect(isDynamicTool("subagent")).toBe(false);
  });

  it("routes research and MCP requests", () => {
    expect(searchDynamicTools(tools, "research current web sources", 2)).toContain("web_search");
    expect(searchDynamicTools(tools, "connect an MCP server", 2)).toContain("mcp");
  });

  it("does not return always-active built-ins", () => {
    expect(searchDynamicTools(tools, "read a file", 10)).not.toContain("read");
    expect(searchDynamicTools(tools, "delegate to another agent", 10)).not.toContain("subagent");
  });
});
