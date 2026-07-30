import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { CONFIG_DIR_NAME, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ProjectAgent {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  model?: string;
  thinking?: AgentThinking;
  filePath: string;
}

export interface ProjectAgentDiscovery {
  projectRoot: string | null;
  agentsDir: string | null;
  agents: ProjectAgent[];
  diagnostics: string[];
}

const DEFAULT_TOOLS = ["read", "grep", "find", "ls"];
const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const THINKING_LEVELS = new Set<AgentThinking>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function findNearestAgentsDir(cwd: string): { projectRoot: string; agentsDir: string } | null {
  let current = resolve(cwd);
  while (true) {
    const agentsDir = join(current, CONFIG_DIR_NAME, "agents");
    if (isDirectory(agentsDir)) return { projectRoot: current, agentsDir };
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseTools(value: unknown, fileName: string, diagnostics: string[]): string[] {
  const raw = stringValue(value);
  if (!raw) return [...DEFAULT_TOOLS];
  const tools = [...new Set(raw.split(",").map((tool) => tool.trim()).filter(Boolean))];
  const invalid = tools.filter((tool) => !TOOL_NAME.test(tool));
  const unsupported = tools.filter((tool) => TOOL_NAME.test(tool) && !BUILTIN_TOOLS.has(tool));
  if (invalid.length > 0) {
    diagnostics.push(`${fileName}: ignored invalid tool names: ${invalid.join(", ")}`);
  }
  if (unsupported.length > 0) {
    diagnostics.push(`${fileName}: ignored tools unavailable in the isolated child: ${unsupported.join(", ")}`);
  }
  return tools.filter((tool) => TOOL_NAME.test(tool) && BUILTIN_TOOLS.has(tool));
}

export function discoverProjectAgents(cwd: string): ProjectAgentDiscovery {
  const found = findNearestAgentsDir(cwd);
  if (!found) return { projectRoot: null, agentsDir: null, agents: [], diagnostics: [] };

  const diagnostics: string[] = [];
  const agents: ProjectAgent[] = [];
  const names = new Set<string>();
  let entries;
  try {
    entries = readdirSync(found.agentsDir, { withFileTypes: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ...found, agents: [], diagnostics: [`Could not read ${found.agentsDir}: ${detail}`] };
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const filePath = join(found.agentsDir, entry.name);
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch (error) {
      diagnostics.push(`${entry.name}: ${error instanceof Error ? error.message : "could not read file"}`);
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
    const fallbackName = parse(entry.name).name;
    const name = stringValue(frontmatter.name) ?? fallbackName;
    const description = stringValue(frontmatter.description);
    const model = stringValue(frontmatter.model);
    const thinkingValue = stringValue(frontmatter.thinking)?.toLowerCase() as AgentThinking | undefined;

    if (!AGENT_NAME.test(name)) {
      diagnostics.push(`${entry.name}: agent name must match ${AGENT_NAME.source}`);
      continue;
    }
    if (names.has(name)) {
      diagnostics.push(`${entry.name}: duplicate agent name "${name}"`);
      continue;
    }
    if (!description) {
      diagnostics.push(`${entry.name}: missing frontmatter description`);
      continue;
    }
    if (!body.trim()) {
      diagnostics.push(`${entry.name}: agent instructions are empty`);
      continue;
    }
    if (thinkingValue && !THINKING_LEVELS.has(thinkingValue)) {
      diagnostics.push(`${entry.name}: ignored invalid thinking level "${thinkingValue}"`);
    }

    names.add(name);
    agents.push({
      name,
      description,
      systemPrompt: body.trim(),
      tools: parseTools(frontmatter.tools, entry.name, diagnostics),
      model,
      thinking: thinkingValue && THINKING_LEVELS.has(thinkingValue) ? thinkingValue : undefined,
      filePath,
    });
  }

  return { ...found, agents, diagnostics };
}
