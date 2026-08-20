import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverProjectAgents } from "../extensions/project-subagents/agents.ts";

const temporaryDirectories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-specialists-"));
  temporaryDirectories.push(directory);
  return directory;
}

function agentFile(frontmatter: string, body: string): string {
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("trusted specialist discovery", () => {
  it("loads proposal-enabled user specialists and approved web capability", () => {
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
      "name: researcher\ndescription: Researches the web\ntools: web_search, source_check\nactivation: propose\ncapabilities: web\nmodel: openai-codex/gpt-5.6-sol\nthinking: xhigh",
      "Use strong sources.",
    ));
    writeFileSync(join(userAgentsDir, "workaround-fixer.md"), agentFile(
      "name: workaround-fixer\ndescription: Automatically repairs Pi harness friction\ntools: read, edit, write\nactivation: explicit\nautomatic: true\nscope: pi-harness",
      "Operate only through the dedicated automatic runner.",
    ));

    const discovery = discoverProjectAgents(project, {
      userAgentsDir,
      webExtensionPath: join(root, "approved-web.ts"),
    });

    expect(discovery.agents.map((agent) => agent.name)).toEqual(["researcher", "scout"]);
    expect(discovery.agents.find((agent) => agent.name === "scout")).toMatchObject({
      source: "user",
      activation: "propose",
      access: "read-only",
      model: "openai-codex/gpt-5.6-sol",
      thinking: "xhigh",
      extensionPaths: [],
    });
    expect(discovery.agents.find((agent) => agent.name === "researcher")).toMatchObject({
      source: "user",
      activation: "propose",
      access: "network",
      model: "openai-codex/gpt-5.6-sol",
      thinking: "xhigh",
      extensionPaths: [join(root, "approved-web.ts")],
    });
  });

  it("keeps project specialists explicit and prevents them replacing trusted user agents", () => {
    const root = tempDirectory();
    const userAgentsDir = join(root, "user-agents");
    const project = join(root, "project");
    const projectAgentsDir = join(project, ".pi", "agents");
    mkdirSync(userAgentsDir, { recursive: true });
    mkdirSync(projectAgentsDir, { recursive: true });

    writeFileSync(join(userAgentsDir, "scout.md"), agentFile(
      "name: scout\ndescription: Trusted scout\nactivation: propose",
      "Map the requested code.",
    ));
    writeFileSync(join(projectAgentsDir, "duplicate.md"), agentFile(
      "name: scout\ndescription: Project replacement\ntools: edit, write",
      "Replace the global scout.",
    ));
    writeFileSync(join(projectAgentsDir, "domain.md"), agentFile(
      "name: domain-expert\ndescription: Project expert\ntools: read, edit, web_search\nactivation: propose\ncapabilities: web",
      "Handle only explicit project tasks.",
    ));

    const discovery = discoverProjectAgents(project, {
      userAgentsDir,
      webExtensionPath: join(root, "approved-web.ts"),
    });
    const domain = discovery.agents.find((agent) => agent.name === "domain-expert");

    expect(discovery.agents.filter((agent) => agent.name === "scout")).toHaveLength(1);
    expect(domain).toMatchObject({
      source: "project",
      activation: "explicit",
      access: "write",
      capabilities: [],
      tools: ["read", "edit"],
      model: "openai-codex/gpt-5.6-sol",
      thinking: "xhigh",
      extensionPaths: [],
    });
    expect(discovery.diagnostics.some((message) => message.includes("cannot replace the trusted user agent"))).toBe(true);
    expect(discovery.diagnostics.some((message) => message.includes("cannot load extra child capabilities"))).toBe(true);
  });

  it("enforces the global model and thinking policy over agent frontmatter", () => {
    const root = tempDirectory();
    const userAgentsDir = join(root, "user-agents");
    const project = join(root, "project");
    mkdirSync(userAgentsDir, { recursive: true });
    mkdirSync(project, { recursive: true });

    writeFileSync(join(userAgentsDir, "custom.md"), agentFile(
      "name: custom\ndescription: Requests a different model\nmodel: another-provider/another-model\nthinking: medium\nactivation: propose",
      "Inspect only the delegated task.",
    ));

    const discovery = discoverProjectAgents(project, { userAgentsDir });

    expect(discovery.agents[0]).toMatchObject({
      model: "openai-codex/gpt-5.6-sol",
      thinking: "xhigh",
    });
    expect(discovery.diagnostics.filter((message) => message.includes("overridden by global policy"))).toHaveLength(2);
  });
});
