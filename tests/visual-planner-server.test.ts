import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RawData, WebSocket } from "ws";
import {
	type PlannerDocument,
	PlannerStore,
} from "../extensions/visual-planner/board-store.ts";
import { PlannerServer } from "../extensions/visual-planner/server.ts";

const temporaryDirectories: string[] = [];
const servers: PlannerServer[] = [];

async function createServer(): Promise<PlannerServer> {
	const root = await mkdtemp(join(tmpdir(), "pi-visual-planner-server-"));
	temporaryDirectories.push(root);
	const staticDirectory = join(root, "static");
	await mkdir(staticDirectory);
	await writeFile(
		join(staticDirectory, "index.html"),
		"<!doctype html><title>Planner</title>",
		"utf8",
	);
	await writeFile(
		join(staticDirectory, "app.js"),
		"console.log('planner')",
		"utf8",
	);
	const server = new PlannerServer(
		new PlannerStore(join(root, "project")),
		staticDirectory,
	);
	await server.start();
	servers.push(server);
	return server;
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
	return new Promise((resolvePromise, reject) => {
		const onMessage = (data: RawData) => {
			cleanup();
			resolvePromise(
				JSON.parse(data.toString("utf8")) as Record<string, unknown>,
			);
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const cleanup = () => {
			socket.off("message", onMessage);
			socket.off("error", onError);
		};
		socket.on("message", onMessage);
		socket.on("error", onError);
	});
}

function requireServerInfo(server: PlannerServer) {
	const info = server.info;
	if (!info) throw new Error("Planner server is not running.");
	return info;
}

async function authenticate(
	server: PlannerServer,
): Promise<{ origin: string; cookie: string }> {
	const info = requireServerInfo(server);
	const response = await fetch(info.url, { redirect: "manual" });
	expect(response.status).toBe(302);
	const cookie = response.headers.get("set-cookie")?.split(";")[0];
	if (!cookie) throw new Error("Missing planner authentication cookie.");
	return { origin: `http://127.0.0.1:${info.port}`, cookie };
}

async function connect(server: PlannerServer): Promise<WebSocket> {
	const { origin, cookie } = await authenticate(server);
	const socket = new WebSocket(
		`ws://127.0.0.1:${requireServerInfo(server).port}/ws`,
		{
			origin,
			headers: { Cookie: cookie },
		},
	);
	await new Promise<void>((resolvePromise, reject) => {
		socket.once("open", () => resolvePromise());
		socket.once("error", reject);
	});
	return socket;
}

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.stop()));
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("visual planner loopback server", () => {
	it("requires the launch token, sets a private cookie, and serves local assets with security headers", async () => {
		const server = await createServer();
		const origin = `http://127.0.0.1:${requireServerInfo(server).port}`;

		expect((await fetch(origin)).status).toBe(403);
		expect(
			(await fetch(`${origin}/?token=wrong`, { redirect: "manual" })).status,
		).toBe(403);

		const { cookie } = await authenticate(server);
		const response = await fetch(origin, { headers: { Cookie: cookie } });
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Planner");
		expect(response.headers.get("content-security-policy")).toContain(
			"default-src 'none'",
		);
		expect(response.headers.get("x-frame-options")).toBe("DENY");

		const asset = await fetch(`${origin}/app.js`, {
			headers: { Cookie: cookie },
		});
		expect(asset.status).toBe(200);
		expect(asset.headers.get("content-type")).toContain("text/javascript");
	});

	it("rejects WebSocket clients without the authenticated cookie", async () => {
		const server = await createServer();
		const port = requireServerInfo(server).port;
		const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
			origin: `http://127.0.0.1:${port}`,
		});

		const status = await new Promise<number>((resolvePromise, reject) => {
			socket.once("unexpected-response", (_request, response) =>
				resolvePromise(response.statusCode ?? 0),
			);
			socket.once("open", () =>
				reject(new Error("Unauthenticated socket unexpectedly opened.")),
			);
			socket.once("error", () => {});
		});
		expect(status).toBe(403);
		socket.close();
	});

	it("applies browser operations and broadcasts the authoritative snapshot", async () => {
		const server = await createServer();
		const socket = await connect(server);
		const initial = await nextMessage(socket);
		expect(initial.type).toBe("snapshot");
		expect((initial.document as PlannerDocument).boardRevision).toBe(0);

		const updatedMessage = nextMessage(socket);
		socket.send(
			JSON.stringify({
				type: "apply_user_operations",
				baseRevision: 0,
				operations: [
					{
						type: "add_node",
						id: "goal",
						title: "Plan visually",
						kind: "goal",
						x: 10,
						y: 20,
					},
				],
			}),
		);
		const updated = await updatedMessage;
		const document = updated.document as PlannerDocument;
		expect(document.boardRevision).toBe(1);
		expect(document.nodes.map((node) => node.id)).toEqual(["goal"]);
		expect((await server.store.read()).boardRevision).toBe(1);
		socket.close();
	});

	it("returns a bounded error instead of applying an invalid client change", async () => {
		const server = await createServer();
		const socket = await connect(server);
		await nextMessage(socket);

		const errorMessage = nextMessage(socket);
		socket.send(
			JSON.stringify({
				type: "apply_user_operations",
				baseRevision: 0,
				operations: [{ type: "remove_node", id: "missing" }],
			}),
		);
		const response = await errorMessage;
		expect(response.type).toBe("error");
		expect(String(response.message)).toContain("does not exist");
		expect((await server.store.read()).boardRevision).toBe(0);
		socket.close();
	});
});
