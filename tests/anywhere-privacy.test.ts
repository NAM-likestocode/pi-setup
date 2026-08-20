import { describe, expect, it } from "vitest";
import { dashboardActivityForTool } from "../extensions/_shared/dashboard-activity.ts";

describe("Anywhere activity redaction", () => {
  it("redacts command credentials and hides sensitive file previews", () => {
    const command = dashboardActivityForTool({
      id: "command-1",
      phase: "end",
      source: "main",
      toolName: "bash",
      args: { command: "curl -H 'Authorization: Bearer secret-value' https://example.test" },
    });
    expect(command.command).toContain("[redacted]");
    expect(command.command).not.toContain("secret-value");

    const edit = dashboardActivityForTool({
      id: "edit-1",
      phase: "end",
      source: "main",
      toolName: "write",
      args: { path: ".env", content: "API_KEY=secret-value" },
    });
    expect(edit.path).toBeUndefined();
    expect(edit.label).not.toContain(".env");
    expect(edit.diff).toBeUndefined();
    expect(edit.detail).toContain("hidden");
  });
});
