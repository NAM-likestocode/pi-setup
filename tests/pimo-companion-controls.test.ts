import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function text(relative: string): string {
	return readFileSync(
		fileURLToPath(new URL(`../${relative}`, import.meta.url)),
		"utf8",
	);
}

describe("Pimo Companion window and session controls", () => {
	it("allows the custom title bar to minimize the native window", () => {
		const capability = JSON.parse(
			text("apps/anywhere-companion/src-tauri/capabilities/default.json"),
		) as { permissions: string[] };
		const panel = text(
			"apps/anywhere-companion/src/components/StatusPanel.tsx",
		);
		expect(capability.permissions).toContain("core:window:allow-minimize");
		expect(panel).toContain(".minimize()");
		expect(panel).toContain("Minimize Pimo Companion");
	});

	it("persists desktop session aliases and applies them to the mobile list", () => {
		const frontend = text("apps/anywhere-companion/src/lib/commands.ts");
		const backend = text(
			"apps/anywhere-companion/src-tauri/src/commands.rs",
		);
		const publicServer = text(
			"apps/anywhere-companion/src-tauri/src/public_server.rs",
		);
		expect(frontend).toContain('invokeStatus("rename_instance"');
		expect(backend).toContain("persisted.session_aliases");
		expect(publicServer).toContain(
			"apply_session_aliases(&mut instances, &runtime.persisted.session_aliases)",
		);
	});
});
