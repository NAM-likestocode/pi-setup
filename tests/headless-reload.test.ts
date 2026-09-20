import { describe, expect, it, vi } from "vitest";
import headlessReload from "../extensions/headless-reload.ts";

type Handler = (event: { type: "session_start"; reason: string }, ctx: Record<string, unknown>) => Promise<void> | void;

function fakePi() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { description: string; handler: (args: string, ctx: Record<string, unknown>) => Promise<void> }>();
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: (name: string, options: { description: string; handler: (args: string, ctx: Record<string, unknown>) => Promise<void> }) => commands.set(name, options),
  };
  return { pi: pi as never, handlers, commands };
}

describe("headless /reload", () => {
  it("stays out of the terminal UI, which has its own built-in", async () => {
    const { pi, handlers, commands } = fakePi();
    headlessReload(pi);
    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, { mode: "tui", hasUI: true });
    expect(commands.size).toBe(0);
  });

  it("registers /reload in RPC mode, refuses while busy, and confirms after the reload", async () => {
    const { pi, handlers, commands } = fakePi();
    headlessReload(pi);
    const notify = vi.fn();
    await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, { mode: "rpc", hasUI: true, ui: { notify } });
    expect([...commands.keys()]).toEqual(["reload"]);
    expect(notify).not.toHaveBeenCalled();

    const reload = vi.fn(async () => undefined);
    const busyNotify = vi.fn();
    await commands.get("reload")!.handler("", { isIdle: () => false, reload, ui: { notify: busyNotify } });
    expect(reload).not.toHaveBeenCalled();
    expect(busyNotify).toHaveBeenCalledWith(expect.stringMatching(/finish before reloading/), "warning");

    await commands.get("reload")!.handler("", { isIdle: () => true, reload, ui: { notify: busyNotify } });
    expect(reload).toHaveBeenCalledTimes(1);

    // The fresh instance announces the completed reload.
    const { pi: pi2, handlers: handlers2 } = fakePi();
    headlessReload(pi2);
    const afterNotify = vi.fn();
    await handlers2.get("session_start")!({ type: "session_start", reason: "reload" }, { mode: "rpc", hasUI: true, ui: { notify: afterNotify } });
    expect(afterNotify).toHaveBeenCalledWith(expect.stringMatching(/^Reloaded/), "info");
  });
});
