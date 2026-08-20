import { describe, expect, it } from "vitest";
import {
  createSettlementGate,
  normalizeRemotePromptAnswer,
} from "../git/github.com/NAM-likestocode/pi-ask-user/cooperative.ts";

describe("maintained pi-ask-user cooperative transport", () => {
  it("settles exactly once with the first valid response", async () => {
    const gate = createSettlementGate();
    expect(gate.settle("remote", { kind: "freeform", text: "phone" })).toBe(true);
    expect(gate.settle("local", { kind: "freeform", text: "terminal" })).toBe(false);
    await expect(gate.promise).resolves.toEqual({
      source: "remote",
      result: { kind: "freeform", text: "phone" },
    });
  });

  it("validates constrained and zero-option answers", () => {
    const options = [{ title: "approve" }, { title: "cancel" }];
    expect(normalizeRemotePromptAnswer(
      { kind: "selection", selections: ["unknown"] }, options, false, false, false,
    )).toBeNull();
    expect(normalizeRemotePromptAnswer(
      { kind: "selection", selections: ["approve"], comment: "safe" }, options, false, false, true,
    )).toEqual({ kind: "selection", selections: ["approve"], comment: "safe" });
    expect(normalizeRemotePromptAnswer(
      { kind: "freeform", text: "typed from phone" }, [], false, false, false,
    )).toEqual({ kind: "freeform", text: "typed from phone" });
  });
});
