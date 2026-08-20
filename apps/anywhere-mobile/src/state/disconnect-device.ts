interface RevocableApi {
	revoke: () => Promise<unknown>;
}

export class DeviceDisconnectError extends Error {
	constructor(
		public readonly stage: "revoke" | "clear",
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "DeviceDisconnectError";
	}
}

export async function revokeAndClearDevice(
	api: RevocableApi | null,
	clearLocalCredentials: () => Promise<void>,
): Promise<void> {
	if (api) {
		try {
			await api.revoke();
		} catch (cause) {
			throw new DeviceDisconnectError(
				"revoke",
				"Could not revoke this phone. Its credential was kept so you can retry when the companion is reachable.",
				{ cause },
			);
		}
	}

	try {
		await clearLocalCredentials();
	} catch (cause) {
		throw new DeviceDisconnectError(
			"clear",
			api
				? "Access was revoked on the companion, but this phone could not clear its local credential."
				: "This phone could not clear its local credential.",
			{ cause },
		);
	}
}
