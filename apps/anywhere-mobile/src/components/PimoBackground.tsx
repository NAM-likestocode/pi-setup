import { LinearGradient } from "expo-linear-gradient";
import type { PropsWithChildren } from "react";
import { StyleSheet } from "react-native";

/** Matches the Companion's warm top-left and plum bottom-right backdrop. */
export function PimoBackground({ children }: PropsWithChildren) {
	return (
		<LinearGradient
			colors={["#5a3729", "#2b201a", "#171411", "#32263b"]}
			locations={[0, 0.28, 0.62, 1]}
			start={{ x: 0, y: 0 }}
			end={{ x: 1, y: 1 }}
			style={styles.background}
		>
			{children}
		</LinearGradient>
	);
}

const styles = StyleSheet.create({
	background: { flex: 1 },
});
