import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";

const EMPTY_COMPONENT: Component = {
	render: () => [],
	invalidate: () => {},
};

export default function (pi: ExtensionAPI): void {
	let hiddenChat: Component[] | undefined;

	async function toggleView(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") return;

		await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
			// Pi's root TUI keeps its transcript in the third container. Removing its
			// existing children clears only the current view; session history and the
			// terminal's existing scrollback remain untouched.
			setTimeout(() => {
				const chat = tui.children[2];
				if (!(chat instanceof Container)) {
					done();
					return;
				}

				if (hiddenChat) {
					chat.children.unshift(...hiddenChat);
					hiddenChat = undefined;
				} else {
					hiddenChat = [...chat.children];
					chat.clear();
					tui.terminal.clearScreen();
				}

				tui.requestRender(true);
				setTimeout(() => done(), 0);
			}, 0);
			return EMPTY_COMPONENT;
		});
	}

	pi.registerShortcut("ctrl+alt+l", {
		description: "Hide or restore previous chat from the current view",
		handler: toggleView,
	});

	pi.registerCommand("clear-view", {
		description: "Hide previous chat from the current view; run again to restore it",
		handler: async (_args, ctx) => toggleView(ctx),
	});
}
