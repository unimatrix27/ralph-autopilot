import { describe, expect, it } from "vitest";
import { parseModeDecision, selectModingCandidates } from "./moding";
import type { Issue } from "../github/types";

/** A ready-for-agent + afk issue with NO mode label (the moding gap), overridable. */
function issue(seed: Partial<Issue> & { number: number }): Issue {
  return {
    title: `Issue ${seed.number}`,
    body: "",
    state: "OPEN",
    labels: ["ready-for-agent", "afk"],
    createdAt: "2026-01-01T00:00:00Z",
    ...seed,
  };
}

/** No issue has dependencies satisfied unless a test seeds them. */
const noneSatisfied = async (): Promise<boolean> => false;

describe("parseModeDecision", () => {
  it("accepts a well-formed tdd/infra verdict", () => {
    expect(parseModeDecision({ mode: "tdd", reason: "ships code" })).toEqual({
      mode: "tdd",
      reason: "ships code",
    });
    expect(parseModeDecision({ mode: "infra", reason: "docs only" }).mode).toBe("infra");
  });

  it("rejects an unknown mode, an empty reason, and extra keys", () => {
    expect(() => parseModeDecision({ mode: "chore", reason: "x" })).toThrow();
    expect(() => parseModeDecision({ mode: "tdd", reason: "" })).toThrow();
    expect(() => parseModeDecision({ mode: "tdd", reason: "x", extra: 1 })).toThrow();
    expect(() => parseModeDecision({ mode: "tdd" })).toThrow();
  });
});

describe("selectModingCandidates", () => {
  it("selects an issue whose ONLY missing gate condition is the mode label", async () => {
    const picked = await selectModingCandidates([issue({ number: 1 })], noneSatisfied, 5, "owner/repo");
    expect(picked.map((i) => i.number)).toEqual([1]);
  });

  it("skips an already-moded issue (idempotent — its label already landed)", async () => {
    const moded = issue({ number: 1, labels: ["ready-for-agent", "afk", "mode:tdd"] });
    expect(await selectModingCandidates([moded], noneSatisfied, 5, "owner/repo")).toEqual([]);
  });

  it("skips issues that fail the gate for a reason OTHER than the mode", async () => {
    const notReady = issue({ number: 1, labels: ["afk"] });
    const notAfk = issue({ number: 2, labels: ["ready-for-agent"] });
    const hitl = issue({ number: 3, labels: ["ready-for-agent", "afk", "hitl"] });
    const paused = issue({ number: 4, labels: ["ready-for-agent", "afk", "awaiting-answer"] });
    const closed = issue({ number: 5, state: "CLOSED" });
    const log = issue({ number: 6, labels: ["ready-for-agent", "afk", "[log] milestone"] });
    const picked = await selectModingCandidates(
      [notReady, notAfk, hitl, paused, closed, log],
      noneSatisfied,
      10,
      "owner/repo",
    );
    expect(picked).toEqual([]);
  });

  it("treats an issue blocked by an unsatisfied dependency as not-a-candidate", async () => {
    const blocked = issue({ number: 1, body: "## Blocked by\n- #99" });
    expect(await selectModingCandidates([blocked], noneSatisfied, 5, "owner/repo")).toEqual([]);
  });

  it("selects an issue once its blocking dependency is closed-and-merged", async () => {
    const blocked = issue({ number: 1, body: "## Blocked by\n- #99" });
    const picked = await selectModingCandidates([blocked], async (n) => n === 99, 5, "owner/repo");
    expect(picked.map((i) => i.number)).toEqual([1]);
  });

  it("caps the selection at maxPerTick, oldest-first (FIFO by issue age)", async () => {
    const issues = [
      issue({ number: 3, createdAt: "2026-03-01T00:00:00Z" }),
      issue({ number: 1, createdAt: "2026-01-01T00:00:00Z" }),
      issue({ number: 2, createdAt: "2026-02-01T00:00:00Z" }),
    ];
    const picked = await selectModingCandidates(issues, noneSatisfied, 2, "owner/repo");
    expect(picked.map((i) => i.number)).toEqual([1, 2]);
  });

  it("returns nothing when maxPerTick is zero or negative", async () => {
    expect(await selectModingCandidates([issue({ number: 1 })], noneSatisfied, 0, "owner/repo")).toEqual([]);
  });
});
