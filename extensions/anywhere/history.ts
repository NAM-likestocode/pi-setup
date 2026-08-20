import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	ANYWHERE_DEFAULT_HISTORY_PAGE_SIZE,
	ANYWHERE_MAX_HISTORY_ITEM_CHARS,
	ANYWHERE_MAX_HISTORY_PAGE_SIZE,
	type HistoryItem,
	type HistoryPage,
} from "../../packages/anywhere-protocol/src/index.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function truncate(text: string): string {
	return text.length <= ANYWHERE_MAX_HISTORY_ITEM_CHARS
		? text
		: `${text.slice(0, ANYWHERE_MAX_HISTORY_ITEM_CHARS)}\n\n[Message truncated for the phone view]`;
}

function timestampMs(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return Date.now();
}

export function messageText(message: unknown): string {
	const record = asRecord(message);
	const content = record?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const item = asRecord(part);
			return item?.type === "text" && typeof item.text === "string"
				? item.text
				: "";
		})
		.filter(Boolean)
		.join("\n");
}

export function getHistoryPage(
	ctx: ExtensionContext,
	instanceId: string,
	epoch: string,
	cursor?: string,
	requestedLimit?: number,
): HistoryPage {
	const numericLimit = Number.isSafeInteger(requestedLimit)
		? requestedLimit
		: undefined;
	const limit =
		numericLimit === undefined
			? ANYWHERE_DEFAULT_HISTORY_PAGE_SIZE
			: Math.max(1, Math.min(ANYWHERE_MAX_HISTORY_PAGE_SIZE, numericLimit));
	const branch = ctx.sessionManager.getBranch() as unknown[];
	const entries: HistoryItem[] = [];
	for (const entry of branch) {
		const record = asRecord(entry);
		const message = asRecord(record?.message);
		const role = message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = truncate(messageText(message));
		if (!text) continue;
		const id = typeof record?.id === "string" ? record.id : undefined;
		if (!id) continue;
		entries.push({
			id,
			...(typeof record?.parentId === "string"
				? { parentId: record.parentId }
				: {}),
			timestamp: timestampMs(record?.timestamp),
			role,
			text,
		});
	}

	// The first page is the latest part of the conversation. A cursor means
	// "load messages before this entry", so the phone can prepend older pages
	// without throwing away the chat the user was reading.
	const cursorIndex = cursor
		? entries.findIndex((entry) => entry.id === cursor)
		: entries.length;
	const resetRequired = Boolean(cursor && cursorIndex < 0);
	const end = resetRequired ? entries.length : cursorIndex;
	const start = Math.max(0, end - limit);
	const page = entries.slice(start, end);
	const first = page[0];
	return {
		version: 2,
		instanceId,
		epoch,
		entries: page,
		nextCursor: start > 0 && first ? first.id : undefined,
		resetRequired,
	};
}

export function branchLeafId(ctx: ExtensionContext): string | undefined {
	const leaf = ctx.sessionManager.getLeafEntry() as unknown;
	const record = asRecord(leaf);
	return typeof record?.id === "string" ? record.id : undefined;
}
