import { describe, expect, it } from "vitest";
import { isAllowedPlanCommand, planningToolProfile } from "../extensions/detailed-plan-mode.ts";

describe("detailed plan command policy", () => {
  it.each([
    "pwd",
    "ls -la src",
    "rg \"token\" src",
    "git status --short",
    "git diff -- src/file.ts",
    "npm audit --json",
    "pnpm why typebox",
    "node --version",
    "python --version",
  ])("allows conservative inspection: %s", (command) => {
    expect(isAllowedPlanCommand(command)).toBe(true);
  });

  it.each([
    "pwd\nnode -e \"require('fs').writeFileSync('x','x')\"",
    "ls | tee output.txt",
    "rg --pre dangerous token .",
    "git diff --output=patch.txt",
    "npm audit --fix",
    "npm test",
    "find . -delete",
    "python --version && rm -rf .",
    "cat file > copy",
    "echo hello",
  ])("blocks executable or mutating shell forms: %s", (command) => {
    expect(isAllowedPlanCommand(command)).toBe(false);
  });

  it("keeps only the reviewed planning tools", () => {
    expect(planningToolProfile(["read", "bash", "edit", "write", "ctx_execute", "ctx_execute_file", "web_search", "mcp"]))
      .toEqual(["read", "bash", "ctx_execute_file", "web_search"]);
  });
});
