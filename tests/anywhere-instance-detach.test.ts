import { afterEach, describe, expect, it, vi } from "vitest";
import { InstanceBridge } from "../extensions/anywhere/instance-bridge.ts";
import type { InternalFrame } from "../packages/anywhere-protocol/src/index.ts";

afterEach(() => {
	vi.useRealTimers();
});

describe("Anywhere desktop session disconnect", () => {
	it("acknowledges the Companion, stops only the bridge, and leaves Pi running", async () => {
		vi.useFakeTimers();
		const send = vi.fn(() => true);
		const stop = vi.fn();
		const notify = vi.fn();
		const setStatus = vi.fn();
		const bridge = new InstanceBridge({} as never);
		const internal = bridge as unknown as {
			active: boolean;
			client: { send: typeof send; stop: typeof stop };
			ctx: { ui: { notify: typeof notify; setStatus: typeof setStatus } };
			handleFrame: (frame: InternalFrame) => void;
		};
		internal.active = true;
		internal.client = { send, stop };
		internal.ctx = { ui: { notify, setStatus } };

		internal.handleFrame({
			type: "command",
			version: 2,
			requestId: "detach-1",
			instanceId: bridge.instanceId,
			command: "detach",
		});

		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "command_result",
				requestId: "detach-1",
				ok: true,
			}),
		);
		await vi.advanceTimersByTimeAsync(50);
		expect(bridge.isActive).toBe(false);
		expect(stop).toHaveBeenCalledOnce();
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "unregister",
				instanceId: bridge.instanceId,
			}),
		);
		expect(setStatus).toHaveBeenCalledWith("anywhere-status", undefined);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("/Pimo start"),
			"info",
		);
	});
});
