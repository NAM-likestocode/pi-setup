import type { HistoryItem, LiveEvent } from "@pi-anywhere/protocol";

export interface TranscriptSnapshot {
	history: HistoryItem[];
	events: LiveEvent[];
	cursor: number;
	nextHistoryCursor?: string;
	hasMoreHistory: boolean;
}

const MAX_CACHED_SESSIONS = 12;
const transcriptCache = new Map<string, TranscriptSnapshot>();

export function mergeLiveEvents(
	current: LiveEvent[],
	incoming: LiveEvent[],
): LiveEvent[] {
	const byId = new Map<string, LiveEvent>();
	for (const event of current)
		byId.set(`${event.kind}:${event.id || event.cursor}`, event);
	for (const event of incoming) {
		if (
			(event.kind === "message" || event.kind === "message_delta") &&
			event.id
		) {
			const key = `message:${event.id}`;
			const previous = byId.get(key);
			byId.set(
				key,
				event.kind === "message_delta"
					? {
							...event,
							kind: "message",
							text: `${previous?.text || ""}${event.text || ""}`,
						}
					: event,
			);
		} else if (event.kind === "activity" && event.activity) {
			byId.set(`activity:${event.activity.id}`, event);
		} else {
			byId.set(`${event.kind}:${event.id || event.cursor}`, event);
		}
	}
	return [...byId.values()].sort((a, b) => a.cursor - b.cursor).slice(-500);
}

export function mergeHistoryEntries(
	current: HistoryItem[],
	incoming: HistoryItem[],
	prepend = false,
): HistoryItem[] {
	const merged = prepend
		? [...incoming, ...current]
		: [...current, ...incoming];
	const seen = new Set<string>();
	return merged.filter((item) => {
		if (seen.has(item.id)) return false;
		seen.add(item.id);
		return true;
	});
}

function messageFingerprint(
	role: "user" | "assistant" | undefined,
	text: string | undefined,
): string | undefined {
	const normalized = text?.trim();
	return role && normalized ? `${role}\u0000${normalized}` : undefined;
}

export function removeHistoryDuplicates(
	history: HistoryItem[],
	events: LiveEvent[],
): LiveEvent[] {
	const historyTimes = new Map<string, number[]>();
	for (const item of history) {
		const fingerprint = messageFingerprint(item.role, item.text);
		if (!fingerprint) continue;
		const times = historyTimes.get(fingerprint) ?? [];
		times.push(item.timestamp);
		historyTimes.set(fingerprint, times);
	}
	return events.filter((event) => {
		if (event.kind !== "message" && event.kind !== "message_delta") return true;
		const fingerprint = messageFingerprint(event.role, event.text);
		if (!fingerprint) return true;
		const matches = historyTimes.get(fingerprint);
		if (!matches?.length) return true;
		const eventTimestamp = event.timestamp;
		if (typeof eventTimestamp !== "number") return false;
		return !matches.some(
			(timestamp) => Math.abs(timestamp - eventTimestamp) < 2 * 60 * 1_000,
		);
	});
}

export function getCachedTranscript(
	instanceId: string,
): TranscriptSnapshot | undefined {
	const snapshot = transcriptCache.get(instanceId);
	return snapshot
		? {
				...snapshot,
				history: [...snapshot.history],
				events: [...snapshot.events],
			}
		: undefined;
}

export function cacheTranscript(
	instanceId: string,
	snapshot: TranscriptSnapshot,
): void {
	transcriptCache.delete(instanceId);
	transcriptCache.set(instanceId, {
		...snapshot,
		history: [...snapshot.history],
		events: [...snapshot.events],
	});
	while (transcriptCache.size > MAX_CACHED_SESSIONS) {
		const oldest = transcriptCache.keys().next().value;
		if (typeof oldest !== "string") break;
		transcriptCache.delete(oldest);
	}
}

export function clearTranscriptCache(): void {
	transcriptCache.clear();
}
