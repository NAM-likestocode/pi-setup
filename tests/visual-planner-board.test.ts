import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyOperations,
	createPlannerDocument,
	getBoardPaths,
	PlannerStore,
	parseOperation,
	renderPlannerMarkdown,
} from "../extensions/visual-planner/board-store.ts";

const temporaryDirectories: string[] = [];

async function createStore(): Promise<PlannerStore> {
	const directory = await mkdtemp(join(tmpdir(), "pi-visual-planner-"));
	temporaryDirectories.push(directory);
	return new PlannerStore(directory);
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("visual planner board store", () => {
	it("creates a versioned project board and readable Markdown", async () => {
		const store = await createStore();
		const document = await store.ensure();

		expect(document.schemaVersion).toBe(1);
		expect(document.boardRevision).toBe(0);
		expect(document.nodes).toEqual([]);
		expect(getBoardPaths(store.cwd)).toEqual(store.paths);
		expect(await readFile(store.paths.json, "utf8")).toContain(
			'"schemaVersion": 1',
		);
		expect(await readFile(store.paths.markdown, "utf8")).toContain(
			"# Visual planner",
		);
	});

	it("applies validated node and edge operations", () => {
		const initial = createPlannerDocument("/tmp/example");
		const next = applyOperations(initial, [
			{
				type: "add_node",
				id: "goal",
				title: "Ship the planner",
				kind: "goal",
				x: 10,
				y: 20,
			},
			{
				type: "add_node",
				id: "task-ui",
				title: "Build the canvas",
				kind: "task",
				status: "open",
				x: 200,
				y: 20,
			},
			{
				type: "add_edge",
				id: "goal-to-ui",
				source: "goal",
				target: "task-ui",
				label: "requires",
			},
			{ type: "update_node", id: "task-ui", status: "done", body: "Validated" },
			{ type: "move_node", id: "goal", x: 30, y: 40 },
		]);

		expect(next.nodes).toHaveLength(2);
		expect(next.nodes.find((node) => node.id === "goal")).toMatchObject({
			x: 30,
			y: 40,
		});
		expect(next.nodes.find((node) => node.id === "task-ui")).toMatchObject({
			status: "done",
			body: "Validated",
		});
		expect(next.edges).toEqual([
			{
				id: "goal-to-ui",
				source: "goal",
				target: "task-ui",
				label: "requires",
			},
		]);
		expect(renderPlannerMarkdown(next)).toContain("`goal` → `task-ui`");
	});

	it("keeps Pi proposals review-only until accepted", async () => {
		const store = await createStore();
		await store.ensure();
		const { document: proposed, proposal } = await store.addProposal(
			"Add the main goal",
			0,
			[
				{
					type: "add_node",
					id: "main-goal",
					title: "Create together",
					kind: "goal",
					x: 0,
					y: 0,
				},
			],
		);

		expect(proposed.boardRevision).toBe(0);
		expect(proposed.nodes).toEqual([]);
		expect(proposal.status).toBe("pending");

		const accepted = await store.acceptProposal(proposal.id);
		expect(accepted.boardRevision).toBe(1);
		expect(accepted.nodes.map((node) => node.id)).toEqual(["main-goal"]);
		expect(
			accepted.proposals.find((item) => item.id === proposal.id)?.status,
		).toBe("accepted");
	});

	it("marks pending proposals stale when the user changes the board", async () => {
		const store = await createStore();
		await store.ensure();
		const { proposal } = await store.addProposal("Pi idea", 0, [
			{ type: "add_node", id: "pi-idea", title: "Pi idea", kind: "idea" },
		]);

		const changed = await store.applyUserOperations(0, [
			{ type: "add_node", id: "user-idea", title: "User idea", kind: "idea" },
		]);

		expect(changed.boardRevision).toBe(1);
		expect(
			changed.proposals.find((item) => item.id === proposal.id)?.status,
		).toBe("stale");
		await expect(store.acceptProposal(proposal.id)).rejects.toThrow("is stale");
	});

	it("rejects stale revisions and invalid references without changing the board", async () => {
		const store = await createStore();
		await store.ensure();

		await expect(
			store.applyUserOperations(0, [
				{ type: "add_edge", id: "missing", source: "one", target: "two" },
			]),
		).rejects.toThrow("does not exist");

		await store.applyUserOperations(0, [
			{ type: "add_node", id: "one", title: "One" },
		]);
		await expect(
			store.applyUserOperations(0, [
				{ type: "add_node", id: "two", title: "Two" },
			]),
		).rejects.toThrow("revision 0 to 1");
		expect((await store.read()).nodes.map((node) => node.id)).toEqual(["one"]);
	});

	it("validates operation-specific required fields", () => {
		expect(() =>
			parseOperation({ type: "move_node", id: "node", x: 1 }),
		).toThrow("x and operation.y are required");
		expect(() => parseOperation({ type: "update_node", id: "node" })).toThrow(
			"field to update",
		);
		expect(() =>
			parseOperation({ type: "add_node", id: "bad id", title: "No" }),
		).toThrow("unsupported characters");
	});
});
