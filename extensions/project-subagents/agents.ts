import { existsSync, type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type AgentSource = "user" | "project" | "builtin" | "adhoc";
export type AgentActivation = "propose" | "explicit";
export type AgentAccess = "read-only" | "network" | "execute" | "write";
export type AgentCapability = "web";
export type RunMode = "background" | "wait";

/** Name of the built-in general-purpose profile used when no `agent` is given. */
export const WORKER_AGENT = "worker";

/**
 * Legacy global policy. No longer applied to subagents by default (set
 * `enforceModel` / `enforceThinking` in `~/.pi/agent/subagents.json` to restore
 * it); still used by `auto-workaround-fixer` for its own automatic child.
 */
export const ENFORCED_SUBAGENT_MODEL = "openai-codex/gpt-5.6-sol";
export const ENFORCED_SUBAGENT_THINKING: AgentThinking = "xhigh";

export interface ProjectAgent {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  /** `provider/id`, or `"inherit"` to use the parent session's model. */
  model: string;
  /** Thinking level, or `"inherit"` to use the parent session's level. */
  thinking: AgentThinking | "inherit";
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

/**
 * Harness-level subagent policy, read from `~/.pi/agent/subagents.json`.
 * Every field is optional; defaults are chosen so delegation "just works":
 * no approval prompt, workers inherit the parent's model, a few can run at once.
 */
export interface SubagentConfig {
  /** Ask before starting a child. Default: "never". */
  approval: "never" | "always";
  /** Model for profiles that do not set one. `"inherit"` = the parent's model. */
  defaultModel: string;
  /** Thinking level for profiles that do not set one. `"inherit"` = the parent's level. */
  defaultThinking: AgentThinking | "inherit";
  /** Force every child onto one model regardless of profile/params (the old global policy). */
  enforceModel?: string;
  /** Force every child onto one thinking level regardless of profile/params. */
  enforceThinking?: AgentThinking;
  /** How many children may run at the same time from one session. Default 4. */
  maxConcurrent: number;
  /** How deep delegation may nest (top-level session is depth 0). Default 2. */
  maxDepth: number;
  /** Default run mode when the tool call does not specify one. Default "background". */
  defaultMode: RunMode;
  /** Where child transcripts (`<runId>.jsonl`) are written. */
  transcriptDir: string;
  /**
   * Extension files every child loads in addition to its profile's. Children run
   * with `--no-extensions`, so provider auth extensions (which make requests count
   * against a subscription plan) must be listed here. Default: auto-detected
   * `*-auth` packages under `~/.pi/agent/npm/node_modules`.
   */
  childExtensions: string[];
}

export interface AgentDiscoveryOptions {
  userAgentsDir?: string;
  webExtensionPath?: string;
  config?: Partial<SubagentConfig>;
}

export const DEFAULT_TOOLS = ["read", "grep", "find", "ls"];
export const WORKER_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
export const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
export const WEB_TOOLS = new Set(["web_search", "source_check", "fetch_content", "get_search_content"]);
export const THINKING_LEVELS = new Set<AgentThinking>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function defaultTranscriptDir(): string {
  const base = process.env.XDG_STATE_HOME && resolve(process.env.XDG_STATE_HOME).startsWith("/")
    ? process.env.XDG_STATE_HOME
    : join(homedir(), ".local", "state");
  return join(base, "pi", "subagents");
}

/**
 * Find installed pi packages whose name marks them as provider auth shims
 * (e.g. `@gotgenes/pi-anthropic-auth`) and return their extension entry files.
 */
export function detectAuthExtensions(nodeModules = join(getAgentDir(), "npm", "node_modules")): string[] {
  const found: string[] = [];
  const visit = (dir: string, name: string) => {
    if (!/(?:^|[-_/])auth(?:$|[-_])/i.test(name)) return;
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) return;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { pi?: { extensions?: unknown } };
      const entries = Array.isArray(pkg.pi?.extensions) ? pkg.pi.extensions : [];
      for (const entry of entries) {
        if (typeof entry !== "string") continue;
        const full = resolve(dir, entry);
        if (existsSync(full) && statSync(full).isFile()) found.push(full);
      }
    } catch {
      // ignore unreadable packages
    }
  };
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(nodeModules, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("@")) {
      let scoped: Dirent[] = [];
      try {
        scoped = readdirSync(join(nodeModules, entry.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const inner of scoped) if (inner.isDirectory()) visit(join(nodeModules, entry.name, inner.name), inner.name);
    } else {
      visit(join(nodeModules, entry.name), entry.name);
    }
  }
  return found.sort();
}

export function defaultConfig(): SubagentConfig {
  return {
    approval: "never",
    defaultModel: "inherit",
    defaultThinking: "inherit",
    maxConcurrent: 4,
    maxDepth: 2,
    defaultMode: "background",
    transcriptDir: defaultTranscriptDir(),
    childExtensions: detectAuthExtensions(),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function commaList(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  const raw = stringValue(value);
  return raw ? [...new Set(raw.split(",").map((item) => item.trim()).filter(Boolean))] : [];
}

export function isThinkingLevel(value: unknown): value is AgentThinking {
  return typeof value === "string" && THINKING_LEVELS.has(value as AgentThinking);
}

export function isModelId(value: unknown): value is string {
  return typeof value === "string" && MODEL_ID.test(value);
}

/** Load `~/.pi/agent/subagents.json` merged over the defaults. Invalid values fall back silently. */
export function loadSubagentConfig(overrides: Partial<SubagentConfig> = {}, configPath?: string): SubagentConfig {
  const config = defaultConfig();
  const path = configPath ?? join(getAgentDir(), "subagents.json");
  let file: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      file = {};
    }
  }
  const merged = { ...file, ...overrides } as Record<string, unknown>;

  if (merged.approval === "always" || merged.approval === "never") config.approval = merged.approval;
  if (merged.defaultModel === "inherit" || isModelId(merged.defaultModel)) config.defaultModel = merged.defaultModel as string;
  if (merged.defaultThinking === "inherit" || isThinkingLevel(merged.defaultThinking)) config.defaultThinking = merged.defaultThinking as AgentThinking | "inherit";
  if (isModelId(merged.enforceModel)) config.enforceModel = merged.enforceModel;
  if (isThinkingLevel(merged.enforceThinking)) config.enforceThinking = merged.enforceThinking;
  if (typeof merged.maxConcurrent === "number" && merged.maxConcurrent >= 1) config.maxConcurrent = Math.floor(merged.maxConcurrent);
  if (typeof merged.maxDepth === "number" && merged.maxDepth >= 0) config.maxDepth = Math.floor(merged.maxDepth);
  if (merged.defaultMode === "background" || merged.defaultMode === "wait") config.defaultMode = merged.defaultMode;
  const dir = stringValue(merged.transcriptDir);
  if (dir) config.transcriptDir = dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir;
  if (Array.isArray(merged.childExtensions)) {
    config.childExtensions = merged.childExtensions
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => (item.startsWith("~/") ? join(homedir(), item.slice(2)) : item));
  }
  return config;
}

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

