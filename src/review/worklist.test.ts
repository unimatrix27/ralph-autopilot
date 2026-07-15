import { describe, expect, it } from "vitest";
import {
  dedupeWorklist,
  gatingItems,
  hasEscalation,
  isClean,
  parseWorklist,
  type WorklistItem,
} from "./worklist";

const item = (severity: WorklistItem["severity"], title: string): WorklistItem => ({
  severity,
  title,
});

describe("worklist gating", () => {
  it("gates on P0, P1, and escalate but never on nits or out-of-scope", () => {
    const worklist = {
      items: [
        item("nit", "rename a variable"),
        item("out-of-scope", "rewrite an unrelated module"),
      ],
    };
    expect(isClean(worklist)).toBe(true);
    expect(gatingItems(worklist)).toHaveLength(0);
  });

  it("is not clean while a P0 or P1 remains", () => {
    expect(isClean({ items: [item("P1", "missing null check")] })).toBe(false);
    expect(isClean({ items: [item("P0", "data loss on retry")] })).toBe(false);
  });

  it("treats an escalate item as gating and detectable", () => {
    const worklist = { items: [item("escalate", "delete the whole persistence layer")] };
    expect(isClean(worklist)).toBe(false);
    expect(hasEscalation(worklist)).toBe(true);
  });
});

describe("dedupeWorklist", () => {
  it("collapses the same finding from review and a bot comment, keeping the most severe", () => {
    const merged = dedupeWorklist([
      { severity: "P1", title: "Missing  null check", source: "review" },
      { severity: "P0", title: "missing null check", source: "pr-comment" },
      { severity: "nit", title: "tidy import order", source: "review" },
    ]);
    expect(merged).toHaveLength(2);
    const nullCheck = merged.find((i) => i.title.toLowerCase().includes("null check"));
    expect(nullCheck?.severity).toBe("P0");
  });

  it("ranks the deduped list most-severe first", () => {
    const merged = dedupeWorklist([
      item("nit", "a"),
      item("P0", "b"),
      item("P1", "c"),
    ]);
    expect(merged.map((i) => i.severity)).toEqual(["P0", "P1", "nit"]);
  });
});

describe("parseWorklist", () => {
  it("accepts a well-formed worklist", () => {
    const parsed = parseWorklist({
      items: [{ severity: "P0", title: "boom", source: "review" }],
    });
    expect(parsed.items[0]!.severity).toBe("P0");
  });

  it("rejects an unknown severity", () => {
    expect(() => parseWorklist({ items: [{ severity: "blocker", title: "x" }] })).toThrow();
  });

  it("rejects an item with an empty title", () => {
    expect(() => parseWorklist({ items: [{ severity: "P0", title: "" }] })).toThrow();
  });
});
