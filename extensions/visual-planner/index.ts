import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	NODE_KINDS,
	NODE_STATUSES,
	OPERATION_TYPES,
	type PlannerDocument,
	PlannerStore,
} from "./board-store.ts";
import { PlannerServer } from "./server.ts";

export const PLANNER_TOOL_NAMES = [
	"visual_planner_read",
	"visual_planner_propose",
] as const;
const STATIC_DIRECTORY = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../apps/visual-planner/dist",
);

const operationSchema = Type.Object(
	{
		type: StringEnum(OPERATION_TYPES),
		id: Type.String({
			description:
				"Stable unique id using letters, numbers, dots, underscores, colons, or hyphens; max 64 characters",
		}),
		title: Type.Optional(Type.String({ maxLength: 160 })),
		body: Type.Optional(Type.String({ maxLength: 5_000 })),
		kind: Type.Optional(StringEnum(NODE_KINDS)),
		status: Type.Optional(StringEnum(NODE_STATUSES)),
		x: Type.Optional(Type.Number({ minimum: -1_000_000, maximum: 1_000_000 })),
		y: Type.Optional(Type.Number({ minimum: -1_000_000, maximum: 1_000_000 })),
		source: Type.Optional(Type.String({ maxLength: 64 })),
		target: Type.Optional(Type.String({ maxLength: 64 })),
		label: Type.Optional(Type.String({ maxLength: 120 })),
	},
	{ additionalProperties: false },
);

function activeWithPlanner(pi: ExtensionAPI): string[] {
	return [...new Set([...pi.getActiveTools(), ...PLANNER_TOOL_NAMES])];
}

function activeWithoutPlanner(pi: ExtensionAPI): string[] {
	return pi
		.getActiveTools()
		.filter(
			(name) => !(PLANNER_TOOL_NAMES as readonly string[]).includes(name),
		);
}

function compact(value: string, length: number): string {
	const text = value.replace(/\s+/g, " ").trim();
	return text.length <= length
		? text
		: `${text.slice(0, Math.max(1, length - 1)).trimEnd()}…`;
}

export function formatPlannerForModel(
	document: PlannerDocument,
	maxCharacters = 45_000,
): string {
	const pending = document.proposals.filter(
		(proposal) => proposal.status === "pending",
	);
	const lines = [
		`Visual planner for ${document.projectName}`,
		`Board revision: ${document.boardRevision}`,
		`Nodes: ${document.nodes.length}; edges: ${document.edges.length}; pending Pi proposals: ${pending.length}`,
		"",
		"Nodes:",
	];
	let truncated = false;
	const append = (line: string): boolean => {
		if (lines.join("\n").length + line.length + 1 > maxCharacters) {
			truncated = true;
			return false;
		}
		lines.push(line);
		return true;
	};

	for (const node of document.nodes) {
		const body = node.body ? ` — ${compact(node.body, 500)}` : "";
		if (
			!append(
				`- [${node.id}] ${node.title} (${node.kind}, ${node.status}, x=${Math.round(node.x)}, y=${Math.round(node.y)})${body}`,
			)
		)
			break;
	}

	if (!truncated) {
		append("");
		append("Connections:");
		for (const edge of document.edges) {
			if (
				!append(
					`- [${edge.id}] ${edge.source} -> ${edge.target}${edge.label ? ` — ${compact(edge.label, 120)}` : ""}`,
				)
			)
				break;
		}
	}

	if (!truncated) {
		append("");
		append("Pending proposals:");
		for (const proposal of pending) {
			if (
				!append(
					`- [${proposal.id}] revision ${proposal.baseRevision}: ${compact(proposal.summary, 500)} (${proposal.operations.length} operations)`,
				)
			)
				break;
		}
	}

	if (truncated)
		lines.push(
			"",
			"[Board output truncated. Keep future proposals focused on nodes and edges visible above.]",
		);
	return lines.join("\n");
}

async function openBrowser(pi: ExtensionAPI, url: string): Promise<void> {
	if (process.platform === "win32") {
		const result = await pi.exec(
			"cmd.exe",
			["/d", "/s", "/c", "start", "", url],
			{ timeout: 10_000 },
		);
		if (result.code !== 0)
			throw new Error(result.stderr || "Windows could not open the browser.");
		return;
	}
	const command = process.platform === "darwin" ? "open" : "xdg-open";
	const result = await pi.exec(command, [url], { timeout: 10_000 });
	if (result.code !== 0)
		throw new Error(result.stderr || `${command} could not open the browser.`);
}

