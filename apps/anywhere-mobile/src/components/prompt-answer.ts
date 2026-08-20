import type { PendingPrompt, PromptAnswer } from "@pi-anywhere/protocol";

export function buildPromptAnswer(
	prompt: PendingPrompt,
	selected: string[],
	freeform: string,
	comment: string,
): PromptAnswer | undefined {
	const typed = freeform.trim();
	if (typed && prompt.allowFreeform) return { kind: "freeform", text: typed };
	if (selected.length === 0) return undefined;
	const trimmedComment = comment.trim();
	return {
		kind: "selection",
		selections: selected,
		...(prompt.allowComment && trimmedComment
			? { comment: trimmedComment }
			: {}),
	};
}
