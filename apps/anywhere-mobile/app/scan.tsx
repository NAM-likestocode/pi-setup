import {
	type BarcodeScanningResult,
	CameraView,
	useCameraPermissions,
} from "expo-camera";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { PimoBackground } from "../src/components/PimoBackground";
import { useConnection } from "../src/state/connection";
import { COLORS, RADIUS, SPACE } from "../src/theme";

export default function Scan() {
	const router = useRouter();
	const { pair } = useConnection();
	const [permission, requestPermission] = useCameraPermissions();
	const [scanned, setScanned] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function scan(result: BarcodeScanningResult) {
		if (scanned) return;
		setScanned(true);
		try {
			await pair(result.data);
			router.replace("/");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setScanned(false);
		}
	}

	if (!permission)
		return (
			<PimoBackground>
				<View style={styles.center}>
					<Text style={styles.text}>Checking camera permission…</Text>
				</View>
			</PimoBackground>
		);
	if (!permission.granted)
		return (
			<PimoBackground>
				<View style={styles.center}>
					<Text style={styles.kicker}>PAIR YOUR PHONE</Text>
					<Text style={styles.title}>
						Camera access is needed to scan the pairing QR.
					</Text>
					<Pressable
						style={styles.primary}
						onPress={() => void requestPermission()}
					>
						<Text style={styles.primaryText}>Allow camera</Text>
					</Pressable>
				</View>
			</PimoBackground>
		);

	return (
		<View style={styles.container}>
			<CameraView
				style={styles.camera}
				facing="back"
				onBarcodeScanned={scanned ? undefined : scan}
				barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
			/>
			<View style={styles.frame} />
			<View style={styles.overlay}>
				<Text style={styles.kicker}>ONE-TIME HANDSHAKE</Text>
				<Text style={styles.title}>Scan the pairing code</Text>
				<Text style={styles.help}>
					Use the QR shown by Pimo Companion. It stays inside your private
					Tailscale network.
				</Text>
				{error && <Text style={styles.error}>{error}</Text>}
				<Pressable
					style={styles.secondary}
					onPress={() => (scanned ? setScanned(false) : router.back())}
				>
					<Text style={styles.secondaryText}>
						{scanned ? "Scan again" : "Cancel"}
					</Text>
				</Pressable>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1, backgroundColor: COLORS.background },
	camera: { flex: 1 },
	frame: {
		position: "absolute",
		top: "28%",
		left: "14%",
		right: "14%",
		height: "36%",
		borderWidth: 2,
		borderColor: COLORS.orange,
		borderRadius: RADIUS.lg,
	},
	overlay: {
		position: "absolute",
		left: SPACE.lg,
		right: SPACE.lg,
		bottom: SPACE.lg,
		padding: SPACE.lg,
		borderRadius: RADIUS.lg,
		backgroundColor: "#171411ee",
		gap: 8,
	},
	kicker: {
		color: COLORS.amber,
		fontSize: 10,
		fontWeight: "900",
		letterSpacing: 1.7,
	},
	title: { color: COLORS.ink, fontSize: 19, lineHeight: 24, fontWeight: "900" },
	help: { color: COLORS.muted, lineHeight: 19 },
	error: { color: COLORS.danger, lineHeight: 19 },
	secondary: { alignSelf: "flex-end", padding: 10 },
	secondaryText: { color: COLORS.orange, fontWeight: "900" },
	center: {
		flex: 1,
		alignItems: "center",
		justifyContent: "center",
		padding: SPACE.xl,
		gap: SPACE.md,
		backgroundColor: "transparent",
	},
	text: { color: COLORS.ink, textAlign: "center" },
	primary: {
		paddingVertical: 12,
		paddingHorizontal: 16,
		borderRadius: RADIUS.sm,
		backgroundColor: COLORS.orange,
	},
	primaryText: { color: COLORS.inkDark, fontWeight: "900" },
});
