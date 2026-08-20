import type { InstanceSummary } from "@pi-anywhere/protocol";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { COLORS, RADIUS, SPACE } from "../theme";

export function InstanceCard({
	instance,
	onPress,
}: {
	instance: InstanceSummary;
	onPress: () => void;
}) {
	const waiting = instance.state === "waiting";
	return (
		<Pressable
			style={({ pressed }) => [styles.card, pressed && styles.pressed]}
			onPress={onPress}
		>
			<View style={styles.heading}>
				<View style={styles.titleRow}>
					<View
						style={[
							styles.stateDot,
							waiting ? styles.waitingDot : styles.readyDot,
						]}
					/>
					<Text style={styles.title} numberOfLines={1}>
						{instance.sessionName || instance.projectName}
					</Text>
				</View>
				<Text style={[styles.state, waiting ? styles.waiting : styles.ready]}>
					{waiting ? "Needs input" : instance.state}
				</Text>
			</View>
			<Text style={styles.sub} numberOfLines={1}>
				{instance.projectName} · {instance.model || "model unavailable"}
			</Text>
			<Text style={styles.path} numberOfLines={1}>
				{instance.cwd}
			</Text>
			{instance.pendingPromptCount > 0 && (
				<View style={styles.prompt}>
					<Text style={styles.promptText}>Needs your answer</Text>
					<Text style={styles.promptCount}>{instance.pendingPromptCount}</Text>
				</View>
			)}
		</Pressable>
	);
}

const styles = StyleSheet.create({
	card: {
		padding: SPACE.lg,
		borderRadius: RADIUS.md,
		borderWidth: 1,
		borderColor: COLORS.line,
		backgroundColor: COLORS.surface,
		gap: 8,
	},
	pressed: {
		backgroundColor: COLORS.surfaceRaised,
		transform: [{ scale: 0.99 }],
	},
	heading: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		gap: SPACE.sm,
	},
	titleRow: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8 },
	stateDot: { width: 8, height: 8, borderRadius: 5 },
	readyDot: { backgroundColor: COLORS.mint },
	waitingDot: { backgroundColor: COLORS.amber },
	title: { color: COLORS.ink, fontSize: 17, fontWeight: "800", flex: 1 },
	state: { fontSize: 11, fontWeight: "900", textTransform: "uppercase" },
	ready: { color: COLORS.mint },
	waiting: { color: COLORS.amber },
	sub: { color: COLORS.muted, fontSize: 12 },
	path: { color: COLORS.faint, fontSize: 11 },
	prompt: {
		flexDirection: "row",
		alignItems: "center",
		alignSelf: "flex-start",
		gap: 7,
		marginTop: 2,
		paddingVertical: 5,
		paddingHorizontal: 8,
		borderRadius: RADIUS.pill,
		backgroundColor: COLORS.amberSoft,
	},
	promptText: { color: COLORS.amber, fontSize: 11, fontWeight: "800" },
	promptCount: {
		minWidth: 16,
		color: COLORS.inkDark,
		backgroundColor: COLORS.amber,
		borderRadius: 8,
		paddingHorizontal: 4,
		textAlign: "center",
		fontSize: 10,
		fontWeight: "900",
	},
});
