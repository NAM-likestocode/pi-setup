import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
   DASHBOARD_ACTIVITY_CHANNEL,
   dashboardActivityForTool,
   isDashboardActivity,
   sanitizeDashboardActivity,
   type DashboardActivity,
} from "../_shared/dashboard-activity.ts";
import { PAGE_CSS, PAGE_HTML, PAGE_JS } from "./web";

const ASK_PROTOCOL_VERSION = 1;
const ASK_REQUEST_CHANNEL = "anywhere:ask:v1:request";
const ASK_CANCEL_CHANNEL = "anywhere:ask:v1:cancel";
const ASK_PROBE_CHANNEL = "anywhere:ask:v1:probe";
const WIDGET_ID = "anywhere-link";
const STATUS_ID = "anywhere-status";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_MESSAGE_CHARS = 12_000;
const MAX_EVENTS = 500;
const MAX_EVENT_TEXT_CHARS = 20_000;

type Delivery = "steer" | "followUp";
type RemoteAnswer =
   | { kind: "selection"; selections: string[]; comment?: string }
   | { kind: "freeform"; text: string };

interface AskOption {
   title: string;
   description?: string;
}

interface RemoteAskRequest {
   version: number;
   id: string;
   question: string;
   context?: string;
   options: AskOption[];
   allowMultiple: boolean;
   allowFreeform: boolean;
   allowComment: boolean;
   timeout?: number;
   signal?: AbortSignal;
   claim: () => boolean;
   respond: (answer: RemoteAnswer | null) => boolean;
}

interface PendingQuestion {
   id: string;
   question: string;
   context?: string;
   options: AskOption[];
   allowMultiple: boolean;
   allowFreeform: boolean;
   allowComment: boolean;
   respond: (answer: RemoteAnswer | null) => boolean;
   cleanup: () => void;
}

interface BrowserEvent {
   seq: number;
   kind: "message" | "message_delta" | "status" | "activity";
   id?: string;
   role?: "user" | "assistant";
   text?: string;
   level?: "ok" | "warn" | "error";
   activity?: DashboardActivity;
}

interface RateBucket {
   count: number;
   resetAt: number;
}

interface CommandResult {
   code: number | null;
   stdout: string;
   stderr: string;
}

