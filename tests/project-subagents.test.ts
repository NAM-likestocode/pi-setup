import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyOverrides,
  defaultConfig,
  detectAuthExtensions,
  discoverProjectAgents,
  loadSubagentConfig,
  poolEntry,
  poolFallbackOrder,
  WORKER_AGENT,
  type PoolModel,
} from "../extensions/project-subagents/agents.ts";

const temporaryDirectories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-specialists-"));
  temporaryDirectories.push(directory);
  return directory;
}

function agentFile(frontmatter: string, body: string): string {
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

/** Discovery with an empty, non-existent config file so host settings never leak into tests. */
function discover(cwd: string, options: Parameters<typeof discoverProjectAgents>[1] = {}) {
  return discoverProjectAgents(cwd, { ...options, config: { ...defaultConfig(), childExtensions: [], ...(options.config ?? {}) } });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("subagent profile discovery", () => {
  it("always offers the built-in worker and loads user specialists with their own model and thinking", () => {
    const root = tempDirectory();
    const userAgentsDir = join(root, "user-agents");
    const project = join(root, "project");
    mkdirSync(userAgentsDir, { recursive: true });
    mkdirSync(project, { recursive: true });

    writeFileSync(join(userAgentsDir, "scout.md"), agentFile(
      "name: scout\ndescription: Maps code\ntools: read, grep, find, ls\nactivation: propose\nmodel: openai-codex/gpt-5.6-sol\nthinking: xhigh",
      "Inspect only the delegated area.",
    ));
    writeFileSync(join(userAgentsDir, "researcher.md"), agentFile(
      "name: researcher\ndescription: Researches the web\ntools: web_search, source_check\nactivation: propose\ncapabilities: web",
      "Use strong sources.",
    ));
    writeFileSync(join(userAgentsDir, "workaround-fixer.md"), agentFile(
      "name: workaround-fixer\ndescription: Automatically repairs Pi harness friction\ntools: read, edit, write\nactivation: explicit\nautomatic: true\nscope: pi-harness",
      "Operate only through the dedicated automatic runner.",
    ));

    const discovery = discover(project, { userAgentsDir, webExtensionPath: join(root, "approved-web.ts") });

    expect(discovery.agents.map((agent) => agent.name)).toEqual([WORKER_AGENT, "researcher", "scout"]);
    expect(discovery.agents.find((agent) => agent.name === "scout")).toMatchObject({
      source: "user",
      activation: "propose",
      access: "read-only",
      model: "openai-codex/gpt-5.6-sol",
      thinking: "xhigh",
      extensionPaths: [],
    });
    // No model/thinking in frontmatter → inherit the parent's.
    expect(discovery.agents.find((agent) => agent.name === "researcher")).toMatchObject({
      access: "network",
      model: "inherit",
      thinking: "inherit",
      extensionPaths: [join(root, "approved-web.ts")],
    });
    expect(discovery.diagnostics).toEqual([]);
  });

  it("gives the built-in worker full tools, write access, and web tools only when the web extension exists", () => {
    const root = tempDirectory();
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    const webPath = join(root, "web.ts");

    const without = discover(project, { userAgentsDir: join(root, "none"), webExtensionPath: webPath }).agents[0];
    expect(without).toMatchObject({ name: WORKER_AGENT, source: "builtin", access: "write", capabilities: [], extensionPaths: [] });
    expect(without.tools).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);

    writeFileSync(webPath, "export default () => {}");
    const withWeb = discover(project, { userAgentsDir: join(root, "none"), webExtensionPath: webPath }).agents[0];
    expect(withWeb.capabilities).toEqual(["web"]);
    expect(withWeb.tools).toContain("web_search");
    expect(withWeb.extensionPaths).toEqual([webPath]);
  });

  it("keeps project specialists explicit and prevents them replacing trusted user agents or the worker", () => {
    const root = tempDirectory();
    const userAgentsDir = join(root, "user-agents");
    const project = join(root, "project");
    const projectAgentsDir = join(project, ".pi", "agents");
    mkdirSync(userAgentsDir, { recursive: true });
    mkdirSync(projectAgentsDir, { recursive: true });

    writeFileSync(join(userAgentsDir, "scout.md"), agentFile("name: scout\ndescription: Trusted scout\nactivation: propose", "Map the requested code."));
    writeFileSync(join(projectAgentsDir, "duplicate.md"), agentFile("name: scout\ndescription: Project replacement\ntools: edit, write", "Replace the global scout."));
    writeFileSync(join(projectAgentsDir, "worker.md"), agentFile("name: worker\ndescription: Replace the worker\ntools: bash", "Nope."));
    writeFileSync(join(projectAgentsDir, "domain.md"), agentFile(
      "name: domain-expert\ndescription: Project expert\ntools: read, edit, web_search\nactivation: propose\ncapabilities: web",
      "Handle only explicit project tasks.",
    ));

    const discovery = discover(project, { userAgentsDir, webExtensionPath: join(root, "approved-web.ts") });
    const domain = discovery.agents.find((agent) => agent.name === "domain-expert");

    expect(discovery.agents.filter((agent) => agent.name === "scout")).toHaveLength(1);
    expect(discovery.agents.filter((agent) => agent.name === WORKER_AGENT)).toHaveLength(1);
    expect(discovery.agents.find((agent) => agent.name === WORKER_AGENT)?.source).toBe("builtin");
    expect(domain).toMatchObject({ source: "project", activation: "explicit", access: "write", capabilities: [], tools: ["read", "edit"] });
    expect(discovery.diagnostics.some((message) => message.includes("cannot replace the trusted user agent"))).toBe(true);
    expect(discovery.diagnostics.some((message) => message.includes("cannot load extra child capabilities"))).toBe(true);
    expect(discovery.diagnostics.some((message) => message.includes("built-in profile and cannot be redefined"))).toBe(true);
  });

  it("enforces a global model and thinking only when configured", () => {
    const root = tempDirectory();
    const userAgentsDir = join(root, "user-agents");
    const project = join(root, "project");
    mkdirSync(userAgentsDir, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(userAgentsDir, "custom.md"), agentFile(
      "name: custom\ndescription: Requests a different model\nmodel: another-provider/another-model\nthinking: medium\nactivation: propose",
      "Inspect only the delegated task.",
    ));

    const free = discover(project, { userAgentsDir });
    expect(free.agents.find((agent) => agent.name === "custom")).toMatchObject({ model: "another-provider/another-model", thinking: "medium" });
    expect(free.diagnostics).toEqual([]);

    const enforced = discover(project, { userAgentsDir, config: { enforceModel: "openai-codex/gpt-5.6-sol", enforceThinking: "xhigh" } });
    expect(enforced.agents.find((agent) => agent.name === "custom")).toMatchObject({ model: "openai-codex/gpt-5.6-sol", thinking: "xhigh" });
    expect(enforced.agents[0]).toMatchObject({ name: WORKER_AGENT, model: "openai-codex/gpt-5.6-sol", thinking: "xhigh" });
    expect(enforced.diagnostics.filter((message) => message.includes("overridden by enforce"))).toHaveLength(2);
  });
});

describe("run overrides", () => {
  it("lets a call restrict tools, pick a model and add instructions without touching the profile", () => {
    const root = tempDirectory();
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    const config = defaultConfig();
    const worker = discover(project, { userAgentsDir: join(root, "none"), webExtensionPath: join(root, "missing.ts") }).agents[0];

    const diagnostics: string[] = [];
    const run = applyOverrides(worker, {
      tools: ["read", "grep", "web_search"],
      model: "anthropic/claude-haiku-4-5",
      thinking: "low",
      instructions: "Use tabs.",
    }, config, diagnostics);

    expect(run.tools).toEqual(["read", "grep"]);
    expect(run.access).toBe("read-only");
    expect(run.model).toBe("anthropic/claude-haiku-4-5");
    expect(run.thinking).toBe("low");
    expect(run.systemPrompt).toContain("Use tabs.");
    expect(run.source).toBe("adhoc");
    expect(worker.tools).toHaveLength(7);
    expect(diagnostics.some((message) => message.includes("web_search"))).toBe(true);

    const bad: string[] = [];
    expect(applyOverrides(worker, { model: "not-a-model", thinking: "ultra" }, config, bad)).toMatchObject({ model: "inherit", thinking: "inherit" });
    expect(bad).toHaveLength(2);
  });
});

describe("child auth extensions", () => {
  it("detects installed *-auth packages and their extension entries", () => {
    const root = tempDirectory();
    const nm = join(root, "node_modules");
    mkdirSync(join(nm, "@vendor", "pi-anthropic-auth", "src"), { recursive: true });
    mkdirSync(join(nm, "pi-web-access"), { recursive: true });
    mkdirSync(join(nm, "author-tools"), { recursive: true });
    writeFileSync(join(nm, "@vendor", "pi-anthropic-auth", "package.json"), JSON.stringify({ name: "@vendor/pi-anthropic-auth", pi: { extensions: ["./src/index.ts"] } }));
    writeFileSync(join(nm, "@vendor", "pi-anthropic-auth", "src", "index.ts"), "export default () => {}");
    writeFileSync(join(nm, "pi-web-access", "package.json"), JSON.stringify({ name: "pi-web-access", pi: { extensions: ["./index.ts"] } }));
    writeFileSync(join(nm, "pi-web-access", "index.ts"), "export default () => {}");
    writeFileSync(join(nm, "author-tools", "package.json"), JSON.stringify({ name: "author-tools", pi: { extensions: ["./index.ts"] } }));
    writeFileSync(join(nm, "author-tools", "index.ts"), "export default () => {}");

    expect(detectAuthExtensions(nm)).toEqual([join(nm, "@vendor", "pi-anthropic-auth", "src", "index.ts")]);
    expect(detectAuthExtensions(join(root, "missing"))).toEqual([]);
  });

  it("finds the real pi-anthropic-auth package on this machine when installed", () => {
    const found = detectAuthExtensions();
    for (const path of found) expect(path).toMatch(/auth/i);
  });
});

describe("model pool", () => {
  const pool: PoolModel[] = [
    { label: "opus", id: "anthropic/claude-opus-5", thinking: "xhigh", use: "implementation" },
    { label: "luna", id: "openai-codex/gpt-5.6-luna", thinking: "max", use: "deep thinking" },
  ];

  it("routes every child onto a pool model, by label or id, defaulting to the first entry", () => {
    const root = tempDirectory();
    const userAgentsDir = join(root, "user-agents");
    const project = join(root, "project");
    mkdirSync(userAgentsDir, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(userAgentsDir, "scout.md"), agentFile("name: scout\ndescription: Maps code\nmodel: openai-codex/gpt-5.6-sol\nactivation: propose", "Map."));
    writeFileSync(join(userAgentsDir, "thinker.md"), agentFile("name: thinker\ndescription: Thinks\nmodel: luna\nactivation: propose", "Think."));

    const discovery = discover(project, { userAgentsDir, config: { models: pool } });
    expect(discovery.agents.find((agent) => agent.name === WORKER_AGENT)?.model).toBe("anthropic/claude-opus-5");
    expect(discovery.agents.find((agent) => agent.name === "scout")?.model).toBe("anthropic/claude-opus-5");
    expect(discovery.agents.find((agent) => agent.name === "thinker")?.model).toBe("openai-codex/gpt-5.6-luna");
    expect(discovery.diagnostics.some((message) => message.includes("not in the subagent model pool"))).toBe(true);

    const config = { ...defaultConfig(), childExtensions: [], models: pool };
    const worker = discovery.agents[0];
    const diagnostics: string[] = [];
    expect(applyOverrides(worker, { model: "LUNA" }, config, diagnostics).model).toBe("openai-codex/gpt-5.6-luna");
    expect(applyOverrides(worker, { model: "anthropic/claude-opus-5" }, config, diagnostics).model).toBe("anthropic/claude-opus-5");
    expect(applyOverrides(worker, { model: "anthropic/claude-haiku-4-5" }, config, diagnostics).model).toBe("anthropic/claude-opus-5");
    expect(diagnostics).toHaveLength(1);
  });

  it("matches labels case-insensitively and orders fallbacks from the chosen entry", () => {
    expect(poolEntry(pool, "Luna")?.id).toBe("openai-codex/gpt-5.6-luna");
    expect(poolEntry(pool, "anthropic/claude-opus-5")?.label).toBe("opus");
    expect(poolEntry(pool, "nope")).toBeUndefined();
    expect(poolFallbackOrder(pool, "openai-codex/gpt-5.6-luna").map((entry) => entry.label)).toEqual(["luna", "opus"]);
    expect(poolFallbackOrder(pool, "x").map((entry) => entry.label)).toEqual(["opus", "luna"]);
  });

  it("parses the pool from config and drops malformed entries", () => {
    const root = tempDirectory();
    const path = join(root, "subagents.json");
    writeFileSync(path, JSON.stringify({ models: [
      { label: "opus", id: "anthropic/claude-opus-5", thinking: "xhigh", use: "code" },
      { label: "opus", id: "anthropic/claude-opus-4-8" },
      { label: "bad id", id: "no-slash" },
      { id: "openai-codex/gpt-5.6-luna" },
      { label: "luna", id: "openai-codex/gpt-5.6-luna", thinking: "ultra" },
    ] }));
    const loaded = loadSubagentConfig({}, path);
    expect(loaded.models).toEqual([
      { label: "opus", id: "anthropic/claude-opus-5", thinking: "xhigh", use: "code" },
      { label: "luna", id: "openai-codex/gpt-5.6-luna", thinking: undefined, use: "" },
    ]);
  });
});

describe("subagent config", () => {
  it("reads ~/.pi/agent/subagents.json over sane defaults and ignores invalid values", () => {
    const root = tempDirectory();
    const path = join(root, "subagents.json");
    expect(loadSubagentConfig({}, path)).toMatchObject({ approval: "never", defaultModel: "inherit", defaultMode: "background", maxConcurrent: 4, maxDepth: 2 });

    writeFileSync(path, JSON.stringify({
      approval: "always",
      defaultModel: "anthropic/claude-haiku-4-5",
      defaultThinking: "bogus",
      maxConcurrent: 2.7,
      maxDepth: -1,
      defaultMode: "wait",
      transcriptDir: "~/.cache/pi-subagents",
    }));
    const loaded = loadSubagentConfig({}, path);
    expect(loaded).toMatchObject({ approval: "always", defaultModel: "anthropic/claude-haiku-4-5", defaultThinking: "inherit", maxConcurrent: 2, maxDepth: 2, defaultMode: "wait" });
    expect(loaded.transcriptDir.endsWith("/.cache/pi-subagents")).toBe(true);
    expect(loaded.transcriptDir.startsWith("~")).toBe(false);

    writeFileSync(path, "{ not json");
    expect(loadSubagentConfig({}, path).approval).toBe("never");
  });
});
