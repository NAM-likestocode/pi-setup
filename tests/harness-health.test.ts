import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectHarnessChecks, EXPECTED_PACKAGE_SPECS, isPinnedPackageSpec } from "../extensions/_shared/harness-health.ts";

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("harness package pins", () => {
  it.each(EXPECTED_PACKAGE_SPECS)("recognizes reviewed pin: %s", (spec) => {
    expect(isPinnedPackageSpec(spec)).toBe(true);
  });

  it.each([
    "npm:some-package",
    "npm:@scope/package",
    "git:github.com/example/tool",
    "https://github.com/example/tool",
  ])("rejects floating package spec: %s", (spec) => {
    expect(isPinnedPackageSpec(spec)).toBe(false);
  });

  it("recognizes scoped npm versions", () => {
    expect(isPinnedPackageSpec("npm:@scope/package@1.2.3")).toBe(true);
  });

  it("passes all fail-level checks against the live harness", async () => {
    const checks = await collectHarnessChecks(process.env.PI_HARNESS_TEST_ROOT ?? harnessRoot, ["read", "bash", "search_tools"]);
    expect(checks.filter((check) => check.level === "fail")).toEqual([]);
  });
});
