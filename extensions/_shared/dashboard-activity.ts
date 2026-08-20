export const DASHBOARD_ACTIVITY_VERSION = 1;
export const DASHBOARD_ACTIVITY_CHANNEL = "pi-dashboard:activity:v1";

export type DashboardActivityPhase = "start" | "update" | "end";
export type DashboardActivitySource = "main" | "subagent";
export type DashboardActivityCategory = "command" | "edit" | "tool" | "subagent";

export interface DashboardActivity {
  version: typeof DASHBOARD_ACTIVITY_VERSION;
  id: string;
  phase: DashboardActivityPhase;
  source: DashboardActivitySource;
  category: DashboardActivityCategory;
  label: string;
  timestamp: number;
  toolName?: string;
  agent?: string;
  runId?: string;
  task?: string;
  path?: string;
  command?: string;
  detail?: string;
  diff?: string;
  isError?: boolean;
}

interface ToolActivityInput {
  id: string;
  phase: DashboardActivityPhase;
  source: DashboardActivitySource;
  toolName: string;
  args: unknown;
  result?: unknown;
  isError?: boolean;
  agent?: string;
  runId?: string;
  timestamp?: number;
}

const MAX_COMMAND_CHARS = 12_000;
const MAX_DIFF_CHARS = 18_000;
const MAX_DETAIL_CHARS = 2_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated for dashboard]`;
}

function stringField(record: Record<string, unknown> | undefined, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = record?.[name];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function shortToolName(toolName: string): string {
  const parts = toolName.split(/[.:/]/).filter(Boolean);
  return (parts.at(-1) ?? toolName).toLowerCase();
}

function redactCommand(command: string): string {
  return command
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)(?:"[^"]*"|'[^']*'|[^\s"']+)/gi, "$1[redacted]")
    .replace(/((?:--?)(?:api[-_]?key|token|password|secret)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi, "$1[redacted]")
    .replace(/(\b(?:api[-_]?key|access[-_]?token|auth[-_]?token|password|passwd|secret)\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s;&|]+)/gi, "$1[redacted]");
}

function isSensitivePath(filePath: string | undefined): boolean {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, "/");
  const name = normalized.split("/").at(-1) ?? normalized;
  return /^\.env(?:\..*)?$/i.test(name)
    || /^(?:auth|credentials?|secrets?)\.json$/i.test(name)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i.test(name)
    || /\.(?:pem|key|p12|pfx)$/i.test(name);
}

function diffFromEditArgs(filePath: string, args: Record<string, unknown>): string | undefined {
  const edits = Array.isArray(args.edits) ? args.edits : [];
  const valid = edits
    .map(asRecord)
    .filter((edit): edit is Record<string, unknown> => Boolean(edit))
    .filter((edit) => typeof edit.oldText === "string" && typeof edit.newText === "string");
  if (valid.length === 0) return undefined;

  const lines = [`--- ${filePath} (before)`, `+++ ${filePath} (after)`];
  valid.forEach((edit, index) => {
    lines.push(`@@ replacement ${index + 1} @@`);
    const oldLines = (edit.oldText as string).split("\n");
    const newLines = (edit.newText as string).split("\n");
    lines.push(...oldLines.map((line) => `-${line}`));
    lines.push(...newLines.map((line) => `+${line}`));
  });
  return truncate(lines.join("\n"), MAX_DIFF_CHARS);
}

function diffFromWriteArgs(filePath: string, args: Record<string, unknown>): string | undefined {
  if (typeof args.content !== "string") return undefined;
  const lines = [
    `--- ${filePath} (previous content not shown)`,
    `+++ ${filePath} (written content)`,
    "@@ write @@",
    ...args.content.split("\n").map((line) => `+${line}`),
  ];
  return truncate(lines.join("\n"), MAX_DIFF_CHARS);
}

function resultPatch(result: unknown): string | undefined {
  const resultRecord = asRecord(result);
  const details = asRecord(resultRecord?.details);
  const patch = stringField(details, "patch", "diff");
  return patch ? truncate(patch, MAX_DIFF_CHARS) : undefined;
}

function resultError(result: unknown): string | undefined {
  const content = asRecord(result)?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map(asRecord)
    .filter((part): part is Record<string, unknown> => Boolean(part))
    .map((part) => part.type === "text" && typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n");
  const lastLine = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
  return lastLine ? truncate(redactCommand(lastLine), MAX_DETAIL_CHARS) : undefined;
}

function genericDetail(args: Record<string, unknown>): string | undefined {
  const entries: string[] = [];
  for (const key of ["action", "query", "pattern", "url", "path", "file_path"]) {
    const value = args[key];
    if (typeof value === "string" && value) {
      if ((key === "path" || key === "file_path") && isSensitivePath(value)) entries.push(`${key}: [sensitive path hidden]`);
      else entries.push(`${key}: ${truncate(key === "url" ? redactCommand(value) : value, 240)}`);
    }
  }
  return entries.length > 0 ? entries.join(" · ") : undefined;
}

export function dashboardActivityForTool(input: ToolActivityInput): DashboardActivity {
  const args = asRecord(input.args) ?? {};
  const normalizedName = shortToolName(input.toolName);
  const filePath = stringField(args, "path", "file_path");
  const displayPath = filePath && !isSensitivePath(filePath) ? filePath : filePath ? "sensitive file" : undefined;
  const commandValue = stringField(args, "command");
  const isCommand = normalizedName === "bash" || Boolean(commandValue);
  const isEdit = normalizedName === "edit" || normalizedName === "write";
  const category: DashboardActivityCategory = normalizedName === "subagent"
    ? "subagent"
    : isCommand
      ? "command"
      : isEdit
        ? "edit"
        : "tool";

  let label = input.toolName;
  let detail: string | undefined;
  let command: string | undefined;
  let diff: string | undefined;

  if (isCommand) {
    label = input.source === "subagent" && input.agent
      ? `${input.agent}: command`
      : "Command";
    command = commandValue ? truncate(redactCommand(commandValue), MAX_COMMAND_CHARS) : undefined;
  } else if (normalizedName === "edit") {
    label = `Edit ${displayPath ?? "file"}`;
    const editCount = Array.isArray(args.edits) ? args.edits.length : 0;
    detail = editCount > 0 ? `${editCount} replacement${editCount === 1 ? "" : "s"}` : undefined;
  } else if (normalizedName === "write") {
    label = `Write ${displayPath ?? "file"}`;
    if (typeof args.content === "string") {
      const lineCount = args.content.split("\n").length;
      detail = `${lineCount} line${lineCount === 1 ? "" : "s"} · ${Buffer.byteLength(args.content, "utf8")} bytes`;
    }
  } else if (normalizedName === "subagent") {
    label = "Project subagent";
    detail = stringField(args, "agent");
  } else {
    detail = genericDetail(args);
  }

  if (isEdit && filePath) {
    if (isSensitivePath(filePath)) {
      detail = [detail, "change preview hidden for sensitive file"].filter(Boolean).join(" · ");
    } else {
      diff = input.phase === "end" ? resultPatch(input.result) : undefined;
      if (!diff) {
        diff = normalizedName === "write"
          ? diffFromWriteArgs(filePath, args)
          : diffFromEditArgs(filePath, args);
      }
    }
  }

  if (input.isError) {
    detail = resultError(input.result) ?? detail ?? "Tool failed.";
  }

  return {
    version: DASHBOARD_ACTIVITY_VERSION,
    id: input.id,
    phase: input.phase,
    source: input.source,
    category,
    label,
    timestamp: input.timestamp ?? Date.now(),
    toolName: input.toolName,
    agent: input.agent,
    runId: input.runId,
    path: filePath && !isSensitivePath(filePath) ? filePath : undefined,
    command,
    detail: detail ? truncate(detail, MAX_DETAIL_CHARS) : undefined,
    diff,
    isError: input.isError,
  };
}

export function isDashboardActivity(value: unknown): value is DashboardActivity {
  const record = asRecord(value);
  return record?.version === DASHBOARD_ACTIVITY_VERSION
    && typeof record.id === "string"
    && (record.phase === "start" || record.phase === "update" || record.phase === "end")
    && (record.source === "main" || record.source === "subagent")
    && (record.category === "command" || record.category === "edit" || record.category === "tool" || record.category === "subagent")
    && typeof record.label === "string"
    && typeof record.timestamp === "number";
}

export function sanitizeDashboardActivity(activity: DashboardActivity): DashboardActivity {
  return {
    ...activity,
    label: truncate(activity.label, 500),
    task: activity.task ? truncate(activity.task, 4_000) : undefined,
    path: activity.path ? truncate(activity.path, 1_000) : undefined,
    command: activity.command ? truncate(redactCommand(activity.command), MAX_COMMAND_CHARS) : undefined,
    detail: activity.detail ? truncate(redactCommand(activity.detail), MAX_DETAIL_CHARS) : undefined,
    diff: activity.diff ? truncate(activity.diff, MAX_DIFF_CHARS) : undefined,
  };
}
