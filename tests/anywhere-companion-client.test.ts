import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { CompanionClient } from "../extensions/anywhere/companion-client.ts";
import { readRendezvous } from "../extensions/anywhere/config.ts";

vi.mock("../extensions/anywhere/config.ts", () => ({
	readRendezvous: vi.fn(),
}));

const servers: WebSocketServer[] = [];

async function closeServer(server: WebSocketServer): Promise<void> {
	for (const socket of server.clients) socket.terminate();
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

afterEach(async () => {
	await Promise.all(servers.splice(0).map(closeServer));
	vi.clearAllMocks();
});

describe("Anywhere companion client", () => {
	it("sends auth and registration before connected callbacks can publish events", async () => {
		const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		servers.push(server);
		await once(server, "listening");
		const port = (server.address() as AddressInfo).port;
		vi.mocked(readRendezvous).mockResolvedValue({
			version: 2,
			process_epoch: "test-process",
			internal_port: port,
			registration_token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		});

		const received = new Promise<Record<string, unknown>[]>(
			(resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error("Timed out waiting for client frames.")),
					2_000,
				);
				server.once("connection", (socket) => {
					const frames: Record<string, unknown>[] = [];
					socket.on("message", (data) => {
						frames.push(JSON.parse(data.toString()) as Record<string, unknown>);
						if (frames.length === 3) {
							clearTimeout(timer);
							resolve(frames);
						}
					});
				});
			},
		);

		const instance = {
			id: "instance-1",
			epoch: "epoch-1",
			sessionId: "session-1",
			projectName: "test-project",
			cwd: process.cwd(),
			state: "idle" as const,
			pendingPromptCount: 0,
			lastActivityAt: Date.now(),
			connectedAt: Date.now(),
		};
		const state = {
			version: 2 as const,
			instanceId: instance.id,
			epoch: instance.epoch,
			cursor: 0,
			oldestCursor: 1,
			resetRequired: false,
			events: [],
			agent: false,
		};
		let client: CompanionClient;
		client = new CompanionClient(instance.id, {
			onFrame: () => {},
			onStatus: (status) => {
				if (status === "connected") {
					client.send({
						type: "event",
						version: 2,
						instanceId: instance.id,
						event: {
							cursor: 1,
							kind: "status",
							text: "connected",
							level: "ok",
						},
					});
				}
			},
		});

		await client.start(instance, state);
		const frames = await received;
		client.stop();

		expect(frames.map((frame) => frame.type)).toEqual([
			"auth",
			"register",
			"event",
		]);
	});

	it("dispatches Rust history commands whose unused options are null", async () => {
		const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		servers.push(server);
		await once(server, "listening");
		const port = (server.address() as AddressInfo).port;
		vi.mocked(readRendezvous).mockResolvedValue({
			version: 2,
			process_epoch: "test-process",
			internal_port: port,
			registration_token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		});

		server.once("connection", (socket) => {
			socket.on("message", (data) => {
				const frame = JSON.parse(data.toString()) as { type?: string };
				if (frame.type === "register") {
					socket.send(
						JSON.stringify({
							type: "command",
							version: 2,
							requestId: "history-1",
							instanceId: "instance-1",
							command: "history",
							enabled: null,
							cursor: null,
							limit: 100,
						}),
					);
				}
			});
		});

		let resolveFrame: (frame: { type: string }) => void = () => {};
		const received = new Promise<{ type: string }>((resolve) => {
			resolveFrame = resolve;
		});
		const client = new CompanionClient("instance-1", {
			onFrame: (frame) => resolveFrame(frame),
		});
		await client.start(
			{
				id: "instance-1",
				epoch: "epoch-1",
				sessionId: "session-1",
				projectName: "test-project",
				cwd: process.cwd(),
				state: "idle",
				pendingPromptCount: 0,
				lastActivityAt: Date.now(),
				connectedAt: Date.now(),
			},
			{
				version: 2,
				instanceId: "instance-1",
				epoch: "epoch-1",
				cursor: 0,
				oldestCursor: 1,
				resetRequired: false,
				events: [],
				agent: false,
			},
		);
		await expect(received).resolves.toMatchObject({
			type: "command",
			command: "history",
		});
		client.stop();
	});
});
