import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function path(relative: string): string {
	return fileURLToPath(new URL(`../${relative}`, import.meta.url));
}

function text(relative: string): string {
	return readFileSync(path(relative), "utf8");
}

describe("Pimo branding", () => {
	it("uses Pimo for visible product names without breaking installed identities", () => {
		const mobile = JSON.parse(text("apps/anywhere-mobile/app.json")).expo;
		const desktop = JSON.parse(
			text("apps/anywhere-companion/src-tauri/tauri.conf.json"),
		);
		expect(mobile.name).toBe("Pimo");
		expect(mobile.scheme).toBe("pi-anywhere");
		expect(mobile.android.package).toBe("com.namlikestocode.pi.anywhere");
		expect(desktop.productName).toBe("Pimo Companion");
		expect(desktop.mainBinaryName).toBe("pi-anywhere-companion");
		expect(desktop.identifier).toBe("com.namlikestocode.pi-anywhere");
	});

	it("ships the supplied mark for desktop, mobile, and launcher use", () => {
		for (const relative of [
			"apps/anywhere-companion/public/pimo-mark.png",
			"apps/anywhere-companion/src-tauri/icons/icon.ico",
			"apps/anywhere-mobile/assets/pimo-mark.png",
			"apps/anywhere-mobile/assets/pimo-icon.png",
			"apps/anywhere-mobile/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.webp",
		]) {
			expect(statSync(path(relative)).size, relative).toBeGreaterThan(1_000);
		}
	});

	it("carries the Companion background gradient into the mobile app", () => {
		const desktop = text("apps/anywhere-companion/src/styles.css");
		const mobile = text(
			"apps/anywhere-mobile/src/components/PimoBackground.tsx",
		);
		for (const color of ["#5a3729", "#171411", "#32263b"]) {
			expect(desktop).toContain(color);
			expect(mobile).toContain(color);
		}
	});

	it("keeps the old slash command only as a compatibility alias", () => {
		const extension = text("extensions/anywhere/index.ts");
		expect(extension).toContain('pi.registerCommand("Pimo"');
		expect(extension).toContain('pi.registerCommand("Anywhere"');
		expect(extension).toContain("Legacy alias for /Pimo");
	});
});
