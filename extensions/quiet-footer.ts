/**
 * Quiet footer: `/verbose off` swaps Pi's built-in three-line footer for a
 * reduced one that keeps only what is needed at a glance.
 *
 * Kept:    path · session name, context usage (coloured when high), model and
 *          thinking level, and extension statuses that signal an *active* mode
 *          or warning (autopilot, delegation off, running subagents, plan mode,
 *          council, workaround fixer, defer triggers, …).
 * Hidden:  token counters, cache stats, cost, provider prefix, "(auto)" tag,
 *          git branch, and purely informational statuses (MCP server count,
 *          Braintrust tracing, Pimo companion, transient LSP activity).
 *
 * The choice is stored in `~/.pi/agent/footer.json` so it survives restarts.
 * `/verbose on` restores the default footer.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const CONFIG_FILE = "footer.json";

/** Status keys that carry no actionable information and are dropped in quiet mode. */
export const HIDDEN_STATUS_KEYS = new Set(["mcp", "mcp-auth", "braintrust", "anywhere", "pi-lsp"]);

export interface FooterConfig {
  verbose: boolean;
}

export function configPath(agentDir = getAgentDir()): string {
  return join(agentDir, CONFIG_FILE);
}

export function loadFooterConfig(path = configPath()): FooterConfig {
  if (!existsSync(path)) return { verbose: true };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return { verbose: raw.verbose !== false };
  } catch {
    return { verbose: true };
  }
}

export function saveFooterConfig(config: FooterConfig, path = configPath()): void {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function parseVerboseArg(args: string): "on" | "off" | "toggle" | "status" | undefined {
  const value = args.trim().toLowerCase();
  if (value === "" || value === "status") return "status";
  if (value === "on" || value === "off" || value === "toggle") return value;
  return undefined;
}

export function formatCwd(cwd: string, home: string | undefined): string {
  return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

export function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** Keep only statuses that indicate something is active or needs attention. */
export function filterStatuses(statuses: ReadonlyMap<string, string>): string[] {
  return Array.from(statuses.entries())
    .filter(([key]) => !HIDDEN_STATUS_KEYS.has(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => text.replace(/[\r\n]+/g, " "));
}

export interface QuietFooterInput {
  cwd: string;
  home: string | undefined;
  sessionName: string | undefined;
  contextPercent: number | null;
  contextWindow: number;
  modelId: string | undefined;
  reasoning: boolean;
  thinkingLevel: string | undefined;
  statuses: ReadonlyMap<string, string>;
}

export interface FooterTheme {
  fg(color: "dim" | "warning" | "error", text: string): string;
}

/** Pure renderer so the layout can be tested without a TUI. */
export function renderQuietFooter(input: QuietFooterInput, theme: FooterTheme, width: number): string[] {
  let pathLine = formatCwd(input.cwd, input.home);
  if (input.sessionName) pathLine = `${pathLine} • ${input.sessionName}`;

  const percentText = input.contextPercent === null ? `?/${formatTokens(input.contextWindow)}` : `${input.contextPercent.toFixed(0)}%/${formatTokens(input.contextWindow)}`;
  const percent = input.contextPercent ?? 0;
  const context = percent > 90 ? theme.fg("error", percentText) : percent > 70 ? theme.fg("warning", percentText) : percentText;

  let model = input.modelId ?? "no-model";
  if (input.reasoning) model = `${model} • ${input.thinkingLevel && input.thinkingLevel !== "off" ? input.thinkingLevel : "thinking off"}`;

  const left = context;
  const right = model;
  const gap = Math.max(2, width - visibleWidth(left) - visibleWidth(right));
  const statsLine = visibleWidth(left) + 2 + visibleWidth(right) <= width
    ? `${left}${" ".repeat(gap)}${right}`
    : truncateToWidth(`${left}  ${right}`, width, "…");

  const lines = [
    truncateToWidth(theme.fg("dim", pathLine), width, theme.fg("dim", "…")),
    theme.fg("dim", statsLine),
  ];
  const statuses = filterStatuses(input.statuses);
  if (statuses.length > 0) lines.push(truncateToWidth(statuses.join(" "), width, theme.fg("dim", "…")));
  return lines;
}

export default function quietFooter(pi: ExtensionAPI): void {
  let verbose = loadFooterConfig().verbose;

  const apply = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (verbose) {
      ctx.ui.setFooter(undefined);
      return;
    }
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width: number): string[] {
          const usage = ctx.getContextUsage();
          return renderQuietFooter(
            {
              cwd: ctx.sessionManager.getCwd(),
              home: process.env.HOME || process.env.USERPROFILE,
              sessionName: ctx.sessionManager.getSessionName() ?? undefined,
              contextPercent: usage?.percent ?? null,
              contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow ?? 0,
              modelId: ctx.model?.id,
              reasoning: Boolean(ctx.model?.reasoning),
              thinkingLevel: ctx.thinkingLevel,
              statuses: footerData.getExtensionStatuses(),
            },
            theme,
            width,
          );
        },
      };
    });
  };

  pi.registerCommand("verbose", {
    description: "Footer detail: /verbose on|off|toggle|status (off hides tokens, cost, MCP and other informational statuses)",
    handler: async (args, ctx) => {
      const action = parseVerboseArg(args);
      if (!action) {
        ctx.ui.notify("Usage: /verbose on|off|toggle|status", "warning");
        return;
      }
      if (action === "status") {
        ctx.ui.notify(verbose ? "Footer is verbose (default). /verbose off hides tokens, cost and informational statuses." : "Footer is quiet. /verbose on restores the default footer.", "info");
        return;
      }
      verbose = action === "toggle" ? !verbose : action === "on";
      try {
        saveFooterConfig({ verbose });
      } catch (error) {
        ctx.ui.notify(`Footer preference not saved: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
      apply(ctx);
      ctx.ui.notify(verbose ? "Default footer restored." : "Quiet footer: context %, model and active-mode warnings only.", "info");
    },
  });

  pi.on("session_start", (_event, ctx) => apply(ctx));
  pi.on("model_select", (_event, ctx) => {
    if (!verbose && ctx.hasUI) apply(ctx);
  });
}
