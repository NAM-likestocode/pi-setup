import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type Step = { number: number; text: string; done: boolean };
type Stage = "off" | "planning" | "executing";
type SavedState = {
  stage: Stage;
  plan?: string;
  summary?: string;
  steps: Step[];
  toolsBefore?: string[];
  planner?: string;
  executor?: string;
  request?: string;
  planFile?: string;
  summaryFile?: string;
  planCreatedAt?: string;
};

const STATE_TYPE = "detailed-plan-mode-state";
const CONTEXT_TYPE = "detailed-plan-mode-context";
const PLAN_SAFE_TOOLS = new Set([
  "read",
  "bash",
  "ask_user",
  "web_search",
  "source_check",
  "fetch_content",
  "get_search_content",
  "visual_planner_read",
  "visual_planner_propose",
]);
const UNSAFE_SHELL_SYNTAX = /[\r\n;&|><`]|\$\(|\$\{/;
const NUL_CHARACTER = String.fromCharCode(0);
const UNSAFE_READ_FLAG = /(?:^|\s)(?:--?(?:exec|execdir|delete|fprint|fprintf|ok|okdir|output|ext-diff|no-index|fix|pre)(?:[=\s]|$)|-[xX](?:\s|$))/i;
const READ_ONLY_COMMAND = /^\s*(?:cat|head|tail|grep|rg|ls|pwd|git\s+(?:status|log|diff|show|branch|remote)|jq|tree|stat|du|npm\s+(?:list|ls|view|info|audit)|pnpm\s+(?:list|why))\b[^\r\n]*$|^\s*(?:node|python)\s+--version\s*$/i;

function assistantText(message: any): string {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
}

export function extractSteps(plan: string): Step[] {
  const section = plan.match(/(?:^|\n)#{1,3}\s*(?:implementation )?(?:plan|steps)[^\n]*\n([\s\S]*?)(?=\n#{1,3}\s+|$)/i)?.[1] ?? plan;
  const found: Step[] = [];
  for (const match of section.matchAll(/^\s*(\d+)[.)]\s+(.*\S)\s*$/gm)) {
    const text = match[2].replace(/[*`]/g, "").trim();
    if (text.length > 3 && found.length < 100) found.push({ number: found.length + 1, text, done: false });
  }
  return found;
}

function compactText(text: string, maxLength = 180): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…` : compact;
}

export function extractPlanSummary(plan: string): string {
  const explicit = plan.match(/(?:^|\n)#{1,3}\s*(?:quick|short|user-facing)\s+(?:summary|version)[^\n]*\n([\s\S]*?)(?=\n#{1,3}\s+|$)/i)?.[1]?.trim();
  if (explicit) return explicit;

  const goal = plan.match(/(?:^|\n)#{1,3}\s*Goal and success criteria[^\n]*\n([\s\S]*?)(?=\n#{1,3}\s+|$)/i)?.[1];
  const steps = extractSteps(plan).slice(0, 5).map((step) => `- ${compactText(step.text, 150)}`);
  const fallback = [goal ? `Goal: ${compactText(goal, 300)}` : "", steps.length > 0 ? `Key steps:\n${steps.join("\n")}` : ""].filter(Boolean).join("\n\n");
  return fallback || "No short summary was generated. Use /plan edit-summary to add one.";
}

export function formatPlanProgress(steps: Step[]): { completed: number; total: number; remaining: number } {
  const completed = steps.filter((step) => step.done).length;
  return { completed, total: steps.length, remaining: Math.max(0, steps.length - completed) };
}

function formatStepMarkers(steps: Step[]): string {
  return steps.map((step) => `${step.done ? "✓" : "○"}${step.number}`).join(" ");
}

function formatShortPlanFile(summary: string, steps: Step[]): string {
  const stepLines = steps.length > 0
    ? steps.map((step) => `${step.number}. ${step.done ? "[x]" : "[ ]"} ${step.text}`).join("\n")
    : "- No numbered steps extracted.";
  return `# Quick plan\n\n${summary.trim()}\n\n## Steps\n\n${stepLines}\n`;
}

function formatModel(model: any): string {
  return `${model.provider}/${model.id}${model.name && model.name !== model.id ? ` — ${model.name}` : ""}`;
}

