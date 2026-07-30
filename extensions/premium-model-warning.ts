import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Keep this list explicit: sol is the highest-cost model in the current catalog.
const PREMIUM_MODELS = new Set(["gpt-5.6-sol"]);

function updatePremiumWarning(
	ctx: ExtensionContext,
	modelId = ctx.model?.id,
	setSolTheme?: (premium: boolean) => void,
): void {
	const premium = modelId !== undefined && PREMIUM_MODELS.has(modelId);
	setSolTheme?.(premium);

	if (!premium) {
		ctx.ui.setStatus("premium-model", undefined);
		ctx.ui.setWidget("premium-model", undefined);
		ctx.ui.setWorkingMessage();
		ctx.ui.setWorkingIndicator();
		return;
	}

	const theme = ctx.ui.theme;
	const label = `◆ Premium model: ${modelId} · higher credit use`;
	ctx.ui.setStatus("premium-model", theme.fg("error", `◆ ${modelId} premium`));
	ctx.ui.setWidget("premium-model", [theme.fg("error", label)]);
	ctx.ui.setWorkingMessage(`Using ${modelId} · premium credits`);
	ctx.ui.setWorkingIndicator({ frames: [theme.fg("error", "◆")] });
}

export default function (pi: ExtensionAPI): void {
	let solThemeApplied = false;
	const setSolTheme = (ctx: ExtensionContext, premium: boolean) => {
		if (premium && !solThemeApplied) {
			ctx.ui.setTheme("tokyo-night-sol-warning");
			solThemeApplied = true;
		} else if (!premium && solThemeApplied) {
			ctx.ui.setTheme("tokyo-night");
			solThemeApplied = false;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		updatePremiumWarning(ctx, undefined, (premium) => setSolTheme(ctx, premium));
	});

	pi.on("model_select", (event, ctx) => {
		updatePremiumWarning(ctx, event.model.id, (premium) => setSolTheme(ctx, premium));
		if (event.source !== "restore" && PREMIUM_MODELS.has(event.model.id)) {
			ctx.ui.notify(`Premium model selected: ${event.model.id}`, "info");
		}
	});
}