class HttpProblem extends Error {
   constructor(readonly status: number, message: string) {
      super(message);
   }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
   return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function truncate(text: string, max = MAX_EVENT_TEXT_CHARS): string {
   return text.length <= max ? text : `${text.slice(0, max)}\n\n[Message truncated for the phone view]`;
}

function textFromMessage(message: unknown): string {
   const record = asRecord(message);
   const content = record?.content;
   if (!Array.isArray(content)) return "";
   return content
      .map((part) => {
         const item = asRecord(part);
         return item?.type === "text" && typeof item.text === "string" ? item.text : "";
      })
      .filter(Boolean)
      .join("\n");
}

function messageId(message: unknown, fallback: string): string {
   const id = asRecord(message)?.id;
   return typeof id === "string" && id ? id : fallback;
}

function getHeader(headers: IncomingMessage["headers"], name: string): string | undefined {
   const value = headers[name.toLowerCase()];
   if (Array.isArray(value)) return value[0];
   return typeof value === "string" ? value : undefined;
}

function bearerToken(req: IncomingMessage): string | undefined {
   const value = getHeader(req.headers, "authorization");
   const match = value?.match(/^Bearer\s+([A-Za-z0-9_-]{20,128})$/i);
   return match?.[1];
}

function constantTimeTokenMatch(expected: string | undefined, supplied: string | undefined): boolean {
   if (!expected || !supplied) return false;
   const left = Buffer.from(expected, "utf8");
   const right = Buffer.from(supplied, "utf8");
   return left.length === right.length && timingSafeEqual(left, right);
}

function randomToken(): string {
   return randomBytes(32).toString("base64url");
}

function parseNonNegativeInteger(value: string | null): number {
   if (!value || !/^\d+$/.test(value)) return 0;
   const parsed = Number(value);
   return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function isRemoteAskRequest(value: unknown): value is RemoteAskRequest {
   const request = asRecord(value);
   return request?.version === ASK_PROTOCOL_VERSION
      && typeof request.id === "string"
      && typeof request.question === "string"
      && Array.isArray(request.options)
      && typeof request.claim === "function"
      && typeof request.respond === "function";
}

function validateAnswer(question: PendingQuestion, value: unknown): RemoteAnswer {
   const answer = asRecord(value);
   if (!answer || typeof answer.kind !== "string") {
      throw new HttpProblem(400, "Answer data is invalid.");
   }

   if (answer.kind === "freeform") {
      const text = typeof answer.text === "string" ? answer.text.trim() : "";
      if (!question.allowFreeform) throw new HttpProblem(400, "A written answer is not allowed for this question.");
      if (!text || text.length > MAX_MESSAGE_CHARS) throw new HttpProblem(400, "Write an answer between 1 and 12,000 characters.");
      return { kind: "freeform", text };
   }

   if (answer.kind === "selection") {
      if (!Array.isArray(answer.selections)) throw new HttpProblem(400, "Select at least one valid option.");
      if (answer.selections.some((selection) => typeof selection !== "string")) {
         throw new HttpProblem(400, "Select one of the options Pi provided.");
      }
      const choices = (answer.selections as string[])
         .map((selection) => selection.trim())
         .filter(Boolean);
      const unique = [...new Set(choices)];
      const allowed = new Set(question.options.map((option) => option.title));
      if (unique.length === 0 || (!question.allowMultiple && unique.length !== 1) || unique.some((choice) => !allowed.has(choice))) {
         throw new HttpProblem(400, "Select one of the options Pi provided.");
      }
      const comment = typeof answer.comment === "string" ? answer.comment.trim() : "";
      if (comment.length > MAX_MESSAGE_CHARS) throw new HttpProblem(400, "The optional comment is too long.");
      return comment && question.allowComment
         ? { kind: "selection", selections: unique, comment }
         : { kind: "selection", selections: unique };
   }

   throw new HttpProblem(400, "Answer data is invalid.");
}

async function readJson(req: IncomingMessage): Promise<unknown> {
   const chunks: Buffer[] = [];
   let bytes = 0;
   for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_BODY_BYTES) throw new HttpProblem(413, "Request body is too large.");
      chunks.push(buffer);
   }
   const raw = Buffer.concat(chunks).toString("utf8").trim();
   if (!raw) return {};
   try {
      return JSON.parse(raw);
   } catch {
      throw new HttpProblem(400, "Request body must be valid JSON.");
   }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
   const content = JSON.stringify(body);
   res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(content),
   });
   res.end(content);
}

function sendText(res: ServerResponse, status: number, contentType: string, body: string): void {
   res.writeHead(status, {
      "content-type": contentType,
      "content-length": Buffer.byteLength(body),
   });
   res.end(body);
}

async function processExitCode(command: string, args: string[], timeoutMs: number): Promise<number | null> {
   return await new Promise((resolve) => {
      let settled = false;
      const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
      const finish = (code: number | null) => {
         if (settled) return;
         settled = true;
         clearTimeout(timer);
         resolve(code);
      };
      const timer = setTimeout(() => {
         child.kill();
         finish(null);
      }, timeoutMs);
      child.once("error", () => finish(null));
      child.once("exit", (code) => finish(code));
   });
}

async function executableWorks(executable: string): Promise<boolean> {
   return (await processExitCode(executable, ["--version"], 10_000)) === 0;
}

