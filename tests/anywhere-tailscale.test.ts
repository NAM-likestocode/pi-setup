import { describe, expect, it, vi } from "vitest";
import { stopTailscaleServe } from "../extensions/anywhere/index.ts";

describe("Anywhere Tailscale shutdown", () => {
  it("removes only Anywhere's HTTPS handler", async () => {
    const runner = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));

    await expect(stopTailscaleServe("tailscale", runner)).resolves.toBe(true);
    expect(runner).toHaveBeenCalledWith("tailscale", ["serve", "--https=443", "off"]);
  });

  it("is safe to run when the handler is already absent", async () => {
    const runner = vi.fn(async () => ({
      code: 1,
      stdout: "",
      stderr: "error: failed to remove web serve: handler does not exist",
    }));

    await expect(stopTailscaleServe("tailscale", runner)).resolves.toBe(false);
  });

  it("reports unexpected Tailscale failures", async () => {
    const runner = vi.fn(async () => ({ code: 1, stdout: "", stderr: "permission denied" }));

    await expect(stopTailscaleServe("tailscale", runner)).rejects.toThrow(
      "Tailscale could not remove Anywhere's private HTTPS route.",
    );
  });
});
