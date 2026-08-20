import type {
	HistoryItem,
	InstanceState,
	LiveEvent,
	PendingPrompt,
	PromptAnswer,
} from "@pi-anywhere/protocol";
import { useRouter } from "expo-router";
import {
	type PropsWithChildren,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	ActivityIndicator,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ApiError } from "../../src/api/client";
import { Composer } from "../../src/components/Composer";
import { PimoBackground } from "../../src/components/PimoBackground";
import { PromptCard } from "../../src/components/PromptCard";
import { Timeline } from "../../src/components/Timeline";
import {
	filterForIncomingPrompt,
	includesConversation,
	type TimelineFilter,
} from "../../src/components/timeline-filter";
import { useConnection } from "../../src/state/connection";
import {
	cacheTranscript,
	getCachedTranscript,
	mergeHistoryEntries,
	mergeLiveEvents,
	removeHistoryDuplicates,
} from "../../src/state/transcript-cache";
import { COLORS, RADIUS, SPACE } from "../../src/theme";

function messageFrom(cause: unknown): string {
	if (cause instanceof ApiError && cause.status === 401)
		return "This phone is no longer paired. Pair it again from Settings.";
	return cause instanceof Error ? cause.message : String(cause);
}

function formatTimestamp(timestamp: number): string {
	if (!Number.isFinite(timestamp)) return "";
	return new Date(timestamp).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

function SessionFrame({ children }: PropsWithChildren) {
	return (
		<PimoBackground>
			<SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
				{children}
			</SafeAreaView>
		</PimoBackground>
	);
}

function SessionTopBar({ onBack }: { onBack: () => void }) {
	return (
		<View style={styles.navigation}>
			<Pressable
				accessibilityRole="button"
				accessibilityLabel="Back to sessions"
				hitSlop={12}
				onPress={onBack}
				style={({ pressed }) => [
					styles.backButton,
					pressed && styles.backButtonPressed,
				]}
			>
				<Text style={styles.backArrow}>‹</Text>
				<Text style={styles.backText}>Back</Text>
			</Pressable>
			<Text style={styles.navigationTitle}>Session</Text>
			<View style={styles.navigationBalance} />
		</View>
	);
}

export default function InstanceScreen() {
	const router = useRouter();
	const { api, instances, selectedInstanceId: instanceId } = useConnection();
	const initialCache = useRef(
		instanceId ? getCachedTranscript(instanceId) : undefined,
	).current;
	const [events, setEvents] = useState<LiveEvent[]>(initialCache?.events ?? []);
	const [history, setHistory] = useState<HistoryItem[]>(
		initialCache?.history ?? [],
	);
	const nextHistoryCursor = useRef<string | undefined>(
		initialCache?.nextHistoryCursor,
	);
	const [hasMoreHistory, setHasMoreHistory] = useState(
		initialCache?.hasMoreHistory ?? false,
	);
	const [historyLoading, setHistoryLoading] = useState(false);
	const historyLoadingRef = useRef(false);
	const [historyError, setHistoryError] = useState<string | null>(null);
	const [prompts, setPrompts] = useState<PendingPrompt[]>([]);
	const [settledPrompts, setSettledPrompts] = useState<Record<string, string>>(
		{},
	);
	const [cursor, setCursor] = useState(initialCache?.cursor ?? 0);
	const cursorRef = useRef(initialCache?.cursor ?? 0);
	const [filter, setFilter] = useState<TimelineFilter>("chat");
	const [state, setState] = useState<InstanceState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(!initialCache);
	const pollInFlight = useRef(false);
	const nearBottom = useRef(true);
	const scrollView = useRef<ScrollView>(null);

	const instance = useMemo(
		() => instances.find((item) => item.id === instanceId),
		[instances, instanceId],
	);

	const timelineEvents = useMemo(
		() => removeHistoryDuplicates(history, events),
		[events, history],
	);

	const scrollToLatest = useCallback((animated = false) => {
		requestAnimationFrame(() => scrollView.current?.scrollToEnd({ animated }));
	}, []);

	const latestPromptId = prompts[prompts.length - 1]?.id;
	useEffect(() => {
		if (!latestPromptId) return;
		setFilter(filterForIncomingPrompt());
		nearBottom.current = true;
		scrollToLatest(true);
	}, [latestPromptId, scrollToLatest]);

	const loadHistory = useCallback(
		async (older = false, replace = false) => {
			if (!api || !instanceId || historyLoadingRef.current) return;
			const requestedCursor = older ? nextHistoryCursor.current : undefined;
			if (older && !requestedCursor) return;
			historyLoadingRef.current = true;
			setHistoryLoading(true);
			setHistoryError(null);
			try {
				const page = await api.history(instanceId, requestedCursor, 100);
				setHistory((current) =>
					replace || page.resetRequired
						? page.entries
						: mergeHistoryEntries(current, page.entries, older),
				);
				nextHistoryCursor.current = page.nextCursor;
				setHasMoreHistory(Boolean(page.nextCursor));
				if (!older) {
					nearBottom.current = true;
					scrollToLatest(false);
				}
			} catch (cause) {
				setHistoryError(messageFrom(cause));
			} finally {
				historyLoadingRef.current = false;
				setHistoryLoading(false);
			}
		},
		[api, instanceId, scrollToLatest],
	);

	const poll = useCallback(async () => {
		if (!api || !instanceId || pollInFlight.current) return;
		pollInFlight.current = true;
		try {
			const next = await api.state(instanceId, cursorRef.current);
			const nextEvents = Array.isArray(next.events) ? next.events : [];
			setState(next);
			cursorRef.current = next.cursor;
			setCursor(next.cursor);
			if (next.resetRequired) {
				setEvents([]);
				setHistory([]);
				nextHistoryCursor.current = undefined;
				setHasMoreHistory(false);
				await loadHistory(false, true);
			} else {
				setEvents((current) => mergeLiveEvents(current, nextEvents));
			}
			const closedPromptIds = nextEvents.flatMap((event) =>
				event.kind === "prompt" && event.promptId ? [event.promptId] : [],
			);
			if (closedPromptIds.length > 0) {
				setSettledPrompts((current) => {
					const updated = { ...current };
					for (const promptId of closedPromptIds)
						if (!updated[promptId])
							updated[promptId] = "Answered in Pi terminal.";
					return updated;
				});
			}
			if (next.question) {
				setPrompts((current) =>
					current.some((prompt) => prompt.id === next.question?.id)
						? current
						: [...current, next.question as PendingPrompt],
				);
			}
			setPrompts((current) =>
				current.filter(
					(prompt) =>
						!closedPromptIds.includes(prompt.id) && !settledPrompts[prompt.id],
				),
			);
			setError(null);
		} catch (cause) {
			setError(messageFrom(cause));
		} finally {
			pollInFlight.current = false;
			setLoading(false);
		}
	}, [api, instanceId, loadHistory, settledPrompts]);

	useEffect(() => {
		void loadHistory(false);
	}, [loadHistory]);

	useEffect(() => {
		void poll();
		const timer = setInterval(
			() => void poll(),
			state?.agent || prompts.length > 0 ? 650 : 1300,
		);
		return () => clearInterval(timer);
	}, [poll, state?.agent, prompts.length]);

	useEffect(() => {
		if (!instanceId) return;
		cacheTranscript(instanceId, {
			history,
			events,
			cursor,
			nextHistoryCursor: nextHistoryCursor.current,
			hasMoreHistory,
		});
	}, [cursor, events, hasMoreHistory, history, instanceId]);

	async function answer(prompt: PendingPrompt, value: PromptAnswer) {
		if (!api || !instanceId) return;
		await api.answer(instanceId, prompt.id, value);
		setSettledPrompts((current) => ({
			...current,
			[prompt.id]: "Answer sent to Pi.",
		}));
	}

	const goBack = () => {
		if (router.canGoBack()) router.back();
		else router.replace("/");
	};

	if (loading && !instance && history.length === 0)
		return (
			<SessionFrame>
				<SessionTopBar onBack={goBack} />
				<View style={styles.center}>
					<ActivityIndicator color={COLORS.orange} />
					<Text style={styles.muted}>Loading session…</Text>
				</View>
			</SessionFrame>
		);
	if (!api)
		return (
			<SessionFrame>
				<SessionTopBar onBack={goBack} />
				<View style={styles.center}>
					<Text style={styles.error}>This phone is not paired.</Text>
				</View>
			</SessionFrame>
		);
	if (!instanceId)
		return (
			<SessionFrame>
				<SessionTopBar onBack={goBack} />
				<View style={styles.center}>
					<Text style={styles.error}>
						Return home and choose a live session.
					</Text>
				</View>
			</SessionFrame>
		);

	const working = state ? Boolean(state.agent) : instance?.state === "working";
	const showConversation = includesConversation(filter);
	return (
		<SessionFrame>
			<SessionTopBar onBack={goBack} />
			<View style={styles.filterDock}>
				<View style={styles.filters}>
					{(["chat", "all", "activity"] as TimelineFilter[]).map((value) => (
						<Pressable
							key={value}
							onPress={() => setFilter(value)}
							style={({ pressed }) => [
								styles.filter,
								filter === value && styles.filterActive,
								pressed && styles.filterPressed,
							]}
						>
							<Text
								style={[
									styles.filterText,
									filter === value && styles.filterTextActive,
								]}
							>
								{value[0].toUpperCase() + value.slice(1)}
							</Text>
						</Pressable>
					))}
				</View>
			</View>
			<ScrollView
				ref={scrollView}
				contentContainerStyle={styles.content}
				keyboardShouldPersistTaps="handled"
				maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
				scrollEventThrottle={100}
				onScroll={({ nativeEvent }) => {
					nearBottom.current =
						nativeEvent.layoutMeasurement.height +
							nativeEvent.contentOffset.y >=
						nativeEvent.contentSize.height - 90;
				}}
				onContentSizeChange={() => {
					if (nearBottom.current) scrollToLatest(false);
				}}
			>
				<View style={styles.heading}>
					<View style={styles.headingCopy}>
						<View style={styles.liveLine}>
							<View
								style={[
									styles.liveDot,
									working ? styles.workingDot : styles.readyDot,
								]}
							/>
							<Text style={styles.kicker}>
								{working ? "WORKING NOW" : "READY"}
							</Text>
						</View>
						<Text style={styles.title}>
							{instance?.sessionName || instance?.projectName || "Pi session"}
						</Text>
						<Text style={styles.muted}>
							{instance?.projectName} · {instance?.model || "model unavailable"}
						</Text>
					</View>
				</View>
				{error && (
					<View style={styles.errorCard}>
						<Text style={styles.error}>{error}</Text>
					</View>
				)}
				{historyError && (
					<View style={styles.errorCard}>
						<Text style={styles.error}>Chat history: {historyError}</Text>
					</View>
				)}
				{showConversation && hasMoreHistory && (
					<Pressable
						disabled={historyLoading}
						style={styles.more}
						onPress={() => void loadHistory(true)}
					>
						<Text style={styles.moreText}>
							{historyLoading
								? "Loading earlier messages…"
								: "Load earlier messages"}
						</Text>
					</Pressable>
				)}
				{showConversation && historyLoading && history.length === 0 && (
					<View style={styles.historyLoading}>
						<ActivityIndicator color={COLORS.orange} size="small" />
						<Text style={styles.muted}>Loading conversation history…</Text>
					</View>
				)}
				{showConversation &&
					history.map((item) => (
						<View
							key={item.id}
							style={[
								styles.historyItem,
								item.role === "user" && styles.historyUser,
							]}
						>
							<View style={styles.messageMeta}>
								<Text style={styles.label}>
									{item.role === "user" ? "You" : "Pi"}
								</Text>
								<Text style={styles.timestamp}>
									{formatTimestamp(item.timestamp)}
								</Text>
							</View>
							<Text style={styles.historyText}>{item.text}</Text>
						</View>
					))}
				<Timeline
					events={timelineEvents}
					filter={filter}
					hideEmpty={
						showConversation && (history.length > 0 || historyLoading)
					}
				/>
				{showConversation &&
					prompts.map((prompt) => (
						<PromptCard
							key={prompt.id}
							prompt={prompt}
							disabled={Boolean(settledPrompts[prompt.id])}
							onSubmit={(value) => answer(prompt, value)}
							settledNote={settledPrompts[prompt.id]}
						/>
					))}
			</ScrollView>
			<Composer
				busy={working}
				onSend={(text, delivery) =>
					api.sendMessage(instanceId, text, delivery).then(() => undefined)
				}
			/>
		</SessionFrame>
	);
}

const styles = StyleSheet.create({
	safe: { flex: 1, backgroundColor: "transparent" },
	navigation: {
		height: 52,
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingHorizontal: SPACE.lg,
		borderBottomWidth: 1,
		borderBottomColor: COLORS.line,
		backgroundColor: COLORS.surface,
	},
	backButton: {
		minWidth: 72,
		flexDirection: "row",
		alignItems: "center",
		gap: 4,
		paddingVertical: 8,
		borderRadius: RADIUS.sm,
	},
	backButtonPressed: { opacity: 0.65 },
	backArrow: {
		color: COLORS.orange,
		fontSize: 30,
		lineHeight: 25,
		fontWeight: "500",
	},
	backText: { color: COLORS.ink, fontSize: 14, fontWeight: "800" },
	navigationTitle: { color: COLORS.ink, fontSize: 15, fontWeight: "900" },
	navigationBalance: { width: 72 },
	filterDock: {
		zIndex: 10,
		paddingHorizontal: SPACE.lg,
		paddingVertical: SPACE.sm,
		backgroundColor: "#171411e8",
		shadowColor: "#000",
		shadowOffset: { width: 0, height: 5 },
		shadowOpacity: 0.28,
		shadowRadius: 8,
		elevation: 8,
	},
	content: {
		paddingHorizontal: SPACE.lg,
		paddingTop: SPACE.md,
		paddingBottom: SPACE.lg,
		gap: SPACE.md,
	},
	center: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		gap: SPACE.sm,
		backgroundColor: "transparent",
	},
	heading: {
		flexDirection: "row",
		justifyContent: "space-between",
		gap: SPACE.sm,
	},
	headingCopy: { flex: 1, gap: 5 },
	liveLine: { flexDirection: "row", alignItems: "center", gap: 7 },
	liveDot: { width: 8, height: 8, borderRadius: 5 },
	readyDot: { backgroundColor: COLORS.mint },
	workingDot: { backgroundColor: COLORS.orange },
	kicker: {
		color: COLORS.amber,
		fontSize: 10,
		fontWeight: "900",
		letterSpacing: 1.5,
	},
	title: { color: COLORS.ink, fontSize: 24, lineHeight: 29, fontWeight: "900" },
	muted: { color: COLORS.muted, fontSize: 12, lineHeight: 19 },
	filters: {
		flexDirection: "row",
		gap: 4,
		padding: 4,
		borderRadius: RADIUS.pill,
		borderWidth: 1,
		borderColor: COLORS.line,
		backgroundColor: COLORS.surface,
	},
	filter: {
		flex: 1,
		alignItems: "center",
		paddingVertical: 9,
		paddingHorizontal: 10,
		borderRadius: RADIUS.pill,
	},
	filterActive: { backgroundColor: COLORS.orangeSoft },
	filterPressed: { opacity: 0.72 },
	filterText: { color: COLORS.muted, fontSize: 12, fontWeight: "800" },
	filterTextActive: { color: COLORS.ink },
	errorCard: {
		padding: SPACE.md,
		borderRadius: RADIUS.sm,
		borderWidth: 1,
		borderColor: COLORS.danger,
		backgroundColor: COLORS.dangerSoft,
	},
	error: { color: COLORS.danger, lineHeight: 19 },
	historyLoading: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "center",
		gap: SPACE.sm,
		padding: SPACE.md,
	},
	historyItem: {
		padding: SPACE.md,
		borderRadius: RADIUS.md,
		borderWidth: 1,
		borderColor: COLORS.line,
		backgroundColor: COLORS.surface,
		gap: 5,
	},
	historyUser: {
		alignSelf: "flex-end",
		maxWidth: "94%",
		backgroundColor: COLORS.orangeSoft,
		borderColor: "#9d5b3f",
	},
	messageMeta: {
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
	timestamp: { color: COLORS.faint, fontSize: 9 },
	historyText: { color: COLORS.ink, lineHeight: 20 },
	more: {
		alignItems: "center",
		padding: SPACE.sm,
		borderRadius: RADIUS.pill,
		borderWidth: 1,
		borderColor: COLORS.line,
		backgroundColor: COLORS.surfaceSoft,
	},
	moreText: { color: COLORS.orange, fontWeight: "900", fontSize: 12 },
});
