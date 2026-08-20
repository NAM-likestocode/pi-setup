import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
	CONFIG_DIR_NAME,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

export const NODE_KINDS = [
	"goal",
	"idea",
	"question",
	"decision",
	"task",
	"file",
] as const;
export const NODE_STATUSES = [
	"none",
	"open",
	"in_progress",
	"blocked",
	"done",
] as const;
export const OPERATION_TYPES = [
	"add_node",
	"update_node",
	"move_node",
	"remove_node",
	"add_edge",
	"update_edge",
	"remove_edge",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];
export type NodeStatus = (typeof NODE_STATUSES)[number];
export type OperationType = (typeof OPERATION_TYPES)[number];

export type PlannerNode = {
	id: string;
	kind: NodeKind;
	title: string;
	body: string;
	status: NodeStatus;
	x: number;
	y: number;
	createdAt: string;
	updatedAt: string;
};

export type PlannerEdge = {
	id: string;
	source: string;
	target: string;
	label: string;
};

export type PlannerOperation = {
	type: OperationType;
	id: string;
	title?: string;
	body?: string;
	kind?: NodeKind;
	status?: NodeStatus;
	x?: number;
	y?: number;
	source?: string;
	target?: string;
	label?: string;
};

export type ProposalStatus = "pending" | "accepted" | "rejected" | "stale";

export type PlannerProposal = {
	id: string;
	summary: string;
	baseRevision: number;
	operations: PlannerOperation[];
	status: ProposalStatus;
	createdAt: string;
	decidedAt?: string;
};

export type PlannerDocument = {
	schemaVersion: 1;
	boardRevision: number;
	projectName: string;
	updatedAt: string;
	nodes: PlannerNode[];
	edges: PlannerEdge[];
	proposals: PlannerProposal[];
};

export type BoardPaths = {
	directory: string;
	json: string;
	markdown: string;
};

