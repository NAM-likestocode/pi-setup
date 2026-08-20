import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

export type HarnessCheck = {
  level: "pass" | "warn" | "fail";
  label: string;
  detail: string;
};

export const EXPECTED_PACKAGE_SPECS = [
  "git:github.com/MasuRii/pi-image-tools@b8977bbb4f416fd63db7c7c602db6dfe7b17f62c",
  "git:github.com/NAM-likestocode/pi-ask-user@b01089e7f67318e7d4fc3a44ad043c6d16c096e5",
  "npm:pi-web-access@0.15.0",
  "npm:pi-mcp-adapter@2.15.0",
  "npm:@narumitw/pi-lsp@0.39.0",
  "npm:@braintrust/pi-extension@0.10.0",
  "npm:pi-voice-stt@0.6.0",
] as const;

const EXPECTED_NPM_VERSIONS: Record<string, string> = {
  "pi-web-access": "0.15.0",
  "pi-mcp-adapter": "2.15.0",
  "@narumitw/pi-lsp": "0.39.0",
  "@braintrust/pi-extension": "0.10.0",
  "pi-voice-stt": "0.6.0",
};
const EXPECTED_ASK_USER_VERSION = "0.14.0";
const EXPECTED_ASK_USER_OWNER = "NAM-likestocode";
const ANYWHERE_PROTOCOL_MARKER = "ANYWHERE_PROMPT_PROTOCOL_VERSION = 2";
const SERVER_COMPACTION_MARKER = "PI_HARNESS_SERVER_COMPACTION_V1";
const VOICE_STT_WINDOWS_MARKER = "PI_HARNESS_FFMPEG_GRACEFUL_STOP_V1";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

export function isPinnedPackageSpec(spec: string): boolean {
  if (spec.startsWith("npm:")) {
    const packagePart = spec.slice(4);
    const separator = packagePart.lastIndexOf("@");
    return separator > 0 && separator < packagePart.length - 1;
  }
  if (spec.startsWith("git:")) {
    const separator = spec.lastIndexOf("@");
    return separator > "git:".length && separator < spec.length - 1;
  }
  return false;
}

