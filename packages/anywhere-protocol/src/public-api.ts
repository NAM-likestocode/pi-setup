import type { PendingPrompt, PromptAnswer } from "./prompt.ts";

export const ANYWHERE_PROTOCOL_VERSION = 2 as const;
export const ANYWHERE_SCHEME = "pi-anywhere" as const;
export const ANYWHERE_PAIR_PATH = "/api/v2/pair" as const;
export const ANYWHERE_MAX_BODY_BYTES = 16 * 1024;
export const ANYWHERE_MAX_MESSAGE_CHARS = 12_000;
export const ANYWHERE_MAX_COMMENT_CHARS = 12_000;
export const ANYWHERE_MAX_HISTORY_PAGE_SIZE = 100;
export const ANYWHERE_DEFAULT_HISTORY_PAGE_SIZE = 50;
export const ANYWHERE_MAX_HISTORY_ITEM_CHARS = 20_000;
export const ANYWHERE_MAX_LIVE_EVENTS = 500;
export const ANYWHERE_PAIR_TOKEN_TTL_MS = 10 * 60 * 1_000;
export const ANYWHERE_HEARTBEAT_INTERVAL_MS = 10 * 1_000;
export const ANYWHERE_INSTANCE_TIMEOUT_MS = 30 * 1_000;

export const ANYWHERE_PROMPT_OPEN_CHANNEL = "anywhere:prompt:v2:open" as const;
export const ANYWHERE_PROMPT_CLOSE_CHANNEL =
	"anywhere:prompt:v2:close" as const;
export const ANYWHERE_PROMPT_PROBE_CHANNEL =
	"anywhere:prompt:v2:probe" as const;

export type ProtocolErrorCode =
	| "invalid_request"
	| "invalid_version"
	| "unauthorized"
	| "forbidden"
	| "not_found"
	| "already_paired"
	| "pairing_expired"
	| "already_settled"
	| "instance_unavailable"
	| "conflict"
	| "rate_limited"
	| "payload_too_large"
	| "companion_unavailable";

export interface ProtocolError {
	code: ProtocolErrorCode;
	message: string;
	requestId?: string;
}

export interface PairingQrPayload {
	version: typeof ANYWHERE_PROTOCOL_VERSION;
	hostId: string;
	baseUrl: string;
	machineName?: string;
	token: string;
}

export interface PairRequest {
	version: typeof ANYWHERE_PROTOCOL_VERSION;
	token: string;
	deviceName?: string;
}

export interface PairResponse {
	version: typeof ANYWHERE_PROTOCOL_VERSION;
	hostId: string;
	baseUrl: string;
	deviceToken: string;
	pairedAt: number;
}

export interface HostBootstrap {
	version: typeof ANYWHERE_PROTOCOL_VERSION;
	hostId: string;
	baseUrl: string;
	machineName?: string;
	paired: boolean;
	companionEnabled: boolean;
	instanceCount: number;
}

export type InstanceActivityState =
	| "idle"
	| "working"
	| "waiting"
	| "disconnected";

export interface InstanceSummary {
	id: string;
	epoch: string;
	sessionId: string;
	sessionName?: string;
	projectName: string;
	cwd: string;
	model?: string;
	thinkingLevel?: string;
	state: InstanceActivityState;
	pendingPromptCount: number;
	lastActivityAt: number;
	connectedAt: number;
}

export interface HistoryItem {
	id: string;
	parentId?: string;
	timestamp: number;
	role: "user" | "assistant";
	text: string;
}

export interface HistoryPage {
	version: typeof ANYWHERE_PROTOCOL_VERSION;
	instanceId: string;
	epoch: string;
	entries: HistoryItem[];
	nextCursor?: string;
	resetRequired: boolean;
}

export type LiveEventKind =
	| "message"
	| "message_delta"
	| "status"
	| "activity"
	| "prompt";

export interface LiveEvent {
	cursor: number;
	kind: LiveEventKind;
	timestamp?: number;
	id?: string;
	role?: "user" | "assistant";
	text?: string;
	level?: "ok" | "warn" | "error";
	activity?: SanitizedActivity;
	prompt?: PendingPrompt;
	promptId?: string;
}

export interface SanitizedActivity {
	version: 1;
	id: string;
	phase: "start" | "update" | "end";
	source: "main" | "subagent";
	category: "command" | "edit" | "tool" | "subagent";
	label: string;
	timestamp: number;
	agent?: string;
	runId?: string;
	path?: string;
	command?: string;
	detail?: string;
	diff?: string;
	isError?: boolean;
}