async function runCommand(executable: string, args: string[], timeoutMs = 20_000): Promise<CommandResult> {
   return await new Promise((resolve) => {
      const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (code: number | null) => {
         if (settled) return;
         settled = true;
         clearTimeout(timer);
         resolve({ code, stdout, stderr });
      };
      const timer = setTimeout(() => {
         child.kill();
         finish(null);
      }, timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.once("error", (error) => {
         stderr += error.message;
         finish(null);
      });
      child.once("exit", (code) => finish(code));
   });
}

async function findTailscale(): Promise<string> {
   const candidates = process.platform === "win32"
      ? ["tailscale", "C:\\Program Files\\Tailscale\\tailscale.exe"]
      : ["tailscale"];
   for (const candidate of candidates) {
      if (await executableWorks(candidate)) return candidate;
   }
   throw new Error("Tailscale is not available. Install it, sign in, and run /Anywhere again.");
}

async function getTailscaleUrl(executable: string): Promise<string> {
   const result = await runCommand(executable, ["status", "--json"]);
   if (result.code !== 0) throw new Error("Tailscale is not running.");
   let status: Record<string, unknown>;
   try {
      status = JSON.parse(result.stdout) as Record<string, unknown>;
   } catch {
      throw new Error("Tailscale returned an unreadable status response.");
   }
   const self = asRecord(status.Self);
   const dnsName = typeof self?.DNSName === "string" ? self.DNSName.replace(/\.$/, "") : "";
   if (status.BackendState !== "Running" || !dnsName) {
      throw new Error("Tailscale must be connected with MagicDNS before Anywhere can start.");
   }
   return `https://${dnsName}`;
}

async function ensureEmptyTailscaleServe(executable: string): Promise<void> {
   const result = await runCommand(executable, ["serve", "status", "--json"]);
   if (result.code !== 0) throw new Error("Could not inspect the existing Tailscale Serve configuration.");
   try {
      const config = JSON.parse(result.stdout) as Record<string, unknown>;
      if (Object.keys(config).length > 0) {
         throw new Error("Tailscale Serve is already configured. Anywhere will not overwrite another service.");
      }
   } catch (error) {
      if (error instanceof Error && error.message.startsWith("Tailscale Serve")) throw error;
      throw new Error("Tailscale returned an unreadable Serve configuration.");
   }
}

async function startTailscaleServe(executable: string, port: number): Promise<void> {
   const result = await runCommand(executable, ["serve", "--https=443", "--bg", `http://127.0.0.1:${port}`]);
   if (result.code === 0) return;
   const approvalUrl = result.stdout.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0];
   if (approvalUrl) {
      throw new Error(`Tailscale Serve must be enabled for this tailnet: ${approvalUrl}`);
   }
   throw new Error("Tailscale could not start its private HTTPS proxy.");
}

async function stopTailscaleServe(executable: string): Promise<void> {
   await runCommand(executable, ["serve", "reset"]);
}

