import * as SecureStore from "expo-secure-store";

const STORAGE_KEY = "pi-anywhere-device-v2";

export interface StoredCredentials {
	version: 2;
	hostId: string;
	baseUrl: string;
	deviceToken: string;
}

export async function loadCredentials(): Promise<StoredCredentials | null> {
	const raw = await SecureStore.getItemAsync(STORAGE_KEY, {
		keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
	});
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as Partial<StoredCredentials>;
		if (
			value.version !== 2 ||
			!value.hostId ||
			!value.baseUrl ||
			!value.deviceToken
		)
			return null;
		return value as StoredCredentials;
	} catch {
		return null;
	}
}

export async function saveCredentials(
	credentials: StoredCredentials,
): Promise<void> {
	await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(credentials), {
		keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
	});
}

export async function clearCredentials(): Promise<void> {
	await SecureStore.deleteItemAsync(STORAGE_KEY);
}
