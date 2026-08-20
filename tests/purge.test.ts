import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { parse, resolve } from "node:path";
import { assertSafePurgeTarget, resolvePurgePath } from "../extensions/purge.ts";

describe("purge tool path policy", () => {
  it("resolves relative paths and leading @ markers", () => {
    const cwd = resolve("project");
    expect(resolvePurgePath("@logs/output", cwd)).toBe(resolve(cwd, "logs/output"));
  });

  it("expands home-relative paths", () => {
    expect(resolvePurgePath("~/cache", "/project", "/home/tester")).toBe(resolve("/home/tester", "cache"));
  });

  it("rejects filesystem roots, home, and the agent directory", () => {
    expect(() => assertSafePurgeTarget(parse(process.cwd()).root)).toThrow("filesystem root");
    expect(() => assertSafePurgeTarget(homedir())).toThrow("home directory");
    expect(() => assertSafePurgeTarget("C:/temp/agent", "/home/tester", "C:/temp/agent")).toThrow("Pi agent directory");
  });
});
