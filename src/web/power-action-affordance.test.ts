import { describe, expect, it } from "vitest";
import { powerActionAffordance } from "./power-action-affordance";

const PRIORITIES = ["priority:p0", "priority:p1", "priority:p2"];

describe("powerActionAffordance", () => {
  it("centralizes per-surface actions and only offers priority choices when configured", () => {
    expect(powerActionAffordance("queued", PRIORITIES)).toEqual({
      actions: ["pause", "set-mode", "set-priority", "close"],
      priorityLabels: PRIORITIES,
    });
    expect(powerActionAffordance("queued", [])).toEqual({
      actions: ["pause", "set-mode", "close"],
      priorityLabels: [],
    });
    expect(powerActionAffordance("attention", PRIORITIES)).toEqual({
      actions: ["readmit", "close"],
      priorityLabels: PRIORITIES,
    });
  });
});
