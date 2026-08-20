import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const ENFORCED_SUBAGENT_MODEL = "openai-codex/gpt-5.6-sol";
export const ENFORCED_SUBAGENT_THINKING: AgentThinking = "xhigh";
export type AgentSource = "user" | "project";
export type AgentActivation = "propose" | "explicit";
export type AgentAccess = "read-only" | "network" | "execute" | "write";
export type AgentCapability = "web";

export interface ProjectAgent {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  model: string;
  thinking: AgentThinking;
  source: AgentSource;
  activation: AgentActivation;
  access: AgentAccess;
  capabilities: AgentCapability[];
  extensionPaths: string[];
  filePath: string;
}

export interface ProjectAgentDiscovery {
  projectRoot: string | null;
  agentsDir: string | null;
  userAgentsDir: string;
  projectAgentsDir: string | null;
  agents: ProjectAgent[];
  diagnostics: string[];
}

export interface AgentDiscoveryOptions {
  userAgentsDir?: string;
  webExtensionPath?: string;
}

const DEFAULT_TOOLS = ["read", "grep", "find", "ls"];
const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
const WEB_TOOLS = new Set(["web_search", "source_check", "fetch_content", "get_search_content"]);
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

function commaList(value: unknown): string[] {
  const raw = stringValue(value);
  return raw ? [...new Set(raw.split(",").map((item) => item.trim()).filter(Boolean))] : [];
}

function parseCapabilities(
  value: unknown,
  fileName: string,
  source: AgentSource,
  diagnostics: string[],
): AgentCapability[] {
  const requested = commaList(value);
  if (source === "project" && requested.length > 0) {
    diagnostics.push(`${fileName}: project agents cannot load extra child capabilities; ignored: ${requested.join(", ")}`);
    return [];
  }
  const capabilities = requested.filter((item): item is AgentCapability => item === "web");
  const unsupported = requested.filter((item) => item !== "web");
  if (unsupported.length > 0) diagnostics.push(`${fileName}: ignored unsupported capabilities: ${unsupported.join(", ")}`);
  return capabilities;
}

function parseTools(
  value: unknown,
  fileName: string,
  capabilities: AgentCapability[],
  diagnostics: string[],
): string[] {
  const requested = commaList(value);
  const tools = requested.length > 0 ? requested : [...DEFAULT_TOOLS];
  const allowed = new Set(BUILTIN_TOOLS);
  if (capabilities.includes("web")) for (const tool of WEB_TOOLS) allowed.add(tool);

  const invalid = tools.filter((tool) => !TOOL_NAME.test(tool));
  const unsupported = tools.filter((tool) => TOOL_NAME.test(tool) && !allowed.has(tool));
  if (invalid.length > 0) diagnostics.push(`${fileName}: ignored invalid tool names: ${invalid.join(", ")}`);
  if (unsupported.length > 0) diagnostics.push(`${fileName}: ignored tools unavailable in this isolated child: ${unsupported.join(", ")}`);
  return tools.filter((tool) => TOOL_NAME.test(tool) && allowed.has(tool));
}

function accessFor(tools: string[], capabilities: AgentCapability[]): AgentAccess {
  if (tools.some((tool) => tool === "edit" || tool === "write")) return "write";
  if (tools.includes("bash")) return "execute";
  if (capabilities.includes("web")) return "network";
  return "read-only";
}

