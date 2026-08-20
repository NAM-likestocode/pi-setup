import { Link, useRouter } from "expo-router";
import {
	Image,
	Pressable,
	RefreshControl,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { InstanceCard } from "../src/components/InstanceCard";
import { PimoBackground } from "../src/components/PimoBackground";
import { useConnection } from "../src/state/connection";
import { COLORS, RADIUS, SPACE } from "../src/theme";

export default function Home() {
	const router = useRouter();
	const {
		credentials,
		instances,
		loading,
		error,
		selectInstance,
		refreshInstances,
	} = useConnection();

	function openInstance(instanceId: string) {
		selectInstance(instanceId);
		router.push("/session");
	}

	return (
		<PimoBackground>
			<SafeAreaView style={styles.safe} edges={["top"]}>
				<ScrollView
				contentContainerStyle={styles.content}
				refreshControl={
					<RefreshControl
						refreshing={loading}
						onRefresh={refreshInstances}
						tintColor={COLORS.orange}
						colors={[COLORS.orange]}
					/>
				}
			>
				<View style={styles.topline}>
					<View style={styles.brandLockup}>
						<View style={styles.brandMark}>
							<Image
								accessible={false}
								source={require("../assets/pimo-mark.png")}
								style={styles.brandLogo}
							/>
						</View>
						<Text style={styles.brand}>Pimo</Text>
					</View>
					<Link href="/settings" asChild>
						<Pressable style={styles.settingsButton}>
							<Text style={styles.settingsText}>Settings</Text>
						</Pressable>
					</Link>
				</View>

				<View style={styles.hero}>
					<View style={styles.heroOrb}>
						<Text style={styles.heroOrbText}>●</Text>
					</View>
					<Text style={styles.kicker}>REMOTE SESSIONS</Text>
					<Text style={styles.title}>Your work, still in reach.</Text>
					<Text style={styles.subtitle}>
						{credentials
							? "Choose a live Pi session from your private Tailscale network."
							: "Pair Pimo with the desktop companion to get started."}
					</Text>
				</View>

				{!credentials ? (
					<Pressable
						style={styles.primaryButton}
						onPress={() => router.push("/scan")}
					>
						<Text style={styles.primaryButtonText}>Scan pairing QR</Text>
						<Text style={styles.buttonArrow}>→</Text>
					</Pressable>
				) : instances.length === 0 ? (
					<View style={styles.emptyCard}>
						<Text style={styles.emptyKicker}>NO LIVE SESSIONS</Text>
						<Text style={styles.emptyTitle}>Start Pi in interactive mode.</Text>
						<Text style={styles.muted}>
							Connected sessions will appear here automatically.
						</Text>
					</View>
				) : (
					<View style={styles.list}>
						<View style={styles.listHeading}>
							<Text style={styles.sectionTitle}>Live now</Text>
							<Text style={styles.count}>
								{instances.length}{" "}
								{instances.length === 1 ? "session" : "sessions"}
							</Text>
						</View>
						{instances.map((instance) => (
							<InstanceCard
								key={`${instance.id}-${instance.epoch}`}
								instance={instance}
								onPress={() => openInstance(instance.id)}
							/>
						))}
					</View>
				)}
				{error && (
					<View style={styles.errorCard}>
						<Text style={styles.errorTitle}>Connection needs attention</Text>
						<Text style={styles.errorText}>{error}</Text>
					</View>
				)}
				<View style={styles.footer}>
					<Text style={styles.footerDot}>●</Text>
					<Text style={styles.footerText}>
						Private by default · no conversation data in push alerts
					</Text>
				</View>
				</ScrollView>
			</SafeAreaView>
		</PimoBackground>
	);
}

const styles = StyleSheet.create({
	safe: { flex: 1, backgroundColor: "transparent" },
	content: {
		flexGrow: 1,
		paddingHorizontal: SPACE.lg,
		paddingBottom: SPACE.xl,
		gap: SPACE.lg,
	},
	topline: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingTop: SPACE.sm,
	},
	brandLockup: { flexDirection: "row", alignItems: "center", gap: SPACE.sm },
	brandMark: {
		width: 42,
		height: 42,
		alignItems: "center",
		justifyContent: "center",
	},
	brandLogo: { width: 46, height: 46 },
	kicker: {
		color: COLORS.amber,
		fontSize: 10,
		fontWeight: "900",
		letterSpacing: 1.7,
	},
	brand: { color: COLORS.ink, fontSize: 20, fontWeight: "900" },
	settingsButton: {
		paddingVertical: 8,
		paddingHorizontal: 10,
		borderRadius: RADIUS.sm,
		borderWidth: 1,
		borderColor: COLORS.line,
	},
	settingsText: { color: COLORS.muted, fontSize: 12, fontWeight: "800" },
	hero: {
		padding: SPACE.xl,
		borderRadius: RADIUS.lg,
		backgroundColor: COLORS.surface,
		borderWidth: 1,
		borderColor: COLORS.line,
		gap: SPACE.sm,
		overflow: "hidden",
	},
	heroOrb: {
		position: "absolute",
		right: 22,
		top: 20,
		width: 70,
		height: 70,
		alignItems: "center",
		justifyContent: "center",
		borderRadius: 40,
		borderWidth: 1,
		borderColor: "#ff7a1a66",
		backgroundColor: COLORS.orangeSoft,
	},
	heroOrbText: { color: COLORS.orange, fontSize: 28 },
	title: {
		maxWidth: 280,
		color: COLORS.ink,
		fontSize: 29,
		lineHeight: 33,
		fontWeight: "900",
		letterSpacing: -0.6,
	},
	subtitle: { maxWidth: 310, color: COLORS.muted, lineHeight: 20 },
	primaryButton: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		padding: 16,
		borderRadius: RADIUS.md,
		backgroundColor: COLORS.orange,
	},
	primaryButtonText: { color: COLORS.inkDark, fontWeight: "900", fontSize: 15 },
	buttonArrow: { color: COLORS.inkDark, fontSize: 22, fontWeight: "700" },
	emptyCard: {
		padding: SPACE.xl,
		borderRadius: RADIUS.md,
		borderWidth: 1,
		borderColor: COLORS.line,
		backgroundColor: COLORS.surfaceSoft,
		gap: SPACE.sm,
	},
	emptyKicker: {
		color: COLORS.plum,
		fontSize: 10,
		letterSpacing: 1.5,
		fontWeight: "900",
	},
	emptyTitle: { color: COLORS.ink, fontSize: 17, fontWeight: "800" },
	muted: { color: COLORS.muted, lineHeight: 20 },
	list: { gap: SPACE.sm },
	listHeading: {
		flexDirection: "row",
		alignItems: "baseline",
		justifyContent: "space-between",
		paddingHorizontal: 2,
	},
	sectionTitle: { color: COLORS.ink, fontSize: 18, fontWeight: "900" },
	count: { color: COLORS.faint, fontSize: 12 },
	errorCard: {
		padding: SPACE.md,
		borderRadius: RADIUS.md,
		borderWidth: 1,
		borderColor: COLORS.danger,
		backgroundColor: COLORS.dangerSoft,
		gap: 4,
	},
	errorTitle: { color: COLORS.danger, fontWeight: "900" },
	errorText: { color: COLORS.muted, lineHeight: 19 },
	footer: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "center",
		gap: 6,
		paddingTop: SPACE.sm,
	},
	footerDot: { color: COLORS.mint, fontSize: 9 },
	footerText: { color: COLORS.faint, fontSize: 11, textAlign: "center" },
});
