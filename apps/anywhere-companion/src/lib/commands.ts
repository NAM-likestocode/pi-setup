import { invoke } from "@tauri-apps/api/core";

export interface CompanionInstance {
	id: string;
	epoch: string;
	sessionId: string;
	sessionName?: string;
	projectName: string;
	cwd: string;
	model?: string;
	thinkingLevel?: string;
	state: "idle" | "working" | "waiting" | "disconnected";
	pendingPromptCount: number;
	lastActivityAt: number;
	connectedAt: number;
}

export interface CompanionStatus {
	machineId: string;
	enabled: boolean;
	publicPort: number;
	internalPort: number;
	processEpoch: string;
	instanceCount: number;
	instances: CompanionInstance[];
	pairingUri?: string;
}

type RawCompanionStatus = Partial<Omit<CompanionStatus, "instances">> & {
	instances?: unknown;
	machine_id?: string;
	public_port?: number;
	internal_port?: number;
	process_epoch?: string;
	instance_count?: number;
	pairing_uri?: string;
};

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function normalizeInstance(value: unknown): CompanionInstance | undefined {
	const item = record(value);
	if (!item || typeof item.id !== "string") return undefined;
	const state = ["idle", "working", "waiting", "disconnected"].includes(
		String(item.state),
	)
		? (item.state as CompanionInstance["state"])
		: "disconnected";
	return {
		id: item.id,
		epoch: typeof item.epoch === "string" ? item.epoch : "",
		sessionId: typeof item.sessionId === "string" ? item.sessionId : item.id,
		sessionName:
			typeof item.sessionName === "string" ? item.sessionName : undefined,
		projectName:
			typeof item.projectName === "string" ? item.projectName : "Pi session",
		cwd: typeof item.cwd === "string" ? item.cwd : "",
		model: typeof item.model === "string" ? item.model : undefined,
		thinkingLevel:
			typeof item.thinkingLevel === "string" ? item.thinkingLevel : undefined,
		state,
		pendingPromptCount:
			typeof item.pendingPromptCount === "number" ? item.pendingPromptCount : 0,
		lastActivityAt:
			typeof item.lastActivityAt === "number" ? item.lastActivityAt : 0,
		connectedAt: typeof item.connectedAt === "number" ? item.connectedAt : 0,
	};
}

function normalizeStatus(raw: RawCompanionStatus): CompanionStatus {
	const instances = Array.isArray(raw.instances)
		? raw.instances
				.map(normalizeInstance)
				.filter((item): item is CompanionInstance => Boolean(item))
		: [];
	instances.sort((left, right) => right.lastActivityAt - left.lastActivityAt);
	return {
		machineId: raw.machineId ?? raw.machine_id ?? "",
		enabled: raw.enabled ?? false,
		publicPort: raw.publicPort ?? raw.public_port ?? 0,
		internalPort: raw.internalPort ?? raw.internal_port ?? 0,
		processEpoch: raw.processEpoch ?? raw.process_epoch ?? "",
		instanceCount: raw.instanceCount ?? raw.instance_count ?? instances.length,
		instances,
		pairingUri: raw.pairingUri ?? raw.pairing_uri,
	};
}

function invokeStatus(
	command: string,
	args?: Record<string, unknown>,
): Promise<CompanionStatus> {
	return invoke<RawCompanionStatus>(command, args).then(normalizeStatus);
}

export function getStatus(): Promise<CompanionStatus> {
	return invokeStatus("companion_status");
}

export function disconnectInstance(instanceId: string): Promise<void> {
	return invoke("disconnect_instance", { instanceId });
}

export function renameInstance(
	instanceId: string,
	name: string,
): Promise<CompanionStatus> {
	return invokeStatus("rename_instance", { instanceId, name });
}

export function showPairing(): Promise<CompanionStatus> {
	return invokeStatus("show_pairing");
}

export function rePair(): Promise<CompanionStatus> {
	return invokeStatus("re_pair");
}

export function setEnabled(enabled: boolean): Promise<CompanionStatus> {
	return invokeStatus("set_enabled", { enabled });
}

export function openDiagnostics(): Promise<string> {
	return invoke<string>("diagnostics");
}

export function quitCompanion(): Promise<void> {
	return invoke("quit_companion");
}