const MAX_NODES = 1_000;
const MAX_EDGES = 3_000;
const MAX_PROPOSALS = 100;
const MAX_OPERATIONS = 200;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function now(): string {
	return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(
	value: unknown,
	label: string,
	maxLength: number,
	allowEmpty = false,
): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string.`);
	const result = value.trim();
	if (!allowEmpty && result.length === 0)
		throw new Error(`${label} cannot be empty.`);
	if (result.length > maxLength)
		throw new Error(`${label} must be ${maxLength} characters or fewer.`);
	return result;
}

function requireId(value: unknown, label: string): string {
	const id = requireString(value, label, 64);
	if (!ID_PATTERN.test(id))
		throw new Error(`${label} contains unsupported characters.`);
	return id;
}

function requireCoordinate(value: unknown, label: string): number {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		Math.abs(value) > 1_000_000
	) {
		throw new Error(
			`${label} must be a finite coordinate between -1000000 and 1000000.`,
		);
	}
	return value;
}

function requireEnum<T extends readonly string[]>(
	value: unknown,
	values: T,
	label: string,
): T[number] {
	if (typeof value !== "string" || !values.includes(value)) {
		throw new Error(`${label} must be one of: ${values.join(", ")}.`);
	}
	return value as T[number];
}

function parseNode(value: unknown, label: string): PlannerNode {
	if (!isRecord(value)) throw new Error(`${label} must be an object.`);
	return {
		id: requireId(value.id, `${label}.id`),
		kind: requireEnum(value.kind, NODE_KINDS, `${label}.kind`),
		title: requireString(value.title, `${label}.title`, 160),
		body: requireString(value.body ?? "", `${label}.body`, 5_000, true),
		status: requireEnum(value.status, NODE_STATUSES, `${label}.status`),
		x: requireCoordinate(value.x, `${label}.x`),
		y: requireCoordinate(value.y, `${label}.y`),
		createdAt: requireString(value.createdAt, `${label}.createdAt`, 64),
		updatedAt: requireString(value.updatedAt, `${label}.updatedAt`, 64),
	};
}

function parseEdge(value: unknown, label: string): PlannerEdge {
	if (!isRecord(value)) throw new Error(`${label} must be an object.`);
	return {
		id: requireId(value.id, `${label}.id`),
		source: requireId(value.source, `${label}.source`),
		target: requireId(value.target, `${label}.target`),
		label: requireString(value.label ?? "", `${label}.label`, 120, true),
	};
}

export function parseOperation(
	value: unknown,
	label = "operation",
): PlannerOperation {
	if (!isRecord(value)) throw new Error(`${label} must be an object.`);
	const type = requireEnum(value.type, OPERATION_TYPES, `${label}.type`);
	const operation: PlannerOperation = {
		type,
		id: requireId(value.id, `${label}.id`),
	};

	if (value.title !== undefined)
		operation.title = requireString(value.title, `${label}.title`, 160);
	if (value.body !== undefined)
		operation.body = requireString(value.body, `${label}.body`, 5_000, true);
	if (value.kind !== undefined)
		operation.kind = requireEnum(value.kind, NODE_KINDS, `${label}.kind`);
	if (value.status !== undefined)
		operation.status = requireEnum(
			value.status,
			NODE_STATUSES,
			`${label}.status`,
		);
	if (value.x !== undefined)
		operation.x = requireCoordinate(value.x, `${label}.x`);
	if (value.y !== undefined)
		operation.y = requireCoordinate(value.y, `${label}.y`);
	if (value.source !== undefined)
		operation.source = requireId(value.source, `${label}.source`);
	if (value.target !== undefined)
		operation.target = requireId(value.target, `${label}.target`);
	if (value.label !== undefined)
		operation.label = requireString(value.label, `${label}.label`, 120, true);

	switch (type) {
		case "add_node":
			if (!operation.title)
				throw new Error(`${label}.title is required for add_node.`);
			if ((operation.x === undefined) !== (operation.y === undefined))
				throw new Error(`${label} must provide both x and y, or neither.`);
			break;
		case "update_node":
			if (
				[
					operation.title,
					operation.body,
					operation.kind,
					operation.status,
				].every((item) => item === undefined)
			) {
				throw new Error(`${label} must include a field to update.`);
			}
			break;
		case "move_node":
			if (operation.x === undefined || operation.y === undefined)
				throw new Error(
					`${label}.x and ${label}.y are required for move_node.`,
				);
			break;
		case "add_edge":
			if (!operation.source || !operation.target)
				throw new Error(
					`${label}.source and ${label}.target are required for add_edge.`,
				);
			break;
		case "update_edge":
			if (operation.label === undefined)
				throw new Error(`${label}.label is required for update_edge.`);
			break;
		case "remove_node":
		case "remove_edge":
			break;
	}

	return operation;
}

function parseProposal(value: unknown, label: string): PlannerProposal {
	if (!isRecord(value)) throw new Error(`${label} must be an object.`);
	const operationsRaw = value.operations;
	if (
		!Array.isArray(operationsRaw) ||
		operationsRaw.length === 0 ||
		operationsRaw.length > MAX_OPERATIONS
	) {
		throw new Error(
			`${label}.operations must contain 1-${MAX_OPERATIONS} operations.`,
		);
	}
	const status = requireEnum(
		value.status,
		["pending", "accepted", "rejected", "stale"] as const,
		`${label}.status`,
	);
	return {
		id: requireId(value.id, `${label}.id`),
		summary: requireString(value.summary, `${label}.summary`, 1_000),
		baseRevision: requireRevision(value.baseRevision, `${label}.baseRevision`),
		operations: operationsRaw.map((operation, index) =>
			parseOperation(operation, `${label}.operations[${index}]`),
		),
		status,
		createdAt: requireString(value.createdAt, `${label}.createdAt`, 64),
		...(value.decidedAt === undefined
			? {}
			: {
					decidedAt: requireString(value.decidedAt, `${label}.decidedAt`, 64),
				}),
	};
}

function requireRevision(value: unknown, label = "revision"): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0)
		throw new Error(`${label} must be a non-negative integer.`);
	return value as number;
}

function validateBoard(nodes: PlannerNode[], edges: PlannerEdge[]): void {
	if (nodes.length > MAX_NODES)
		throw new Error(`The board cannot contain more than ${MAX_NODES} nodes.`);
	if (edges.length > MAX_EDGES)
		throw new Error(`The board cannot contain more than ${MAX_EDGES} edges.`);

	const nodeIds = new Set<string>();
	for (const node of nodes) {
		if (nodeIds.has(node.id)) throw new Error(`Duplicate node id: ${node.id}.`);
		nodeIds.add(node.id);
	}

	const edgeIds = new Set<string>();
	for (const edge of edges) {
		if (edgeIds.has(edge.id)) throw new Error(`Duplicate edge id: ${edge.id}.`);
		edgeIds.add(edge.id);
		if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
			throw new Error(`Edge ${edge.id} references a node that does not exist.`);
		}
	}
}

export function parsePlannerDocument(value: unknown): PlannerDocument {
	if (!isRecord(value)) throw new Error("Planner document must be an object.");
	if (value.schemaVersion !== 1)
		throw new Error("Unsupported visual planner schema version.");
	if (
		!Array.isArray(value.nodes) ||
		!Array.isArray(value.edges) ||
		!Array.isArray(value.proposals)
	) {
		throw new Error(
			"Planner document nodes, edges, and proposals must be arrays.",
		);
	}
	if (value.proposals.length > MAX_PROPOSALS)
		throw new Error(
			`The planner cannot retain more than ${MAX_PROPOSALS} proposals.`,
		);

	const nodes = value.nodes.map((node, index) =>
		parseNode(node, `nodes[${index}]`),
	);
	const edges = value.edges.map((edge, index) =>
		parseEdge(edge, `edges[${index}]`),
	);
	validateBoard(nodes, edges);

	return {
		schemaVersion: 1,
		boardRevision: requireRevision(value.boardRevision, "boardRevision"),
		projectName: requireString(value.projectName, "projectName", 200),
		updatedAt: requireString(value.updatedAt, "updatedAt", 64),
		nodes,
		edges,
		proposals: value.proposals.map((proposal, index) =>
			parseProposal(proposal, `proposals[${index}]`),
		),
	};
}

export function createPlannerDocument(cwd: string): PlannerDocument {
	return {
		schemaVersion: 1,
		boardRevision: 0,
		projectName: basename(cwd) || cwd,
		updatedAt: now(),
		nodes: [],
		edges: [],
		proposals: [],
	};
}

export function getBoardPaths(cwd: string): BoardPaths {
	const directory = join(cwd, CONFIG_DIR_NAME, "visual-planner");
	return {
		directory,
		json: join(directory, "board.json"),
		markdown: join(directory, "board.md"),
	};
}

function cloneDocument(document: PlannerDocument): PlannerDocument {
	return structuredClone(document);
}

function pruneProposals(proposals: PlannerProposal[]): PlannerProposal[] {
	if (proposals.length <= MAX_PROPOSALS) return proposals;
	const pending = proposals.filter((proposal) => proposal.status === "pending");
	const resolved = proposals.filter(
		(proposal) => proposal.status !== "pending",
	);
	return [
		...resolved.slice(
			Math.max(0, resolved.length - (MAX_PROPOSALS - pending.length)),
		),
		...pending,
	].slice(-MAX_PROPOSALS);
}

function markPendingProposalsStale(
	document: PlannerDocument,
	exceptId?: string,
): void {
	const decidedAt = now();
	for (const proposal of document.proposals) {
		if (proposal.status === "pending" && proposal.id !== exceptId) {
			proposal.status = "stale";
			proposal.decidedAt = decidedAt;
		}
	}
}

export function applyOperations(
	document: PlannerDocument,
	rawOperations: unknown[],
): PlannerDocument {
	if (rawOperations.length === 0 || rawOperations.length > MAX_OPERATIONS) {
		throw new Error(
			`A change batch must contain 1-${MAX_OPERATIONS} operations.`,
		);
	}
	const operations = rawOperations.map((operation, index) =>
		parseOperation(operation, `operations[${index}]`),
	);
	const next = cloneDocument(document);

	for (const operation of operations) {
		const nodeIndex = next.nodes.findIndex((node) => node.id === operation.id);
		const edgeIndex = next.edges.findIndex((edge) => edge.id === operation.id);
		const changedAt = now();

		switch (operation.type) {
			case "add_node": {
				if (nodeIndex !== -1 || edgeIndex !== -1)
					throw new Error(`Id already exists: ${operation.id}.`);
				if (operation.title === undefined)
					throw new Error(`add_node requires a title for ${operation.id}.`);
				next.nodes.push({
					id: operation.id,
					title: operation.title,
					body: operation.body ?? "",
					kind: operation.kind ?? "idea",
					status: operation.status ?? "none",
					x: operation.x ?? next.nodes.length * 40,
					y: operation.y ?? next.nodes.length * 30,
					createdAt: changedAt,
					updatedAt: changedAt,
				});
				break;
			}
			case "update_node": {
				if (nodeIndex === -1)
					throw new Error(`Node does not exist: ${operation.id}.`);
				const current = next.nodes[nodeIndex];
				next.nodes[nodeIndex] = {
					...current,
					...(operation.title === undefined ? {} : { title: operation.title }),
					...(operation.body === undefined ? {} : { body: operation.body }),
					...(operation.kind === undefined ? {} : { kind: operation.kind }),
					...(operation.status === undefined
						? {}
						: { status: operation.status }),
					updatedAt: changedAt,
				};
				break;
			}
			case "move_node": {
				if (nodeIndex === -1)
					throw new Error(`Node does not exist: ${operation.id}.`);
				if (operation.x === undefined || operation.y === undefined)
					throw new Error(`move_node requires x and y for ${operation.id}.`);
				next.nodes[nodeIndex] = {
					...next.nodes[nodeIndex],
					x: operation.x,
					y: operation.y,
					updatedAt: changedAt,
				};
				break;
			}
			case "remove_node":
				if (nodeIndex === -1)
					throw new Error(`Node does not exist: ${operation.id}.`);
				next.nodes.splice(nodeIndex, 1);
				next.edges = next.edges.filter(
					(edge) =>
						edge.source !== operation.id && edge.target !== operation.id,
				);
				break;
			case "add_edge":
				if (nodeIndex !== -1 || edgeIndex !== -1)
					throw new Error(`Id already exists: ${operation.id}.`);
				if (operation.source === undefined || operation.target === undefined)
					throw new Error(
						`add_edge requires source and target for ${operation.id}.`,
					);
				if (
					!next.nodes.some((node) => node.id === operation.source) ||
					!next.nodes.some((node) => node.id === operation.target)
				) {
					throw new Error(
						`Edge ${operation.id} references a node that does not exist.`,
					);
				}
				next.edges.push({
					id: operation.id,
					source: operation.source,
					target: operation.target,
					label: operation.label ?? "",
				});
				break;
			case "update_edge":
				if (edgeIndex === -1)
					throw new Error(`Edge does not exist: ${operation.id}.`);
				if (operation.label === undefined)
					throw new Error(`update_edge requires a label for ${operation.id}.`);
				next.edges[edgeIndex] = {
					...next.edges[edgeIndex],
					label: operation.label,
				};
				break;
			case "remove_edge":
				if (edgeIndex === -1)
					throw new Error(`Edge does not exist: ${operation.id}.`);
				next.edges.splice(edgeIndex, 1);
				break;
		}
	}

	validateBoard(next.nodes, next.edges);
	return next;
}

function markdownText(value: string): string {
	return value
		.replace(/\r?\n/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[<>]/g, "");
}

export function renderPlannerMarkdown(document: PlannerDocument): string {
	const statusMark: Record<NodeStatus, string> = {
		none: "-",
		open: "[ ]",
		in_progress: "[~]",
		blocked: "[!]",
		done: "[x]",
	};
	const lines = [
		"# Visual planner",
		"",
		`Project: ${markdownText(document.projectName)}`,
		`Board revision: ${document.boardRevision}`,
		`Updated: ${document.updatedAt}`,
		"",
		"## Nodes",
		"",
	];

	if (document.nodes.length === 0) lines.push("- No nodes yet.");
	for (const node of document.nodes) {
		lines.push(
			`- ${statusMark[node.status]} **${markdownText(node.title)}** \`${node.id}\` (${node.kind})`,
		);
		if (node.body) lines.push(`  - ${markdownText(node.body)}`);
	}

	lines.push("", "## Connections", "");
	if (document.edges.length === 0) lines.push("- No connections yet.");
	for (const edge of document.edges) {
		lines.push(
			`- \`${edge.source}\` → \`${edge.target}\`${edge.label ? ` — ${markdownText(edge.label)}` : ""}`,
		);
	}

	const pending = document.proposals.filter(
		(proposal) => proposal.status === "pending",
	);
	lines.push("", "## Pending Pi proposals", "");
	if (pending.length === 0) lines.push("- None.");
	for (const proposal of pending) {
		lines.push(
			`- **${markdownText(proposal.summary)}** \`${proposal.id}\` (${proposal.operations.length} changes, based on revision ${proposal.baseRevision})`,
		);
	}
	lines.push("");
	return lines.join("\n");
}

