import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { access, stat } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { extname, resolve, sep } from "node:path";
import { type WebSocket, WebSocketServer } from "ws";
import type { PlannerDocument, PlannerStore } from "./board-store.ts";

const MAX_WEBSOCKET_PAYLOAD = 1024 * 1024;
const MAX_HTTP_HEADER_BYTES = 16 * 1024;

export type PlannerServerInfo = {
	port: number;
	url: string;
};

type ClientMessage =
	| { type: "request_snapshot" }
	| {
			type: "apply_user_operations";
			baseRevision: number;
			operations: unknown[];
	  }
	| {
			type: "replace_board";
			baseRevision: number;
			nodes: unknown[];
			edges: unknown[];
	  }
	| { type: "accept_proposal"; proposalId: string }
	| { type: "reject_proposal"; proposalId: string };

type ServerMessage =
	| { type: "snapshot"; document: PlannerDocument }
	| { type: "error"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseClientMessage(value: unknown): ClientMessage {
	if (!isRecord(value) || typeof value.type !== "string")
		throw new Error("Message must have a type.");
	switch (value.type) {
		case "request_snapshot":
			return { type: "request_snapshot" };
		case "apply_user_operations":
			if (
				!Number.isSafeInteger(value.baseRevision) ||
				!Array.isArray(value.operations)
			)
				throw new Error("Invalid apply_user_operations message.");
			return {
				type: "apply_user_operations",
				baseRevision: value.baseRevision as number,
				operations: value.operations,
			};
		case "replace_board":
			if (
				!Number.isSafeInteger(value.baseRevision) ||
				!Array.isArray(value.nodes) ||
				!Array.isArray(value.edges)
			) {
				throw new Error("Invalid replace_board message.");
			}
			return {
				type: "replace_board",
				baseRevision: value.baseRevision as number,
				nodes: value.nodes,
				edges: value.edges,
			};
		case "accept_proposal":
		case "reject_proposal":
			if (typeof value.proposalId !== "string")
				throw new Error(`Invalid ${value.type} message.`);
			return { type: value.type, proposalId: value.proposalId };
		default:
			throw new Error(`Unsupported message type: ${value.type}.`);
	}
}

function tokenDigest(value: string): Buffer {
	return createHash("sha256").update(value).digest();
}

function secureTokenEquals(
	actual: string | undefined,
	expectedDigest: Buffer,
): boolean {
	if (!actual) return false;
	const digest = tokenDigest(actual);
	return (
		digest.length === expectedDigest.length &&
		timingSafeEqual(digest, expectedDigest)
	);
}

function cookieToken(request: IncomingMessage): string | undefined {
	const cookie = request.headers.cookie;
	if (!cookie) return undefined;
	for (const part of cookie.split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (name === "visual_planner_token")
			return decodeURIComponent(rest.join("="));
	}
	return undefined;
}

function contentType(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".html":
			return "text/html; charset=utf-8";
		case ".js":
			return "text/javascript; charset=utf-8";
		case ".css":
			return "text/css; charset=utf-8";
		case ".svg":
			return "image/svg+xml";
		case ".png":
			return "image/png";
		case ".ico":
			return "image/x-icon";
		case ".woff2":
			return "font/woff2";
		default:
			return "application/octet-stream";
	}
}

function writeText(
	response: ServerResponse,
	status: number,
	text: string,
): void {
	response.writeHead(status, {
		"Content-Type": "text/plain; charset=utf-8",
		"Cache-Control": "no-store",
	});
	response.end(text);
}

function socketOpen(socket: WebSocket): boolean {
	return socket.readyState === socket.OPEN;
}

export class PlannerServer {
	private readonly token = randomBytes(32).toString("base64url");
	private readonly tokenHash = tokenDigest(this.token);
	private readonly sockets = new Set<WebSocket>();
	private server: Server | undefined;
	private websocketServer: WebSocketServer | undefined;
	private infoValue: PlannerServerInfo | undefined;

	constructor(
		readonly store: PlannerStore,
		readonly staticDirectory: string,
	) {}

	get info(): PlannerServerInfo | undefined {
		return this.infoValue;
	}

