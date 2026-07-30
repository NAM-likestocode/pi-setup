import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type Step = { number: number; text: string; done: boolean };
type Stage = "off" | "planning" | "executing";
type SavedState = {
  stage: Stage;
  plan?: string;
  steps: Step[];
  toolsBefore?: string[];
  planner?: string;
  executor?: string;
  request?: string;
  planFile?: string;
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
  "ctx_execute_file",
  "ctx_search",
]);
const UNSAFE_SHELL_SYNTAX = /[\r\n;&|><`\u0000]|\$\(|\$\{/;
const UNSAFE_READ_FLAG = /(?:^|\s)(?:--?(?:exec|execdir|delete|fprint|fprintf|ok|okdir|output|ext-diff|no-index|fix|pre)(?:[=\s]|$)|-[xX](?:\s|$))/i;
const READ_ONLY_COMMAND = /^\s*(?:cat|head|tail|grep|rg|ls|pwd|git\s+(?:status|log|diff|show|branch|remote)|jq|tree|stat|du|npm\s+(?:list|ls|view|info|audit)|pnpm\s+(?:list|why))\b[^\r\n]*$|^\s*(?:node|python)\s+--version\s*$/i;

function assistantText(message: any): string {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
}

function extractSteps(plan: string): Step[] {
  const section = plan.match(/(?:^|\n)#{1,3}\s*(?:implementation )?(?:plan|steps)[^\n]*\n([\s\S]*)/i)?.[1] ?? plan;
  const found: Step[] = [];
  for (const match of section.matchAll(/^\s*(\d+)[.)]\s+(.*\S)\s*$/gm)) {
    const text = match[2].replace(/[*`]/g, "").trim();
    if (text.length > 3 && found.length < 20) found.push({ number: found.length + 1, text, done: false });
  }
  return found;
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
  const complete = state.steps.filter((step) => step.done).length;
  const stageLabel = state.stage === "planning" ? "PLAN REVIEW" : "IMPLEMENTING";
  ctx.ui.setStatus("detailed-plan", theme.fg(state.stage === "planning" ? "warning" : "accent", `▣ ${stageLabel} ${complete}/${state.steps.length}`));

  const lines: string[] = [];
  lines.push(theme.bold(theme.fg("accent", `▣ ${stageLabel}`)) + theme.fg("muted", state.planner ? ` · planner: ${state.planner}` : ""));
  if (state.stage === "planning") {
    lines.push(theme.fg("muted", "Restricted inspection · executable checks wait for approval · /plan implement"));
  } else {
    lines.push(theme.fg("muted", state.executor ? `Executor: ${state.executor}` : "Executor selected"));
  }
  for (const step of state.steps.slice(0, state.stage === "planning" ? 12 : 8)) {
    const marker = step.done ? theme.fg("success", "✓") : theme.fg("muted", "○");
    lines.push(`${marker} ${step.done ? theme.strikethrough(step.text) : step.text}`);
  }
  if (state.steps.length > (state.stage === "planning" ? 12 : 8)) lines.push(theme.fg("dim", `… ${state.steps.length - (state.stage === "planning" ? 12 : 8)} more steps`));
  if (state.stage === "planning") lines.push(theme.fg("dim", "Use /plan edit for direct Markdown editing. The detailed plan is also in this chat."));
  ctx.ui.setWidget("detailed-plan", lines);
}

