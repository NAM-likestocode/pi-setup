import type { InternalAuthFrame, InternalFrame } from "./internal-frames.ts";
import {
	type PendingPrompt,
	type PromptOption,
	validatePromptAnswer,
} from "./prompt.ts";
import {
	ANYWHERE_MAX_BODY_BYTES,
	ANYWHERE_MAX_COMMENT_CHARS,
	ANYWHERE_MAX_HISTORY_PAGE_SIZE,
	ANYWHERE_MAX_MESSAGE_CHARS,
	ANYWHERE_PROTOCOL_VERSION,
	type PairingQrPayload,
	type PairRequest,
	type PromptAnswerRequest,
	type PushTokenRequest,
	type SendMessageRequest,
} from "./public-api.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every((key) => allowed.has(key));
}

export function hasProtocolVersion(value: unknown): value is Record<
	string,
	unknown
> & {
	version: typeof ANYWHERE_PROTOCOL_VERSION;
} {
	return isRecord(value) && value.version === ANYWHERE_PROTOCOL_VERSION;
}

export function isNonEmptyString(
	value: unknown,
	maxLength = 1_000,
): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value.length <= maxLength
	);
}

export function isToken(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9_-]{20,128}$/.test(value);
}

function isPromptOption(value: unknown): value is PromptOption {
	if (!isRecord(value) || !hasOnlyKeys(value, ["title", "description"]))
		return false;
	return (
		isNonEmptyString(value.title, 500) &&
		(value.description === undefined ||
			isNonEmptyString(value.description, 2_000))
	);
}

export function isPendingPrompt(value: unknown): value is PendingPrompt {
	if (!isRecord(value) || !hasProtocolVersion(value)) return false;
	if (
		!hasOnlyKeys(value, [
			"version",
			"id",
			"kind",
			"question",
			"context",
			"options",
			"allowMultiple",
			"allowFreeform",
			"allowComment",
			"timeout",
			"openedAt",
			"instanceId",
			"agent",
		])
	)
		return false;
	return (
		isNonEmptyString(value.id, 300) &&
		(value.kind === "ask_user" || value.kind === "specialist") &&
		isNonEmptyString(value.question, ANYWHERE_MAX_MESSAGE_CHARS) &&
		(value.context === undefined || typeof value.context === "string") &&
		Array.isArray(value.options) &&
		value.options.every((option) => isPromptOption(option)) &&
		typeof value.allowMultiple === "boolean" &&
		typeof value.allowFreeform === "boolean" &&
		typeof value.allowComment === "boolean" &&
		(value.timeout === undefined ||
			(typeof value.timeout === "number" &&
				Number.isFinite(value.timeout) &&
				value.timeout > 0)) &&
		typeof value.openedAt === "number" &&
		(value.instanceId === undefined ||
			isNonEmptyString(value.instanceId, 300)) &&
		(value.agent === undefined || isNonEmptyString(value.agent, 500))
	);
}

export function isPairingQrPayload(value: unknown): value is PairingQrPayload {
	if (!isRecord(value) || !hasProtocolVersion(value)) return false;
	if (
		!hasOnlyKeys(value, [
			"version",
			"hostId",
			"baseUrl",
			"machineName",
			"token",
		])
	)
		return false;
	try {
		const baseUrl = new URL(String(value.baseUrl));
		if (baseUrl.protocol !== "https:") return false;
	} catch {
		return false;
	}
	return (
		isNonEmptyString(value.hostId, 300) &&
		isNonEmptyString(value.baseUrl, 2_000) &&
		(value.machineName === undefined ||
			isNonEmptyString(value.machineName, 500)) &&
		isToken(value.token)
	);
}

export function isPairRequest(value: unknown): value is PairRequest {
	if (!isRecord(value) || !hasProtocolVersion(value)) return false;
	if (!hasOnlyKeys(value, ["version", "token", "deviceName"])) return false;
	return (
		isToken(value.token) &&
		(value.deviceName === undefined || isNonEmptyString(value.deviceName, 500))
	);
}

export function isSendMessageRequest(
	value: unknown,
): value is SendMessageRequest {
	if (!isRecord(value) || !hasProtocolVersion(value)) return false;
	if (!hasOnlyKeys(value, ["version", "idempotencyKey", "text", "delivery"]))
		return false;
	return (
		isNonEmptyString(value.idempotencyKey, 300) &&
		isNonEmptyString(value.text, ANYWHERE_MAX_MESSAGE_CHARS) &&
		(value.delivery === "steer" || value.delivery === "followUp")
	);
}

export function isPromptAnswerRequest(
	value: unknown,
	prompt?: PendingPrompt,
): value is PromptAnswerRequest {
	if (!isRecord(value) || !hasProtocolVersion(value)) return false;
	if (!hasOnlyKeys(value, ["version", "answer"]) || !isRecord(value.answer))
		return false;
	if (!prompt) return true;
	return validatePromptAnswer(prompt, value.answer) !== undefined;
}

export function isPushTokenRequest(value: unknown): value is PushTokenRequest {
	if (!isRecord(value) || !hasProtocolVersion(value)) return false;
	if (!hasOnlyKeys(value, ["version", "token", "platform"])) return false;
	return (
		isNonEmptyString(value.token, 500) &&
		(value.platform === "android" || value.platform === "ios")
	);
}

export function isInternalAuthFrame(
	value: unknown,
): value is InternalAuthFrame {
	if (!isRecord(value) || value.type !== "auth" || !hasProtocolVersion(value))
		return false;
	if (
		!hasOnlyKeys(value, ["type", "version", "registrationToken", "instanceId"])
	)
		return false;
	return (
		isToken(value.registrationToken) && isNonEmptyString(value.instanceId, 300)
	);
}

