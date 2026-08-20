import type { InstanceSummary } from "@pi-anywhere/protocol";
import * as Notifications from "expo-notifications";
import {
	createContext,
	type PropsWithChildren,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import {
	AnywhereApi,
	ApiError,
	type PairResult,
	pairFromUri,
} from "../api/client";
import {
	clearCredentials,
	loadCredentials,
	type StoredCredentials,
} from "../auth/credential-store";
import { registerDevicePushToken } from "../notifications/register";
import { revokeAndClearDevice } from "./disconnect-device";
import { clearTranscriptCache } from "./transcript-cache";

interface ConnectionValue {
	api: AnywhereApi | null;
	credentials: StoredCredentials | null;
	instances: InstanceSummary[];
	loading: boolean;
	error: string | null;
	selectedInstanceId: string | null;
	selectInstance: (instanceId: string) => void;
	refreshInstances: () => Promise<void>;
	pair: (uri: string) => Promise<PairResult>;
	disconnect: () => Promise<void>;
}

const ConnectionContext = createContext<ConnectionValue | undefined>(undefined);

export function ConnectionProvider({ children }: PropsWithChildren) {
	const [credentials, setCredentials] = useState<StoredCredentials | null>(
		null,
	);
	const [api, setApi] = useState<AnywhereApi | null>(null);
	const [instances, setInstances] = useState<InstanceSummary[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(
		null,
	);

	useEffect(() => {
		let active = true;
		void loadCredentials()
			.then((stored) => {
				if (!active) return;
				setCredentials(stored);
				setApi(stored ? new AnywhereApi(stored) : null);
				setLoading(false);
			})
			.catch((cause) => {
				if (!active) return;
				setError(
					cause instanceof Error
						? cause.message
						: "Secure storage is unavailable on this device.",
				);
				setLoading(false);
			});
		return () => {
			active = false;
		};
	}, []);

	const refreshInstances = useCallback(async () => {
		if (!api) {
			setInstances([]);
			return;
		}
		try {
			setError(null);
			setInstances(await api.instances());
		} catch (cause) {
			if (cause instanceof ApiError && cause.status === 401) {
				await clearCredentials();
				clearTranscriptCache();
				setCredentials(null);
				setApi(null);
				setInstances([]);
				setSelectedInstanceId(null);
			} else {
				setError(cause instanceof Error ? cause.message : String(cause));
			}
		}
	}, [api]);

	useEffect(() => {
		void refreshInstances();
		const timer = api
			? setInterval(() => void refreshInstances(), 5_000)
			: undefined;
		let subscription: Notifications.EventSubscription | undefined;
		try {
			subscription = Notifications.addNotificationResponseReceivedListener(
				() => {
					void refreshInstances();
				},
			);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Notifications are unavailable on this build.",
			);
		}
		return () => {
			if (timer) clearInterval(timer);
			subscription?.remove();
		};
	}, [api, refreshInstances]);

	const pair = useCallback(async (uri: string) => {
		const result = await pairFromUri(uri, "Pi Anywhere mobile");
		clearTranscriptCache();
		setCredentials(result.credentials);
		setApi(new AnywhereApi(result.credentials));
		setSelectedInstanceId(null);
		setError(null);
		try {
			await registerDevicePushToken(new AnywhereApi(result.credentials));
		} catch {
			// Push is best effort; foreground polling remains the source of truth.
		}
		return result;
	}, []);

	const disconnect = useCallback(async () => {
		try {
			await revokeAndClearDevice(api, clearCredentials);
		} catch (cause) {
			const message =
				cause instanceof Error
					? cause.message
					: "Could not disconnect this phone safely.";
			setError(message);
			throw cause;
		}
		clearTranscriptCache();
		setCredentials(null);
		setApi(null);
		setInstances([]);
		setSelectedInstanceId(null);
		setError(null);
	}, [api]);

	const selectInstance = useCallback((instanceId: string) => {
		setSelectedInstanceId(instanceId);
	}, []);

	const value = useMemo(
		() => ({
			api,
			credentials,
			instances,
			loading,
			error,
			selectedInstanceId,
			selectInstance,
			refreshInstances,
			pair,
			disconnect,
		}),
		[
			api,
			credentials,
			instances,
			loading,
			error,
			selectedInstanceId,
			selectInstance,
			refreshInstances,
			pair,
			disconnect,
		],
	);

	return (
		<ConnectionContext.Provider value={value}>
			{children}
		</ConnectionContext.Provider>
	);
}

export function useConnection(): ConnectionValue {
	const value = useContext(ConnectionContext);
	if (!value)
		throw new Error("useConnection must be used inside ConnectionProvider");
	return value;
}