export function isAllowedPlanCommand(command: string): boolean {
  return !UNSAFE_SHELL_SYNTAX.test(command) && !UNSAFE_READ_FLAG.test(command) && READ_ONLY_COMMAND.test(command);
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

    const filePath = join(ctx.cwd, relativePath);
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, `${state.plan.trim()}\n`, "utf8");
      persist();
      return relativePath;
    } catch (error) {
      persist();
      const reason = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not export Markdown plan: ${reason}`, "error");
      return undefined;
    }
  };
  const enablePlanning = () => {
    if (!state.toolsBefore) state.toolsBefore = pi.getActiveTools();
    pi.setActiveTools(planningToolProfile(state.toolsBefore));
  };
  const restoreTools = () => {
    if (state.toolsBefore) pi.setActiveTools(state.toolsBefore);
    state.toolsBefore = undefined;
  };
  const disable = (ctx: ExtensionContext, message: string) => {
    restoreTools();
    state = { stage: "off", steps: [] };
    persist();
    updateUi(ctx, state);
    ctx.ui.notify(message, "info");
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
    restoreTools();
    await savePlanMarkdown(ctx);
    updateUi(ctx, state);
    pi.sendUserMessage(`Implement the approved specification below immediately. Follow it step by step. Before any material deviation, stop and explain the conflict. Run the stated validation. After completing a numbered implementation step, include [DONE:n] in your response.\n\n--- APPROVED SPECIFICATION ---\n${state.plan}\n--- END SPECIFICATION ---`);
  }

  pi.registerCommand("plan", {
    description: "Start planning, or use implement/revise/edit/cancel",
    handler: async (args, ctx) => {
      const input = args.trim();
      const [verb, ...rest] = input.split(/\s+/);
      const feedback = rest.join(" ");
      if (verb === "implement") return implementPlan(ctx);
      if (verb === "cancel") return disable(ctx, "Plan cancelled. Full tool access restored.");
      if (verb === "edit") {
        if (state.stage !== "planning" || !state.plan) return ctx.ui.notify("There is no saved plan to edit yet.", "warning");
        const edited = await ctx.ui.editor("Edit detailed plan", state.plan);
        if (!edited?.trim()) return;
        state.plan = edited.trim();
        state.steps = extractSteps(state.plan);
        const planFile = await savePlanMarkdown(ctx);
        updateUi(ctx, state);
        return ctx.ui.notify(planFile ? `Plan updated: ${planFile}` : "Plan updated; Markdown export failed.", planFile ? "info" : "warning");
      }
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
    description: "Edit the saved plan Markdown directly",
    handler: async (_args, ctx) => {
      if (state.stage !== "planning" || !state.plan) return ctx.ui.notify("There is no saved plan to edit yet.", "warning");
      const edited = await ctx.ui.editor("Edit detailed plan", state.plan);
      if (!edited?.trim()) return;
      state.plan = edited.trim();
      state.steps = extractSteps(state.plan);
      const planFile = await savePlanMarkdown(ctx);
      updateUi(ctx, state);
      ctx.ui.notify(planFile ? `Plan updated: ${planFile}` : "Plan updated; Markdown export failed.", planFile ? "info" : "warning");
    },
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
    if (state.stage === "planning") return { message: { customType: CONTEXT_TYPE, display: false, content: `You are creating a detailed implementation specification, not code. Inspect the project carefully. Do not edit files or run tests, builds, scripts, or other executable checks until the user approves implementation. Before finalizing the plan, use the ask_user tool to obtain an explicit decision whenever requirements or success criteria are materially unclear, multiple valid approaches have preference-dependent trade-offs, or the plan would change architecture, schemas, APIs, deployment, security, or other costly-to-reverse behavior. First gather evidence; then ask one focused, neutral question with concise context and 2–5 options (allowFreeform: true). Do not ask for trivial choices or repeat a decision the user has already made. If a high-stakes question is cancelled or remains unclear, stop and state that planning is blocked rather than inventing an answer. Record resolved user decisions in the plan. Your final response MUST be a detailed Markdown specification with these headings: Goal and success criteria; Current-state findings; Design decisions; Files and symbols affected; Implementation Plan (a numbered list); Per-step executor instructions; Edge cases; Test matrix; Risks, assumptions, and non-goals. Each numbered step must identify files/symbols, exact behavior, constraints, and acceptance criteria. The future executor may be a weaker model, so remove ambiguity.` } };
    if (state.stage === "executing" && state.plan) return { message: { customType: CONTEXT_TYPE, display: false, content: `You are executing an approved detailed specification. Follow it in order, keep scope tight, validate each step, and include [DONE:n] only after that numbered step is actually complete. Stop and ask before material deviations.\n\n${state.plan}` } };
  });

  pi.on("turn_end", async (event: any, ctx) => {
    const text = assistantText(event.message);
    if (!text) return;
    if (state.stage === "planning" && /(?:implementation )?plan/i.test(text) && extractSteps(text).length > 0) {
      state.plan = text;
      state.steps = extractSteps(text);
      const planFile = await savePlanMarkdown(ctx);
      updateUi(ctx, state);
      ctx.ui.notify(
        planFile
          ? `Detailed plan exported to ${planFile}. Review it above, revise it, or run /plan-implement.`
          : "Detailed plan saved in the session, but Markdown export failed. Review it above, revise it, or run /plan-implement.",
        planFile ? "info" : "warning",
      );
    }
    if (state.stage === "executing") {
      for (const match of text.matchAll(/\[DONE:(\d+)\]/gi)) {
        const step = state.steps.find((item) => item.number === Number(match[1]));
        if (step) step.done = true;
      }
      persist(); updateUi(ctx, state);
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries() as any[];
    const saved = entries.filter((entry) => entry.type === "custom" && entry.customType === STATE_TYPE).pop();
    if (saved?.data && typeof saved.data === "object") state = saved.data as SavedState;
    if (state.stage === "planning") enablePlanning();
    if (state.plan) await savePlanMarkdown(ctx);
    updateUi(ctx, state);
  });
}
