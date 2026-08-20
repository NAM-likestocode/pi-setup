import {
	Background,
	BackgroundVariant,
	type Connection,
	Controls,
	type Edge,
	Handle,
	MarkerType,
	MiniMap,
	type Node,
	type NodeProps,
	Panel,
	Position,
	ReactFlow,
	type ReactFlowInstance,
	ReactFlowProvider,
	useEdgesState,
	useNodesState,
} from "@xyflow/react";
import {
	StrictMode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import type {
	ClientMessage,
	NodeKind,
	NodeStatus,
	PlannerDocument,
	PlannerEdge,
	PlannerNode,
	PlannerOperation,
	PlannerProposal,
	ServerMessage,
} from "./protocol";

const NODE_KINDS: NodeKind[] = [
	"goal",
	"idea",
	"question",
	"decision",
	"task",
	"file",
];
const NODE_STATUSES: NodeStatus[] = [
	"none",
	"open",
	"in_progress",
	"blocked",
	"done",
];
const KIND_LABELS: Record<NodeKind, string> = {
	goal: "Goal",
	idea: "Idea",
	question: "Question",
	decision: "Decision",
	task: "Task",
	file: "File",
};
const STATUS_LABELS: Record<NodeStatus, string> = {
	none: "No status",
	open: "Open",
	in_progress: "In progress",
	blocked: "Blocked",
	done: "Done",
};

type FlowNodeData = Record<string, unknown> & { planner: PlannerNode };
type PlannerFlowNode = Node<FlowNodeData, "planner">;
type PlannerFlowEdge = Edge;
type BoardSnapshot = { nodes: PlannerNode[]; edges: PlannerEdge[] };

function PlannerCard({ data, selected }: NodeProps<PlannerFlowNode>) {
	const node = data.planner;
	return (
		<article
			className={`planner-card kind-${node.kind} status-${node.status}${selected ? " selected" : ""}`}
		>
			<Handle className="node-handle" type="target" position={Position.Left} />
			<div className="planner-card-heading">
				<span className="kind-chip">{KIND_LABELS[node.kind]}</span>
				{node.status !== "none" && (
					<span className="status-chip">{STATUS_LABELS[node.status]}</span>
				)}
			</div>
			<strong>{node.title}</strong>
			{node.body && <p>{node.body}</p>}
			<Handle className="node-handle" type="source" position={Position.Right} />
		</article>
	);
}

const NODE_TYPES = { planner: PlannerCard };

function NodeInspector({
	node,
	disabled,
	onSave,
	onDelete,
}: {
	node: PlannerNode;
	disabled: boolean;
	onSave: (operation: PlannerOperation) => void;
	onDelete: () => void;
}) {
	const [title, setTitle] = useState(node.title);
	const [body, setBody] = useState(node.body);
	const [kind, setKind] = useState(node.kind);
	const [status, setStatus] = useState(node.status);

	return (
		<section className="inspector-section">
			<div className="section-heading">
				<h2>Edit card</h2>
				<code>{node.id}</code>
			</div>
			<label>
				Title
				<input
					value={title}
					maxLength={160}
					onChange={(event) => setTitle(event.target.value)}
				/>
			</label>
			<label>
				Notes
				<textarea
					value={body}
					maxLength={5000}
					rows={7}
					onChange={(event) => setBody(event.target.value)}
				/>
			</label>
			<div className="field-row">
				<label>
					Type
					<select
						value={kind}
						onChange={(event) => setKind(event.target.value as NodeKind)}
					>
						{NODE_KINDS.map((item) => (
							<option key={item} value={item}>
								{KIND_LABELS[item]}
							</option>
						))}
					</select>
				</label>
				<label>
					Status
					<select
						value={status}
						onChange={(event) => setStatus(event.target.value as NodeStatus)}
					>
						{NODE_STATUSES.map((item) => (
							<option key={item} value={item}>
								{STATUS_LABELS[item]}
							</option>
						))}
					</select>
				</label>
			</div>
			<div className="button-row">
				<button
					type="button"
					className="primary"
					disabled={disabled || !title.trim()}
					onClick={() =>
						onSave({
							type: "update_node",
							id: node.id,
							title: title.trim(),
							body,
							kind,
							status,
						})
					}
				>
					Save
				</button>
				<button
					type="button"
					className="danger"
					disabled={disabled}
					onClick={onDelete}
				>
					Delete
				</button>
			</div>
		</section>
	);
}

function EdgeInspector({
	edge,
	disabled,
	onSave,
	onDelete,
}: {
	edge: PlannerEdge;
	disabled: boolean;
	onSave: (operation: PlannerOperation) => void;
	onDelete: () => void;
}) {
	const [label, setLabel] = useState(edge.label);
	return (
		<section className="inspector-section">
			<div className="section-heading">
				<h2>Edit connection</h2>
				<code>{edge.id}</code>
			</div>
			<p className="edge-path">
				<code>{edge.source}</code> → <code>{edge.target}</code>
			</p>
			<label>
				Label
				<input
					value={label}
					maxLength={120}
					onChange={(event) => setLabel(event.target.value)}
				/>
			</label>
			<div className="button-row">
				<button
					type="button"
					className="primary"
					disabled={disabled}
					onClick={() => onSave({ type: "update_edge", id: edge.id, label })}
				>
					Save
				</button>
				<button
					type="button"
					className="danger"
					disabled={disabled}
					onClick={onDelete}
				>
					Delete
				</button>
			</div>
		</section>
	);
}

function ProposalCard({
	proposal,
	disabled,
	onAccept,
	onReject,
}: {
	proposal: PlannerProposal;
	disabled: boolean;
	onAccept: () => void;
	onReject: () => void;
}) {
	const [expanded, setExpanded] = useState(false);
	return (
		<article className="proposal-card">
			<div className="proposal-title">
				<span>Pi proposal</span>
				<small>{proposal.operations.length} changes</small>
			</div>
			<p>{proposal.summary}</p>
			<button
				type="button"
				className="text-button"
				onClick={() => setExpanded((value) => !value)}
			>
				{expanded ? "Hide changes" : "Preview changes"}
			</button>
			{expanded && (
				<ol className="operation-list">
					{proposal.operations.map((operation) => (
						<li key={JSON.stringify(operation)}>
							<code>{operation.type}</code> {operation.id}
							{operation.title ? ` — ${operation.title}` : ""}
						</li>
					))}
				</ol>
			)}
			<div className="button-row">
				<button
					type="button"
					className="primary"
					disabled={disabled}
					onClick={onAccept}
				>
					Accept batch
				</button>
				<button type="button" disabled={disabled} onClick={onReject}>
					Reject
				</button>
			</div>
		</article>
	);
}

function VisualPlanner() {
	const [document, setDocument] = useState<PlannerDocument>();
	const [nodes, setNodes, onNodesChange] = useNodesState<PlannerFlowNode>([]);
	const [edges, setEdges, onEdgesChange] = useEdgesState<PlannerFlowEdge>([]);
	const [connected, setConnected] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [notice, setNotice] = useState(
		"Connect cards by dragging from one side handle to another.",
	);
	const [selectedNodeId, setSelectedNodeId] = useState<string>();
	const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
	const [newKind, setNewKind] = useState<NodeKind>("idea");
	const [, setHistoryVersion] = useState(0);
	const socketRef = useRef<WebSocket | undefined>(undefined);
	const documentRef = useRef<PlannerDocument | undefined>(undefined);
	const undoRef = useRef<BoardSnapshot[]>([]);
	const redoRef = useRef<BoardSnapshot[]>([]);
	const flowRef = useRef<
		ReactFlowInstance<PlannerFlowNode, PlannerFlowEdge> | undefined
	>(undefined);
	const canvasRef = useRef<HTMLDivElement>(null);

	const applySnapshot = useCallback(
		(next: PlannerDocument) => {
			documentRef.current = next;
			setDocument(next);
			setNodes(
				next.nodes.map((node) => ({
					id: node.id,
					type: "planner",
					position: { x: node.x, y: node.y },
					data: { planner: node },
				})),
			);
			setEdges(
				next.edges.map((edge) => ({
					id: edge.id,
					source: edge.source,
					target: edge.target,
					label: edge.label,
					markerEnd: { type: MarkerType.ArrowClosed },
					className: "planner-edge",
				})),
			);
			setBusy(false);
			setError(undefined);
		},
		[setEdges, setNodes],
	);

	useEffect(() => {
		let reconnectTimer: number | undefined;
		let stopped = false;
		const connect = () => {
			const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
			const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
			socketRef.current = socket;
			socket.addEventListener("open", () => {
				setConnected(true);
				setNotice("Canvas connected to Pi.");
			});
			socket.addEventListener("message", (event) => {
				try {
					const message = JSON.parse(String(event.data)) as ServerMessage;
					if (message.type === "snapshot") applySnapshot(message.document);
					else {
						setError(message.message);
						setBusy(false);
						undoRef.current = [];
						redoRef.current = [];
						setHistoryVersion((value) => value + 1);
					}
				} catch {
					setError("The planner received an invalid server message.");
					setBusy(false);
				}
			});
			socket.addEventListener("close", () => {
				setConnected(false);
				setBusy(false);
				if (!stopped) reconnectTimer = window.setTimeout(connect, 1200);
			});
			socket.addEventListener("error", () =>
				setError("Connection to Pi was interrupted."),
			);
		};
		connect();
		return () => {
			stopped = true;
			if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
			socketRef.current?.close();
		};
	}, [applySnapshot]);

	const currentSnapshot = useCallback((): BoardSnapshot | undefined => {
		const current = documentRef.current;
		return current
			? {
					nodes: structuredClone(current.nodes),
					edges: structuredClone(current.edges),
				}
			: undefined;
	}, []);

	const send = useCallback(
		(message: ClientMessage, recordHistory = false) => {
			const socket = socketRef.current;
			if (!socket || socket.readyState !== WebSocket.OPEN) {
				setError("Canvas is not connected to Pi.");
				return;
			}
			if (recordHistory) {
				const snapshot = currentSnapshot();
				if (snapshot) {
					undoRef.current.push(snapshot);
					if (undoRef.current.length > 50) undoRef.current.shift();
					redoRef.current = [];
					setHistoryVersion((value) => value + 1);
				}
			}
			setBusy(true);
			setError(undefined);
			socket.send(JSON.stringify(message));
		},
		[currentSnapshot],
	);

	const mutate = useCallback(
		(operations: PlannerOperation[], recordHistory = true) => {
			const current = documentRef.current;
			if (!current) return;
			send(
				{
					type: "apply_user_operations",
					baseRevision: current.boardRevision,
					operations,
				},
				recordHistory,
			);
		},
		[send],
	);

	const addNode = useCallback(() => {
		const current = documentRef.current;
		if (!current) return;
		const bounds = canvasRef.current?.getBoundingClientRect();
		const point =
			bounds && flowRef.current
				? flowRef.current.screenToFlowPosition({
						x: bounds.left + bounds.width / 2,
						y: bounds.top + bounds.height / 2,
					})
				: { x: current.nodes.length * 40, y: current.nodes.length * 30 };
		mutate([
			{
				type: "add_node",
				id: `${newKind}-${crypto.randomUUID()}`,
				title: `New ${KIND_LABELS[newKind].toLowerCase()}`,
				kind: newKind,
				status: newKind === "task" ? "open" : "none",
				x: point.x,
				y: point.y,
			},
		]);
	}, [mutate, newKind]);

	const connectNodes = useCallback(
		(connection: Connection) => {
			if (
				!connection.source ||
				!connection.target ||
				connection.source === connection.target
			)
				return;
			mutate([
				{
					type: "add_edge",
					id: `edge-${crypto.randomUUID()}`,
					source: connection.source,
					target: connection.target,
					label: "",
				},
			]);
		},
		[mutate],
	);

	const undo = useCallback(() => {
		const target = undoRef.current.pop();
		const current = documentRef.current;
		if (!target || !current) return;
		redoRef.current.push({
			nodes: structuredClone(current.nodes),
			edges: structuredClone(current.edges),
		});
		setHistoryVersion((value) => value + 1);
		send({
			type: "replace_board",
			baseRevision: current.boardRevision,
			nodes: target.nodes,
			edges: target.edges,
		});
	}, [send]);

	const redo = useCallback(() => {
		const target = redoRef.current.pop();
		const current = documentRef.current;
		if (!target || !current) return;
		undoRef.current.push({
			nodes: structuredClone(current.nodes),
			edges: structuredClone(current.edges),
		});
		setHistoryVersion((value) => value + 1);
		send({
			type: "replace_board",
			baseRevision: current.boardRevision,
			nodes: target.nodes,
			edges: target.edges,
		});
	}, [send]);

	const selectedNode = document?.nodes.find(
		(node) => node.id === selectedNodeId,
	);
	const selectedEdge = document?.edges.find(
		(edge) => edge.id === selectedEdgeId,
	);
	const pendingProposals = useMemo(
		() =>
			document?.proposals.filter((proposal) => proposal.status === "pending") ??
			[],
		[document],
	);

	if (!document) {
		return (
			<main className="loading-screen">
				<div className="loading-mark">◇</div>
				<h1>Pi Visual Planner</h1>
				<p>{error ?? "Connecting to the local Pi session…"}</p>
			</main>
		);
	}

	return (
		<main className="app-shell">
			<header className="topbar">
				<div>
					<span className="brand-mark">◇</span>
					<div>
						<h1>{document.projectName}</h1>
						<p>Visual planner · revision {document.boardRevision}</p>
					</div>
				</div>
				<div className="connection-status">
					<span className={connected ? "online" : "offline"} />
					{connected ? "Connected to Pi" : "Reconnecting"}
				</div>
			</header>

			<div className="workspace">
				<div className="canvas-wrap" ref={canvasRef}>
					<ReactFlow<PlannerFlowNode, PlannerFlowEdge>
						nodes={nodes}
						edges={edges}
						nodeTypes={NODE_TYPES}
						onNodesChange={onNodesChange}
						onEdgesChange={onEdgesChange}
						onConnect={connectNodes}
						onInit={(instance) => {
							flowRef.current = instance;
						}}
						onNodeDragStop={(_event, node) =>
							mutate([
								{
									type: "move_node",
									id: node.id,
									x: node.position.x,
									y: node.position.y,
								},
							])
						}
						onSelectionChange={({
							nodes: selectedNodes,
							edges: selectedEdges,
						}) => {
							setSelectedNodeId(selectedNodes[0]?.id);
							setSelectedEdgeId(
								selectedNodes.length === 0 ? selectedEdges[0]?.id : undefined,
							);
						}}
						fitView
						fitViewOptions={{ padding: 0.25 }}
						minZoom={0.15}
						maxZoom={2.5}
						deleteKeyCode={null}
						proOptions={{ hideAttribution: true }}
						nodesDraggable={!busy}
						nodesConnectable={!busy}
						elementsSelectable
					>
						<Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
						<Controls showInteractive={false} />
						<MiniMap pannable zoomable nodeStrokeWidth={3} />
						<Panel position="top-left" className="canvas-toolbar">
							<select
								aria-label="New card type"
								value={newKind}
								onChange={(event) => setNewKind(event.target.value as NodeKind)}
							>
								{NODE_KINDS.map((kind) => (
									<option key={kind} value={kind}>
										{KIND_LABELS[kind]}
									</option>
								))}
							</select>
							<button
								type="button"
								className="primary"
								disabled={busy || !connected}
								onClick={addNode}
							>
								+ Add card
							</button>
							<span className="toolbar-separator" />
							<button
								type="button"
								disabled={busy || undoRef.current.length === 0}
								onClick={undo}
							>
								Undo
							</button>
							<button
								type="button"
								disabled={busy || redoRef.current.length === 0}
								onClick={redo}
							>
								Redo
							</button>
						</Panel>
						{document.nodes.length === 0 && (
							<Panel position="top-center" className="empty-hint">
								<strong>Start with a goal or idea</strong>
								<span>
									Add cards here, then connect them into a plan or mind map.
								</span>
							</Panel>
						)}
					</ReactFlow>
				</div>

				<aside className="sidebar">
					<section className="proposal-section">
						<div className="section-heading">
							<h2>Review Pi changes</h2>
							{pendingProposals.length > 0 && (
								<span className="count-badge">{pendingProposals.length}</span>
							)}
						</div>
						{pendingProposals.length === 0 ? (
							<p className="muted">
								Pi’s suggestions will appear here as reviewable batches. Nothing
								is applied automatically.
							</p>
						) : (
							pendingProposals.map((proposal) => (
								<ProposalCard
									key={proposal.id}
									proposal={proposal}
									disabled={busy}
									onAccept={() => {
										const current = documentRef.current;
										if (!current) return;
										send(
											{ type: "accept_proposal", proposalId: proposal.id },
											true,
										);
										setNotice("Accepting Pi proposal…");
									}}
									onReject={() =>
										send({ type: "reject_proposal", proposalId: proposal.id })
									}
								/>
							))
						)}
					</section>

					{selectedNode ? (
						<NodeInspector
							key={`${selectedNode.id}-${selectedNode.updatedAt}`}
							node={selectedNode}
							disabled={busy}
							onSave={(operation) => mutate([operation])}
							onDelete={() => {
								mutate([{ type: "remove_node", id: selectedNode.id }]);
								setSelectedNodeId(undefined);
							}}
						/>
					) : selectedEdge ? (
						<EdgeInspector
							key={`${selectedEdge.id}-${selectedEdge.label}`}
							edge={selectedEdge}
							disabled={busy}
							onSave={(operation) => mutate([operation])}
							onDelete={() => {
								mutate([{ type: "remove_edge", id: selectedEdge.id }]);
								setSelectedEdgeId(undefined);
							}}
						/>
					) : (
						<section className="inspector-section">
							<h2>Card details</h2>
							<p className="muted">
								Select a card or connection to edit it. Drag cards to arrange
								the board.
							</p>
						</section>
					)}

					<section className="help-section">
						<h2>Working with Pi</h2>
						<ol>
							<li>
								Open this board with <code>/canvas</code>.
							</li>
							<li>Ask Pi to read the visual planner.</li>
							<li>Review and accept or reject Pi’s proposed batch here.</li>
						</ol>
					</section>
				</aside>
			</div>

			<footer className="statusbar">
				<span>{busy ? "Saving…" : notice}</span>
				{error && <strong>{error}</strong>}
				<span>
					{document.nodes.length} cards · {document.edges.length} links
				</span>
			</footer>
		</main>
	);
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Visual planner root element is missing.");
createRoot(rootElement).render(
	<StrictMode>
		<ReactFlowProvider>
			<VisualPlanner />
		</ReactFlowProvider>
	</StrictMode>,
);
