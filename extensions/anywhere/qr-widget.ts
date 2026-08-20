import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PAIRING_WIDGET_ID = "anywhere-pairing";

export function clearPairingWidget(ctx: ExtensionContext): void {
	ctx.ui.setWidget(PAIRING_WIDGET_ID, undefined);
}