async function waitForTailscaleServe(url: string, timeoutMs = 30_000): Promise<void> {
   const deadline = Date.now() + timeoutMs;
   while (Date.now() < deadline) {
      try {
         const response = await fetch(`${url}/`, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
         if (response.status === 200) return;
      } catch {
         // The local Tailscale HTTPS proxy can take a few seconds to receive its certificate.
      }
      await sleep(1_000);
   }
   throw new Error("Tailscale Serve did not become reachable in time.");
}

function sleep(milliseconds: number): Promise<void> {
   return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class AnywhereBridge {
   private server: Server | undefined;
   private tailscaleExecutable: string | undefined;
   private tailscaleServeActive = false;
   private ctx: ExtensionContext | undefined;
   private active = false;
   private port = 0;
   private publicUrl: string | undefined;
   private publicHost: string | undefined;
   private pairingToken: string | undefined;
   private clientToken: string | undefined;
   private pendingQuestion: PendingQuestion | undefined;
   private events: BrowserEvent[] = [];
   private nextSequence = 1;
   // Some Pi message_update events do not expose a stable message id. Keep one
   // bridge-side id for the whole assistant stream so each text delta updates
   // one chat bubble instead of creating a bubble per token.
   private assistantStreamId: string | undefined;
   private seenMessages = new Set<string>();
   private toolArgs = new Map<string, unknown>();
   private rateBuckets = new Map<string, RateBucket>();

   constructor(private readonly pi: ExtensionAPI) {}

   get isActive(): boolean {
      return this.active;
   }

   get isPaired(): boolean {
      return Boolean(this.clientToken);
   }

   get link(): string | undefined {
      return this.publicUrl && this.pairingToken ? `${this.publicUrl}/#${this.pairingToken}` : undefined;
   }

   setContext(ctx: ExtensionContext): void {
      this.ctx = ctx;
   }

   async start(ctx: ExtensionContext): Promise<string> {
      if (this.active) {
         const existing = this.link;
         if (!existing && this.clientToken) throw new Error("A phone is already paired. Use /Anywhere pair to replace it.");
         if (!existing) throw new Error("Anywhere is already active.");
         return existing;
      }

      this.ctx = ctx;
      this.events = [];
      this.nextSequence = 1;
      this.assistantStreamId = undefined;
      this.seenMessages.clear();
      this.toolArgs.clear();
      this.rateBuckets.clear();
      this.pairingToken = randomToken();
      this.clientToken = undefined;
      this.pendingQuestion = undefined;

      try {
         this.port = await this.openServer();
         this.active = true;
         this.tailscaleExecutable = await findTailscale();
         await ensureEmptyTailscaleServe(this.tailscaleExecutable);
         this.publicUrl = await getTailscaleUrl(this.tailscaleExecutable);
         this.publicHost = new URL(this.publicUrl).host.toLowerCase();
         await startTailscaleServe(this.tailscaleExecutable, this.port);
         this.tailscaleServeActive = true;
         await waitForTailscaleServe(this.publicUrl);
         this.publishStatus("Anywhere is ready through your private Tailscale network. Pair your phone with the link shown in Pi.", "ok");
         return this.link!;
      } catch (error) {
         await this.stop("Anywhere could not start.");
         throw error;
      }
   }

   async stop(reason = "Anywhere access stopped."): Promise<void> {
      const pending = this.pendingQuestion;
      this.pendingQuestion = undefined;
      pending?.cleanup();
      pending?.respond(null);

      this.active = false;
      this.pairingToken = undefined;
      this.clientToken = undefined;
      this.publicUrl = undefined;
      this.publicHost = undefined;
      this.port = 0;
      this.events = [];
      this.assistantStreamId = undefined;
      this.seenMessages.clear();
      this.toolArgs.clear();

      const tailscaleExecutable = this.tailscaleExecutable;
      const tailscaleServeActive = this.tailscaleServeActive;
      this.tailscaleExecutable = undefined;
      this.tailscaleServeActive = false;
      if (tailscaleServeActive && tailscaleExecutable) {
         await stopTailscaleServe(tailscaleExecutable).catch(() => undefined);
      }

      const server = this.server;
      this.server = undefined;
      if (server?.listening) {
         await new Promise<void>((resolve) => server.close(() => resolve()));
      }

      this.ctx?.ui.setWidget(WIDGET_ID, undefined);
      this.ctx?.ui.setStatus(STATUS_ID, undefined);
      this.ctx?.ui.notify(reason, "info");
   }

   rotatePairing(): string {
      if (!this.active || !this.publicUrl) throw new Error("Anywhere is not active. Run /Anywhere first.");
      this.clientToken = undefined;
      this.pairingToken = randomToken();
      this.publishStatus("The previous phone was unpaired. A new pairing link is ready.", "warn");
      return this.link!;
   }

   recordMessage(message: unknown): void {
      if (!this.active) return;
      const record = asRecord(message);
      const role = record?.role;
      if (role !== "user" && role !== "assistant") return;
      const text = textFromMessage(message);
      if (!text) return;
      // Prefer the stream id for the finalized assistant message. That makes
      // the final event replace the streamed content in the same browser row.
      const id = role === "assistant" && this.assistantStreamId
         ? this.assistantStreamId
         : messageId(message, `${role}-${Date.now()}-${this.nextSequence}`);
      if (role === "assistant") this.assistantStreamId = undefined;
      if (this.seenMessages.has(id)) return;
      this.seenMessages.add(id);
      this.publish({ kind: "message", id, role, text: truncate(text) });
   }

   recordAssistantDelta(message: unknown, delta: string): void {
      if (!this.active || !delta) return;
      const suppliedId = asRecord(message)?.id;
      const id = this.assistantStreamId
         ?? (typeof suppliedId === "string" && suppliedId ? suppliedId : `assistant-stream-${this.nextSequence}`);
      this.assistantStreamId = id;
      this.publish({ kind: "message_delta", id, role: "assistant", text: truncate(delta, 4_000) });
   }

   recordToolStart(toolCallId: string, toolName: string, args: unknown): void {
      if (!this.active || toolName === "subagent") return;
      this.toolArgs.set(toolCallId, args);
      this.receiveActivity(dashboardActivityForTool({
         id: `main:${toolCallId}`,
         phase: "start",
         source: "main",
         toolName,
         args,
      }));
   }

   recordToolEnd(toolCallId: string, toolName: string, args: unknown, result: unknown, isError: boolean): void {
      if (!this.active || toolName === "subagent") return;
      this.receiveActivity(dashboardActivityForTool({
         id: `main:${toolCallId}`,
         phase: "end",
         source: "main",
         toolName,
         args: args ?? this.toolArgs.get(toolCallId),
         result,
         isError,
      }));
      this.toolArgs.delete(toolCallId);
   }

   receiveActivity(value: unknown): void {
      if (!this.active || !isDashboardActivity(value)) return;
      const activity = sanitizeDashboardActivity(value);
      this.publish({ kind: "activity", id: activity.id, activity });
   }

   receiveAsk(value: unknown): void {
      if (!this.active || !this.isPaired || this.pendingQuestion || !isRemoteAskRequest(value)) return;
      if (!value.claim()) return;

      const options = value.options
         .filter((option) => option && typeof option.title === "string" && option.title.trim())
         .map((option) => option.description && option.description.trim()
            ? { title: option.title.trim(), description: option.description.trim() }
            : { title: option.title.trim() });
      const cleanupAbort = () => this.cancelQuestion(value.id);
      value.signal?.addEventListener("abort", cleanupAbort, { once: true });
      this.pendingQuestion = {
         id: value.id,
         question: value.question,
         context: value.context?.trim() || undefined,
         options,
         allowMultiple: Boolean(value.allowMultiple),
         // pi-ask-user's native zero-option path always accepts a typed answer.
         allowFreeform: value.allowFreeform !== false || options.length === 0,
         allowComment: Boolean(value.allowComment),
         respond: value.respond,
         cleanup: () => value.signal?.removeEventListener("abort", cleanupAbort),
      };
      this.publishStatus("Pi is waiting for your answer.", "warn");
   }

   cancelQuestion(id: string): void {
      if (!this.pendingQuestion || this.pendingQuestion.id !== id) return;
      this.pendingQuestion.cleanup();
      this.pendingQuestion = undefined;
      this.publishStatus("The pending question was cancelled.", "warn");
   }

   private async openServer(): Promise<number> {
      const server = createServer((req, res) => {
         void this.handleRequest(req, res);
      });
      server.on("clientError", (_error, socket) => {
         socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      });
      this.server = server;

      await new Promise<void>((resolve, reject) => {
         const onError = (error: Error) => {
            server.off("listening", onListening);
            reject(error);
         };
         const onListening = () => {
            server.off("error", onError);
            resolve();
         };
         server.once("error", onError);
         server.once("listening", onListening);
         server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
      });

      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Could not allocate a loopback port for Anywhere.");
      return address.port;
   }

   private publish(event: Omit<BrowserEvent, "seq">): void {
      if (!this.active) return;
      this.events.push({ ...event, seq: this.nextSequence++ });
      if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
   }

   private publishStatus(text: string, level: "ok" | "warn" | "error"): void {
      this.publish({ kind: "status", text, level });
      const status = level === "ok" ? "Anywhere active" : text;
      this.ctx?.ui.setStatus(STATUS_ID, status);
   }

   private requestIdentity(req: IncomingMessage): string {
      return getHeader(req.headers, "cf-connecting-ip") ?? getHeader(req.headers, "x-forwarded-for")?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "unknown";
   }

   private rateLimit(req: IncomingMessage, category: string, limit: number): boolean {
      const now = Date.now();
      // Polling /api/state must not consume the smaller mutation budget used
      // to submit chat/question answers from the same paired phone.
      const key = `${category}:${this.requestIdentity(req)}`;
      const previous = this.rateBuckets.get(key);
      const bucket = !previous || previous.resetAt <= now ? { count: 0, resetAt: now + 60_000 } : previous;
      bucket.count++;
      this.rateBuckets.set(key, bucket);
      if (this.rateBuckets.size > 128) {
         for (const [identity, value] of this.rateBuckets) {
            if (value.resetAt <= now) this.rateBuckets.delete(identity);
         }
      }
      return bucket.count <= limit;
   }

   private setSecurityHeaders(res: ServerResponse): void {
      res.setHeader("cache-control", "no-store, max-age=0");
      res.setHeader("content-security-policy", "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'");
      res.setHeader("cross-origin-opener-policy", "same-origin");
      res.setHeader("cross-origin-resource-policy", "same-origin");
      res.setHeader("permissions-policy", "camera=(), geolocation=(), microphone=()");
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("x-frame-options", "DENY");
   }

   private allowedHost(req: IncomingMessage): boolean {
      const host = (getHeader(req.headers, "host") ?? "").toLowerCase().replace(/\.$/, "");
      const localHosts = new Set([`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`]);
      return Boolean(host) && (host === this.publicHost || localHosts.has(host));
   }

   private allowedOrigin(req: IncomingMessage): boolean {
      const origin = getHeader(req.headers, "origin");
      return !origin || origin === this.publicUrl;
   }

   private requireClient(req: IncomingMessage): void {
      if (!constantTimeTokenMatch(this.clientToken, bearerToken(req))) {
         throw new HttpProblem(401, "This phone is not paired to the current Pi session.");
      }
   }

   private publicQuestion(): Record<string, unknown> | null {
      const question = this.pendingQuestion;
      if (!question) return null;
      return {
         id: question.id,
         question: question.question,
         context: question.context,
         options: question.options,
         allowMultiple: question.allowMultiple,
         allowFreeform: question.allowFreeform,
         allowComment: question.allowComment,
      };
   }

   private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
      this.setSecurityHeaders(res);
      try {
         if (!this.active) throw new HttpProblem(503, "Anywhere is not active.");
         if (!this.allowedHost(req)) throw new HttpProblem(421, "Unexpected host.");
         const url = new URL(req.url ?? "/", "http://anywhere.local");
         const method = req.method ?? "GET";

         if (method === "GET" && url.pathname === "/") {
            if (!this.rateLimit(req, "page", 180)) throw new HttpProblem(429, "Too many requests. Try again in a minute.");
            sendText(res, 200, "text/html; charset=utf-8", PAGE_HTML);
            return;
         }
         if (method === "GET" && url.pathname === "/app.css") {
            sendText(res, 200, "text/css; charset=utf-8", PAGE_CSS);
            return;
         }
         if (method === "GET" && url.pathname === "/app.js") {
            sendText(res, 200, "text/javascript; charset=utf-8", PAGE_JS);
            return;
         }
         if (method === "GET" && url.pathname === "/favicon.ico") {
            res.writeHead(204);
            res.end();
            return;
         }

         if (method === "POST" && url.pathname === "/api/pair") {
            if (!this.allowedOrigin(req)) throw new HttpProblem(403, "Unexpected request origin.");
            if (!this.rateLimit(req, "pair", 8)) throw new HttpProblem(429, "Too many pairing attempts. Try again in a minute.");
            await readJson(req);
            if (!constantTimeTokenMatch(this.pairingToken, bearerToken(req))) {
               throw new HttpProblem(401, "This pairing link is invalid, expired, or has already been used.");
            }
            if (this.clientToken) {
               throw new HttpProblem(410, "A phone is already paired. Run /Anywhere pair in Pi to approve a replacement device.");
            }
            // The public route is private to the tailnet, and this bootstrap
            // secret is consumed once. The device token is remembered only by
            // the paired browser and remains valid until Anywhere stops.
            this.clientToken = randomToken();
            this.pairingToken = undefined;
            this.publishStatus("A phone is paired to this Pi session.", "ok");
            sendJson(res, 200, { token: this.clientToken });
            return;
         }

         if (url.pathname.startsWith("/api/")) {
            if (!this.rateLimit(req, method === "GET" ? "read" : "write", method === "GET" ? 180 : 40)) throw new HttpProblem(429, "Too many requests. Try again in a minute.");
            if (method !== "GET" && !this.allowedOrigin(req)) throw new HttpProblem(403, "Unexpected request origin.");
            this.requireClient(req);
         }

         if (method === "GET" && url.pathname === "/api/state") {
            const since = parseNonNegativeInteger(url.searchParams.get("since"));
            sendJson(res, 200, {
               events: this.events.filter((event) => event.seq > since),
               cursor: this.nextSequence - 1,
               question: this.publicQuestion(),
               agent: this.ctx ? !this.ctx.isIdle() : false,
            });
            return;
         }

         if (method === "POST" && url.pathname === "/api/messages") {
            const body = asRecord(await readJson(req));
            const text = typeof body?.text === "string" ? body.text.trim() : "";
            const delivery = body?.delivery === "steer" ? "steer" : "followUp";
            if (!text || text.length > MAX_MESSAGE_CHARS) throw new HttpProblem(400, "Write a message between 1 and 12,000 characters.");
            if (!this.ctx) throw new HttpProblem(409, "Pi is not ready to receive a message.");
            if (this.pendingQuestion && delivery === "steer") {
               throw new HttpProblem(409, "Pi is waiting for an answer. Submit the question card before steering it.");
            }
            const wasBusy = !this.ctx.isIdle();
            if (!wasBusy) {
               this.pi.sendUserMessage(text);
            } else {
               this.pi.sendUserMessage(text, { deliverAs: delivery as Delivery });
            }
            sendJson(res, 202, { accepted: true, queued: wasBusy });
            return;
         }

         const questionMatch = url.pathname.match(/^\/api\/questions\/([^/]+)\/answer$/);
         if (method === "POST" && questionMatch) {
            const id = decodeURIComponent(questionMatch[1]);
            const question = this.pendingQuestion;
            if (!question || question.id !== id) throw new HttpProblem(404, "That question is no longer pending.");
            const answer = validateAnswer(question, await readJson(req));
            this.pendingQuestion = undefined;
            question.cleanup();
            if (!question.respond(answer)) throw new HttpProblem(409, "That question is no longer pending.");
            this.publishStatus("Your answer was sent to Pi.", "ok");
            sendJson(res, 200, { accepted: true });
            return;
         }

         throw new HttpProblem(404, "Not found.");
      } catch (error) {
         if (res.headersSent) {
            res.end();
            return;
         }
         const status = error instanceof HttpProblem ? error.status : 500;
         const message = error instanceof HttpProblem ? error.message : "The Anywhere server could not process that request.";
         sendJson(res, status, { error: message });
      }
   }
}

function findAskTransport(pi: ExtensionAPI): boolean {
   let available = false;
   pi.events.emit(ASK_PROBE_CHANNEL, {
      version: ASK_PROTOCOL_VERSION,
      report: (capability: unknown) => {
         const record = asRecord(capability);
         if (record?.version === ASK_PROTOCOL_VERSION && record.remoteAsk === true) available = true;
      },
   });
   return available;
}

function showLink(ctx: ExtensionContext, bridge: AnywhereBridge, link: string): void {
   ctx.ui.setWidget(WIDGET_ID, [
      "📱 Anywhere is active on your private Tailscale network. Pair this phone once:",
      link,
      "The pairing link is a password. After pairing, this browser stays remembered until /Anywhere off.",
   ]);
   ctx.ui.setStatus(STATUS_ID, "Anywhere active");
   ctx.ui.notify("Anywhere link is shown above the editor.", "info");
}

export default function anywhere(pi: ExtensionAPI) {
   const bridge = new AnywhereBridge(pi);
   let removeAskRequestListener: (() => void) | undefined;
   let removeAskCancelListener: (() => void) | undefined;
   let removeActivityListener: (() => void) | undefined;

   pi.on("session_start", (_event, ctx) => {
      bridge.setContext(ctx);
      removeAskRequestListener = pi.events.on(ASK_REQUEST_CHANNEL, (value) => bridge.receiveAsk(value));
      removeAskCancelListener = pi.events.on(ASK_CANCEL_CHANNEL, (value) => {
         const record = asRecord(value);
         if (record?.version === ASK_PROTOCOL_VERSION && typeof record.id === "string") bridge.cancelQuestion(record.id);
      });
      removeActivityListener = pi.events.on(DASHBOARD_ACTIVITY_CHANNEL, (value) => bridge.receiveActivity(value));
   });

   pi.on("message_update", (event) => {
      const update = (event as unknown as { message: unknown; assistantMessageEvent?: { type?: string; delta?: string } });
      if (update.assistantMessageEvent?.type === "text_delta" && typeof update.assistantMessageEvent.delta === "string") {
         bridge.recordAssistantDelta(update.message, update.assistantMessageEvent.delta);
      }
   });

   pi.on("message_end", (event) => {
      bridge.recordMessage((event as unknown as { message: unknown }).message);
   });

   pi.on("tool_execution_start", (event) => {
      bridge.recordToolStart(event.toolCallId, event.toolName, event.args);
   });

   pi.on("tool_execution_end", (event) => {
      bridge.recordToolEnd(event.toolCallId, event.toolName, undefined, event.result, event.isError);
   });

   pi.on("session_shutdown", async () => {
      removeAskRequestListener?.();
      removeAskCancelListener?.();
      removeActivityListener?.();
      removeAskRequestListener = undefined;
      removeAskCancelListener = undefined;
      removeActivityListener = undefined;
      await bridge.stop("Anywhere access stopped because this Pi session ended.");
   });

   pi.registerCommand("Anywhere", {
      description: "Open a secure phone chat for this Pi session (start, status, pair, off)",
      handler: async (args, ctx) => {
         const action = args.trim().toLowerCase();
         if (action === "off" || action === "stop") {
            if (!bridge.isActive) {
               ctx.ui.notify("Anywhere is already off.", "info");
               return;
            }
            await bridge.stop("Anywhere access was revoked.");
            return;
         }

         if (action === "status") {
            const state = !bridge.isActive ? "Anywhere is off. Run /Anywhere to start it."
               : bridge.isPaired ? "Anywhere is active and one phone is paired."
               : "Anywhere is active and waiting for a phone to pair.";
            ctx.ui.notify(state, "info");
            return;
         }

         if (action === "pair" || action === "link") {
            try {
               const link = bridge.rotatePairing();
               showLink(ctx, bridge, link);
            } catch (error) {
               ctx.ui.notify(error instanceof Error ? error.message : "Anywhere is not active.", "warning");
            }
            return;
         }

         if (action && action !== "start") {
            ctx.ui.notify("Usage: /Anywhere [start|status|pair|off]", "warning");
            return;
         }

         if (ctx.mode !== "tui") {
            ctx.ui.notify("/Anywhere needs Pi's interactive TUI so the secret pairing link can stay out of model context.", "error");
            return;
         }
         if (!findAskTransport(pi)) {
            ctx.ui.notify("The installed pi-ask-user extension does not have the Anywhere transport hook. Reapply the included patch before starting.", "error");
            return;
         }
         try {
            const link = await bridge.start(ctx);
            showLink(ctx, bridge, link);
         } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown startup error.";
            ctx.ui.notify(`Anywhere could not start: ${message}`, "error");
         }
      },
   });
}
