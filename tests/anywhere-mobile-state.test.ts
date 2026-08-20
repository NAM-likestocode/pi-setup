import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeInstanceState } from "../apps/anywhere-mobile/src/api/normalize.ts";
import { buildPromptAnswer } from "../apps/anywhere-mobile/src/components/prompt-answer.ts";
import {
	filterForIncomingPrompt,
	includesConversation,
} from "../apps/anywhere-mobile/src/components/timeline-filter.ts";
import { revokeAndClearDevice } from "../apps/anywhere-mobile/src/state/disconnect-device.ts";

describe("mobile instance state normalization", () => {
	it("accepts the partial heartbeat state emitted by older companions", () => {
		expect(
			normalizeInstanceState("instance-1", {
				epoch: "epoch-1",
				cursor: 7,
				oldestCursor: 3,
				resetRequired: false,
				agent: true,
			}),
		).toEqual({
			version: 2,
			instanceId: "instance-1",
			epoch: "epoch-1",
			cursor: 7,
			oldestCursor: 3,
			resetRequired: false,
			events: [],
			question: undefined,
			agent: true,
		});
	});

	it("preserves events from a full companion state", () => {
		const event = { cursor: 2, kind: "message" as const, text: "hello" };
		const state = normalizeInstanceState("fallback", {
			version: 2,
			instanceId: "instance-2",
			epoch: "epoch-2",
			cursor: 2,
			oldestCursor: 2,
			resetRequired: false,
			events: [event],
			agent: false,
		});
		expect(state?.instanceId).toBe("instance-2");
		expect(state?.events).toEqual([event]);
	});

	it("rejects a response without a numeric cursor", () => {
		expect(normalizeInstanceState("instance-1", undefined)).toBeUndefined();
		expect(
			normalizeInstanceState("instance-1", { epoch: "epoch-1" }),
		).toBeUndefined();
	});

	it("treats pending questions as conversation, not activity", () => {
		expect(includesConversation("chat")).toBe(true);
		expect(includesConversation("all")).toBe(true);
		expect(includesConversation("activity")).toBe(false);
		expect(filterForIncomingPrompt()).toBe("chat");
	});

	it("builds valid selector and typed prompt answers", () => {
		const prompt = {
			version: 2 as const,
			id: "prompt-1",
			kind: "ask_user" as const,
			question: "Choose",
			options: [{ title: "Orange" }, { title: "Mint" }],
			allowMultiple: false,
			allowFreeform: true,
			allowComment: true,
			openedAt: 1,
		};
		expect(buildPromptAnswer(prompt, ["Mint"], "", "looks good")).toEqual({
			kind: "selection",
			selections: ["Mint"],
			comment: "looks good",
		});
		expect(buildPromptAnswer(prompt, [], "Other", "")).toEqual({
			kind: "freeform",
			text: "Other",
		});
	});

	it("keeps local credentials when remote revocation fails", async () => {
		let cleared = false;
		await expect(
			revokeAndClearDevice(
				{
					revoke: async () => {
						throw new Error("offline");
					},
				},
				async () => {
					cleared = true;
				},
			),
		).rejects.toMatchObject({ stage: "revoke" });
		expect(cleared).toBe(false);
	});

	it("clears local credentials only after successful revocation", async () => {
		const order: string[] = [];
		await revokeAndClearDevice(
			{
				revoke: async () => {
					order.push("revoke");
				},
			},
			async () => {
				order.push("clear");
			},
		);
		expect(order).toEqual(["revoke", "clear"]);
	});

	it("explicitly removes Android permissions that Pimo does not need", () => {
		const manifest = readFileSync(
			new URL(
				"../apps/anywhere-mobile/android/app/src/main/AndroidManifest.xml",
				import.meta.url,
			),
			"utf8",
		);
		for (const permission of [
			"READ_EXTERNAL_STORAGE",
			"WRITE_EXTERNAL_STORAGE",
			"RECORD_AUDIO",
			"SYSTEM_ALERT_WINDOW",
		]) {
			const declaration = manifest.match(
				new RegExp(
					`<uses-permission[^>]*android:name="android.permission.${permission}"[^>]*/>`,
				),
			)?.[0];
			expect(declaration).toContain('tools:node="remove"');
		}
		expect(manifest).toContain("android.permission.CAMERA");
		expect(manifest).toContain("android.permission.POST_NOTIFICATIONS");
	});

	it("renders pending questions after the live timeline", () => {
		const source = readFileSync(
			new URL(
				"../apps/anywhere-mobile/app/instance/[instanceId].tsx",
				import.meta.url,
			),
			"utf8",
		);
		expect(source.indexOf("prompts.map((prompt)")).toBeGreaterThan(
			source.indexOf("<Timeline"),
		);
	});
});
