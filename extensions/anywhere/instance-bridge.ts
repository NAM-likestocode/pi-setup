import { basename } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	ANYWHERE_MAX_LIVE_EVENTS,
	type CommandResultFrame,
	type CompanionCommandName,
	type InstanceEventFrame,
	type InstanceState,
	type InstanceSummary,
	type LiveEvent,
	type MessageAckFrame,
	type MessageFrame,
} from "../../packages/anywhere-protocol/src/index.ts";
import {
	dashboardActivityForTool,
	isDashboardActivity,
	sanitizeDashboardActivity,
} from "../_shared/dashboard-activity.ts";
import { CompanionClient } from "./companion-client.ts";
import { ANYWHERE_STATUS_ID, instanceEpoch, instanceId } from "./config.ts";
import { getHistoryPage, messageText } from "./history.ts";
import { PromptTransport } from "./prompt-transport.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function modelName(ctx: ExtensionContext): string | undefined {
	const model = asRecord(ctx.model);
	const provider = typeof model?.provider === "string" ? model.provider : "";
	const id = typeof model?.id === "string" ? model.id : "";
	return provider && id ? `${provider}/${id}` : id || undefined;
}

export class InstanceBridge {
	private ctx?: ExtensionContext;
	private client?: CompanionClient;
	private prompts?: PromptTransport;
	private active = false;
	private readonly id = instanceId();
	private readonly epoch = instanceEpoch();
	private events: LiveEvent[] = [];
	private nextCursor = 1;
	private assistantStreamId?: string;
	private readonly seenMessages = new Set<string>();
	private readonly toolArgs = new Map<string, unknown>();
	private historyResetRequired = false;
	private readonly pendingCommands = new Map<
		string,
		{
			resolve: (result: CommandResultFrame) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();

	constructor(private readonly pi: ExtensionAPI) {}

	get instanceId(): string {
		return this.id;
	}

	get instanceEpoch(): string {
		return this.epoch;
	}

	get isActive(): boolean {
		return this.active;
	}

	get pendingPromptCount(): number {
		return this.prompts?.size ?? 0;
	}

	setContext(ctx: ExtensionContext): void {
		this.ctx = ctx;
	}

	async start(ctx: ExtensionContext, force = false): Promise<void> {
		if (this.active || (!force && process.env.PI_PROJECT_SUBAGENT === "1"))
			return;
		this.ctx = ctx;
		this.active = true;
		this.client = new CompanionClient(this.id, {
			onFrame: (frame) => this.handleFrame(frame),
			onStatus: (status) => {
				if (status === "connected")
					this.publishStatus("Connected to Pimo Companion.", "ok");
				if (status === "connecting")
					this.publishStatus("Connecting to Pimo Companion…", "warn");
				if (status === "disconnected")
					this.publishStatus(
						"Pimo Companion is unavailable; retrying…",
						"warn",
					);
			},
		});
		this.prompts = new PromptTransport(
			this.pi,
			this.client,
			this.id,
			(event) => this.publishPromptEvent(event),
			() => this.refreshRegistration(),
		);
		await this.client.start(this.buildSummary(), this.buildState());
	}

	stop(): void {
		if (!this.active) return;
		this.client?.send({
			type: "unregister",
			version: 2,
			instanceId: this.id,
			epoch: this.epoch,
		});
		for (const pending of this.pendingCommands.values()) {
			clearTimeout(pending.timer);
			pending.reject(
				new Error("Pi session stopped before the companion replied."),
			);
		}
		this.pendingCommands.clear();
		this.prompts?.dispose();
		this.client?.stop();
		this.prompts = undefined;
		this.client = undefined;
		this.active = false;
	}

	recordMessage(message: unknown): void {
		if (!this.active) return;
		const record = asRecord(message);
		const role = record?.role;
		if (role !== "user" && role !== "assistant") return;
		const text = messageText(message);
		if (!text) return;
		const id =
			role === "assistant" && this.assistantStreamId
				? this.assistantStreamId
				: typeof record?.id === "string" && record.id
					? record.id
					: `${role}-${Date.now()}-${this.nextCursor}`;
		if (role === "assistant") this.assistantStreamId = undefined;
		if (this.seenMessages.has(id)) return;
		this.seenMessages.add(id);
		this.publish({
			kind: "message",
			id,
			role,
			text: this.truncateLiveText(text),
		});
	}

	recordAssistantDelta(message: unknown, delta: string): void {
		if (!this.active || !delta) return;
		const suppliedId = asRecord(message)?.id;
		const id =
			this.assistantStreamId ??
			(typeof suppliedId === "string" && suppliedId
				? suppliedId
				: `assistant-stream-${this.nextCursor}`);
		this.assistantStreamId = id;
		this.publish({
			kind: "message_delta",
			id,
			role: "assistant",
			text: this.truncateLiveText(delta, 4_000),
		});
	}

	recordToolStart(toolCallId: string, toolName: string, args: unknown): void {
		if (!this.active || toolName === "subagent") return;
		this.toolArgs.set(toolCallId, args);
		this.receiveActivity(
			dashboardActivityForTool({
				id: `main:${toolCallId}`,
				phase: "start",
				source: "main",
				toolName,
				args,
			}),
		);
	}

	recordToolEnd(
		toolCallId: string,
		toolName: string,
		result: unknown,
		isError: boolean,
	): void {
		if (!this.active || toolName === "subagent") return;
		this.receiveActivity(
			dashboardActivityForTool({
				id: `main:${toolCallId}`,
				phase: "end",
				source: "main",
				toolName,
				args: this.toolArgs.get(toolCallId),
				result,
				isError,
			}),
		);
		this.toolArgs.delete(toolCallId);
	}

	receiveActivity(value: unknown): void {
		if (!this.active || !isDashboardActivity(value)) return;
		const { task: _task, ...sanitized } = sanitizeDashboardActivity(value);
		this.publish({ kind: "activity", id: value.id, activity: sanitized });
	}

	getHistoryPage(cursor?: string, limit?: number) {
		if (!this.ctx) throw new Error("Pi session context is not available.");
		const page = getHistoryPage(this.ctx, this.id, this.epoch, cursor, limit);
		this.historyResetRequired = false;
		this.refreshRegistration();
		return page;
	}

	getState(): InstanceState {
		return this.buildState();
	}

	markHistoryReset(): void {
		if (!this.active) return;
		this.historyResetRequired = true;
		this.publishStatus(
			"The active Pi branch changed; refresh history.",
			"warn",
		);
		this.refreshRegistration();
	}

	async command(command: CompanionCommandName): Promise<CommandResultFrame> {
		if (!this.client || !this.active)
			throw new Error("Pimo Companion is not connected.");
		if (!(await this.client.waitUntilConnected()))
			throw new Error(
				"Pimo Companion is not connected; still waiting for the desktop companion.",
			);
		const requestId = `${this.id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
		return new Promise<CommandResultFrame>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingCommands.delete(requestId);
				reject(new Error("Pimo Companion did not respond in time."));
			}, 10_000);
			this.pendingCommands.set(requestId, { resolve, reject, timer });
			if (
				!this.client?.send({
					type: "command",
					version: 2,
					requestId,
					instanceId: this.id,
					command,
				})
			) {
				clearTimeout(timer);
				this.pendingCommands.delete(requestId);
				reject(new Error("Pimo Companion is not connected."));
			}
		});
	}

	getSummary(): InstanceSummary {
		return this.buildSummary();
	}

	private handleFrame(
		frame: import("../../packages/anywhere-protocol/src/index.ts").InternalFrame,
	): void {
		if (frame.type === "prompt_answer") {
			this.prompts?.handleFrame(frame);
			return;
		}
		if (frame.type === "message") {
			this.handleMessage(frame);
			return;
		}
		if (frame.type === "command_result") {
			const pending = this.pendingCommands.get(frame.requestId);
			if (pending) {
				clearTimeout(pending.timer);
				this.pendingCommands.delete(frame.requestId);
				pending.resolve(frame);
			}
			return;
		}
		if (frame.type === "command" && frame.instanceId === this.id) {
			this.handleCommand(
				frame.requestId,
				frame.command,
				frame.cursor ?? undefined,
				frame.limit ?? undefined,
			);
		}
	}

	private handleMessage(frame: MessageFrame): void {
		const ack: MessageAckFrame = {
			type: "message_ack",
			version: 2,
			requestId: frame.requestId,
			accepted: false,
		};
		if (!this.ctx || frame.instanceId !== this.id) {
			ack.errorCode = "instance_unavailable";
			this.client?.send(ack);
			return;
		}
		if (this.prompts?.size && frame.delivery === "steer") {
			ack.errorCode = "conflict";
			this.client?.send(ack);
			return;
		}
		const busy = !this.ctx.isIdle();
		if (busy)
			this.pi.sendUserMessage(frame.text, { deliverAs: frame.delivery });
		else this.pi.sendUserMessage(frame.text);
		ack.accepted = true;
		this.client?.send(ack);
	}

	private handleCommand(
		requestId: string,
		command: string,
		cursor?: string,
		limit?: number,
	): void {
		if (command === "detach") {
			const acknowledged = this.client?.send({
				type: "command_result",
				version: 2,
				requestId,
				ok: true,
				message: "Session disconnected from Pimo. Pi is still running.",
			});
			if (acknowledged) {
				const timer = setTimeout(() => {
					this.ctx?.ui.setStatus(ANYWHERE_STATUS_ID, undefined);
					this.ctx?.ui.notify(
						"Disconnected from Pimo by the desktop Companion. Run /Pimo start to reconnect.",
						"info",
					);
					this.stop();
				}, 50);
				timer.unref?.();
			}
			return;
		}
		if (command === "history") {
			try {
				this.client?.send({
					type: "command_result",
					version: 2,
					requestId,
					ok: true,
					message: "History loaded.",
					history: this.getHistoryPage(cursor, limit),
				});
			} catch (error) {
				this.client?.send({
					type: "command_result",
					version: 2,
					requestId,
					ok: false,
					message: error instanceof Error ? error.message : String(error),
				});
			}
			return;
		}
		if (command === "status") {
			this.client?.send({
				type: "command_result",
				version: 2,
				requestId,
				ok: true,
				message: "Instance is connected.",
				instances: [this.buildSummary()],
			});
			return;
		}
		this.client?.send({
			type: "command_result",
			version: 2,
			requestId,
			ok: false,
			message: "Command is not available yet.",
		});
	}

	private publishPromptEvent(event: InstanceEventFrame["event"]): void {
		this.publish(event);
	}

	private publish(event: Omit<LiveEvent, "cursor">): void {
		if (!this.active) return;
		const liveEvent: LiveEvent = {
			timestamp: Date.now(),
			...event,
			cursor: this.nextCursor++,
		};
		this.events.push(liveEvent);
		if (this.events.length > ANYWHERE_MAX_LIVE_EVENTS)
			this.events.splice(0, this.events.length - ANYWHERE_MAX_LIVE_EVENTS);
		this.client?.send({
			type: "event",
			version: 2,
			instanceId: this.id,
			event: liveEvent,
		});
		this.refreshRegistration();
	}

	private publishStatus(text: string, level: "ok" | "warn" | "error"): void {
		this.publish({ kind: "status", text, level });
	}

	private refreshRegistration(): void {
		if (!this.client || !this.active) return;
		this.client.update(this.buildSummary(), this.buildState());
	}

	private buildSummary(): InstanceSummary {
		const ctx = this.ctx;
		const cwd = ctx?.cwd ?? process.cwd();
		const idle = ctx?.isIdle() ?? true;
		const waiting = (this.prompts?.size ?? 0) > 0;
		return {
			id: this.id,
			epoch: this.epoch,
			sessionId: ctx?.sessionManager.getSessionId() ?? this.id,
			sessionName: this.pi.getSessionName() ?? undefined,
			projectName: basename(cwd),
			cwd,
			model: ctx ? modelName(ctx) : undefined,
			thinkingLevel: ctx?.thinkingLevel,
			state: waiting ? "waiting" : idle ? "idle" : "working",
			pendingPromptCount: this.prompts?.size ?? 0,
			lastActivityAt: Date.now(),
			connectedAt: Date.now(),
		};
	}

	private buildState(): InstanceState {
		return {
			version: 2,
			instanceId: this.id,
			epoch: this.epoch,
			cursor: this.nextCursor - 1,
			oldestCursor: this.events[0]?.cursor ?? this.nextCursor,
			resetRequired: this.historyResetRequired,
			events: [...this.events],
			question: this.prompts?.firstPrompt,
			agent: this.ctx ? !this.ctx.isIdle() : false,
		};
	}

	private truncateLiveText(text: string, max = 20_000): string {
		return text.length <= max
			? text
			: `${text.slice(0, max)}\n\n[Message truncated for the phone view]`;
	}
}
