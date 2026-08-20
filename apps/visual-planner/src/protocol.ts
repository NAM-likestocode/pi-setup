export type NodeKind =
	| "goal"
	| "idea"
	| "question"
	| "decision"
	| "task"
	| "file";
export type NodeStatus = "none" | "open" | "in_progress" | "blocked" | "done";

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
	type:
		| "add_node"
		| "update_node"
		| "move_node"
		| "remove_node"
		| "add_edge"
		| "update_edge"
		| "remove_edge";
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

export type PlannerProposal = {
	id: string;
	summary: string;
	baseRevision: number;
	operations: PlannerOperation[];
	status: "pending" | "accepted" | "rejected" | "stale";
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

export type ClientMessage =
	| { type: "request_snapshot" }
	| {
			type: "apply_user_operations";
			baseRevision: number;
			operations: PlannerOperation[];
	  }
	| {
			type: "replace_board";
			baseRevision: number;
			nodes: PlannerNode[];
			edges: PlannerEdge[];
	  }
	| { type: "accept_proposal"; proposalId: string }
	| { type: "reject_proposal"; proposalId: string };

export type ServerMessage =
	| { type: "snapshot"; document: PlannerDocument }
	| { type: "error"; message: string };
