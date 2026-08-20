import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ANYWHERE_PROMPT_CLOSE_CHANNEL,
  ANYWHERE_PROMPT_OPEN_CHANNEL,
  ANYWHERE_PROMPT_PROBE_CHANNEL,
  type InstanceEventFrame,
  type InternalFrame,
  type PendingPrompt,
  type PromptAnswer,
  validatePromptAnswer,
} from "../../packages/anywhere-protocol/src/index.ts";
import type { CompanionClient } from "./companion-client.ts";

interface RemotePromptEnvelope {
  version: number;
  id: string;
  kind?: "ask_user" | "specialist";
  question: string;
  context?: string;
  options: Array<{ title: string; description?: string }>;
  allowMultiple: boolean;
  allowFreeform: boolean;
  allowComment: boolean;
  timeout?: number;
  signal?: AbortSignal;
  respond: (answer: PromptAnswer | null) => boolean;
}

interface RemotePromptClose {
  version: number;
  id: string;
  reason: "answered" | "cancelled" | "timeout" | "aborted" | "replaced";
}

interface PendingRemotePrompt {
  prompt: PendingPrompt;
  respond: (answer: PromptAnswer | null) => boolean;
  cleanup: () => void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isOpen(value: unknown): value is RemotePromptEnvelope {
  const record = asRecord(value);
  return record?.version === 2
    && typeof record.id === "string"
    && typeof record.question === "string"
    && Array.isArray(record.options)
    && typeof record.allowMultiple === "boolean"
    && typeof record.allowFreeform === "boolean"
    && typeof record.allowComment === "boolean"
    && typeof record.respond === "function";
}

function isClose(value: unknown): value is RemotePromptClose {
  const record = asRecord(value);
  return record?.version === 2
    && typeof record.id === "string"
    && ["answered", "cancelled", "timeout", "aborted", "replaced"].includes(String(record.reason));
}

export class PromptTransport {
  private readonly pending = new Map<string, PendingRemotePrompt>();
  private readonly removeOpen: () => void;
  private readonly removeClose: () => void;
  private readonly removeProbe: () => void;

  constructor(
    pi: ExtensionAPI,
    private readonly client: CompanionClient,
    private readonly instanceId: string,
    private readonly onEvent: (event: InstanceEventFrame["event"]) => void,
    private readonly onChange: () => void,
  ) {
    this.removeOpen = pi.events.on(ANYWHERE_PROMPT_OPEN_CHANNEL, (value) => this.receiveOpen(value));
    this.removeClose = pi.events.on(ANYWHERE_PROMPT_CLOSE_CHANNEL, (value) => this.receiveClose(value));
    this.removeProbe = pi.events.on(ANYWHERE_PROMPT_PROBE_CHANNEL, (value) => {
      const probe = asRecord(value);
      if (probe?.version !== 2 || typeof probe.report !== "function") return;
      (probe.report as (capability: { version: number; remotePrompt: boolean }) => void)({ version: 2, remotePrompt: this.client.isConnected });
    });
  }

  dispose(): void {
    this.removeOpen();
    this.removeClose();
    this.removeProbe();
    for (const pending of this.pending.values()) pending.cleanup();
    this.pending.clear();
    this.onChange();
  }

  get size(): number {
    return this.pending.size;
  }

  get firstPrompt(): PendingPrompt | undefined {
    return this.pending.values().next().value?.prompt;
  }

  handleFrame(frame: InternalFrame): void {
    if (frame.type !== "prompt_answer") return;
    if (frame.instanceId !== this.instanceId) return;
    const pending = this.pending.get(frame.promptId);
    if (!pending) {
      this.sendAck(frame.promptId, frame.requestId, false, "already_settled");
      return;
    }
    if (frame.answer !== null && !validatePromptAnswer(pending.prompt, frame.answer)) {
      this.sendAck(frame.promptId, frame.requestId, false, "invalid_answer");
      return;
    }
    const accepted = pending.respond(frame.answer);
    if (!accepted) {
      this.sendAck(frame.promptId, frame.requestId, false, "already_settled");
      return;
    }
    pending.cleanup();
    this.pending.delete(frame.promptId);
    this.sendAck(frame.promptId, frame.requestId, true);
    this.onChange();
  }

  private sendAck(
    promptId: string,
    requestId: string | undefined,
    accepted: boolean,
    errorCode?: "already_settled" | "invalid_answer" | "instance_unavailable",
  ): void {
    this.client.send({
      type: "prompt_answer_ack",
      version: 2,
      promptId,
      requestId,
      accepted,
      errorCode,
    });
  }

  private receiveOpen(value: unknown): void {
    if (!isOpen(value) || this.pending.has(value.id)) return;
    const options = value.options
      .filter((option) => option && typeof option.title === "string" && option.title.trim())
      .map((option) => option.description?.trim()
        ? { title: option.title.trim(), description: option.description.trim() }
        : { title: option.title.trim() });
    const prompt: PendingPrompt = {
      version: 2,
      id: value.id,
      kind: value.kind === "specialist" ? "specialist" : "ask_user",
      question: value.question,
      context: value.context?.trim() || undefined,
      options,
      allowMultiple: value.allowMultiple,
      allowFreeform: value.allowFreeform || options.length === 0,
      allowComment: value.allowComment,
      timeout: value.timeout,
      openedAt: Date.now(),
      instanceId: this.instanceId,
    };
    const onAbort = () => {
      this.removePending(value.id);
      this.sendEvent({
        cursor: 0,
        kind: "prompt",
        promptId: value.id,
      });
    };
    value.signal?.addEventListener("abort", onAbort, { once: true });
    this.pending.set(value.id, {
      prompt,
      respond: value.respond,
      cleanup: () => value.signal?.removeEventListener("abort", onAbort),
    });
    this.sendEvent({ cursor: 0, kind: "prompt", prompt });
    this.onChange();
  }

  private receiveClose(value: unknown): void {
    if (!isClose(value)) return;
    this.removePending(value.id);
    this.sendEvent({ cursor: 0, kind: "prompt", promptId: value.id });
    this.onChange();
  }

  private removePending(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    pending.cleanup();
    this.pending.delete(id);
  }

  private sendEvent(event: InstanceEventFrame["event"]): void {
    this.onEvent(event);
  }
}
