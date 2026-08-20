import type { PendingPrompt, PromptAnswer } from "@pi-anywhere/protocol";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { COLORS, RADIUS, SPACE } from "../theme";
import { buildPromptAnswer } from "./prompt-answer";

export function PromptCard({
	prompt,
	disabled,
	settledNote,
	onSubmit,
}: {
	prompt: PendingPrompt;
	disabled?: boolean;
	settledNote?: string;
	onSubmit: (answer: PromptAnswer) => Promise<void>;
}) {
	const [selected, setSelected] = useState<string[]>([]);
	const [freeform, setFreeform] = useState("");
	const [comment, setComment] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function toggle(title: string) {
		if (prompt.allowMultiple)
			setSelected((current) =>
				current.includes(title)
					? current.filter((item) => item !== title)
					: [...current, title],
			);
		else setSelected([title]);
	}

	async function submit() {
		const answer = buildPromptAnswer(prompt, selected, freeform, comment);
		if (!answer) {
			setError("Select an option or write an answer first.");
			return;
		}
		setError(null);
		setSubmitting(true);
		try {
			await onSubmit(answer);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setSubmitting(false);
		}
	}

	const unavailable = disabled || submitting;
	return (
		<View style={[styles.card, disabled && styles.settled]}>
			<Text style={styles.kicker}>
				{prompt.kind === "specialist"
					? "SPECIALIST REQUEST"
					: "PI NEEDS YOUR ANSWER"}
			</Text>
			<Text style={styles.heading}>{prompt.question}</Text>
			{prompt.context && <Text style={styles.context}>{prompt.context}</Text>}
			{(Array.isArray(prompt.options) ? prompt.options : []).map((option) => {
				const checked = selected.includes(option.title);
				return (
					<Pressable
						key={option.title}
						disabled={unavailable}
						onPress={() => toggle(option.title)}
						style={[styles.option, checked && styles.optionSelected]}
					>
						<Text style={styles.checkbox}>{checked ? "●" : "○"}</Text>
						<View style={styles.optionCopy}>
							<Text style={styles.optionTitle}>{option.title}</Text>
							{option.description && (
								<Text style={styles.optionDescription}>
									{option.description}
								</Text>
							)}
						</View>
					</Pressable>
				);
			})}
			{prompt.allowFreeform && (
				<TextInput
					editable={!unavailable}
					multiline
					value={freeform}
					onChangeText={setFreeform}
					placeholder="Or write a response…"
					placeholderTextColor={COLORS.faint}
					style={styles.input}
				/>
			)}
			{prompt.allowComment && selected.length > 0 && (
				<TextInput
					editable={!unavailable}
					multiline
					value={comment}
					onChangeText={setComment}
					placeholder="Optional comment…"
					placeholderTextColor={COLORS.faint}
					style={styles.input}
				/>
			)}
			{error && <Text style={styles.error}>{error}</Text>}
			{settledNote ? (
				<Text style={styles.success}>{settledNote}</Text>
			) : (
				<Pressable
					disabled={unavailable}
					onPress={() => void submit()}
					style={[styles.submit, unavailable && styles.disabled]}
				>
					<Text style={styles.submitText}>
						{submitting ? "Sending…" : "Submit answer"}
					</Text>
				</Pressable>
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	card: {
		padding: SPACE.lg,
		borderRadius: RADIUS.lg,
		borderWidth: 1,
		borderColor: COLORS.amber,
		backgroundColor: COLORS.amberSoft,
		gap: SPACE.sm,
	},
	settled: { borderColor: COLORS.mint, backgroundColor: COLORS.mintSoft },
	kicker: {
		color: COLORS.amber,
		fontSize: 10,
		fontWeight: "900",
		letterSpacing: 1.4,
	},
	heading: {
		color: COLORS.ink,
		fontSize: 16,
		lineHeight: 22,
		fontWeight: "800",
	},
	context: { color: COLORS.muted, lineHeight: 19 },
	option: {
		flexDirection: "row",
		gap: SPACE.sm,
		alignItems: "flex-start",
		padding: SPACE.sm,
		borderRadius: RADIUS.sm,
		borderWidth: 1,
		borderColor: COLORS.line,
		backgroundColor: COLORS.surfaceSoft,
	},
	optionSelected: {
		borderColor: COLORS.orange,
		backgroundColor: COLORS.orangeSoft,
	},
	checkbox: { color: COLORS.orange, fontSize: 18 },
	optionCopy: { flex: 1, gap: 2 },
	optionTitle: { color: COLORS.ink, fontWeight: "800" },
	optionDescription: { color: COLORS.muted, fontSize: 12, lineHeight: 17 },
	input: {
		minHeight: 54,
		padding: 10,
		borderRadius: RADIUS.sm,
		borderWidth: 1,
		borderColor: COLORS.line,
		backgroundColor: COLORS.surfaceSoft,
		color: COLORS.ink,
		textAlignVertical: "top",
	},
	error: { color: COLORS.danger },
	success: { color: COLORS.mint, fontWeight: "800" },
	submit: {
		alignSelf: "flex-end",
		paddingVertical: 10,
		paddingHorizontal: 14,
		borderRadius: RADIUS.sm,
		backgroundColor: COLORS.orange,
	},
	disabled: { opacity: 0.45 },
	submitText: { color: COLORS.inkDark, fontWeight: "900" },
});
