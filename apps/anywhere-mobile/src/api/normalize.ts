import type {
	InstanceState,
	LiveEvent,
	PendingPrompt,
} from "@pi-anywhere/protocol";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function normalizeInstanceState(
	instanceId: string,
	value: unknown,
): InstanceState | undefined {
	const state = asRecord(value);
	if (!state || typeof state.cursor !== "number") return undefined;
	return {
		version: 2,
		instanceId:
			typeof state.instanceId === "string" ? state.instanceId : instanceId,
		epoch: typeof state.epoch === "string" ? state.epoch : "",
		cursor: state.cursor,
		oldestCursor:
			typeof state.oldestCursor === "number"
				? state.oldestCursor
				: state.cursor,
		resetRequired: Boolean(state.resetRequired),
		events: Array.isArray(state.events) ? (state.events as LiveEvent[]) : [],
		question: asRecord(state.question)
			? (state.question as unknown as PendingPrompt)
			: undefined,
		agent: Boolean(state.agent),
	};
}
