import {
  ANYWHERE_MAX_COMMENT_CHARS,
  ANYWHERE_MAX_MESSAGE_CHARS,
  ANYWHERE_PROTOCOL_VERSION,
} from "./public-api.ts";

export interface PromptOption {
  title: string;
  description?: string;
}

export type PromptKind = "ask_user" | "specialist";

export interface PendingPrompt {
  version: typeof ANYWHERE_PROTOCOL_VERSION;
  id: string;
  kind: PromptKind;
  question: string;
  context?: string;
  options: PromptOption[];
  allowMultiple: boolean;
  allowFreeform: boolean;
  allowComment: boolean;
  timeout?: number;
  openedAt: number;
  instanceId?: string;
  agent?: string;
}

export type PromptAnswer =
  | {
      kind: "selection";
      selections: string[];
      comment?: string;
    }
  | {
      kind: "freeform";
      text: string;
    };

export interface PromptOpenEvent {
  version: typeof ANYWHERE_PROTOCOL_VERSION;
  prompt: PendingPrompt;
  claim: () => boolean;
  respond: (answer: PromptAnswer | null) => boolean;
}

export interface PromptCloseEvent {
  version: typeof ANYWHERE_PROTOCOL_VERSION;
  id: string;
  reason: "answered" | "cancelled" | "timeout" | "aborted" | "replaced";
}

export interface PromptProbeEvent {
  version: typeof ANYWHERE_PROTOCOL_VERSION;
  report: (capability: { version: number; remotePrompt: boolean }) => void;
}

export function validatePromptAnswer(
  prompt: {
    options: ReadonlyArray<PromptOption>;
    allowMultiple: boolean;
    allowFreeform: boolean;
    allowComment: boolean;
  },
  value: unknown,
): PromptAnswer | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;

  if (record.kind === "freeform") {
    if (!prompt.allowFreeform || typeof record.text !== "string") return undefined;
    const text = record.text.trim();
    if (!text || text.length > ANYWHERE_MAX_MESSAGE_CHARS) return undefined;
    return { kind: "freeform", text };
  }

  if (record.kind !== "selection" || !Array.isArray(record.selections)) return undefined;
  if (record.selections.some((selection) => typeof selection !== "string")) return undefined;
  const selections = [...new Set(
    record.selections.map((selection) => selection.trim()).filter(Boolean),
  )];
  const allowed = new Set(prompt.options.map((option) => option.title));
  if (
    selections.length === 0
    || (!prompt.allowMultiple && selections.length !== 1)
    || selections.some((selection) => !allowed.has(selection))
  ) return undefined;

  if (record.comment !== undefined && typeof record.comment !== "string") return undefined;
  const comment = typeof record.comment === "string" ? record.comment.trim() : "";
  if (comment && (!prompt.allowComment || comment.length > ANYWHERE_MAX_COMMENT_CHARS)) return undefined;
  return comment && prompt.allowComment
    ? { kind: "selection", selections, comment }
    : { kind: "selection", selections };
}
