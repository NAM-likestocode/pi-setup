import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const START = "<!-- pi-memory:start -->";
const END = "<!-- pi-memory:end -->";
const HEADING = "## Remembered notes";
export const MAX_MEMORY_CHARS = 500;
export const MAX_MEMORIES_PER_SCOPE = 40;
export const MAX_MEMORY_CONTEXT_CHARS = 8_000;

type Scope = "project" | "global";

type MemoryFile = {
	path: string;
	scope: Scope;
};

export function normalizeMemory(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function validateMemoryAddition(memories: string[], memory: string): string | undefined {
	if (memory.length > MAX_MEMORY_CHARS) return `Memory is too long (${memory.length}/${MAX_MEMORY_CHARS} characters).`;
	if (memories.length >= MAX_MEMORIES_PER_SCOPE) return `This scope already has ${MAX_MEMORIES_PER_SCOPE} memories. Forget one before adding another.`;
	const contextChars = [...memories, memory].reduce((total, item) => total + item.length, 0);
	if (contextChars > MAX_MEMORY_CONTEXT_CHARS) return `Remembered notes would exceed the ${MAX_MEMORY_CONTEXT_CHARS}-character context budget.`;
	return undefined;
}

function memoryFile(scope: Scope, cwd: string): MemoryFile {
	return {
		scope,
		path: scope === "global" ? join(homedir(), ".pi", "agent", "AGENTS.md") : join(cwd, "AGENTS.md"),
	};
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function readMemories(file: MemoryFile): Promise<string[]> {
	if (!(await exists(file.path))) return [];
	const content = await readFile(file.path, "utf8");
	const match = content.match(new RegExp(`${escapeRegExp(START)}\\r?\\n([\\s\\S]*?)\\r?\\n${escapeRegExp(END)}`));
	if (!match) return [];
	return match[1]
		.split(/\r?\n/)
		.map((line) => line.match(/^\s*-\s+(.+)\s*$/)?.[1]?.trim())
		.filter((memory): memory is string => Boolean(memory));
}

export function renderMemoryDocument(current: string, memories: string[]): string {
	const block = [START, HEADING, ...memories.map((memory) => `- ${memory}`), END].join("\n");
	const pattern = new RegExp(`${escapeRegExp(START)}[\\s\\S]*?${escapeRegExp(END)}`);
	return pattern.test(current)
		? current.replace(pattern, block)
		: `${current.trimEnd()}${current.trim() ? "\n\n" : ""}${block}\n`;
}

async function saveMemories(file: MemoryFile, memories: string[]): Promise<void> {
	const current = (await exists(file.path)) ? await readFile(file.path, "utf8") : "";
	const next = renderMemoryDocument(current, memories);
	const temporaryPath = `${file.path}.${process.pid}.${Date.now()}.tmp`;

	await mkdir(dirname(file.path), { recursive: true });
	try {
		await writeFile(temporaryPath, next, { encoding: "utf8", flag: "wx" });
		await rename(temporaryPath, file.path);
	} catch (error) {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseScope(args: string): { scope: Scope; value: string } {
	const trimmed = args.trim();
	if (trimmed === "global") return { scope: "global", value: "" };
	if (trimmed.startsWith("global ")) return { scope: "global", value: trimmed.slice("global ".length).trim() };
	return { scope: "project", value: trimmed };
}

function scopeLabel(scope: Scope): string {
	return scope === "global" ? "Global" : "Project";
}

async function reloadForCurrentSession(ctx: ExtensionCommandContext): Promise<void> {
	await ctx.reload();
}

export default function memoryExtension(pi: ExtensionAPI) {
	pi.registerCommand("remember", {
		description: "Remember a note for this project; use /remember global <note> for all projects",
		handler: async (args, ctx) => {
			const { scope, value } = parseScope(args);
			const memory = normalizeMemory(value);
			if (!memory) {
				ctx.ui.notify("Usage: /remember [global] <note>", "warning");
				return;
			}

			const file = memoryFile(scope, ctx.cwd);
			const memories = await readMemories(file);
			if (memories.includes(memory)) {
				ctx.ui.notify(`${scopeLabel(scope)} memory already exists.`, "info");
				return;
			}
			const validationError = validateMemoryAddition(memories, memory);
			if (validationError) {
				ctx.ui.notify(validationError, "warning");
				return;
			}

			memories.push(memory);
			await saveMemories(file, memories);
			ctx.ui.notify(`${scopeLabel(scope)} memory saved to ${file.path}. Reloading context…`, "info");
			await reloadForCurrentSession(ctx);
		},
	});

	pi.registerCommand("memories", {
		description: "List remembered project notes; use /memories global for global notes",
		handler: async (args, ctx) => {
			const { scope, value } = parseScope(args);
			if (value) {
				ctx.ui.notify("Usage: /memories [global]", "warning");
				return;
			}

			const file = memoryFile(scope, ctx.cwd);
			const memories = await readMemories(file);
			const title = `${scopeLabel(scope)} memories`;
			const contextChars = memories.reduce((total, memory) => total + memory.length, 0);
			const message = memories.length
				? `${title} (${memories.length}/${MAX_MEMORIES_PER_SCOPE}, ${contextChars}/${MAX_MEMORY_CONTEXT_CHARS} context characters; ${file.path}):\n${memories.map((memory, index) => `${index + 1}. ${memory}`).join("\n")}`
				: `No ${scope} memories saved yet.`;
			ctx.ui.notify(message, "info");
		},
	});

	pi.registerCommand("forget", {
		description: "Delete a remembered note by number; use /forget global <number> for global notes",
		handler: async (args, ctx) => {
			const { scope, value } = parseScope(args);
			const index = Number(value);
			if (!Number.isInteger(index) || index < 1) {
				ctx.ui.notify("Usage: /forget [global] <number>; use /memories first.", "warning");
				return;
			}

			const file = memoryFile(scope, ctx.cwd);
			const memories = await readMemories(file);
			if (index > memories.length) {
				ctx.ui.notify(`No ${scope} memory #${index}.`, "warning");
				return;
			}

			const [removed] = memories.splice(index - 1, 1);
			await saveMemories(file, memories);
			ctx.ui.notify(`Forgot ${scope} memory: ${removed}. Reloading context…`, "info");
			await reloadForCurrentSession(ctx);
		},
	});
}