export async function collectHarnessChecks(agentDir: string, activeTools: string[]): Promise<HarnessCheck[]> {
  const checks: HarnessCheck[] = [];
  const settingsPath = join(agentDir, "settings.json");
  try {
    const settings = await readJson(settingsPath);
    checks.push({
      level: settings.defaultProjectTrust === "ask" ? "pass" : "fail",
      label: "Project trust",
      detail: `defaultProjectTrust=${String(settings.defaultProjectTrust ?? "default")}`,
    });
    const packages = Array.isArray(settings.packages) ? settings.packages.filter((item): item is string => typeof item === "string") : [];
    const unpinned = packages.filter((spec) => !isPinnedPackageSpec(spec));
    checks.push({
      level: unpinned.length === 0 ? "pass" : "fail",
      label: "Package pins",
      detail: unpinned.length === 0 ? `${packages.length} package specs pinned` : `unpinned: ${unpinned.join(", ")}`,
    });
    const drift = EXPECTED_PACKAGE_SPECS.filter((spec) => !packages.includes(spec));
    checks.push({
      level: drift.length === 0 ? "pass" : "warn",
      label: "Package lock manifest",
      detail: drift.length === 0 ? "settings match the reviewed package manifest" : `${drift.length} reviewed specs differ; update tests and provenance intentionally`,
    });
  } catch (error) {
    checks.push({ level: "fail", label: "Settings", detail: error instanceof Error ? error.message : String(error) });
  }

  for (const [name, expected] of Object.entries(EXPECTED_NPM_VERSIONS)) {
    try {
      const manifest = await readJson(join(agentDir, "npm", "node_modules", name, "package.json"));
      const actual = String(manifest.version ?? "unknown");
      checks.push({ level: actual === expected ? "pass" : "fail", label: name, detail: `installed=${actual}, expected=${expected}` });
    } catch (error) {
      checks.push({ level: "fail", label: name, detail: `not readable: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  try {
    const recorder = await readFile(join(agentDir, "npm", "node_modules", "pi-voice-stt", "src", "audio", "ffmpeg-recorder.ts"), "utf8");
    const graceful = recorder.includes(VOICE_STT_WINDOWS_MARKER)
      && recorder.includes('input.write("q")')
      && !recorder.includes('"-nostdin"');
    checks.push({
      level: graceful ? "pass" : "fail",
      label: "Pi Voice STT Windows capture",
      detail: graceful ? "FFmpeg exits through its native q command and finalizes WAV recordings" : "managed graceful-stop fix is missing; run npm run patch:voice",
    });
  } catch (error) {
    checks.push({ level: "fail", label: "Pi Voice STT Windows capture", detail: error instanceof Error ? error.message : String(error) });
  }

  const askUserDir = join(agentDir, "git", "github.com", EXPECTED_ASK_USER_OWNER, "pi-ask-user");
  try {
    const manifest = await readJson(join(askUserDir, "package.json"));
    const source = await readFile(join(askUserDir, "index.ts"), "utf8");
    const version = String(manifest.version ?? "unknown");
    const cooperative = source.includes(ANYWHERE_PROTOCOL_MARKER) && source.includes("ANYWHERE_PROMPT_OPEN_CHANNEL");
    checks.push({
      level: version === EXPECTED_ASK_USER_VERSION && cooperative ? "pass" : "fail",
      label: "pi-ask-user cooperative transport",
      detail: `version=${version}, protocol-v2=${cooperative}`,
    });
  } catch (error) {
    checks.push({ level: "fail", label: "pi-ask-user cooperative transport", detail: error instanceof Error ? error.message : String(error) });
  }

  const piAiApiDir = join(
    process.env.LOCALAPPDATA ?? "",
    "pi-node",
    "current",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "node_modules",
    "@earendil-works",
    "pi-ai",
    "dist",
    "api",
  );
  try {
    const piAiPackage = await readJson(join(piAiApiDir, "..", "..", "package.json"));
    const installedPiAiVersion = String(piAiPackage.version ?? "unknown");
    if (installedPiAiVersion !== "0.82.1") {
      checks.push({ level: "warn", label: "Responses server compaction", detail: `managed patch is version-locked to pi-ai 0.82.1; installed=${installedPiAiVersion}; skipped` });
    } else {
      const codexProvider = await readFile(join(piAiApiDir, "openai-codex-responses.js"), "utf8");
      const sharedProvider = await readFile(join(piAiApiDir, "openai-responses-shared.js"), "utf8");
      const patched = codexProvider.includes(SERVER_COMPACTION_MARKER)
        && sharedProvider.includes(SERVER_COMPACTION_MARKER)
        && codexProvider.includes("SERVER_COMPACTION_THRESHOLD = 200_000");
      checks.push({
        level: patched ? "pass" : "fail",
        label: "Responses server compaction",
        detail: patched ? "Codex Responses uses encrypted server compaction at 200K with unsupported-parameter fallback" : "managed pi-ai patch missing or incompatible",
      });
    }
  } catch (error) {
    checks.push({ level: "warn", label: "Responses server compaction", detail: error instanceof Error ? error.message : String(error) });
  }

  const legacyCloudflared = join(agentDir, "extensions", "anywhere", "bin", "cloudflared-windows-amd64.exe");
  checks.push({
    level: (await exists(legacyCloudflared)) ? "warn" : "pass",
    label: "Legacy tunnel binary",
    detail: (await exists(legacyCloudflared)) ? "unused cloudflared binary is still present" : "absent; Anywhere uses Tailscale Serve",
  });

  const scaffold = ["package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", "tests", ".gitignore", "APPEND_SYSTEM.md", "pi-lsp.json", "scripts/responses-compaction-patch.mjs", "scripts/pi-voice-stt-windows-patch.mjs", "extensions/00-dynamic-tool-loader.ts", "extensions/auto-workaround-fixer/index.ts", "extensions/auto-workaround-fixer/child-guard.ts", "extensions/auto-workaround-fixer/workspace.ts", "extensions/auto-workaround-fixer/restricted-check.ts"];
  const missing = [] as string[];
  for (const relative of scaffold) if (!(await exists(join(agentDir, relative)))) missing.push(relative);
  checks.push({ level: missing.length === 0 ? "pass" : "warn", label: "Harness checks", detail: missing.length === 0 ? "typecheck/test scaffold and communication preferences present" : `missing: ${missing.join(", ")}` });

  const proposalSpecialists = ["scout.md", "researcher.md", "reviewer.md"];
  const specialistIssues: string[] = [];
  for (const file of proposalSpecialists) {
    try {
      const source = await readFile(join(agentDir, "agents", file), "utf8");
      const frontmatter = source.split("---")[1] ?? "";
      const tools = frontmatter.match(/^tools:\s*(.+)$/m)?.[1] ?? "";
      if (!/^activation:\s*propose\s*$/m.test(frontmatter)) specialistIssues.push(`${file}: not proposal-enabled`);
      if (!/^model:\s*openai-codex\/gpt-5\.6-sol\s*$/m.test(frontmatter)) specialistIssues.push(`${file}: model is not openai-codex/gpt-5.6-sol`);
      if (!/^thinking:\s*xhigh\s*$/m.test(frontmatter)) specialistIssues.push(`${file}: thinking is not xhigh`);
      if (/(?:^|,\s*)(?:bash|edit|write)(?:\s*,|$)/i.test(tools)) specialistIssues.push(`${file}: has mutating or shell access`);
    } catch {
      specialistIssues.push(`${file}: missing`);
    }
  }
  try {
    const source = await readFile(join(agentDir, "agents", "workaround-fixer.md"), "utf8");
    const frontmatter = source.split("---")[1] ?? "";
    const tools = frontmatter.match(/^tools:\s*(.+)$/m)?.[1] ?? "";
    if (!/^activation:\s*explicit\s*$/m.test(frontmatter)) specialistIssues.push("workaround-fixer.md: generic activation is not explicit");
    if (!/^automatic:\s*true\s*$/m.test(frontmatter)) specialistIssues.push("workaround-fixer.md: automatic marker missing");
    if (!/^scope:\s*pi-harness\s*$/m.test(frontmatter)) specialistIssues.push("workaround-fixer.md: scope is not pi-harness");
    if (!/^model:\s*openai-codex\/gpt-5\.6-sol\s*$/m.test(frontmatter)) specialistIssues.push("workaround-fixer.md: model is not openai-codex/gpt-5.6-sol");
    if (!/^thinking:\s*xhigh\s*$/m.test(frontmatter)) specialistIssues.push("workaround-fixer.md: thinking is not xhigh");
    if (!/(?:^|,\s*)edit(?:\s*,|$)/i.test(tools) || !/(?:^|,\s*)write(?:\s*,|$)/i.test(tools)) specialistIssues.push("workaround-fixer.md: staged write tools missing");
    if (/(?:^|,\s*)bash(?:\s*,|$)/i.test(tools)) specialistIssues.push("workaround-fixer.md: arbitrary shell access enabled");
  } catch {
    specialistIssues.push("workaround-fixer.md: missing");
  }
  checks.push({
    level: specialistIssues.length === 0 ? "pass" : "fail",
    label: "Specialist roster",
    detail: specialistIssues.length === 0 ? "three proposal-only read-only specialists plus the staged automatic Pi workaround fixer use gpt-5.6-sol/xhigh" : specialistIssues.join("; "),
  });

  checks.push({
    level: activeTools.length <= 18 ? "pass" : "warn",
    label: "Active tool surface",
    detail: `${activeTools.length} active tools${activeTools.length > 18 ? "; use /tool-loader reset to return dynamic tools to on-demand loading" : "; larger tool groups load on demand"}`,
  });

  return checks;
}
