/**
 * /council — convenes four opinionated advisors on one idea.
 *
 * Each member is a headless Pi child process on a model the user names, they debate
 * one another for a round, and a chair merges everything into a single verdict that
 * lands in the session as one message.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  getAgentDir,
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import {
  CHAIR_PROMPT,
  chairTask,
  councilMembers,
  debateTask,
  DEFAULT_THINKING,
  isModelResolutionError,
  openingTask,
  parseCouncilArgs,
  resolveModelSpec,
  THINKING_LEVELS,
  type CatalogModel,
  type CouncilMember,
  type ThinkingLevel,
} from "./members.ts";
import { buildReport, buildTranscript, extractScore, type MemberOutcome } from "./report.ts";
import { addUsage, emptyUsage, runCouncilChild, WEB_TOOLS } from "./run.ts";

const STATUS_ID = "council";
const WIDGET_ID = "council-progress";
const MESSAGE_TYPE = "council-report";
const TICK_MS = 1_000;
const MAX_ACTIVITY_CHARS = 60;
const MEMBER_TIMEOUT_MS = 8 * 60 * 1000;
const CHAIR_TIMEOUT_MS = 8 * 60 * 1000;
const MIN_IDEA_CHARS = 8;
const MAX_IDEA_CHARS = 8_000;

interface CouncilDetails {
  idea: string;
  headline: string;
  scores: string;
  chair: string;
}

const USAGE = [
  "Usage: /council <model> [options] <idea>",
  "",
  "  /council opus5max should I start a bakery in Vienna?",
  "  /council sonnet5 --quick is a paid newsletter worth it?",
  "  /council gpt56sol --no-web --rounds 2 <idea>",
  "",
  "Options:",
  "  --rounds N   1-3 debate rounds (default 2)",
  "  --quick      same as --rounds 1",
  "  --no-web     reasoning only, no web research (web is on by default)",
  "",
  "  /council models   list model names you can use",
  "  /council help     this text",
  "",
  "Model names are fuzzy: opus5, sonnet5, haiku45, sol, luna, gpt55.",
  `Add a thinking level with a suffix or colon: opus5max, opus5:xhigh (${THINKING_LEVELS.join(", ")}).`,
  "Leave the model out to use the session's current model.",
].join("\n");

function catalogFrom(ctx: ExtensionCommandContext): CatalogModel[] {
  const available = ctx.modelRegistry.getAvailable();
  const models = available.length > 0 ? available : ctx.modelRegistry.getAll();
  return models.map((model) => ({ provider: model.provider, id: model.id }));
}

function webExtensionPath(): string {
  return join(getAgentDir(), "npm", "node_modules", "pi-web-access", "index.ts");
}

/**
 * Children run with --no-extensions, which also drops provider auth extensions.
 * Anthropic here is OAuth-based and needs its auth extension, or the child is
 * rejected as an unauthenticated third-party app.
 */
function providerExtensionPaths(model: string): string[] {
  if (!model.startsWith("anthropic/")) return [];
  const authPath = join(
    getAgentDir(),
    "npm",
    "node_modules",
    "@gotgenes",
    "pi-anthropic-auth",
    "src",
    "index.ts",
  );
  return existsSync(authPath) ? [authPath] : [];
}

