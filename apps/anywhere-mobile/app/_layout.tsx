import { type ErrorBoundaryProps, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { PimoBackground } from "../src/components/PimoBackground";
import { ConnectionProvider } from "../src/state/connection";
import { COLORS, RADIUS, SPACE } from "../src/theme";

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
	return (
		<PimoBackground>
			<View style={styles.errorScreen}>
				<Text style={styles.errorKicker}>PIMO NEEDS A RESET</Text>
				<Text style={styles.errorTitle}>The mobile app hit a snag.</Text>
				<Text selectable style={styles.errorMessage}>
					{error.message}
				</Text>
				<Text style={styles.buildLabel}>Version 0.1.7 · Android build 8</Text>
				<Pressable style={styles.errorButton} onPress={() => void retry()}>
					<Text style={styles.errorButtonText}>Try again</Text>
				</Pressable>
			</View>
		</PimoBackground>
	);
}

export default function Layout() {
	return (
		<ConnectionProvider>
			<StatusBar style="light" />
			<Stack
				screenOptions={{
					headerStyle: { backgroundColor: COLORS.surface },
					headerTintColor: COLORS.ink,
					headerTitleStyle: { fontWeight: "800" },
					headerShadowVisible: false,
					contentStyle: { backgroundColor: COLORS.background },
				}}
			>
				<Stack.Screen name="index" options={{ headerShown: false }} />
				<Stack.Screen name="scan" options={{ title: "Pair phone" }} />
				<Stack.Screen name="session" options={{ headerShown: false }} />
				<Stack.Screen
					name="instance/[instanceId]"
					options={{ headerShown: false }}
				/>
				<Stack.Screen name="settings" options={{ title: "Settings" }} />
			</Stack>
		</ConnectionProvider>
	);
}

const styles = StyleSheet.create({
	errorScreen: {
		flex: 1,
		justifyContent: "center",
		padding: SPACE.xl,
		gap: SPACE.md,
		backgroundColor: "transparent",
	},
	errorKicker: {
		color: COLORS.amber,
		fontSize: 11,
		fontWeight: "900",
		letterSpacing: 1.8,
	},
	errorTitle: {
		color: COLORS.ink,
		fontSize: 28,
		lineHeight: 34,
		fontWeight: "900",
	},
	errorMessage: { color: COLORS.muted, lineHeight: 20 },
	buildLabel: { color: COLORS.faint, fontSize: 11 },
	errorButton: {
		alignSelf: "flex-start",
		marginTop: SPACE.sm,
		paddingVertical: 12,
		paddingHorizontal: 18,
		borderRadius: RADIUS.sm,
		backgroundColor: COLORS.orange,
	},
	errorButtonText: { color: COLORS.inkDark, fontWeight: "900" },
});
