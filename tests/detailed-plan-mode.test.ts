import { describe, expect, it } from "vitest";
import { extractPlanSummary, extractSteps, formatPlanProgress, isAllowedPlanCommand, planningToolProfile } from "../extensions/detailed-plan-mode.ts";

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
    expect(planningToolProfile([
      "read",
      "bash",
      "edit",
      "write",
      "web_search",
      "mcp",
      "visual_planner_read",
      "visual_planner_propose",
    ])).toEqual(["read", "bash", "web_search", "visual_planner_read", "visual_planner_propose"]);
  });

  it("extracts the numbered implementation steps without later numbered sections", () => {
    const plan = `## Implementation Plan\n\n1. Add the state field.\n2. Update the UI.\n\n## Test matrix\n\n1. Run the unit tests.`;
    expect(extractSteps(plan).map((step) => step.text)).toEqual(["Add the state field.", "Update the UI."]);
  });

  it("extracts the user-facing quick summary", () => {
    const plan = `## Quick summary\n\n- Show all progress.\n- Keep a short version for the user.\n\n## Detailed specification\n\n### Goal and success criteria\n\nLong details.`;
    expect(extractPlanSummary(plan)).toContain("Show all progress.");
    expect(extractPlanSummary(plan)).not.toContain("Long details.");
  });

  it("reports completed and remaining steps", () => {
    const steps = extractSteps("## Steps\n\n1. First\n2. Second\n3. Third");
    const first = steps[0];
    expect(first).toBeDefined();
    if (first) first.done = true;
    expect(formatPlanProgress(steps)).toEqual({ completed: 1, total: 3, remaining: 2 });
  });
});
