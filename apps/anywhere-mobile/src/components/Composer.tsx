import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { COLORS, RADIUS, SPACE } from "../theme";

export function Composer({
	onSend,
	busy,
}: {
	onSend: (text: string, delivery: "steer" | "followUp") => Promise<void>;
	busy: boolean;
}) {
	const [text, setText] = useState("");
	const [delivery, setDelivery] = useState<"steer" | "followUp">("followUp");
	const [error, setError] = useState<string | null>(null);
	const [sending, setSending] = useState(false);

	async function send() {
		const value = text.trim();
		if (!value) return;
		setSending(true);
		setError(null);
		try {
			await onSend(value, delivery);
			setText("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setSending(false);
		}
	}

	return (
		<View style={styles.container}>
			<TextInput
				value={text}
				onChangeText={setText}
				multiline
				maxLength={12000}
				placeholder="Send a message to Pi…"
				placeholderTextColor={COLORS.faint}
				style={styles.input}
			/>
			{busy && (
				<View style={styles.delivery}>
					<Text style={styles.hint}>While Pi is working:</Text>
					<Pressable
						onPress={() =>
							setDelivery((value) =>
								value === "followUp" ? "steer" : "followUp",
							)
						}
					>
						<Text style={styles.choice}>
							{delivery === "followUp" ? "Queue next" : "Steer now"}
						</Text>
					</Pressable>
				</View>
			)}
			{error && <Text style={styles.error}>{error}</Text>}
			<Pressable
				disabled={sending || !text.trim()}
				onPress={() => void send()}
				style={[
					styles.button,
					(!text.trim() || sending) && styles.buttonDisabled,
				]}
			>
				<Text style={styles.buttonText}>{sending ? "Sending…" : "Send"}</Text>
			</Pressable>
		</View>
	);
}

const styles = StyleSheet.create({
	container: {
		gap: 8,
		padding: SPACE.md,
		borderRadius: RADIUS.md,
		borderWidth: 1,
		borderColor: COLORS.line,
		backgroundColor: COLORS.surface,
	},
	input: {
		minHeight: 62,
		color: COLORS.ink,
		padding: 11,
		borderRadius: RADIUS.sm,
		borderWidth: 1,
		borderColor: COLORS.line,
		backgroundColor: COLORS.surfaceSoft,
		textAlignVertical: "top",
	},
	delivery: {
		flexDirection: "row",
		flexWrap: "wrap",
		gap: 6,
		alignItems: "center",
	},
	hint: { color: COLORS.muted, fontSize: 12 },
	choice: { color: COLORS.orange, fontSize: 12, fontWeight: "900" },
	error: { color: COLORS.danger },
	button: {
		alignSelf: "flex-end",
		paddingVertical: 10,
		paddingHorizontal: 16,
		borderRadius: RADIUS.sm,
		backgroundColor: COLORS.orange,
	},
	buttonDisabled: { opacity: 0.45 },
	buttonText: { color: COLORS.inkDark, fontWeight: "900" },
});
