import {
	type HistoryPage,
	type InstanceState,
	type InstanceSummary,
	type PairResponse,
	type PromptAnswer,
	parsePairingUri,
	type SendMessageResult,
} from "@pi-anywhere/protocol";
import {
	clearCredentials,
	type StoredCredentials,
	saveCredentials,
} from "../auth/credential-store";
import { normalizeInstanceState } from "./normalize";

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
	) {
		super(message);
	}
}

export interface PairResult {
	credentials: StoredCredentials;
	response: PairResponse;
}

function requestId(): string {
	return `mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class AnywhereApi {
	constructor(private credentials: StoredCredentials) {}

	get baseUrl(): string {
		return this.credentials.baseUrl.replace(/\/$/, "");
	}

	async bootstrap(): Promise<unknown> {
		return this.request("/api/v2/bootstrap");
	}

	async instances(): Promise<InstanceSummary[]> {
		const body = await this.request<{ instances?: InstanceSummary[] }>(
			"/api/v2/instances",
		);
		return Array.isArray(body.instances) ? body.instances : [];
	}

	async history(
		instanceId: string,
		cursor?: string,
		limit = 50,
	): Promise<HistoryPage> {
		const params = new URLSearchParams({ limit: String(limit) });
		if (cursor) params.set("cursor", cursor);
		const body = await this.request<HistoryPage>(
			`/api/v2/instances/${encodeURIComponent(instanceId)}/history?${params.toString()}`,
		);
		if (!body || typeof body !== "object" || !Array.isArray(body.entries)) {
			throw new ApiError(
				"The companion returned an invalid history response.",
				502,
				"companion_unavailable",
			);
		}
		return body;
	}

	async state(instanceId: string, since?: number): Promise<InstanceState> {
		const suffix =
			since === undefined ? "" : `?since=${encodeURIComponent(String(since))}`;
		const body = await this.request<{ state?: unknown }>(
			`/api/v2/instances/${encodeURIComponent(instanceId)}/state${suffix}`,
		);
		const state = normalizeInstanceState(instanceId, body.state);
		if (!state) {
			throw new ApiError(
				"The companion returned an invalid session response.",
				502,
				"companion_unavailable",
			);
		}
		return state;
	}

	async sendMessage(
		instanceId: string,
		text: string,
		delivery: "steer" | "followUp",
	): Promise<SendMessageResult> {
		return this.request<SendMessageResult>(
			`/api/v2/instances/${encodeURIComponent(instanceId)}/messages`,
			{
				method: "POST",
				body: JSON.stringify({
					version: 2,
					idempotencyKey: requestId(),
					text,
					delivery,
				}),
			},
		);
	}

	async answer(
		instanceId: string,
		promptId: string,
		answer: PromptAnswer,
	): Promise<void> {
		await this.request(
			`/api/v2/instances/${encodeURIComponent(instanceId)}/prompts/${encodeURIComponent(promptId)}/answer`,
			{
				method: "POST",
				body: JSON.stringify({ version: 2, answer }),
			},
		);
	}

	async registerPushToken(
		token: string,
		platform: "android" | "ios",
	): Promise<void> {
		await this.request("/api/v2/device/push-token", {
			method: "PUT",
			body: JSON.stringify({ version: 2, token, platform }),
		});
	}

	async revoke(): Promise<void> {
		await this.request("/api/v2/device", { method: "DELETE" });
		await clearCredentials();
	}

	async request<T = Record<string, unknown>>(
		path: string,
		options: RequestInit = {},
	): Promise<T> {
		const headers = new Headers(options.headers);
		headers.set("Authorization", `Bearer ${this.credentials.deviceToken}`);
		headers.set("Accept", "application/json");
		if (options.body) headers.set("Content-Type", "application/json");
		let response: Response;
		try {
			response = await fetch(`${this.baseUrl}${path}`, {
				...options,
				headers,
				cache: "no-store",
			});
		} catch (error) {
			throw new ApiError(
				error instanceof Error ? error.message : "Network connection failed",
				0,
			);
		}
		const body = (await response.json().catch(() => ({}))) as Record<
			string,
			unknown
		>;
		if (!response.ok) {
			const error =
				body.error && typeof body.error === "object"
					? (body.error as Record<string, unknown>)
					: undefined;
			throw new ApiError(
				typeof error?.message === "string"
					? error.message
					: `Request failed (${response.status})`,
				response.status,
				typeof error?.code === "string" ? error.code : undefined,
			);
		}
		return body as T;
	}
}

export async function pairFromUri(
	uri: string,
	deviceName?: string,
): Promise<PairResult> {
	const pairing = parsePairingUri(uri);
	if (!pairing)
		throw new ApiError(
			"This QR code is invalid, expired, or from an incompatible Pimo version.",
			400,
			"invalid_pairing",
		);
	const baseUrl = pairing.baseUrl.replace(/\/$/, "");
	if (!baseUrl.startsWith("https://"))
		throw new ApiError(
			"Pairing requires a private HTTPS Tailscale address.",
			400,
			"invalid_pairing",
		);
	let response: Response;
	try {
		response = await fetch(`${baseUrl}/api/v2/pair`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({ version: 2, token: pairing.token, deviceName }),
		});
	} catch (error) {
		throw new ApiError(
			error instanceof Error
				? error.message
				: "Could not reach the Pi computer.",
			0,
		);
	}
	const body = (await response
		.json()
		.catch(() => ({}))) as Partial<PairResponse> & {
		error?: { message?: string; code?: string };
	};
	if (
		!response.ok ||
		typeof body.deviceToken !== "string" ||
		typeof body.hostId !== "string" ||
		typeof body.baseUrl !== "string"
	) {
		throw new ApiError(
			body.error?.message ?? "Pairing failed. Generate a fresh QR code.",
			response.status,
			body.error?.code,
		);
	}
	const credentials: StoredCredentials = {
		version: 2,
		hostId: body.hostId,
		baseUrl: body.baseUrl,
		deviceToken: body.deviceToken,
	};
	await saveCredentials(credentials);
	return { credentials, response: body as PairResponse };
}
