import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collectHarnessChecks } from "./_shared/harness-health.ts";

const AGENT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

export default function harnessDoctor(pi: ExtensionAPI): void {
  pi.registerCommand("harness-doctor", {
    description: "Check harness pins, compatibility, trust, tests, and active tool surface",
    handler: async (_args, ctx) => {
      const checks = await collectHarnessChecks(AGENT_DIR, pi.getActiveTools());
      const marker = { pass: "✓", warn: "!", fail: "✗" } as const;
      const failures = checks.filter((check) => check.level === "fail").length;
      const warnings = checks.filter((check) => check.level === "warn").length;
      const lines = checks.map((check) => `${marker[check.level]} ${check.label}: ${check.detail}`);
      lines.unshift(`Harness doctor: ${failures} failure(s), ${warnings} warning(s)`);
      ctx.ui.notify(lines.join("\n"), failures > 0 ? "error" : warnings > 0 ? "warning" : "info");
    },
  });
}
