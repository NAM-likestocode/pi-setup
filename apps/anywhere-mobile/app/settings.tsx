import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { PimoBackground } from "../src/components/PimoBackground";
import { useConnection } from "../src/state/connection";
import { COLORS, RADIUS, SPACE } from "../src/theme";

export default function Settings() {
	const router = useRouter();
	const { credentials, disconnect, error } = useConnection();
	const [busy, setBusy] = useState(false);

	async function revoke() {
		setBusy(true);
		try {
			await disconnect();
			router.replace("/");
		} catch {
			// The connection provider keeps the credential and exposes a retryable error.
		} finally {
			setBusy(false);
		}
	}

	return (
		<PimoBackground>
			<View style={styles.container}>
			<Text style={styles.kicker}>DEVICE ACCESS</Text>
			<Text style={styles.title}>Phone connection</Text>
			{error ? (
				<View style={styles.errorCard}>
					<Text style={styles.errorText}>{error}</Text>
				</View>
			) : null}
			{credentials ? (
				<>
					<View style={styles.infoCard}>
						<Text style={styles.infoLabel}>PAIRED HOST</Text>
						<Text style={styles.host}>{credentials.hostId}</Text>
						<Text style={styles.muted}>
							Traffic uses the paired computer’s private Tailscale HTTPS
							address.
						</Text>
					</View>
					<Pressable
						disabled={busy}
						style={styles.danger}
						onPress={() => void revoke()}
					>
						<Text style={styles.dangerText}>
							{busy ? "Disconnecting…" : "Disconnect and revoke phone"}
						</Text>
					</Pressable>
				</>
			) : (
				<>
					<View style={styles.infoCard}>
						<Text style={styles.muted}>
							This phone is not paired to Pimo Companion.
						</Text>
					</View>
					<Pressable
						style={styles.primary}
						onPress={() => router.push("/scan")}
					>
						<Text style={styles.primaryText}>Scan pairing QR</Text>
					</Pressable>
				</>
			)}
			<View style={styles.spacer} />
			<Text style={styles.build}>Version 0.1.7 · Android build 8</Text>
				<Text style={styles.note}>
					Push notifications are generic. They never contain prompt text, project
					names, paths, or conversation data.
				</Text>
			</View>
		</PimoBackground>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		padding: SPACE.lg,
		gap: SPACE.md,
		backgroundColor: "transparent",
	},
	kicker: {
		color: COLORS.amber,
		fontSize: 10,
		fontWeight: "900",
		letterSpacing: 1.7,
	},
	title: {
		color: COLORS.ink,
		fontSize: 26,
		fontWeight: "900",
		marginBottom: SPACE.sm,
	},
	infoCard: {
		padding: SPACE.lg,
		borderRadius: RADIUS.md,
		borderWidth: 1,
		borderColor: COLORS.line,
		backgroundColor: COLORS.surface,
		gap: 8,
	},
	infoLabel: {
		color: COLORS.faint,
		fontSize: 10,
		fontWeight: "900",
		letterSpacing: 1.4,
	},
	host: { color: COLORS.plum, fontSize: 13, fontWeight: "800" },
	muted: { color: COLORS.muted, lineHeight: 20 },
	primary: {
		alignItems: "center",
		padding: 14,
		borderRadius: RADIUS.sm,
		backgroundColor: COLORS.orange,
	},
	primaryText: { color: COLORS.inkDark, fontWeight: "900" },
	danger: {
		alignItems: "center",
		padding: 14,
		borderRadius: RADIUS.sm,
		borderWidth: 1,
		borderColor: COLORS.danger,
		backgroundColor: COLORS.dangerSoft,
	},
	dangerText: { color: COLORS.danger, fontWeight: "900" },
	errorCard: {
		padding: SPACE.md,
		borderRadius: RADIUS.sm,
		borderWidth: 1,
		borderColor: COLORS.danger,
		backgroundColor: COLORS.dangerSoft,
	},
	errorText: { color: COLORS.danger, lineHeight: 19 },
	spacer: { flex: 1 },
	build: { color: COLORS.faint, fontSize: 11, fontWeight: "800" },
	note: { color: COLORS.faint, fontSize: 12, lineHeight: 18 },
});