export default function visualPlanner(pi: ExtensionAPI): void {
	let server: PlannerServer | undefined;

	const stopServer = async (): Promise<void> => {
		const current = server;
		server = undefined;
		if (current) await current.stop();
		pi.setActiveTools(activeWithoutPlanner(pi));
	};

	const ensureServer = async (
		ctx: ExtensionContext,
	): Promise<PlannerServer> => {
		if (server && server.store.cwd === ctx.cwd) return server;
		if (server) await stopServer();
		const next = new PlannerServer(new PlannerStore(ctx.cwd), STATIC_DIRECTORY);
		await next.start();
		server = next;
		pi.setActiveTools(activeWithPlanner(pi));
		return next;
	};

	pi.registerTool({
		name: "visual_planner_read",
		label: "Read Visual Planner",
		description:
			"Read the current project's visual planning board, including stable node ids, connections, board revision, and pending Pi proposals. Output is capped at 45,000 characters.",
		promptSnippet:
			"Read the open visual planning canvas and its current revision",
		promptGuidelines: [
			"Use visual_planner_read before proposing canvas changes, and preserve the stable ids it returns.",
		],
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const document = await new PlannerStore(ctx.cwd).read();
			return {
				content: [{ type: "text", text: formatPlannerForModel(document) }],
				details: {
					boardRevision: document.boardRevision,
					nodes: document.nodes.length,
					edges: document.edges.length,
					pendingProposals: document.proposals.filter(
						(proposal) => proposal.status === "pending",
					).length,
				},
			};
		},
	});

	pi.registerTool({
		name: "visual_planner_propose",
		label: "Propose Visual Planner Changes",
		description: `Stage a review-only batch of visual planning changes. This never changes the canonical board until the user accepts it in the browser. Supported operation types: ${OPERATION_TYPES.join(", ")}. Read the board first and pass its exact current revision.`,
		promptSnippet:
			"Propose a reviewable batch of changes to the open visual planning canvas",
		promptGuidelines: [
			"Use visual_planner_propose only after visual_planner_read, and tell the user to accept or reject the staged batch in the browser.",
			"visual_planner_propose must use stable readable ids and must not claim its changes are applied before browser approval.",
		],
		parameters: Type.Object(
			{
				summary: Type.String({
					description:
						"Short user-facing explanation of the proposed board changes",
					minLength: 1,
					maxLength: 1_000,
				}),
				baseRevision: Type.Integer({
					description: "Exact board revision returned by visual_planner_read",
					minimum: 0,
				}),
				operations: Type.Array(operationSchema, { minItems: 1, maxItems: 200 }),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = new PlannerStore(ctx.cwd);
			const { document, proposal } = await store.addProposal(
				params.summary,
				params.baseRevision,
				params.operations,
			);
			if (server?.store.cwd === ctx.cwd) server.broadcast(document);
			return {
				content: [
					{
						type: "text",
						text: `Staged proposal ${proposal.id} with ${proposal.operations.length} change(s). The board has not changed. Ask the user to review it in the visual planner browser.`,
					},
				],
				details: {
					proposalId: proposal.id,
					boardRevision: document.boardRevision,
					operations: proposal.operations.length,
					status: proposal.status,
				},
				terminate: true,
			};
		},
	});

	pi.registerCommand("canvas", {
		description: "Open, close, or show status for the visual planning canvas",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "off" || action === "close" || action === "stop") {
				await stopServer();
				ctx.ui.setStatus("visual-planner", undefined);
				ctx.ui.notify(
					"Visual planner closed. The project board remains saved on disk.",
					"info",
				);
				return;
			}
			if (action === "status") {
				const info = server?.info;
				const paths = new PlannerStore(ctx.cwd).paths;
				ctx.ui.notify(
					info
						? `Visual planner is open at http://127.0.0.1:${info.port}. Board: ${paths.json}`
						: `Visual planner is closed. Board: ${paths.json}`,
					"info",
				);
				return;
			}
			if (
				action &&
				action !== "open" &&
				action !== "on" &&
				action !== "start"
			) {
				ctx.ui.notify("Usage: /canvas [open|status|off]", "warning");
				return;
			}

			try {
				const activeServer = await ensureServer(ctx);
				const info = activeServer.info;
				if (!info) throw new Error("Visual planner server did not start.");
				ctx.ui.setStatus(
					"visual-planner",
					ctx.ui.theme.fg("accent", "◇ CANVAS"),
				);
				await openBrowser(pi, info.url);
				ctx.ui.notify(
					`Visual planner opened. Board: ${activeServer.store.paths.json}`,
					"info",
				);
			} catch (error) {
				await stopServer();
				ctx.ui.setStatus("visual-planner", undefined);
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(
					message.includes("index.html")
						? "Visual planner browser files are missing. Run `npm run planner:build` in ~/.pi/agent, then try /canvas again."
						: `Could not open visual planner: ${message}`,
					"error",
				);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		pi.setActiveTools(activeWithoutPlanner(pi));
		ctx.ui.setStatus("visual-planner", undefined);
	});

	pi.on("session_shutdown", async () => {
		await stopServer();
	});
}