export class PlannerStore {
	readonly paths: BoardPaths;

	constructor(readonly cwd: string) {
		this.paths = getBoardPaths(cwd);
	}

	private async readFromDisk(): Promise<PlannerDocument | undefined> {
		try {
			const raw = await readFile(this.paths.json);
			if (raw.byteLength > MAX_JSON_BYTES)
				throw new Error(
					`Planner file exceeds the ${MAX_JSON_BYTES}-byte limit.`,
				);
			return parsePlannerDocument(JSON.parse(raw.toString("utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			if (error instanceof SyntaxError)
				throw new Error(`Could not parse ${this.paths.json}: ${error.message}`);
			throw error;
		}
	}

	private async writeToDisk(document: PlannerDocument): Promise<void> {
		const serialized = `${JSON.stringify(document, null, 2)}\n`;
		if (Buffer.byteLength(serialized, "utf8") > MAX_JSON_BYTES) {
			throw new Error(`Planner data exceeds the ${MAX_JSON_BYTES}-byte limit.`);
		}
		await mkdir(this.paths.directory, { recursive: true });
		const suffix = `${process.pid}-${randomUUID()}`;
		const jsonTemp = `${this.paths.json}.${suffix}.tmp`;
		const markdownTemp = `${this.paths.markdown}.${suffix}.tmp`;
		try {
			await writeFile(jsonTemp, serialized, "utf8");
			await writeFile(markdownTemp, renderPlannerMarkdown(document), "utf8");
			await rename(markdownTemp, this.paths.markdown);
			await rename(jsonTemp, this.paths.json);
		} finally {
			await Promise.all([
				unlink(jsonTemp).catch(() => {}),
				unlink(markdownTemp).catch(() => {}),
			]);
		}
	}

	private async mutate(
		mutator: (document: PlannerDocument) => PlannerDocument | undefined,
	): Promise<PlannerDocument> {
		return withFileMutationQueue(this.paths.json, async () => {
			const current =
				(await this.readFromDisk()) ?? createPlannerDocument(this.cwd);
			const next = mutator(cloneDocument(current)) ?? current;
			next.updatedAt = now();
			next.proposals = pruneProposals(next.proposals);
			const validated = parsePlannerDocument(next);
			await this.writeToDisk(validated);
			return validated;
		});
	}

	async ensure(): Promise<PlannerDocument> {
		const current = await this.readFromDisk();
		if (current) return current;
		return this.mutate((document) => document);
	}

	async read(): Promise<PlannerDocument> {
		return (await this.readFromDisk()) ?? this.ensure();
	}

	async applyUserOperations(
		baseRevision: number,
		operations: unknown[],
	): Promise<PlannerDocument> {
		requireRevision(baseRevision, "baseRevision");
		return this.mutate((document) => {
			if (document.boardRevision !== baseRevision)
				throw new Error(
					`Board changed from revision ${baseRevision} to ${document.boardRevision}; refresh and try again.`,
				);
			const next = applyOperations(document, operations);
			next.boardRevision += 1;
			markPendingProposalsStale(next);
			return next;
		});
	}

	async replaceBoard(
		baseRevision: number,
		rawNodes: unknown[],
		rawEdges: unknown[],
	): Promise<PlannerDocument> {
		requireRevision(baseRevision, "baseRevision");
		return this.mutate((document) => {
			if (document.boardRevision !== baseRevision)
				throw new Error(
					`Board changed from revision ${baseRevision} to ${document.boardRevision}; refresh and try again.`,
				);
			const nodes = rawNodes.map((node, index) =>
				parseNode(node, `nodes[${index}]`),
			);
			const edges = rawEdges.map((edge, index) =>
				parseEdge(edge, `edges[${index}]`),
			);
			validateBoard(nodes, edges);
			document.nodes = nodes;
			document.edges = edges;
			document.boardRevision += 1;
			markPendingProposalsStale(document);
			return document;
		});
	}

	async addProposal(
		summaryValue: unknown,
		baseRevision: number,
		operations: unknown[],
	): Promise<{ document: PlannerDocument; proposal: PlannerProposal }> {
		const summary = requireString(summaryValue, "summary", 1_000);
		requireRevision(baseRevision, "baseRevision");
		const parsedOperations = operations.map((operation, index) =>
			parseOperation(operation, `operations[${index}]`),
		);
		if (
			parsedOperations.length === 0 ||
			parsedOperations.length > MAX_OPERATIONS
		) {
			throw new Error(
				`A proposal must contain 1-${MAX_OPERATIONS} operations.`,
			);
		}
		let createdProposal: PlannerProposal | undefined;
		const document = await this.mutate((current) => {
			if (current.boardRevision !== baseRevision) {
				throw new Error(
					`Board changed from revision ${baseRevision} to ${current.boardRevision}; read it again before proposing changes.`,
				);
			}
			// Validate the complete batch without changing the canonical board.
			applyOperations(current, parsedOperations);
			const proposal: PlannerProposal = {
				id: `proposal-${randomUUID()}`,
				summary,
				baseRevision,
				operations: parsedOperations,
				status: "pending",
				createdAt: now(),
			};
			createdProposal = proposal;
			current.proposals.push(proposal);
			return current;
		});
		if (!createdProposal)
			throw new Error("Proposal creation did not complete.");
		return { document, proposal: createdProposal };
	}

	async acceptProposal(proposalIdValue: unknown): Promise<PlannerDocument> {
		const proposalId = requireId(proposalIdValue, "proposalId");
		return this.mutate((document) => {
			const proposal = document.proposals.find(
				(item) => item.id === proposalId,
			);
			if (!proposal) throw new Error(`Proposal does not exist: ${proposalId}.`);
			if (proposal.status !== "pending")
				throw new Error(
					`Proposal ${proposalId} is ${proposal.status}, not pending.`,
				);
			if (document.boardRevision !== proposal.baseRevision) {
				proposal.status = "stale";
				proposal.decidedAt = now();
				return document;
			}
			const next = applyOperations(document, proposal.operations);
			next.boardRevision += 1;
			const accepted = next.proposals.find((item) => item.id === proposalId);
			if (!accepted)
				throw new Error(`Proposal disappeared while applying: ${proposalId}.`);
			accepted.status = "accepted";
			accepted.decidedAt = now();
			markPendingProposalsStale(next, proposalId);
			return next;
		});
	}

	async rejectProposal(proposalIdValue: unknown): Promise<PlannerDocument> {
		const proposalId = requireId(proposalIdValue, "proposalId");
		return this.mutate((document) => {
			const proposal = document.proposals.find(
				(item) => item.id === proposalId,
			);
			if (!proposal) throw new Error(`Proposal does not exist: ${proposalId}.`);
			if (proposal.status !== "pending")
				throw new Error(
					`Proposal ${proposalId} is ${proposal.status}, not pending.`,
				);
			proposal.status = "rejected";
			proposal.decidedAt = now();
			return document;
		});
	}
}
