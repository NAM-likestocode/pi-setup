import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	DASHBOARD_ACTIVITY_CHANNEL,
	isDashboardActivity,
} from "../_shared/dashboard-activity.ts";
import { ANYWHERE_STATUS_ID } from "./config.ts";
import { InstanceBridge } from "./instance-bridge.ts";
import { clearPairingWidget } from "./qr-widget.ts";

function notifyCompanionError(ctx: ExtensionContext, error: unknown): void {
	ctx.ui.notify(
		error instanceof Error ? error.message : String(error),
		"error",
	);
}

function showStatus(ctx: ExtensionContext, bridge: InstanceBridge): void {
	const summary = bridge.getSummary();
	ctx.ui.notify(
		`Pimo session ${summary.projectName} is ${summary.state}; ${summary.pendingPromptCount} pending prompt(s).`,
		"info",
	);
}

export default function anywhere(pi: ExtensionAPI): void {
	const bridge = new InstanceBridge(pi);
	let removeActivityListener: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		clearPairingWidget(ctx);
		bridge.setContext(ctx);
		removeActivityListener?.();
		removeActivityListener = pi.events.on(
			DASHBOARD_ACTIVITY_CHANNEL,
			(value) => {
				if (isDashboardActivity(value)) bridge.receiveActivity(value);
			},
		);
		if (process.env.PI_PROJECT_SUBAGENT !== "1") {
			void bridge.start(ctx).catch((error) => {
				ctx.ui.setStatus(ANYWHERE_STATUS_ID, "Pimo Companion unavailable");
				ctx.ui.notify(
					`Pimo could not connect to its companion: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			});
		}
	});

	pi.on("message_update", (event) => {
		const update = event as unknown as {
			message: unknown;
			assistantMessageEvent?: { type?: string; delta?: string };
		};
		if (
			update.assistantMessageEvent?.type === "text_delta" &&
			typeof update.assistantMessageEvent.delta === "string"
		) {
			bridge.recordAssistantDelta(
				update.message,
				update.assistantMessageEvent.delta,
			);
		}
	});

	pi.on("message_end", (event) => {
		bridge.recordMessage((event as unknown as { message: unknown }).message);
	});

	pi.on("session_tree", () => {
		bridge.markHistoryReset();
	});

	pi.on("tool_execution_start", (event) => {
		bridge.recordToolStart(event.toolCallId, event.toolName, event.args);
	});

	pi.on("tool_execution_end", (event) => {
		bridge.recordToolEnd(
			event.toolCallId,
			event.toolName,
			event.result,
			event.isError,
		);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		removeActivityListener?.();
		removeActivityListener = undefined;
		bridge.stop();
		clearPairingWidget(ctx);
	});

	async function handlePimoCommand(
		args: string,
		ctx: ExtensionContext,
	): Promise<void> {
		const action = args.trim().toLowerCase();
		if (
			action &&
			!["start", "status", "pair", "link", "off", "stop"].includes(action)
		) {
			ctx.ui.notify("Usage: /Pimo [start|status|pair|off]", "warning");
			return;
		}
		clearPairingWidget(ctx);
		if (action === "pair" || action === "link") {
			ctx.ui.notify(
				"Open Pimo Companion and choose Show pairing QR. Pairing codes are never shown in Pi.",
				"info",
			);
			return;
		}
		if (action === "off" || action === "stop") {
			try {
				const result = await bridge.command("off");
				ctx.ui.notify(result.message, result.ok ? "info" : "error");
			} catch (error) {
				notifyCompanionError(ctx, error);
			}
			return;
		}
		if (!bridge.isActive) {
			await bridge.start(ctx, true);
		}
		try {
			const result = await bridge.command("status");
			ctx.ui.setStatus(
				ANYWHERE_STATUS_ID,
				result.ok ? "Pimo connected" : result.message,
			);
			if (result.ok) showStatus(ctx, bridge);
			else ctx.ui.notify(result.message, "warning");
		} catch (error) {
			notifyCompanionError(ctx, error);
		}
	}

	pi.registerCommand("Pimo", {
		description:
			"Connect this Pi session to Pimo Companion (pairing stays in the desktop app)",
		handler: handlePimoCommand,
	});
	pi.registerCommand("Anywhere", {
		description: "Legacy alias for /Pimo",
		handler: handlePimoCommand,
	});
}
