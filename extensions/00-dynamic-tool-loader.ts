import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const STATE_TYPE = "dynamic-tool-loader-state";
const PLAN_STATE_TYPE = "detailed-plan-mode-state";

const DYNAMIC_TOOL_NAMES = new Set([
  "web_search",
  "source_check",
  "fetch_content",
  "get_search_content",
  "mcp",
  "subagent",
  "ctx_execute",
  "ctx_execute_file",
  "ctx_index",
  "ctx_search",
  "ctx_fetch_and_index",
  "ctx_batch_execute",
  "ctx_stats",
  "ctx_doctor",
  "ctx_upgrade",
  "ctx_purge",
  "ctx_insight",
]);

const TOOL_ALIASES: Record<string, string> = {
  web_search: "web internet online current latest news research search",
  source_check: "verify fact claim evidence citation source research",
  fetch_content: "fetch url webpage github youtube video transcript content",
  get_search_content: "retrieve previous web result full page content response id",
  mcp: "model context protocol external server gateway remote tools",
  subagent: "delegate delegation another agent project worker researcher workaround root cause permanent fix native supported shim hack",
  ctx_execute: "run command tests build logs shell cli api response sandbox context mode",
  ctx_execute_file: "analyze large file log csv json source code parse context mode",
  ctx_index: "index local documentation project knowledge base context mode",
  ctx_search: "search indexed documentation memory knowledge base context mode",
  ctx_fetch_and_index: "fetch documentation url index web docs context mode",
  ctx_batch_execute: "batch commands parallel git logs issues multi command context mode",
  ctx_stats: "context usage savings statistics tokens context mode",
  ctx_doctor: "diagnose context mode installation hooks runtimes",
  ctx_upgrade: "upgrade update context mode installation",
  ctx_purge: "delete wipe purge context knowledge base destructive",
  ctx_insight: "open insight analytics dashboard context mode",
};

type LoaderState = { enabledTools: string[] };

const SEARCH_PARAMS = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 500, description: "Capability or task to search for" }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
});

export function isDynamicTool(name: string): boolean {
  return DYNAMIC_TOOL_NAMES.has(name);
}

export function shouldConsiderSubagent(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const explicit = /\b(?:sub[ -]?agents?|delegat(?:e|ion)|another agent)\b/.test(text);
  const research = /\b(?:research|fact[- ]?check|benchmark|sources?|current|latest|up[- ]to[- ]date)\b/.test(text);
  const review = /\b(?:review|audit|security|threat model|regression|risk assessment)\b/.test(text);
  const workaround = /\b(?:workarounds?|work[ -]?around|hacks?|shim|monkey[ -]?patch|temporary fix|fallback)\b/.test(text);
  const broadScope = /\b(?:codebase|repository|repo-wide|cross-cutting|architecture|multiple modules|across the project)\b/.test(text);
  const investigation = /\b(?:explore|map|trace|locate|understand|investigate|find all)\b/.test(text);
  return explicit || research || review || workaround || (broadScope && investigation);
}

export function searchDynamicTools(tools: ToolInfo[], query: string, limit = 5): string[] {
  const terms = query.toLowerCase().split(/[^a-z0-9_.:-]+/).filter((term) => term.length > 1);
  return tools
    .filter((tool) => isDynamicTool(tool.name))
    .map((tool) => {
      const name = tool.name.toLowerCase();
      const haystack = `${name} ${tool.description ?? ""} ${TOOL_ALIASES[tool.name] ?? ""}`.toLowerCase();
      const score = terms.reduce((total, term) => total + (name === term ? 5 : name.includes(term) ? 3 : haystack.includes(term) ? 1 : 0), 0);
      return { name: tool.name, score };
    })
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, Math.max(1, Math.min(10, limit)))
    .map((match) => match.name);
}

function latestCustomState<T>(entries: any[], customType: string): T | undefined {
  const entry = entries.filter((candidate) => candidate.type === "custom" && candidate.customType === customType).pop();
  return entry?.data as T | undefined;
}

export default function dynamicToolLoader(pi: ExtensionAPI): void {
  let enabledTools = new Set<string>();

  const persist = () => pi.appendEntry<LoaderState>(STATE_TYPE, { enabledTools: [...enabledTools].sort() });
  const availableDynamicNames = () => new Set(pi.getAllTools().filter((tool) => isDynamicTool(tool.name)).map((tool) => tool.name));
  const activate = (names: string[], persistChange = true): string[] => {
    const available = availableDynamicNames();
    const active = pi.getActiveTools();
    const added = names.filter((name) => available.has(name) && !active.includes(name));
    if (added.length === 0) return [];
    for (const name of added) enabledTools.add(name);
    pi.setActiveTools([...new Set([...active, ...added])]);
    if (persistChange) persist();
    return added;
  };

  pi.registerTool({
    name: "search_tools",
    label: "Search Tools",
    description: "Search for and enable currently inactive web, context-mode, MCP, or project-subagent tools relevant to a task",
    promptSnippet: "Search and enable additional tools when the active tools cannot perform the task",
    promptGuidelines: ["Use search_tools when the task requires a web, context-mode, MCP, or delegation capability that is not currently active."],
    parameters: SEARCH_PARAMS,
    async execute(_toolCallId, params) {
      const matches = searchDynamicTools(pi.getAllTools(), params.query, params.limit ?? 5);
      if (matches.length === 0) {
        return { content: [{ type: "text", text: `No additional tools found for: ${params.query}` }], details: { matches: [], added: [] } };
      }
      const added = activate(matches);
      return {
        content: [{ type: "text", text: added.length > 0 ? `Loaded tools: ${added.join(", ")}` : `Matching tools already active: ${matches.join(", ")}` }],
        details: { matches, added },
      };
    },
  });

  pi.registerCommand("tool-loader", {
    description: "Show or reset dynamically loaded tools: /tool-loader [status|reset]",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "status";
      if (action === "status") {
        const active = pi.getActiveTools().filter((name) => isDynamicTool(name));
        ctx.ui.notify(active.length > 0 ? `Dynamically loaded tools: ${active.join(", ")}` : "No dynamic tools are currently loaded.", "info");
        return;
      }
      if (action === "reset") {
        enabledTools.clear();
        pi.setActiveTools(pi.getActiveTools().filter((name) => !isDynamicTool(name)));
        persist();
        ctx.ui.notify("Dynamic tools reset. Use search_tools to load capabilities on demand.", "info");
        return;
      }
      ctx.ui.notify("Usage: /tool-loader [status|reset]", "warning");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getBranch() as any[];
    const saved = latestCustomState<LoaderState>(entries, STATE_TYPE);
    const plan = latestCustomState<{ stage?: string }>(entries, PLAN_STATE_TYPE);
    const available = availableDynamicNames();
    enabledTools = new Set((saved?.enabledTools ?? []).filter((name) => available.has(name)));
    const base = pi.getActiveTools().filter((name) => !isDynamicTool(name));
    if (plan?.stage === "planning") {
      pi.setActiveTools(base);
      return;
    }
    pi.setActiveTools([...new Set([...base, "search_tools", ...enabledTools])]);
  });

  pi.on("before_agent_start", async (event) => {
    if (typeof event.prompt !== "string" || !shouldConsiderSubagent(event.prompt)) return;
    activate(["subagent"]);
  });
}
