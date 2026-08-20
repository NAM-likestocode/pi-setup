export type TimelineFilter = "all" | "chat" | "activity";

export function includesConversation(filter: TimelineFilter): boolean {
	return filter === "chat" || filter === "all";
}

export function filterForIncomingPrompt(): TimelineFilter {
	return "chat";
}
