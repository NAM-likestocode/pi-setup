import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";

const DOUBLE_ESCAPE_WINDOW_MS = 750;

/**
 * First Escape keeps Pi's normal cancel behavior. A second Escape while that
 * cancellation is armed consumes the key and requests a hard stop.
 */
export default function hardStop(pi: ExtensionAPI): void {
	let unsubscribe: (() => void) | undefined;
	let hardStopUntil = 0;

	const uninstall = (): void => {
		unsubscribe?.();
		unsubscribe = undefined;
		hardStopUntil = 0;
	};

	const install = (ctx: ExtensionContext): void => {
		uninstall();
		if (ctx.mode !== "tui") return;

		unsubscribe = ctx.ui.onTerminalInput((data) => {
			if (!matchesKey(data, Key.escape)) return;

			const now = Date.now();
			if (hardStopUntil !== 0 && now <= hardStopUntil) {
				hardStopUntil = 0;
				ctx.abort();
				ctx.ui.notify("Hard stop requested.", "warning");
				return { consume: true };
			}

			// Let the first Escape reach Pi normally, but always arm the second.
			// A child process can outlive Pi's visible agent state, so using
			// isIdle() here would leave precisely the stuck case unkillable.
			hardStopUntil = now + DOUBLE_ESCAPE_WINDOW_MS;
			return;
		});
	};

	pi.on("session_start", (_event, ctx) => install(ctx));
	pi.on("session_shutdown", () => uninstall());
}
