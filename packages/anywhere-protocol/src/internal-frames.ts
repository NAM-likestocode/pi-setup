import type { PendingPrompt, PromptAnswer } from "./prompt.ts";
import type {
	ANYWHERE_PROTOCOL_VERSION,
	HistoryPage,
	InstanceState,
	InstanceSummary,
	SanitizedActivity,
} from "./public-api.ts";

export type InternalFrame =
	| RegisterInstanceFrame
	| HeartbeatFrame
	| InstanceEventFrame
	| InstanceStateFrame
	| PromptAnswerFrame
	| PromptAnswerAckFrame
	| MessageFrame
	| MessageAckFrame
	| CommandFrame
	| CommandResultFrame
	| UnregisterInstanceFrame;

export interface InternalAuthFrame {
	type: "auth";
	version: typeof ANYWHERE_PROTOCOL_VERSION;
	registrationToken: string;
	instanceId: string;
}

export interface RegisterInstanceFrame {
	type: "register";
	version: typeof ANYWHERE_PROTOCOL_VERSION;
	instance: InstanceSummary;
	state: InstanceState;
}

export interface HeartbeatFrame {
	type: "heartbeat";
	version: typeof ANYWHERE_PROTOCOL_VERSION;
	instance: InstanceSummary;
	state: Pick<
		InstanceState,
		"epoch" | "cursor" | "oldestCursor" | "resetRequired" | "agent" | "question"
	>;
}

export interface InstanceEventFrame {
	type: "event";
	version: typeof ANYWHERE_PROTOCOL_VERSION;
	instanceId: string;
	event: {
		cursor: number;
		kind: "message" | "message_delta" | "status" | "activity" | "prompt";
		timestamp?: number;
		id?: string;
		role?: "user" | "assistant";
		text?: string;
		level?: "ok" | "warn" | "error";
		activity?: SanitizedActivity;
		prompt?: PendingPrompt;
		promptId?: string;
	};
}

export interface InstanceStateFrame {
	type: "state";
	version: typeof ANYWHERE_PROTOCOL_VERSION;
	instanceId: string;
	state: InstanceState;
}

export interface PromptAnswerFrame {
	type: "prompt_answer";
	version: typeof ANYWHERE_PROTOCOL_VERSION;
	instanceId: string;
	promptId: string;
	answer: PromptAnswer | null;
	requestId?: string;
}

export interface PromptAnswerAckFrame {
	type: "prompt_answer_ack";
	version: typeof ANYWHERE_PROTOCOL_VERSION;
	promptId: string;
	requestId?: string;
	accepted: boolean;
	errorCode?: "already_settled" | "invalid_answer" | "instance_unavailable";
}

export interface MessageFrame {
	type: "message";
	version: typeof ANYWHERE_PROTOCOL_VERSION;
	instanceId: string;
	requestId: string;
	text: string;
	delivery: "steer" | "followUp";
}

export interface MessageAckFrame {
	type: "message_ack";
	version: typeof ANYWHERE_PROTOCOL_VERSION;
	requestId: string;
	accepted: boolean;
	errorCode?: "instance_unavailable" | "conflict";
}

export type CompanionCommandName =
	| "status"
	| "pair"
	| "off"
	| "show_pairing"
	| "set_enabled"
	| "history"
	| "detach";

export interface CommandFrame {
	type: "command";
	version: typeof ANYWHERE_PROTOCOL_VERSION;
	requestId: string;
	instanceId: string;
	command: CompanionCommandName;
	enabled?: boolean | null;
	cursor?: string | null;
	limit?: number | null;
}

export interface CommandResultFrame {
	type: "command_result";
	version: typeof ANYWHERE_PROTOCOL_VERSION;
	requestId: string;
	ok: boolean;
	message: string;
	pairingUri?: string | null;
	instances?: InstanceSummary[] | null;
	history?: HistoryPage | null;
	state?: InstanceState | null;
}

export interface UnregisterInstanceFrame {
	type: "unregister";
	version: typeof ANYWHERE_PROTOCOL_VERSION;
	instanceId: string;
	epoch: string;
}
