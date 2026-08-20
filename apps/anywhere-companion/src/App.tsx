import { useCallback, useEffect, useState } from "react";
import { PairingQr } from "./components/PairingQr";
import { StatusPanel } from "./components/StatusPanel";
import {
	type CompanionStatus,
	disconnectInstance,
	getStatus,
	openDiagnostics,
	renameInstance,
	rePair,
	setEnabled,
	showPairing,
} from "./lib/commands";

function messageFrom(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export default function App() {
	const [status, setStatus] = useState<CompanionStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [showQr, setShowQr] = useState(false);
	const [disconnectingInstanceId, setDisconnectingInstanceId] = useState<
		string | null
	>(null);
	const [renamingInstanceId, setRenamingInstanceId] = useState<string | null>(
		null,
	);

	const refresh = useCallback(async () => {
		try {
			setError(null);
			setStatus(await getStatus());
		} catch (cause) {
			setError(messageFrom(cause));
		}
	}, []);

	useEffect(() => {
		void refresh();
		const timer = window.setInterval(() => void refresh(), 5_000);
		const onVisible = () => {
			if (document.visibilityState === "visible") void refresh();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			window.clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [refresh]);

	async function pair(replace = false) {
		try {
			setError(null);
			const next = replace ? await rePair() : await showPairing();
			setStatus(next);
			setShowQr(true);
		} catch (cause) {
			setError(messageFrom(cause));
		}
	}

	async function toggle() {
		if (!status) return;
		try {
			setError(null);
			setStatus(await setEnabled(!status.enabled));
		} catch (cause) {
			setError(messageFrom(cause));
		}
	}

	async function disconnect(instanceId: string) {
		try {
			setError(null);
			setDisconnectingInstanceId(instanceId);
			await disconnectInstance(instanceId);
			await refresh();
		} catch (cause) {
			setError(messageFrom(cause));
		} finally {
			setDisconnectingInstanceId(null);
		}
	}

	async function rename(instanceId: string, name: string) {
		try {
			setError(null);
			setRenamingInstanceId(instanceId);
			setStatus(await renameInstance(instanceId, name));
		} catch (cause) {
			setError(messageFrom(cause));
			throw cause;
		} finally {
			setRenamingInstanceId(null);
		}
	}

	async function diagnostics() {
		try {
			const text = await openDiagnostics();
			await navigator.clipboard?.writeText(text);
			window.alert(text);
		} catch (cause) {
			setError(messageFrom(cause));
		}
	}

	return (
		<main className="shell">
			<StatusPanel
				status={status}
				error={error}
				onRefresh={() => void refresh()}
				onPair={() => void pair()}
				onRePair={() => void pair(true)}
				onToggle={() => void toggle()}
				onDisconnect={(instanceId) => void disconnect(instanceId)}
				disconnectingInstanceId={disconnectingInstanceId}
				onRename={rename}
				renamingInstanceId={renamingInstanceId}
				onDiagnostics={() => void diagnostics()}
			/>
			{showQr && (
				<PairingQr uri={status?.pairingUri} onClose={() => setShowQr(false)} />
			)}
			<footer className="privacy-note">
				<span className="footer-mark">●</span>
				Private by default. Pi traffic stays on your Tailscale network.
			</footer>
		</main>
	);
}
