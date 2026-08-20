import type { LiveEvent } from "@pi-anywhere/protocol";
import { StyleSheet, Text, View } from "react-native";
import { COLORS, RADIUS, SPACE } from "../theme";
import type { TimelineFilter } from "./timeline-filter";

export type { TimelineFilter } from "./timeline-filter";

function formatTimestamp(timestamp: number | undefined): string {
	if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return "";
	return new Date(timestamp).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

export function Timeline({
	events,
	filter,
	hideEmpty = false,
}: {
	events: LiveEvent[];
	filter: TimelineFilter;
	hideEmpty?: boolean;
}) {
	const visible = (Array.isArray(events) ? events : []).filter((event) => {
		const chat = event.kind === "message" || event.kind === "message_delta";
		const activity = event.kind === "activity" && Boolean(event.activity);
		return filter === "all"
			? chat || activity
			: filter === "chat"
				? chat
				: activity;
	});
	if (visible.length === 0)
		return hideEmpty ? null : (
			<Text style={styles.empty}>
				{filter === "activity"
					? "No activity recorded yet."
					: "No conversation messages yet."}
			</Text>
		);
	return (
		<View style={styles.list}>
			{visible.map((event) => {
				if (event.kind === "message" || event.kind === "message_delta") {
					return (
						<View
							key={`${event.cursor}-${event.id || event.kind}`}
							style={[styles.message, event.role === "user" && styles.user]}
						>
							<View style={styles.meta}>
								<Text style={styles.label}>
									{event.role === "user" ? "You" : "Pi"}
								</Text>
								<Text style={styles.timestamp}>
									{formatTimestamp(event.timestamp)}
								</Text>
							</View>
							<Text style={styles.text}>{event.text}</Text>
						</View>
					);
				}
				if (event.kind === "activity" && event.activity) {
					return (
						<View
							key={`${event.cursor}-${event.activity.id}`}
							style={styles.activity}
						>
							<View style={styles.meta}>
								<Text style={styles.activityLabel}>{event.activity.label}</Text>
								<Text style={styles.timestamp}>
									{formatTimestamp(event.timestamp ?? event.activity.timestamp)}
								</Text>
							</View>
							<Text style={styles.text}>
								{event.activity.detail ||
									event.activity.path ||
									event.activity.command ||
									"Activity"}
							</Text>
						</View>
					);
				}
				return null;
			})}
		</View>
	);
}

const styles = StyleSheet.create({
	list: { gap: SPACE.sm },
	message: {
		alignSelf: "flex-start",
		maxWidth: "92%",
		padding: SPACE.md,
		borderRadius: RADIUS.md,
		backgroundColor: COLORS.surface,
		borderWidth: 1,
		borderColor: COLORS.line,
		gap: 5,
	},
	user: {
		alignSelf: "flex-end",
		backgroundColor: COLORS.orangeSoft,
		borderColor: "#9d5b3f",
	},
	activity: {
		padding: SPACE.md,
		borderRadius: RADIUS.sm,
		backgroundColor: COLORS.surfaceSoft,
		borderLeftWidth: 3,
		borderLeftColor: COLORS.plum,
		gap: 5,
	},
	meta: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		gap: SPACE.md,
	},
	label: {
		color: COLORS.faint,
		fontSize: 10,
		fontWeight: "900",
		textTransform: "uppercase",
		letterSpacing: 1,
	},
	activityLabel: { color: COLORS.plum, fontSize: 11, fontWeight: "900" },
	timestamp: { color: COLORS.faint, fontSize: 9 },
	text: { color: COLORS.ink, lineHeight: 20 },
	empty: { color: COLORS.faint, textAlign: "center", padding: SPACE.xl },
});