	async start(): Promise<PlannerServerInfo> {
		if (this.infoValue) return this.infoValue;
		await access(resolve(this.staticDirectory, "index.html"));
		await this.store.ensure();

		const server = createServer(
			{ maxHeaderSize: MAX_HTTP_HEADER_BYTES },
			(request, response) => {
				void this.handleHttp(request, response).catch((error) => {
					if (!response.headersSent)
						writeText(
							response,
							500,
							error instanceof Error ? error.message : String(error),
						);
					else
						response.destroy(
							error instanceof Error ? error : new Error(String(error)),
						);
				});
			},
		);
		const websocketServer = new WebSocketServer({
			noServer: true,
			maxPayload: MAX_WEBSOCKET_PAYLOAD,
			perMessageDeflate: false,
		});

		server.on("upgrade", (request, socket, head) => {
			const info = this.infoValue;
			const expectedOrigin = info ? `http://127.0.0.1:${info.port}` : undefined;
			const host = info ? `127.0.0.1:${info.port}` : undefined;
			if (
				!info ||
				request.headers.host !== host ||
				request.headers.origin !== expectedOrigin ||
				!secureTokenEquals(cookieToken(request), this.tokenHash) ||
				new URL(request.url ?? "/", expectedOrigin).pathname !== "/ws"
			) {
				socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
				socket.destroy();
				return;
			}
			websocketServer.handleUpgrade(request, socket, head, (websocket) =>
				websocketServer.emit("connection", websocket, request),
			);
		});

		websocketServer.on("connection", (socket) => {
			this.sockets.add(socket);
			let messageQueue = Promise.resolve();
			void this.store
				.read()
				.then((document) => this.send(socket, { type: "snapshot", document }))
				.catch((error) => this.sendError(socket, error));
			socket.on("message", (data, isBinary) => {
				messageQueue = messageQueue
					.then(async () => {
						if (isBinary) throw new Error("Binary messages are not supported.");
						const message = parseClientMessage(
							JSON.parse(data.toString("utf8")),
						);
						const document = await this.handleClientMessage(message);
						this.broadcast(document);
					})
					.catch((error) => this.sendError(socket, error));
			});
			socket.on("close", () => this.sockets.delete(socket));
			socket.on("error", () => this.sockets.delete(socket));
		});

		await new Promise<void>((resolvePromise, reject) => {
			const onError = (error: Error) => reject(error);
			server.once("error", onError);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", onError);
				resolvePromise();
			});
		});

		const address = server.address();
		if (!address || typeof address === "string") {
			server.close();
			throw new Error("Visual planner server did not receive a loopback port.");
		}

		this.server = server;
		this.websocketServer = websocketServer;
		this.infoValue = {
			port: address.port,
			url: `http://127.0.0.1:${address.port}/?token=${encodeURIComponent(this.token)}`,
		};
		return this.infoValue;
	}

	private async handleHttp(
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> {
		const info = this.infoValue;
		if (!info || request.headers.host !== `127.0.0.1:${info.port}`)
			return writeText(response, 403, "Forbidden");
		if (request.method !== "GET" && request.method !== "HEAD")
			return writeText(response, 405, "Method not allowed");

		const url = new URL(request.url ?? "/", `http://127.0.0.1:${info.port}`);
		const queryToken = url.searchParams.get("token") ?? undefined;
		if (queryToken !== undefined) {
			if (
				!secureTokenEquals(queryToken, this.tokenHash) ||
				url.pathname !== "/"
			)
				return writeText(response, 403, "Forbidden");
			response.writeHead(302, {
				Location: "/",
				"Set-Cookie": `visual_planner_token=${encodeURIComponent(this.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=7200`,
				"Cache-Control": "no-store",
				"Referrer-Policy": "no-referrer",
			});
			response.end();
			return;
		}

		if (!secureTokenEquals(cookieToken(request), this.tokenHash))
			return writeText(response, 403, "Forbidden");
		let pathname: string;
		try {
			pathname = decodeURIComponent(url.pathname);
		} catch {
			return writeText(response, 400, "Invalid path");
		}
		const relativePath =
			pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
		const root = resolve(this.staticDirectory);
		const filePath = resolve(root, relativePath);
		if (filePath !== root && !filePath.startsWith(`${root}${sep}`))
			return writeText(response, 403, "Forbidden");

		let fileStats: Stats;
		try {
			fileStats = await stat(filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				return writeText(response, 404, "Not found");
			throw error;
		}
		if (!fileStats.isFile()) return writeText(response, 404, "Not found");

		response.writeHead(200, {
			"Content-Type": contentType(filePath),
			"Content-Length": String(fileStats.size),
			"Cache-Control": "no-store",
			"Content-Security-Policy": `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ws://127.0.0.1:${info.port}; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
			"X-Frame-Options": "DENY",
			"Cross-Origin-Resource-Policy": "same-origin",
		});
		if (request.method === "HEAD") {
			response.end();
			return;
		}
		createReadStream(filePath)
			.on("error", (error) => response.destroy(error))
			.pipe(response);
	}

	private async handleClientMessage(
		message: ClientMessage,
	): Promise<PlannerDocument> {
		switch (message.type) {
			case "request_snapshot":
				return this.store.read();
			case "apply_user_operations":
				return this.store.applyUserOperations(
					message.baseRevision,
					message.operations,
				);
			case "replace_board":
				return this.store.replaceBoard(
					message.baseRevision,
					message.nodes,
					message.edges,
				);
			case "accept_proposal":
				return this.store.acceptProposal(message.proposalId);
			case "reject_proposal":
				return this.store.rejectProposal(message.proposalId);
		}
	}

	private send(socket: WebSocket, message: ServerMessage): void {
		if (socketOpen(socket)) socket.send(JSON.stringify(message));
	}

	private sendError(socket: WebSocket, error: unknown): void {
		this.send(socket, {
			type: "error",
			message: error instanceof Error ? error.message : String(error),
		});
	}

	broadcast(document: PlannerDocument): void {
		const encoded = JSON.stringify({
			type: "snapshot",
			document,
		} satisfies ServerMessage);
		for (const socket of this.sockets) {
			if (socketOpen(socket)) socket.send(encoded);
		}
	}

	async stop(): Promise<void> {
		for (const socket of this.sockets) socket.close(1001, "Planner stopped");
		this.sockets.clear();
		this.websocketServer?.close();
		this.websocketServer = undefined;
		const server = this.server;
		this.server = undefined;
		this.infoValue = undefined;
		if (!server) return;
		await new Promise<void>((resolvePromise) =>
			server.close(() => resolvePromise()),
		);
	}
}