function updateUi(ctx: ExtensionContext, state: SavedState): void {
  if (state.stage === "off") {
    ctx.ui.setStatus("detailed-plan", undefined);
    ctx.ui.setWidget("detailed-plan", undefined);
    return;
  }

  const theme = ctx.ui.theme;
  const progress = formatPlanProgress(state.steps);
  const stageLabel = state.stage === "planning" ? "PLAN REVIEW" : "IMPLEMENTING";
  ctx.ui.setStatus(
    "detailed-plan",
    theme.fg(state.stage === "planning" ? "warning" : "accent", `▣ ${stageLabel} ${progress.completed}/${progress.total} · ${progress.remaining} left`),
  );

  const lines: string[] = [];
  lines.push(theme.bold(theme.fg("accent", `▣ ${stageLabel}`)) + theme.fg("muted", state.planner ? ` · planner: ${state.planner}` : ""));
  lines.push(
    theme.fg(
      "muted",
      state.stage === "planning"
        ? "Restricted inspection · executable checks wait for approval"
        : state.executor
          ? `Full tools restored · executor: ${state.executor}`
          : "Full tools restored · implementation in progress",
    ),
  );
  lines.push(theme.fg("muted", `Steps: ${progress.completed}/${progress.total} complete · ${progress.remaining} left`));
  if (state.steps.length > 0) lines.push(theme.fg("dim", formatStepMarkers(state.steps)));

  const summaryLines = (state.summary ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (summaryLines.length > 0) {
    lines.push(theme.fg("accent", "Short version:"));
    for (const line of summaryLines.slice(0, 3)) lines.push(theme.fg("dim", compactText(line, 110)));
    if (summaryLines.length > 3) lines.push(theme.fg("dim", `… ${summaryLines.length - 3} more summary lines`));
  }
  lines.push(theme.fg("dim", "Use /plan steps to browse all steps · /plan edit-summary for the short version · /plan edit for the full spec."));
  ctx.ui.setWidget("detailed-plan", lines);
}

export function isAllowedPlanCommand(command: string): boolean {
  return !UNSAFE_SHELL_SYNTAX.test(command) && !command.includes(NUL_CHARACTER) && !UNSAFE_READ_FLAG.test(command) && READ_ONLY_COMMAND.test(command);
}

export function planningToolProfile(tools: string[]): string[] {
  return tools.filter((tool) => PLAN_SAFE_TOOLS.has(tool));
}

export default function detailedPlanMode(pi: ExtensionAPI): void {
  let state: SavedState = { stage: "off", steps: [] };

  const persist = () => pi.appendEntry(STATE_TYPE, state);
  const savePlanMarkdown = async (ctx: ExtensionContext): Promise<string | undefined> => {
    if (!state.plan?.trim()) {
      persist();
      return undefined;
    }

    if (!state.summary?.trim()) state.summary = extractPlanSummary(state.plan);

    let relativePath = state.planFile;
    if (!relativePath) {
      const createdAt = state.planCreatedAt ?? new Date().toISOString();
      state.planCreatedAt = createdAt;
      const timestamp = createdAt.replace(/[:.]/g, "-").replace("T", "-").replace(/Z$/, "");
      const slug = (state.request ?? "implementation-plan")
        .replace(/[`*_#]/g, "")
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase()
        .slice(0, 80)
        .replace(/-+$/, "") || "implementation-plan";
      relativePath = join(CONFIG_DIR_NAME, "plans", `${timestamp}-${slug}.md`);
      state.planFile = relativePath;
    }

    const summaryRelativePath = state.summaryFile ?? relativePath.replace(/\.md$/i, "-summary.md");
    state.summaryFile = summaryRelativePath;
    const filePath = join(ctx.cwd, relativePath);
    const summaryFilePath = join(ctx.cwd, summaryRelativePath);
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, `${state.plan.trim()}\n`, "utf8");
      await writeFile(summaryFilePath, formatShortPlanFile(state.summary, state.steps), "utf8");
      persist();
      return relativePath;
    } catch (error) {
      persist();
      const reason = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not export plan Markdown: ${reason}`, "error");
      return undefined;
    }
  };
  const enablePlanning = () => {
    if (!state.toolsBefore) state.toolsBefore = pi.getActiveTools();
    pi.setActiveTools(planningToolProfile(state.toolsBefore));
  };
  const restoreTools = (preserveSnapshot = false) => {
    if (state.toolsBefore) pi.setActiveTools(state.toolsBefore);
    if (!preserveSnapshot) state.toolsBefore = undefined;
  };
  const disable = (ctx: ExtensionContext, message: string) => {
    restoreTools();
    state = { stage: "off", steps: [] };
    persist();
    updateUi(ctx, state);
    ctx.ui.notify(message, "info");
  };

  const editDetailedPlan = async (ctx: ExtensionContext): Promise<void> => {
    if (!state.plan) return ctx.ui.notify("There is no saved plan to edit yet.", "warning");
    if (state.stage !== "planning") return ctx.ui.notify("Edit the detailed plan before implementation starts.", "warning");
    const edited = await ctx.ui.editor("Edit detailed plan", state.plan);
    if (!edited?.trim()) return;
    state.plan = edited.trim();
    state.steps = extractSteps(state.plan);
    state.summary = extractPlanSummary(state.plan);
    const planFile = await savePlanMarkdown(ctx);
    updateUi(ctx, state);
    ctx.ui.notify(planFile ? `Plan updated. Short plan: ${state.summaryFile}` : "Plan updated; Markdown export failed.", planFile ? "info" : "warning");
  };

  const editPlanSummary = async (ctx: ExtensionContext): Promise<void> => {
    if (!state.plan) return ctx.ui.notify("There is no saved plan to summarize yet.", "warning");
    const edited = await ctx.ui.editor("Edit short plan", state.summary ?? extractPlanSummary(state.plan));
    if (!edited?.trim()) return;
    state.summary = edited.trim();
    const planFile = await savePlanMarkdown(ctx);
    updateUi(ctx, state);
    ctx.ui.notify(planFile ? `Short plan updated: ${state.summaryFile}` : "Short plan updated; Markdown export failed.", planFile ? "info" : "warning");
  };

  const showPlanSteps = async (ctx: ExtensionContext): Promise<void> => {
    if (!state.plan || state.steps.length === 0) return ctx.ui.notify("There are no numbered plan steps yet.", "warning");
    const progress = formatPlanProgress(state.steps);
    if (!ctx.hasUI) return ctx.ui.notify(`Plan steps: ${progress.completed}/${progress.total} complete · ${progress.remaining} left.`, "info");
    await ctx.ui.select(`Plan steps · ${progress.remaining} remaining`, state.steps.map((step) => `${step.done ? "✓" : "○"} ${step.number}. ${step.text}`));
  };

  const finishExecution = (ctx: ExtensionContext) => {
    restoreTools();
    state = { ...state, stage: "off", toolsBefore: undefined };
    persist();
    updateUi(ctx, state);
    ctx.ui.notify("Plan implementation complete. Full tool access restored.", "info");
  };

  async function implementPlan(ctx: ExtensionContext): Promise<void> {
    if (state.stage !== "planning" || !state.plan) return ctx.ui.notify("Create a detailed plan first.", "warning");
    const models = ctx.modelRegistry.getAvailable();
    if (models.length === 0) return ctx.ui.notify("No authenticated executor models are available.", "error");
    const labels = models.map(formatModel);
    const selected = await ctx.ui.select("Choose executor model", labels);
    if (!selected) return;
    const model = models[labels.indexOf(selected)];
    if (!model || !(await pi.setModel(model))) return ctx.ui.notify("Could not select that model.", "error");
    state.stage = "executing";
    state.executor = `${model.provider}/${model.id}`;
    restoreTools(true);
    await savePlanMarkdown(ctx);
    updateUi(ctx, state);
    ctx.ui.notify("Plan mode ended. Full tools restored; implementation started.", "info");
    pi.sendUserMessage(`Implement the approved detailed specification below immediately. The short version is for the user; follow the full specification as the source of truth. Before any material deviation, stop and explain the conflict. Run the stated validation. After completing a numbered implementation step, include [DONE:n] in your response.\n\n--- APPROVED DETAILED SPECIFICATION ---\n${state.plan}\n--- END APPROVED SPECIFICATION ---`);
  }

  pi.registerCommand("plan", {
    description: "Start planning, or use implement/steps/summary/edit/edit-summary/revise/cancel",
    handler: async (args, ctx) => {
      const input = args.trim();
      const [verb, ...rest] = input.split(/\s+/);
      const feedback = rest.join(" ");
      if (verb === "implement") return implementPlan(ctx);
      if (verb === "steps") return showPlanSteps(ctx);
      if (verb === "summary") return ctx.ui.notify(state.summary ? `Short plan:\n${state.summary}` : "There is no short plan yet.", state.summary ? "info" : "warning");
      if (verb === "edit-summary" || verb === "edit-short") return editPlanSummary(ctx);
      if (verb === "cancel") return disable(ctx, "Plan cancelled. Full tool access restored.");
      if (verb === "edit") return editDetailedPlan(ctx);
      if (verb === "revise") {
        if (state.stage !== "planning") return ctx.ui.notify("Start /plan first, or revise before implementing.", "warning");
        if (!feedback) return ctx.ui.notify("Usage: /plan revise <feedback>", "warning");
        pi.sendUserMessage(`Revise the implementation specification using this feedback:\n${feedback}`);
        return;
      }
      if (state.stage !== "off") return disable(ctx, "Plan mode cancelled. Full tool access restored.");
      state = { stage: "planning", steps: [], toolsBefore: pi.getActiveTools(), planner: `${ctx.model?.provider ?? "unknown"}/${ctx.model?.id ?? "unknown"}`, request: input || undefined };
      enablePlanning(); persist(); updateUi(ctx, state);
      ctx.ui.notify("Detailed plan mode enabled. Tools are restricted to inspection; executable checks wait for approval.", "info");
      if (input) pi.sendUserMessage(input);
    },
  });

  pi.registerCommand("plan-revise", {
    description: "Revise the active plan: /plan-revise <feedback>",
    handler: async (args, ctx) => {
      if (state.stage !== "planning") return ctx.ui.notify("Start /plan first, or revise before implementing.", "warning");
      if (!args.trim()) return ctx.ui.notify("Usage: /plan-revise <feedback>", "warning");
      pi.sendUserMessage(`Revise the implementation specification using this feedback:\n${args.trim()}`);
    },
  });

  pi.registerCommand("plan-edit", {
    description: "Edit the saved detailed plan Markdown directly",
    handler: async (_args, ctx) => editDetailedPlan(ctx),
  });

  pi.registerCommand("plan-edit-summary", {
    description: "Edit the short user-facing plan summary",
    handler: async (_args, ctx) => editPlanSummary(ctx),
  });

  pi.registerCommand("plan-steps", {
    description: "Browse all plan steps in a scrollable list",
    handler: async (_args, ctx) => showPlanSteps(ctx),
  });

  pi.registerCommand("plan-implement", {
    description: "Alias for /plan implement",
    handler: async (_args, ctx) => implementPlan(ctx),
  });

  pi.registerCommand("plan-cancel", {
    description: "Cancel the active plan and restore normal tools",
    handler: async (_args, ctx) => disable(ctx, "Plan cancelled. Full tool access restored."),
  });

  pi.registerShortcut("ctrl+shift+m", {
    description: "Toggle detailed plan mode",
    handler: async (ctx) => {
      if (state.stage === "off") {
        state = { stage: "planning", steps: [], toolsBefore: pi.getActiveTools(), planner: `${ctx.model?.provider ?? "unknown"}/${ctx.model?.id ?? "unknown"}` };
        enablePlanning(); persist(); updateUi(ctx, state);
        ctx.ui.notify("Plan mode enabled. Describe the task to create a specification.", "info");
      } else disable(ctx, "Plan mode cancelled. Full tool access restored.");
    },
  });

  pi.on("tool_call", async (event: any) => {
    if (state.stage !== "planning") return;
    if (!PLAN_SAFE_TOOLS.has(event.toolName)) {
      return { block: true, reason: "Detailed plan mode permits only its restricted inspection tool profile. Use /plan-implement after approval." };
    }
    if (event.toolName === "bash" && !isAllowedPlanCommand(String(event.input?.command ?? ""))) {
      return { block: true, reason: "Plan mode permits only a single conservative read-only command. Pipelines, redirection, command substitution, mutating flags, and executable checks are blocked." };
    }
  });

  pi.on("before_agent_start", async (event: any) => {
    if (state.stage === "planning" && !state.request && typeof event.prompt === "string" && event.prompt.trim()) {
      state.request = event.prompt.trim();
      persist();
    }
    if (state.stage === "planning") return {
      message: {
        customType: CONTEXT_TYPE,
        display: false,
        content: `You are creating a detailed implementation specification, not code. Inspect the project carefully. Do not edit files or run tests, builds, scripts, or other executable checks until the user approves implementation. Before finalizing the plan, use the ask_user tool to obtain an explicit decision whenever requirements or success criteria are materially unclear, multiple valid approaches have preference-dependent trade-offs, or the plan would change architecture, schemas, APIs, deployment, security, or other costly-to-reverse behavior. First gather evidence; then ask one focused, neutral question with concise context and 2–5 options (allowFreeform: true). Do not ask for trivial choices or repeat a decision the user already made. If a high-stakes question is cancelled or remains unclear, stop and state that planning is blocked rather than inventing an answer. Record resolved user decisions in the plan.

Your final response MUST contain two layers in this order:

## Quick summary
Write 3–6 short plain-language bullets for the user. Explain what will change and why, avoid implementation jargon, and keep it understandable without reading the rest.

## Detailed specification
Then provide the long, precise specification for a future executor. It MUST contain these headings: Goal and success criteria; Current-state findings; Design decisions; Files and symbols affected; Implementation Plan (a numbered list); Per-step executor instructions; Edge cases; Test matrix; Risks, assumptions, and non-goals. Each numbered step must identify files/symbols, exact behavior, constraints, and acceptance criteria. The detailed specification is the source of truth for implementation. The future executor may be a weaker model, so remove ambiguity.`,
      },
    };
    if (state.stage === "executing" && state.plan) return {
      message: {
        customType: CONTEXT_TYPE,
        display: false,
        content: `You are executing an approved detailed specification. Plan mode restrictions are off and full tools are restored. Follow the detailed specification in order, keep scope tight, validate each step, and include [DONE:n] only after that numbered step is actually complete. The quick summary is for the user; the detailed specification below is the source of truth. Stop and ask before material deviations.\n\n${state.plan}`,
      },
    };
  });

  pi.on("turn_end", async (event: any, ctx) => {
    const text = assistantText(event.message);
    if (!text) return;
    if (state.stage === "planning" && /(?:implementation )?plan/i.test(text) && extractSteps(text).length > 0) {
      state.plan = text;
      state.steps = extractSteps(text);
      state.summary = extractPlanSummary(text);
      const planFile = await savePlanMarkdown(ctx);
      updateUi(ctx, state);
      ctx.ui.notify(
        planFile
          ? `Detailed plan exported to ${planFile}. Short plan: ${state.summaryFile}. Browse all steps with /plan steps or edit the summary with /plan edit-summary.`
          : "Detailed plan saved in the session, but Markdown export failed. Browse /plan steps or edit the summary with /plan edit-summary.",
        planFile ? "info" : "warning",
      );
    }
    if (state.stage === "executing") {
      let changed = false;
      for (const match of text.matchAll(/\[DONE:(\d+)\]/gi)) {
        const step = state.steps.find((item) => item.number === Number(match[1]));
        if (step && !step.done) {
          step.done = true;
          changed = true;
        }
      }
      if (changed) await savePlanMarkdown(ctx);
      if (state.steps.length > 0 && state.steps.every((step) => step.done)) {
        finishExecution(ctx);
        return;
      }
      persist(); updateUi(ctx, state);
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries() as any[];
    const saved = entries.filter((entry) => entry.type === "custom" && entry.customType === STATE_TYPE).pop();
    if (saved?.data && typeof saved.data === "object") state = saved.data as SavedState;
    if (state.plan && !state.summary) state.summary = extractPlanSummary(state.plan);
    if (state.stage === "planning") enablePlanning();
    if (state.stage === "executing") restoreTools(true);
    if (state.plan) await savePlanMarkdown(ctx);
    updateUi(ctx, state);
  });
}
