import { describe, expect, it } from "vitest";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { isDynamicTool, searchDynamicTools, shouldConsiderSubagent } from "../extensions/00-dynamic-tool-loader.ts";

const tools = [
  { name: "read", description: "Read a file" },
  { name: "web_search", description: "Search the web" },
  { name: "source_check", description: "Verify claims with sources" },
  { name: "ctx_execute", description: "Run code in a sandbox" },
  { name: "ctx_execute_file", description: "Analyze a large file" },
  { name: "subagent", description: "Run a project agent" },
  { name: "mcp", description: "Connect to MCP servers" },
] as ToolInfo[];

describe("dynamic tool loader", () => {
  it("limits dynamic loading to reviewed tool families", () => {
    expect(isDynamicTool("ctx_execute")).toBe(true);
    expect(isDynamicTool("web_search")).toBe(true);
    expect(isDynamicTool("read")).toBe(false);
    expect(isDynamicTool("edit")).toBe(false);
  });

  it("routes test and log work to context-mode tools", () => {
    expect(searchDynamicTools(tools, "run tests and analyze logs", 3)).toContain("ctx_execute");
    expect(searchDynamicTools(tools, "analyze a large log file", 3)).toContain("ctx_execute_file");
  });

  it("routes research, delegation, and MCP requests", () => {
    expect(searchDynamicTools(tools, "research current web sources", 2)).toContain("web_search");
    expect(searchDynamicTools(tools, "delegate to another agent", 2)).toContain("subagent");
    expect(searchDynamicTools(tools, "connect an MCP server", 2)).toContain("mcp");
  });

  it("does not return always-active built-ins", () => {
    expect(searchDynamicTools(tools, "read a file", 10)).not.toContain("read");
  });

  it("surfaces specialists only for explicit or high-value work", () => {
    expect(shouldConsiderSubagent("delegate this research to another agent")).toBe(true);
    expect(shouldConsiderSubagent("research the current options and cite sources")).toBe(true);
    expect(shouldConsiderSubagent("audit this security-sensitive change")).toBe(true);
    expect(shouldConsiderSubagent("map the architecture across the codebase")).toBe(true);
    expect(shouldConsiderSubagent("add a temporary workaround for this package bug")).toBe(true);
    expect(shouldConsiderSubagent("rename this variable in one file")).toBe(false);
    expect(shouldConsiderSubagent("what does this error mean?")).toBe(false);
  });
});
