import { describe, expect, it } from "vitest";
import {
	cacheTranscript,
	clearTranscriptCache,
	getCachedTranscript,
	mergeHistoryEntries,
	mergeLiveEvents,
	removeHistoryDuplicates,
} from "../apps/anywhere-mobile/src/state/transcript-cache.ts";
import { getHistoryPage } from "../extensions/anywhere/history.ts";

function contextWithMessages(count: number) {
	const branch = Array.from({ length: count }, (_, index) => ({
		id: `entry-${index + 1}`,
		parentId: index > 0 ? `entry-${index}` : undefined,
		timestamp: `2026-08-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
		message: {
			role: index % 2 === 0 ? "user" : "assistant",
			content: `message ${index + 1}`,
		},
	}));
	return {
		sessionManager: { getBranch: () => branch },
	} as never;
}

describe("Anywhere conversation history", () => {
	it("opens on the latest messages and pages backward", () => {
		const context = contextWithMessages(6);
		const latest = getHistoryPage(
			context,
			"instance-1",
			"epoch-1",
			undefined,
			2,
		);
		expect(latest.entries.map((entry) => entry.id)).toEqual([
			"entry-5",
			"entry-6",
		]);
		expect(latest.nextCursor).toBe("entry-5");
		expect(latest.entries[0]?.timestamp).toBe(
			Date.parse("2026-08-05T12:00:00.000Z"),
		);

		const older = getHistoryPage(
			context,
			"instance-1",
			"epoch-1",
			latest.nextCursor,
			2,
		);
		expect(older.entries.map((entry) => entry.id)).toEqual([
			"entry-3",
			"entry-4",
		]);
		expect(older.nextCursor).toBe("entry-3");
	});

	it("recovers an unknown cursor with the latest page", () => {
		const page = getHistoryPage(
			contextWithMessages(4),
			"instance-1",
			"epoch-1",
			"missing-entry",
			2,
		);
		expect(page.resetRequired).toBe(true);
		expect(page.entries.map((entry) => entry.id)).toEqual([
			"entry-3",
			"entry-4",
		]);
	});

	it("prepends older pages without duplicating messages", () => {
		const latest = [
			{ id: "3", timestamp: 3, role: "user" as const, text: "three" },
			{ id: "4", timestamp: 4, role: "assistant" as const, text: "four" },
		];
		const older = [
			{ id: "1", timestamp: 1, role: "user" as const, text: "one" },
			{ id: "3", timestamp: 3, role: "user" as const, text: "three" },
		];
		expect(
			mergeHistoryEntries(latest, older, true).map((entry) => entry.id),
		).toEqual(["1", "3", "4"]);
	});

	it("keeps live chat while hiding copies already present in history", () => {
		const history = [
			{
				id: "entry-1",
				timestamp: 1_000,
				role: "assistant" as const,
				text: "Finished",
			},
		];
		const events = mergeLiveEvents(
			[],
			[
				{
					cursor: 1,
					kind: "message_delta",
					id: "stream-1",
					role: "assistant",
					text: "Fin",
					timestamp: 900,
				},
				{
					cursor: 2,
					kind: "message_delta",
					id: "stream-1",
					role: "assistant",
					text: "ished",
					timestamp: 1_100,
				},
			],
		);
		expect(events[0]?.text).toBe("Finished");
		expect(removeHistoryDuplicates(history, events)).toEqual([]);
	});

	it("keeps a bounded in-memory transcript when switching sessions", () => {
		clearTranscriptCache();
		cacheTranscript("instance-1", {
			history: [{ id: "1", timestamp: 1, role: "user", text: "remember me" }],
			events: [],
			cursor: 7,
			nextHistoryCursor: "1",
			hasMoreHistory: true,
		});
		expect(getCachedTranscript("instance-1")?.history[0]?.text).toBe(
			"remember me",
		);
		clearTranscriptCache();
		expect(getCachedTranscript("instance-1")).toBeUndefined();
	});
});