export interface InstanceState {
	version: typeof ANYWHERE_PROTOCOL_VERSION;
	instanceId: string;
	epoch: string;
	cursor: number;
	oldestCursor: number;
	resetRequired: boolean;
	events: LiveEvent[];
	question?: PendingPrompt;
	agent: boolean;
}

export interface SendMessageRequest {
	version: typeof ANYWHERE_PROTOCOL_VERSION;
	idempotencyKey: string;
	text: string;
	delivery: "steer" | "followUp";
}

export interface SendMessageResult {
	version: typeof ANYWHERE_PROTOCOL_VERSION;
	accepted: true;
	queued: boolean;
	idempotencyKey: string;
}

export interface PromptAnswerRequest {
	version: typeof ANYWHERE_PROTOCOL_VERSION;
	answer: PromptAnswer;
}

export interface PromptAnswerResult {
	version: typeof ANYWHERE_PROTOCOL_VERSION;
	accepted: true;
	promptId: string;
}

export interface PushTokenRequest {
	version: typeof ANYWHERE_PROTOCOL_VERSION;
	token: string;
	platform: "android" | "ios";
}

export interface ApiEnvelope<T> {
	version: typeof ANYWHERE_PROTOCOL_VERSION;
	data: T;
}

export interface InstanceListResponse {
	version: typeof ANYWHERE_PROTOCOL_VERSION;
	instances: InstanceSummary[];
}

export interface StateResponse {
	version: typeof ANYWHERE_PROTOCOL_VERSION;
	state: InstanceState;
}

export interface PairingUriOptions {
	hostId: string;
	baseUrl: string;
	token: string;
	machineName?: string;
}

export function createPairingUri(options: PairingUriOptions): string {
	const url = new URL("pi-anywhere://pair");
	url.searchParams.set("v", String(ANYWHERE_PROTOCOL_VERSION));
	url.searchParams.set("host", options.hostId);
	url.searchParams.set("base", options.baseUrl);
	if (options.machineName) url.searchParams.set("name", options.machineName);
	url.hash = options.token;
	return url.toString();
}

function decodePairingPart(value: string): string | undefined {
	try {
		return decodeURIComponent(value.replace(/\+/g, " "));
	} catch {
		return undefined;
	}
}

function pairingPayload(
	versionValue: string | null | undefined,
	hostValue: string | null | undefined,
	baseValue: string | null | undefined,
	machineValue: string | null | undefined,
	tokenValue: string | undefined,
): PairingQrPayload | undefined {
	const version = Number(versionValue);
	const hostId = hostValue ?? "";
	const baseUrl = baseValue ?? "";
	const token = tokenValue ?? "";
	if (version !== ANYWHERE_PROTOCOL_VERSION || !hostId || !baseUrl || !token)
		return undefined;
	return {
		version: ANYWHERE_PROTOCOL_VERSION,
		hostId,
		baseUrl,
		machineName: machineValue || undefined,
		token,
	};
}

export function parsePairingUri(value: string): PairingQrPayload | undefined {
	const candidate = value.trim().replace(/^URL:\s*/i, "");
	try {
		const url = new URL(candidate);
		if (url.protocol === `${ANYWHERE_SCHEME}:` && url.hostname === "pair") {
			const parsed = pairingPayload(
				url.searchParams.get("v"),
				url.searchParams.get("host"),
				url.searchParams.get("base"),
				url.searchParams.get("name"),
				url.hash.slice(1),
			);
			if (parsed) return parsed;
		}
	} catch {
		// Some Android URL implementations do not understand private URI schemes.
	}

	const prefix = `${ANYWHERE_SCHEME}://pair?`;
	if (!candidate.toLowerCase().startsWith(prefix)) return undefined;
	const body = candidate.slice(prefix.length);
	const hashIndex = body.indexOf("#");
	const query = hashIndex < 0 ? body : body.slice(0, hashIndex);
	const token =
		hashIndex < 0 ? "" : decodePairingPart(body.slice(hashIndex + 1));
	const values = new Map<string, string>();
	for (const part of query.split("&")) {
		if (!part) continue;
		const separator = part.indexOf("=");
		const key = decodePairingPart(
			separator < 0 ? part : part.slice(0, separator),
		);
		const parsedValue = decodePairingPart(
			separator < 0 ? "" : part.slice(separator + 1),
		);
		if (key && parsedValue !== undefined) values.set(key, parsedValue);
	}
	return pairingPayload(
		values.get("v"),
		values.get("host"),
		values.get("base"),
		values.get("name"),
		token,
	);
}