/** Validate a tool list against what an isolated child can offer. */
export function resolveTools(
  requested: string[],
  fallback: string[],
  capabilities: AgentCapability[],
  label: string,
  diagnostics: string[],
): string[] {
  const tools = requested.length > 0 ? requested : [...fallback];
  const allowed = new Set(BUILTIN_TOOLS);
  if (capabilities.includes("web")) for (const tool of WEB_TOOLS) allowed.add(tool);

  const invalid = tools.filter((tool) => !TOOL_NAME.test(tool));
  const unsupported = tools.filter((tool) => TOOL_NAME.test(tool) && !allowed.has(tool));
  if (invalid.length > 0) diagnostics.push(`${label}: ignored invalid tool names: ${invalid.join(", ")}`);
  if (unsupported.length > 0) diagnostics.push(`${label}: ignored tools unavailable in this isolated child: ${unsupported.join(", ")}`);
  return tools.filter((tool) => TOOL_NAME.test(tool) && allowed.has(tool));
}

export function accessFor(tools: string[], capabilities: AgentCapability[]): AgentAccess {
  if (tools.some((tool) => tool === "edit" || tool === "write")) return "write";
  if (tools.includes("bash")) return "execute";
  if (capabilities.includes("web")) return "network";
  return "read-only";
}

/** Apply the model / thinking policy from config to a requested value. */
function policyModel(requested: string | undefined, config: SubagentConfig, label: string, diagnostics: string[]): string {
  if (config.enforceModel) {
    if (requested && requested !== config.enforceModel) diagnostics.push(`${label}: model "${requested}" overridden by enforceModel (${config.enforceModel})`);
    return config.enforceModel;
  }
  if (!requested) return config.defaultModel;
  if (requested === "inherit" || isModelId(requested)) return requested;
  diagnostics.push(`${label}: ignored invalid model "${requested}" (expected provider/id)`);
  return config.defaultModel;
}

function policyThinking(requested: string | undefined, config: SubagentConfig, label: string, diagnostics: string[]): AgentThinking | "inherit" {
  if (config.enforceThinking) {
    if (requested && requested !== config.enforceThinking) diagnostics.push(`${label}: thinking "${requested}" overridden by enforceThinking (${config.enforceThinking})`);
    return config.enforceThinking;
  }
  if (!requested) return config.defaultThinking;
  if (requested === "inherit" || isThinkingLevel(requested)) return requested;
  diagnostics.push(`${label}: ignored invalid thinking level "${requested}"`);
  return config.defaultThinking;
}