function isRegisterFrame(value: Record<string, unknown>): boolean {
	return (
		value.type === "register" &&
		hasProtocolVersion(value) &&
		hasOnlyKeys(value, ["type", "version", "instance", "state"]) &&
		isRecord(value.instance) &&
		isRecord(value.state)
	);
}

function isEventFrame(value: Record<string, unknown>): boolean {
	if (value.type !== "event" || !hasProtocolVersion(value)) return false;
	if (!hasOnlyKeys(value, ["type", "version", "instanceId", "event"]))
		return false;
	const event = value.event;
	return (
		isNonEmptyString(value.instanceId, 300) &&
		isRecord(event) &&
		typeof event.cursor === "number" &&
		["message", "message_delta", "status", "activity", "prompt"].includes(
			String(event.kind),
		)
	);
}

export function isInternalFrame(value: unknown): value is InternalFrame {
	if (!isRecord(value) || !hasProtocolVersion(value)) return false;
	if (isRegisterFrame(value) || isEventFrame(value)) return true;
	if (value.type === "heartbeat")
		return (
			hasOnlyKeys(value, ["type", "version", "instance", "state"]) &&
			isRecord(value.instance) &&
			isRecord(value.state)
		);
	if (value.type === "state")
		return (
			hasOnlyKeys(value, ["type", "version", "instanceId", "state"]) &&
			isNonEmptyString(value.instanceId, 300) &&
			isRecord(value.state)
		);
	if (value.type === "prompt_answer")
		return (
			hasOnlyKeys(value, [
				"type",
				"version",
				"instanceId",
				"promptId",
				"answer",
				"requestId",
			]) &&
			isNonEmptyString(value.instanceId, 300) &&
			isNonEmptyString(value.promptId, 300) &&
			(value.answer === null || isRecord(value.answer)) &&
			(value.requestId === undefined || isNonEmptyString(value.requestId, 300))
		);
	if (value.type === "prompt_answer_ack")
		return (
			hasOnlyKeys(value, [
				"type",
				"version",
				"promptId",
				"requestId",
				"accepted",
				"errorCode",
			]) &&
			isNonEmptyString(value.promptId, 300) &&
			(value.requestId === undefined ||
				isNonEmptyString(value.requestId, 300)) &&
			typeof value.accepted === "boolean" &&
			(value.errorCode === undefined ||
				["already_settled", "invalid_answer", "instance_unavailable"].includes(
					String(value.errorCode),
				))
		);
	if (value.type === "message")
		return (
			hasOnlyKeys(value, [
				"type",
				"version",
				"instanceId",
				"requestId",
				"text",
				"delivery",
			]) &&
			isNonEmptyString(value.instanceId, 300) &&
			isNonEmptyString(value.requestId, 300) &&
			isNonEmptyString(value.text, 12_000) &&
			(value.delivery === "steer" || value.delivery === "followUp")
		);
	if (value.type === "message_ack")
		return (
			hasOnlyKeys(value, [
				"type",
				"version",
				"requestId",
				"accepted",
				"errorCode",
			]) &&
			isNonEmptyString(value.requestId, 300) &&
			typeof value.accepted === "boolean" &&
			(value.errorCode === undefined ||
				["instance_unavailable", "conflict"].includes(String(value.errorCode)))
		);
	if (value.type === "command")
		return (
			hasOnlyKeys(value, [
				"type",
				"version",
				"requestId",
				"instanceId",
				"command",
				"enabled",
				"cursor",
				"limit",
			]) &&
			isNonEmptyString(value.requestId, 300) &&
			isNonEmptyString(value.instanceId, 300) &&
			[
				"status",
				"pair",
				"off",
				"show_pairing",
				"set_enabled",
				"history",
				"detach",
			].includes(String(value.command)) &&
			(value.enabled == null || typeof value.enabled === "boolean") &&
			(value.cursor == null || isNonEmptyString(value.cursor, 300)) &&
			(value.limit == null ||
				(Number.isSafeInteger(value.limit) &&
					Number(value.limit) >= 1 &&
					Number(value.limit) <= 100))
		);
	if (value.type === "command_result")
		return (
			hasOnlyKeys(value, [
				"type",
				"version",
				"requestId",
				"ok",
				"message",
				"pairingUri",
				"instances",
				"history",
				"state",
			]) &&
			isNonEmptyString(value.requestId, 300) &&
			typeof value.ok === "boolean" &&
			typeof value.message === "string" &&
			(value.pairingUri == null || typeof value.pairingUri === "string") &&
			(value.instances == null || Array.isArray(value.instances)) &&
			(value.history == null || isRecord(value.history)) &&
			(value.state == null || isRecord(value.state))
		);
	if (value.type === "unregister")
		return (
			hasOnlyKeys(value, ["type", "version", "instanceId", "epoch"]) &&
			isNonEmptyString(value.instanceId, 300) &&
			isNonEmptyString(value.epoch, 300)
		);
	return false;
}

export function validatePageSize(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) return 50;
	return Math.max(1, Math.min(ANYWHERE_MAX_HISTORY_PAGE_SIZE, value));
}

export function validateBodySize(bytes: number): boolean {
	return (
		Number.isSafeInteger(bytes) &&
		bytes >= 0 &&
		bytes <= ANYWHERE_MAX_BODY_BYTES
	);
}

export function validateComment(value: unknown): boolean {
	return (
		value === undefined ||
		(typeof value === "string" && value.length <= ANYWHERE_MAX_COMMENT_CHARS)
	);
}
