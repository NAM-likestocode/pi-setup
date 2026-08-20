import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export const COMPANION_IDENTIFIER = "com.namlikestocode.pi-anywhere";
export const RENDEZVOUS_VERSION = 2;
export const MAX_REGISTRATION_TOKEN_LENGTH = 128;
export const ANYWHERE_STATUS_ID = "anywhere-status";

export interface RendezvousInfo {
	version: number;
	process_epoch: string;
	internal_port: number;
	registration_token: string;
}

export function companionDataDirectories(): string[] {
	const home = homedir();
	if (platform() === "win32") {
		const appData = process.env.APPDATA;
		return [
			...(appData ? [join(appData, COMPANION_IDENTIFIER)] : []),
			join(home, "AppData", "Roaming", COMPANION_IDENTIFIER),
		];
	}
	if (platform() === "darwin")
		return [join(home, "Library", "Application Support", COMPANION_IDENTIFIER)];
	const dataHome = process.env.XDG_DATA_HOME || join(home, ".local", "share");
	return [join(dataHome, COMPANION_IDENTIFIER)];
}

export function rendezvousPaths(): string[] {
	return companionDataDirectories().map((directory) =>
		join(directory, "rendezvous.json"),
	);
}

export function instanceId(): string {
	return `pi-${randomUUID()}`;
}

export function instanceEpoch(): string {
	return randomUUID();
}

export function isValidRendezvous(value: unknown): value is RendezvousInfo {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		record.version === RENDEZVOUS_VERSION &&
		typeof record.process_epoch === "string" &&
		record.process_epoch.length > 0 &&
		Number.isSafeInteger(record.internal_port) &&
		Number(record.internal_port) >= 1 &&
		Number(record.internal_port) <= 65_535 &&
		typeof record.registration_token === "string" &&
		/^[A-Za-z0-9_-]{20,128}$/.test(record.registration_token)
	);
}

export async function readRendezvous(): Promise<RendezvousInfo | undefined> {
	for (const path of rendezvousPaths()) {
		if (!existsSync(path)) continue;
		try {
			const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
			if (isValidRendezvous(parsed)) return parsed;
		} catch {
			// The companion may be replacing the file; try again on the next interval.
		}
	}
	return undefined;
}

export async function ensureCompanionDataDirectory(): Promise<void> {
	const [directory] = companionDataDirectories();
	if (directory)
		await mkdir(dirname(join(directory, "rendezvous.json")), {
			recursive: true,
		});
}
