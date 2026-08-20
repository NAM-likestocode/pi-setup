import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import type { AnywhereApi } from "../api/client";

Notifications.setNotificationHandler({
	handleNotification: async () => ({
		shouldPlaySound: false,
		shouldSetBadge: false,
		shouldShowBanner: AppState.currentState !== "active",
		shouldShowList: true,
	}),
});

export async function registerDevicePushToken(
	api: AnywhereApi,
): Promise<boolean> {
	if (!Device.isDevice) return false;
	const current = await Notifications.getPermissionsAsync();
	let permission = current.status;
	if (permission !== "granted") {
		permission = (await Notifications.requestPermissionsAsync()).status;
	}
	if (permission !== "granted") return false;
	const projectId = Constants.expoConfig?.extra?.eas?.projectId;
	if (!projectId || projectId === "replace-with-private-eas-project-id")
		return false;
	const token = await Notifications.getExpoPushTokenAsync({ projectId });
	await api.registerPushToken(
		token.data,
		Platform.OS === "ios" ? "ios" : "android",
	);
	return true;
}