/** The always-available general-purpose profile. */
export function workerAgent(config: SubagentConfig, webExtensionPath: string): ProjectAgent {
  const capabilities: AgentCapability[] = existsSync(webExtensionPath) ? ["web"] : [];
  const tools = [...WORKER_TOOLS, ...(capabilities.includes("web") ? [...WEB_TOOLS] : [])];
  return {
    name: WORKER_AGENT,
    description: "General-purpose worker: can read, run commands, edit and write files (and search the web when available). Use for a bounded piece of implementation, investigation or verification that can proceed independently.",
    systemPrompt: [
      "You are a worker agent delegated a bounded task by a parent Pi session.",
      "Do the task fully: inspect the relevant code first, follow existing conventions, make the change, run the focused checks that prove it works, and fix what you broke.",
      "Stay inside the delegated scope. Do not refactor unrelated code or change files the task does not require.",
      "Finish with a short, plain report: what you changed (files), what you verified, and anything the parent must still decide or check.",
    ].join("\n"),
    tools,
    model: config.enforceModel ?? config.defaultModel,
    thinking: config.enforceThinking ?? config.defaultThinking,
    source: "builtin",
    activation: "propose",
    access: accessFor(tools, capabilities),
    capabilities,
    extensionPaths: capabilities.includes("web") ? [webExtensionPath] : [],
    filePath: "(built-in)",
  };
}

function loadAgentsFromDir(
  dir: string,
  source: "user" | "project",
  diagnostics: string[],
  webExtensionPath: string,
  config: SubagentConfig,
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
    const requestedActivation = stringValue(frontmatter.activation)?.toLowerCase();

    if (!AGENT_NAME.test(name)) {
      diagnostics.push(`${entry.name}: agent name must match ${AGENT_NAME.source}`);
      continue;
    }
    if (name === WORKER_AGENT) {
      diagnostics.push(`${entry.name}: "${WORKER_AGENT}" is the built-in profile and cannot be redefined`);
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
    if (requestedActivation && requestedActivation !== "propose" && requestedActivation !== "explicit") {
      diagnostics.push(`${entry.name}: ignored invalid activation "${requestedActivation}"`);
    }

    const capabilities = parseCapabilities(frontmatter.capabilities, entry.name, source, diagnostics);
    const tools = resolveTools(commaList(frontmatter.tools), DEFAULT_TOOLS, capabilities, entry.name, diagnostics);
    const activation: AgentActivation = source === "project"
      ? "explicit"
      : requestedActivation === "propose" ? "propose" : "explicit";

    agents.push({
      name,
      description,
      systemPrompt: body.trim(),
      tools,
      model: policyModel(stringValue(frontmatter.model), config, entry.name, diagnostics),
      thinking: policyThinking(stringValue(frontmatter.thinking)?.toLowerCase(), config, entry.name, diagnostics),
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

export function defaultWebExtensionPath(): string {
  return join(getAgentDir(), "npm", "node_modules", "pi-web-access", "index.ts");
}

export function discoverProjectAgents(cwd: string, options: AgentDiscoveryOptions = {}): ProjectAgentDiscovery {
  const config = loadSubagentConfig(options.config ?? {});
  const userAgentsDir = options.userAgentsDir ?? join(getAgentDir(), "agents");
  const webExtensionPath = options.webExtensionPath ?? defaultWebExtensionPath();
  const project = findNearestAgentsDir(cwd);
  const diagnostics: string[] = [];
  const agents: ProjectAgent[] = [workerAgent(config, webExtensionPath)];
  const names = new Set<string>([WORKER_AGENT]);

  for (const agent of loadAgentsFromDir(userAgentsDir, "user", diagnostics, webExtensionPath, config)) {
    if (names.has(agent.name)) {
      diagnostics.push(`${agent.filePath}: duplicate user agent name "${agent.name}"`);
      continue;
    }
    names.add(agent.name);
    agents.push(agent);
  }

  if (project && resolve(project.agentsDir) !== resolve(userAgentsDir)) {
    for (const agent of loadAgentsFromDir(project.agentsDir, "project", diagnostics, webExtensionPath, config)) {
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

/** Overrides a tool call may apply on top of a profile. */
export interface AdhocOverrides {
  tools?: string[];
  model?: string;
  thinking?: string;
  instructions?: string;
}

/** Derive the effective profile for one run from a named profile plus call-site overrides. */
export function applyOverrides(
  base: ProjectAgent,
  overrides: AdhocOverrides,
  config: SubagentConfig,
  diagnostics: string[],
): ProjectAgent {
  const label = `${base.name} call`;
  const tools = overrides.tools && overrides.tools.length > 0
    ? resolveTools(commaList(overrides.tools), base.tools, base.capabilities, label, diagnostics)
    : base.tools;
  const model = overrides.model ? policyModel(overrides.model, config, label, diagnostics) : base.model;
  const thinking = overrides.thinking ? policyThinking(overrides.thinking.toLowerCase(), config, label, diagnostics) : base.thinking;
  const systemPrompt = overrides.instructions?.trim()
    ? `${base.systemPrompt}\n\nAdditional instructions for this run:\n${overrides.instructions.trim()}`
    : base.systemPrompt;
  const changed = tools !== base.tools || model !== base.model || thinking !== base.thinking || systemPrompt !== base.systemPrompt;
  return {
    ...base,
    tools,
    model,
    thinking,
    systemPrompt,
    access: accessFor(tools, base.capabilities),
    source: changed && base.source === "builtin" ? "adhoc" : base.source,
  };
}