export default function council(pi: ExtensionAPI): void {
  // Never let a council member convene its own council.
  if (process.env.PI_COUNCIL_MEMBER === "1") return;

  let running = false;

  pi.registerMessageRenderer<CouncilDetails>(MESSAGE_TYPE, (message, { expanded, outputPad }, theme) => {
    const details = message.details;
    const container = new Container();
    const title = `${theme.fg("toolTitle", theme.bold("council"))} ${theme.fg("accent", details?.idea ?? "")}`;
    container.addChild(new Text(title, outputPad, 0));
    if (details?.headline) container.addChild(new Text(theme.fg("dim", details.headline), outputPad, 0));
    if (details?.scores) container.addChild(new Text(theme.fg("muted", details.scores), outputPad, 0));
    container.addChild(new Spacer(1));

    const body = expanded
      ? typeof message.content === "string"
        ? message.content
        : (details?.chair ?? "")
      : (details?.chair ?? "");
    container.addChild(new Markdown(body, outputPad, 0, getMarkdownTheme()));
    if (!expanded) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", "ctrl+o to read the full debate"), outputPad, 0));
    }
    return container;
  });

  pi.registerCommand("council", {
    description: "Convene four advisors (optimist, skeptic, CFO, operator) on an idea: /council <model> <idea>",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trim().toLowerCase();
      if (trimmed.includes(" ")) return null;
      const options = ["models", "help", "opus5max", "sonnet5", "gpt56sol"];
      const matches = options
        .filter((value) => value.startsWith(trimmed))
        .map((value) => ({ value, label: value }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      if (running) {
        ctx.ui.notify("A council is already sitting in this session. Wait for it to finish.", "warning");
        return;
      }

      const parsed = parseCouncilArgs(args);
      for (const error of parsed.errors) ctx.ui.notify(error, "warning");
      if (parsed.errors.length > 0) return;

      if (parsed.subcommand === "help" || parsed.full === "") {
        ctx.ui.notify(USAGE, "info");
        return;
      }

      const catalog = catalogFrom(ctx);
      if (parsed.subcommand === "models") {
        const names = catalog.map((model) => `${model.provider}/${model.id}`);
        ctx.ui.notify(
          names.length > 0 ? `Models you can name:\n${names.join("\n")}` : "No models are available.",
          "info",
        );
        return;
      }

      // First token is a model only when it actually resolves; otherwise it is part of the idea.
      const attempt = resolveModelSpec(parsed.firstToken, catalog);
      let model: string;
      let thinking: ThinkingLevel;
      let idea: string;

      if (!isModelResolutionError(attempt)) {
        model = attempt.model;
        thinking = attempt.thinking;
        idea = parsed.rest;
      } else if (ctx.model) {
        model = `${ctx.model.provider}/${ctx.model.id}`;
        thinking = (ctx.thinkingLevel as ThinkingLevel | undefined) ?? DEFAULT_THINKING;
        idea = parsed.full;
      } else {
        ctx.ui.notify(`${attempt.error}\n\n${USAGE}`, "warning");
        return;
      }

      idea = idea.trim();
      if (idea.length < MIN_IDEA_CHARS) {
        ctx.ui.notify(`Describe the idea in a sentence or two.\n\n${USAGE}`, "warning");
        return;
      }
      if (idea.length > MAX_IDEA_CHARS) idea = `${idea.slice(0, MAX_IDEA_CHARS)}…`;

      const members = councilMembers(parsed.web);
      const rounds = parsed.rounds;
      const childCount = members.length * rounds + 1;
      const authExtensions = providerExtensionPaths(model);
      if (model.startsWith("anthropic/") && authExtensions.length === 0) {
        ctx.ui.notify(
          "The Anthropic OAuth extension was not found, so council members cannot authenticate. Reinstall @gotgenes/pi-anthropic-auth or pick another provider.",
          "error",
        );
        return;
      }
      const memberExtensions = parsed.web
        ? [...authExtensions, webExtensionPath()]
        : authExtensions;
      const memberTools = parsed.web ? [...WEB_TOOLS] : undefined;

      const confirmed = !ctx.hasUI || await ctx.ui.confirm(
        "Convene the council?",
        [
          `Idea: ${idea.length > 160 ? `${idea.slice(0, 160)}…` : idea}`,
          `Model: ${model} · thinking ${thinking}`,
          `Members: ${members.map((member) => member.shortName).join(", ")}`,
          `Rounds: ${rounds} (+ chair) → ${childCount} model runs`,
          parsed.web
            ? "Web research: ON — your idea text is sent to the search provider"
            : "Web research: off — reasoning only",
          "",
          "This runs several full model sessions and costs real tokens.",
        ].join("\n"),
        { signal: ctx.signal },
      );
      if (!confirmed) {
        ctx.ui.notify("Council cancelled.", "info");
        return;
      }

      running = true;
      const startedAt = Date.now();
      const usage = emptyUsage();
      const notes: string[] = [];
      const outcomes: MemberOutcome[] = members.map((member) => ({
        member,
        rounds: [],
        failures: [],
        searches: 0,
      }));

      // Live progress. A council run is minutes of silence otherwise.
      const progress = new Map<string, string>(members.map((member) => [member.id, "waiting"]));
      let phase = "opening statements";

      const elapsed = (): string => {
        const seconds = Math.round((Date.now() - startedAt) / 1000);
        return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
      };

      const paint = (): void => {
        ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("accent", `⚖ council · ${phase} · ${elapsed()}`));
        if (!ctx.hasUI) return;
        const lines = [`⚖ Council · ${phase} · ${elapsed()} · ${model}`];
        for (const member of members) {
          const state = progress.get(member.id) ?? "waiting";
          lines.push(`  ${member.glyph} ${member.shortName.padEnd(9)} ${state}`);
        }
        lines.push("  esc interrupts the run");
        ctx.ui.setWidget(WIDGET_ID, lines);
      };

      const setProgress = (memberId: string, state: string): void => {
        progress.set(memberId, state);
        paint();
      };

      const ticker = setInterval(paint, TICK_MS);
      ticker.unref?.();
      ctx.ui.notify(
        `Council convened on ${model} (${thinking}). ${childCount} runs, several minutes. Progress is shown above the prompt.`,
        "info",
      );
      paint();

      try {
        for (let round = 0; round < rounds; round++) {
          const label = round === 0 ? "opening" : `round ${round + 1}`;
          phase = round === 0 ? "opening statements" : `debate round ${round + 1}`;
          for (const member of members) progress.set(member.id, "waiting");
          paint();
          const eligible = outcomes.filter(
            (outcome) => round === 0 || outcome.rounds[round - 1]?.trim(),
          );
          if (round > 0 && eligible.length < 2) {
            notes.push("Not enough members answered to hold a debate round.");
            break;
          }

          let done = 0;
          for (const outcome of eligible) progress.set(outcome.member.id, "thinking…");
          paint();

          await Promise.all(
            eligible.map(async (outcome) => {
              const others = eligible
                .filter((other) => other !== outcome && other.rounds[round - 1]?.trim())
                .map((other) => ({
                  member: other.member,
                  text: other.rounds[round - 1] ?? "",
                }));
              const task = round === 0
                ? openingTask(idea)
                : debateTask(idea, outcome.member, others);

              const result = await runCouncilChild({
                cwd: ctx.cwd,
                model,
                thinking,
                systemPrompt: outcome.member.systemPrompt,
                task,
                extensionPaths: memberExtensions,
                tools: memberTools,
                timeoutMs: MEMBER_TIMEOUT_MS,
                signal: ctx.signal,
                onToolActivity: (activity) => {
                  const text = activity.length > MAX_ACTIVITY_CHARS
                    ? `${activity.slice(0, MAX_ACTIVITY_CHARS)}…`
                    : activity;
                  setProgress(outcome.member.id, `🔎 ${text}`);
                },
              });

              addUsage(usage, result.usage);
              outcome.searches += result.searches;
              if (result.ok) outcome.rounds[round] = result.output;
              else outcome.failures.push(`${label} failed — ${result.failure}`);

              done++;
              const score = result.ok ? extractScore(result.output) : undefined;
              setProgress(
                outcome.member.id,
                result.ok
                  ? `done${score === undefined ? "" : ` · ${score}/10`}${outcome.searches > 0 ? ` · ${outcome.searches} searches` : ""}`
                  : `failed · ${result.failure}`,
              );
            }),
          );
        }

        const answered = outcomes.filter((outcome) => outcome.rounds.some((text) => text?.trim()));
        if (answered.length === 0) {
          const reasons = outcomes.flatMap((outcome) =>
            outcome.failures.map((failure) => `${outcome.member.shortName}: ${failure}`),
          );
          ctx.ui.notify(`The council could not sit.\n${reasons.join("\n")}`, "error");
          return;
        }

        phase = "chair is deciding";
        paint();
        const transcript = buildTranscript(outcomes, rounds);
        const chairResult = await runCouncilChild({
          cwd: ctx.cwd,
          model,
          thinking,
          systemPrompt: CHAIR_PROMPT,
          task: chairTask(idea, transcript),
          extensionPaths: authExtensions,
          timeoutMs: CHAIR_TIMEOUT_MS,
          signal: ctx.signal,
        });
        addUsage(usage, chairResult.usage);
        if (!chairResult.ok) notes.push(`Chair failed — ${chairResult.failure}`);

        const report = buildReport({
          idea,
          model,
          thinking,
          rounds,
          web: parsed.web,
          chair: chairResult.output,
          members: outcomes,
          costUsd: usage.cost.total,
          durationMs: Date.now() - startedAt,
          notes,
        });

        const headlineText = report.markdown.split("\n").find((line) => line.startsWith("> ") && !line.includes("**Idea:**"))
          ?.slice(2) ?? "";
        pi.sendMessage<CouncilDetails>({
          customType: MESSAGE_TYPE,
          content: report.markdown,
          display: true,
          details: {
            idea: idea.length > 120 ? `${idea.slice(0, 120)}…` : idea,
            headline: headlineText,
            scores: report.scores,
            chair: chairResult.output || "_The chair produced no synthesis._",
          },
        });
      } catch (error) {
        ctx.ui.notify(`Council failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        clearInterval(ticker);
        running = false;
        ctx.ui.setStatus(STATUS_ID, undefined);
        ctx.ui.setWidget(WIDGET_ID, undefined);
      }
    },
  });
}

export type { CouncilMember };
