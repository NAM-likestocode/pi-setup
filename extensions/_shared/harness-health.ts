import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

export type HarnessCheck = {
  level: "pass" | "warn" | "fail";
  label: string;
  detail: string;
};

export const EXPECTED_PACKAGE_SPECS = [
  "git:github.com/MasuRii/pi-image-tools@b8977bbb4f416fd63db7c7c602db6dfe7b17f62c",
  "git:github.com/edlsh/pi-ask-user@1ad2adf7010c4ac5068668b6999bc1eb98a864a7",
  "npm:context-mode@1.0.169",
  "npm:pi-web-access@0.15.0",
  "npm:pi-mcp-adapter@2.15.0",
] as const;

const EXPECTED_NPM_VERSIONS: Record<string, string> = {
  "context-mode": "1.0.169",
  "pi-web-access": "0.15.0",
  "pi-mcp-adapter": "2.15.0",
};
const EXPECTED_ASK_USER_VERSION = "0.13.0";
const EXPECTED_PATCH_SHA256 = "3e3f8f1f41b04169dea175bcc7ad8742170663076ac8288335a45e7e5cc836e3";
const ANYWHERE_PROTOCOL_MARKER = "ANYWHERE_ASK_PROTOCOL_VERSION = 1";
const SERVER_COMPACTION_MARKER = "PI_HARNESS_SERVER_COMPACTION_V1";

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

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
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

  const askUserDir = join(agentDir, "git", "github.com", "edlsh", "pi-ask-user");
  try {
    const manifest = await readJson(join(askUserDir, "package.json"));
    const source = await readFile(join(askUserDir, "index.ts"), "utf8");
    const version = String(manifest.version ?? "unknown");
    checks.push({
      level: version === EXPECTED_ASK_USER_VERSION && source.includes(ANYWHERE_PROTOCOL_MARKER) ? "pass" : "fail",
      label: "pi-ask-user Anywhere hook",
      detail: `version=${version}, protocol-v1=${source.includes(ANYWHERE_PROTOCOL_MARKER)}`,
    });
  } catch (error) {
    checks.push({ level: "fail", label: "pi-ask-user Anywhere hook", detail: error instanceof Error ? error.message : String(error) });
  }

  const patchPath = join(agentDir, "extensions", "anywhere", "pi-ask-user-anywhere.patch");
  try {
    const actual = await sha256(patchPath);
    checks.push({ level: actual === EXPECTED_PATCH_SHA256 ? "pass" : "fail", label: "Anywhere patch", detail: `sha256=${actual}` });
  } catch (error) {
    checks.push({ level: "fail", label: "Anywhere patch", detail: error instanceof Error ? error.message : String(error) });
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
  } catch (error) {
    checks.push({ level: "fail", label: "Responses server compaction", detail: error instanceof Error ? error.message : String(error) });
  }

  const legacyCloudflared = join(agentDir, "extensions", "anywhere", "bin", "cloudflared-windows-amd64.exe");
  checks.push({
    level: (await exists(legacyCloudflared)) ? "warn" : "pass",
    label: "Legacy tunnel binary",
    detail: (await exists(legacyCloudflared)) ? "unused cloudflared binary is still present" : "absent; Anywhere uses Tailscale Serve",
  });

  const scaffold = ["package.json", "package-lock.json", "tsconfig.json", "vitest.config.ts", "tests", ".gitignore", "scripts/responses-compaction-patch.mjs", "extensions/00-dynamic-tool-loader.ts"];
  const missing = [] as string[];
  for (const relative of scaffold) if (!(await exists(join(agentDir, relative)))) missing.push(relative);
  checks.push({ level: missing.length === 0 ? "pass" : "warn", label: "Harness checks", detail: missing.length === 0 ? "typecheck/test scaffold present" : `missing: ${missing.join(", ")}` });
  checks.push({
    level: activeTools.length <= 18 ? "pass" : "warn",
    label: "Active tool surface",
    detail: `${activeTools.length} active tools${activeTools.length > 18 ? "; use /tool-loader reset to return dynamic tools to on-demand loading" : "; larger tool groups load on demand"}`, 
  });

  return checks;
}
