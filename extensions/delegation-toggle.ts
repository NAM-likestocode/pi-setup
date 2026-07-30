import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "delegation-toggle";
const BLOCKED_ACTIONS = new Set(["schedule", "resume", "append-step"]);

export default function delegationToggle(pi: ExtensionAPI): void {
  let enabled = true;

  const updateUi = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(
      STATUS_ID,
      enabled ? undefined : ctx.ui.theme.fg("warning", "⛔ DELEGATION OFF"),
    );
  };

  const setEnabled = (next: boolean, ctx: ExtensionContext): void => {
    enabled = next;
    updateUi(ctx);
    ctx.ui.notify(
      enabled
        ? "Subagent delegation enabled."
        : "Subagent delegation disabled for this session. Existing runs can still be inspected or stopped.",
      "info",
    );
  };

  pi.registerCommand("delegation", {
    description: "Enable or disable new subagent delegation: /delegation on|off|toggle|status",
    getArgumentCompletions: (prefix) => {
      const options = ["on", "off", "toggle", "status"];
      const matches = options
        .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
        .map((value) => ({ value, label: value }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "toggle";
      if (action === "status") {
        ctx.ui.notify(`Subagent delegation is ${enabled ? "enabled" : "disabled"}.`, "info");
        return;
      }
      if (action === "on") return setEnabled(true, ctx);
      if (action === "off") return setEnabled(false, ctx);
      if (action === "toggle") return setEnabled(!enabled, ctx);
      ctx.ui.notify("Usage: /delegation on|off|toggle|status", "warning");
    },
  });

  pi.on("tool_call", async (event: any) => {
    if (enabled || event.toolName !== "subagent") return;

    const action = typeof event.input?.action === "string" ? event.input.action : undefined;
    const startsNewWork = action === undefined || BLOCKED_ACTIONS.has(action);
    if (startsNewWork) {
      return {
        block: true,
        reason: "Subagent delegation is disabled for this session. Use /delegation on to re-enable it.",
      };
    }
  });

  pi.on("before_agent_start", async () => {
    if (enabled) return;
    return {
      message: {
        customType: "delegation-toggle-context",
        display: false,
        content: "The user has disabled subagent delegation for this session. Do not launch, schedule, resume, or append work for subagents. Complete the task in the parent session. Status, interrupt, and stop actions for already-running subagents remain allowed.",
      },
    };
  });

  pi.on("session_start", async (_event, ctx) => updateUi(ctx));
}