function loadAgentsFromDir(
  dir: string,
  source: AgentSource,
  diagnostics: string[],
  webExtensionPath: string,
): ProjectAgent[] {
  if (!isDirectory(dir)) return [];

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    diagnostics.push(`Could not read ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }

  const agents: ProjectAgent[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const filePath = join(dir, entry.name);
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch (error) {
      diagnostics.push(`${entry.name}: ${error instanceof Error ? error.message : "could not read file"}`);
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
    const managedAutomatically = frontmatter.automatic === true
      || stringValue(frontmatter.automatic)?.toLowerCase() === "true";
    if (source === "user" && managedAutomatically && stringValue(frontmatter.scope) === "pi-harness") continue;

    const name = stringValue(frontmatter.name) ?? parse(entry.name).name;
    const description = stringValue(frontmatter.description);
    const requestedModel = stringValue(frontmatter.model);
    const requestedThinking = stringValue(frontmatter.thinking)?.toLowerCase() as AgentThinking | undefined;
    const requestedActivation = stringValue(frontmatter.activation)?.toLowerCase();

    if (!AGENT_NAME.test(name)) {
      diagnostics.push(`${entry.name}: agent name must match ${AGENT_NAME.source}`);
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
    if (requestedThinking && !THINKING_LEVELS.has(requestedThinking)) {
      diagnostics.push(`${entry.name}: ignored invalid thinking level "${requestedThinking}"`);
    }
    if (requestedModel && requestedModel !== ENFORCED_SUBAGENT_MODEL) {
      diagnostics.push(`${entry.name}: model "${requestedModel}" overridden by global policy (${ENFORCED_SUBAGENT_MODEL})`);
    }
    if (requestedThinking && requestedThinking !== ENFORCED_SUBAGENT_THINKING) {
      diagnostics.push(`${entry.name}: thinking "${requestedThinking}" overridden by global policy (${ENFORCED_SUBAGENT_THINKING})`);
    }
    if (requestedActivation && requestedActivation !== "propose" && requestedActivation !== "explicit") {
      diagnostics.push(`${entry.name}: ignored invalid activation "${requestedActivation}"`);
    }

    const capabilities = parseCapabilities(frontmatter.capabilities, entry.name, source, diagnostics);
    const tools = parseTools(frontmatter.tools, entry.name, capabilities, diagnostics);
    const activation: AgentActivation = source === "project"
      ? "explicit"
      : requestedActivation === "propose" ? "propose" : "explicit";

    agents.push({
      name,
      description,
      systemPrompt: body.trim(),
      tools,
      model: ENFORCED_SUBAGENT_MODEL,
      thinking: ENFORCED_SUBAGENT_THINKING,
      source,
      activation,
      access: accessFor(tools, capabilities),
      capabilities,
      extensionPaths: capabilities.includes("web") ? [webExtensionPath] : [],
      filePath,
    });
  }
  return agents;
}

export function discoverProjectAgents(cwd: string, options: AgentDiscoveryOptions = {}): ProjectAgentDiscovery {
  const userAgentsDir = options.userAgentsDir ?? join(getAgentDir(), "agents");
  const webExtensionPath = options.webExtensionPath
    ?? join(getAgentDir(), "npm", "node_modules", "pi-web-access", "index.ts");
  const project = findNearestAgentsDir(cwd);
  const diagnostics: string[] = [];
  const agents: ProjectAgent[] = [];
  const names = new Set<string>();

  for (const agent of loadAgentsFromDir(userAgentsDir, "user", diagnostics, webExtensionPath)) {
    if (names.has(agent.name)) {
      diagnostics.push(`${agent.filePath}: duplicate user agent name "${agent.name}"`);
      continue;
    }
    names.add(agent.name);
    agents.push(agent);
  }

  if (project && resolve(project.agentsDir) !== resolve(userAgentsDir)) {
    for (const agent of loadAgentsFromDir(project.agentsDir, "project", diagnostics, webExtensionPath)) {
      if (names.has(agent.name)) {
        diagnostics.push(`${agent.filePath}: project agent "${agent.name}" cannot replace the trusted user agent with the same name`);
        continue;
      }
      names.add(agent.name);
      agents.push(agent);
    }
  }

  return {
    projectRoot: project?.projectRoot ?? null,
    agentsDir: project?.agentsDir ?? null,
    userAgentsDir,
    projectAgentsDir: project?.agentsDir ?? null,
    agents,
    diagnostics,
  };
}
