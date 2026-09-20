import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * `/reload` outside the terminal UI.
 *
 * The interactive TUI handles `/reload` itself before extension commands are
 * dispatched, and RPC mode has no reload command at all, so a front-end such as
 * pi-desk that forwards the typed text as a prompt ends up sending "/reload" to
 * the model. This registers an equivalent extension command only when Pi is not
 * running the TUI, where it cannot shadow the built-in or trigger the
 * conflict warning, and confirms the reload from the freshly loaded instance.
 */
export default function headlessReload(pi: ExtensionAPI): void {
  pi.on("session_start", async (event, ctx) => {
    if (ctx.mode === "tui") return;
    if (event.reason === "reload" && ctx.hasUI) {
      ctx.ui.notify("Reloaded extensions, skills, prompts, themes, and context files.", "info");
    }
    pi.registerCommand("reload", {
      description: "Reload extensions, skills, prompts, themes, and context files",
      handler: async (_args, commandCtx) => {
        if (!commandCtx.isIdle()) {
          commandCtx.ui.notify("Wait for the current response to finish before reloading.", "warning");
          return;
        }
        // Nothing may touch commandCtx after this: the runner it belongs to is replaced.
        await commandCtx.reload();
      },
    });
  });
}
