import WebSocket from "ws";
import {
	ANYWHERE_HEARTBEAT_INTERVAL_MS,
	type InstanceState,
	type InstanceSummary,
	type InternalAuthFrame,
	type InternalFrame,
	isInternalFrame,
	type RegisterInstanceFrame,
} from "../../packages/anywhere-protocol/src/index.ts";
import { readRendezvous } from "./config.ts";

export interface CompanionClientCallbacks {
	onFrame: (frame: InternalFrame) => void;
	onStatus?: (status: "connecting" | "connected" | "disconnected") => void;
}

export class CompanionClient {
	private socket: WebSocket | undefined;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	private stopped = true;
	private reconnectDelay = 1_000;
	private connecting = false;
	private readonly connectionWaiters = new Set<(connected: boolean) => void>();
	private latestInstance?: InstanceSummary;
	private latestState?: InstanceState;

	get isConnected(): boolean {
		return this.socket?.readyState === WebSocket.OPEN;
	}

	async waitUntilConnected(timeoutMs = 5_000): Promise<boolean> {
		if (this.isConnected) return true;
		if (this.stopped) return false;
		void this.connect();
		return new Promise((resolve) => {
			let settled = false;
			const finish = (connected: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.connectionWaiters.delete(finish);
				resolve(connected);
			};
			const timer = setTimeout(() => finish(false), timeoutMs);
			this.connectionWaiters.add(finish);
		});
	}

	constructor(
		private readonly instanceId: string,
		private readonly callbacks: CompanionClientCallbacks,
	) {}

	async start(instance: InstanceSummary, state: InstanceState): Promise<void> {
		this.latestInstance = instance;
		this.latestState = state;
		this.stopped = false;
		this.callbacks.onStatus?.("connecting");
		await this.connect();
		this.heartbeatTimer = setInterval(
			() => this.sendHeartbeat(),
			ANYWHERE_HEARTBEAT_INTERVAL_MS,
		);
	}

	stop(): void {
		this.stopped = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.reconnectTimer = undefined;
		this.heartbeatTimer = undefined;
		const socket = this.socket;
		this.socket = undefined;
		if (
			socket &&
			(socket.readyState === WebSocket.OPEN ||
				socket.readyState === WebSocket.CONNECTING)
		) {
			socket.close(1000, "Pi session stopped");
		}
		this.resolveConnectionWaiters(false);
		this.callbacks.onStatus?.("disconnected");
	}

	update(instance: InstanceSummary, state: InstanceState): void {
		this.latestInstance = instance;
		this.latestState = state;
		this.sendHeartbeat();
	}

	send(frame: InternalFrame): boolean {
		const socket = this.socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) return false;
		socket.send(JSON.stringify(frame));
		return true;
	}

	private async connect(): Promise<void> {
		if (
			this.stopped ||
			this.connecting ||
			(this.socket &&
				(this.socket.readyState === WebSocket.OPEN ||
					this.socket.readyState === WebSocket.CONNECTING))
		)
			return;
		this.connecting = true;
		try {
			const rendezvous = await readRendezvous();
			if (!rendezvous) {
				this.callbacks.onStatus?.("disconnected");
				this.scheduleReconnect();
				return;
			}
			const socket = new WebSocket(
				`ws://127.0.0.1:${rendezvous.internal_port}/internal`,
			);
			this.socket = socket;
			socket.on("open", () => {
				if (this.stopped || this.socket !== socket) return;
				this.reconnectDelay = 1_000;
				const auth: InternalAuthFrame = {
					type: "auth",
					version: 2,
					registrationToken: rendezvous.registration_token,
					instanceId: this.instanceId,
				};
				socket.send(JSON.stringify(auth));
				if (this.latestInstance && this.latestState) {
					const registration: RegisterInstanceFrame = {
						type: "register",
						version: 2,
						instance: this.latestInstance,
						state: this.latestState,
					};
					socket.send(JSON.stringify(registration));
				}
				// The companion requires auth to be the first frame. Status callbacks may
				// publish events immediately, so expose the connection only after auth and
				// registration have been queued on the ordered WebSocket stream.
				this.resolveConnectionWaiters(true);
				this.callbacks.onStatus?.("connected");
			});
			socket.on("message", (data) => {
				let value: unknown;
				try {
					value = JSON.parse(data.toString());
				} catch {
					return;
				}
				if (isInternalFrame(value)) this.callbacks.onFrame(value);
			});
			socket.on("close", () => {
				if (this.socket !== socket) return;
				this.socket = undefined;
				this.resolveConnectionWaiters(false);
				this.callbacks.onStatus?.("disconnected");
				this.scheduleReconnect();
			});
			socket.on("error", () => {
				if (this.socket !== socket) return;
				this.callbacks.onStatus?.("disconnected");
			});
		} finally {
			this.connecting = false;
		}
	}

	private sendHeartbeat(): void {
		if (!this.latestInstance || !this.latestState) return;
		this.send({
			type: "heartbeat",
			version: 2,
			instance: this.latestInstance,
			state: {
				epoch: this.latestState.epoch,
				cursor: this.latestState.cursor,
				oldestCursor: this.latestState.oldestCursor,
				resetRequired: this.latestState.resetRequired,
				agent: this.latestState.agent,
				question: this.latestState.question,
			},
		});
	}

	private resolveConnectionWaiters(connected: boolean): void {
		for (const waiter of [...this.connectionWaiters]) waiter(connected);
	}

	private scheduleReconnect(): void {
		if (this.stopped || this.reconnectTimer) return;
		const delay = this.reconnectDelay;
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.connect();
		}, delay);
		this.reconnectTimer.unref?.();
	}
}
