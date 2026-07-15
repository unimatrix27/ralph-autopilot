import { describe, expect, it } from "vitest";
import type { Issue } from "../github/types";
import { admit, type LaunchPlan, type World } from "../core/admission";
import { projectBacklog } from "./backlog";

/** Minimal eligible issue (the FakeGitHub default label set), overridable. */
function issue(over: Partial<Issue> & { number: number }): Issue {
  return {
    title: `Issue ${over.number}`,
    body: "",
    state: "OPEN",
    labels: ["ready-for-agent", "afk", "mode:tdd"],
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

/** No `## Blocked by` dep is satisfied — the default for the dep-free fixtures below. */
const noneSatisfied = async () => false;

/** A launch plan with empty defaults, overridable per field. */
function plan(over: Partial<LaunchPlan> = {}): LaunchPlan {
  return { picked: [], eligible: [], excluded: [], ...over };
}

describe("projectBacklog", () => {
  it("maps the eligible queue in plan pick-order with the priority tag", async () => {
    const a = issue({ number: 1 });
    const b = issue({ number: 2, labels: ["ready-for-agent", "afk", "mode:infra", "priority:p0"] });
    // `eligible` is already in admission pick-order; the view preserves it verbatim.
    const view = await projectBacklog(
      [a, b],
      plan({ eligible: [{ issue: a, mode: "tdd" }, { issue: b, mode: "infra" }] }),
      ["priority:p0", "priority:p1"],
      noneSatisfied,
    );
    expect(view.eligible.map((e) => e.issueNumber)).toEqual([1, 2]);
    expect(view.eligible[0]).toEqual({ issueNumber: 1, title: "Issue 1", priority: null, priorityColor: null });
    expect(view.eligible[1]).toEqual({
      issueNumber: 2,
      title: "Issue 2",
      priority: "priority:p0",
      priorityColor: "red",
    });
  });

  it("colours each eligible row by its proportional rank in priorityLabels", async () => {
    const labels = ["priority:p0", "priority:p1", "priority:p2", "priority:p3"];
    const mk = (n: number, p?: string) =>
      issue({ number: n, labels: ["ready-for-agent", "afk", "mode:tdd", ...(p ? [p] : [])] });
    const issues = [
      mk(1, "priority:p0"),
      mk(2, "priority:p1"),
      mk(3, "priority:p2"),
      mk(4, "priority:p3"),
      mk(5),
    ];
    const view = await projectBacklog(
      issues,
      plan({ eligible: issues.map((i) => ({ issue: i, mode: "tdd" as const })) }),
      labels,
      noneSatisfied,
    );
    // f = rank / max(1, N-1) with N=4 → 0, 1/3, 2/3, 1; banded <1/3 red, <2/3 yellow, else blue.
    // No priority label (#5) carries no colour.
    expect(view.eligible.map((e) => e.priorityColor)).toEqual(["red", "yellow", "blue", "blue", null]);
  });

  it("buckets red/yellow/blue across any list length; a single-label list ranks red", async () => {
    const mk = (n: number, p: string) => issue({ number: n, labels: ["ready-for-agent", "afk", "mode:tdd", p] });
    // N=1: the only configured label is most-urgent → red (no degenerate divide-by-zero).
    const solo = mk(1, "sev:blocker");
    expect(
      (await projectBacklog([solo], plan({ eligible: [{ issue: solo, mode: "tdd" }] }), ["sev:blocker"], noneSatisfied))
        .eligible[0]!.priorityColor,
    ).toBe("red");
    // N=3: ranks 0,1,2 → f 0, 0.5, 1 → red, yellow, blue. Tracks any naming convention.
    const issues = [mk(1, "sev:high"), mk(2, "sev:med"), mk(3, "sev:low")];
    const view = await projectBacklog(
      issues,
      plan({ eligible: issues.map((i) => ({ issue: i, mode: "tdd" as const })) }),
      ["sev:high", "sev:med", "sev:low"],
      noneSatisfied,
    );
    expect(view.eligible.map((e) => e.priorityColor)).toEqual(["red", "yellow", "blue"]);
  });

  it("surfaces no-provider exclusions distinctly, in pick-order, with the reset ETA (ADR-0037, #165)", async () => {
    const a = issue({ number: 1 });
    const b = issue({ number: 2 });
    // When no provider has headroom, admission launches nothing and excludes the whole
    // otherwise-eligible queue as `no-provider`, in the order it would have picked them.
    const view = await projectBacklog(
      [a, b],
      plan({ excluded: [{ issue: a, reason: "no-provider" }, { issue: b, reason: "no-provider" }] }),
      [],
      noneSatisfied,
      "2026-06-29T14:30:00.000Z",
    );
    expect(view.noProvider).toEqual([
      { issueNumber: 1, title: "Issue 1", resetsAt: "2026-06-29T14:30:00.000Z" },
      { issueNumber: 2, title: "Issue 2", resetsAt: "2026-06-29T14:30:00.000Z" },
    ]);
    // These are NOT in the eligible (queued-for-a-slot) section — they wait on a provider, not a slot.
    expect(view.eligible).toEqual([]);
  });

  it("leaves the reset ETA null when unknown (degrades gracefully)", async () => {
    const a = issue({ number: 1 });
    const view = await projectBacklog([a], plan({ excluded: [{ issue: a, reason: "no-provider" }] }), [], noneSatisfied);
    expect(view.noProvider).toEqual([{ issueNumber: 1, title: "Issue 1", resetsAt: null }]);
  });

  it("maps blocked exclusions with each ref's satisfaction, sorted by issue number", async () => {
    const i5 = issue({ number: 5, body: "## Blocked by\n- #98\n- #99\n" });
    const i3 = issue({ number: 3, body: "## Blocked by\n- #1\n" });
    const view = await projectBacklog(
      [i5, i3],
      plan({
        excluded: [
          { issue: i5, reason: "blocked", blockers: [{ ref: 98, satisfied: true }, { ref: 99, satisfied: false }] },
          { issue: i3, reason: "blocked", blockers: [{ ref: 1, satisfied: false }] },
        ],
      }),
      [],
      noneSatisfied,
    );
    expect(view.blocked.map((b) => b.issueNumber)).toEqual([3, 5]);
    expect(view.blocked[1]!.blockers).toEqual([
      { ref: 98, satisfied: true },
      { ref: 99, satisfied: false },
    ]);
  });

  it("ignores non-blocked exclusions (held, in-flight, gate failures)", async () => {
    const i1 = issue({ number: 1 });
    const i2 = issue({ number: 2 });
    const view = await projectBacklog(
      [i1, i2],
      plan({
        excluded: [
          { issue: i1, reason: "held" },
          { issue: i2, reason: "not-afk" },
        ],
      }),
      [],
      noneSatisfied,
    );
    expect(view.eligible).toHaveLength(0);
    expect(view.blocked).toHaveLength(0);
    expect(view.paused).toHaveLength(0);
    expect(view.manualHolds).toHaveLength(0);
    expect(view.modingCandidates).toHaveLength(0);
  });

  it("surfaces ready hitl issues as manual holds so the UI can unpause them", async () => {
    const held = issue({ number: 6, labels: ["ready-for-agent", "hitl", "mode:tdd"], title: "operator paused" });
    const view = await projectBacklog(
      [held],
      plan({ excluded: [{ issue: held, reason: "not-afk" }] }),
      [],
      noneSatisfied,
    );
    expect(view.manualHolds).toEqual([{ issueNumber: 6, title: "operator paused" }]);
    expect(view.paused).toHaveLength(0);
  });

  it("maps dep-free no-mode exclusions to moding candidates, sorted by issue number", async () => {
    // `no-mode` is the gate's verdict for a ready+afk issue whose only missing
    // condition is a `mode:*` label — and, for these dep-free issues, exactly the
    // moding pass's candidates (the synthetic-mode gate passes with no blockers).
    const i7 = issue({ number: 7, labels: ["ready-for-agent", "afk"], title: "no mode here" });
    const i2 = issue({ number: 2, labels: ["ready-for-agent", "afk"], title: "also unmoded" });
    const view = await projectBacklog(
      [i7, i2],
      plan({
        excluded: [
          { issue: i7, reason: "no-mode" },
          { issue: i2, reason: "no-mode" },
          // A different gate failure is NOT a moding candidate.
          { issue: issue({ number: 9 }), reason: "not-ready" },
        ],
      }),
      [],
      noneSatisfied,
    );
    expect(view.modingCandidates).toEqual([
      { issueNumber: 2, title: "also unmoded" },
      { issueNumber: 7, title: "no mode here" },
    ]);
    // Moding candidates are neither eligible nor blocked nor paused.
    expect(view.eligible).toHaveLength(0);
    expect(view.blocked).toHaveLength(0);
    expect(view.paused).toHaveLength(0);
  });

  it("files a blocked-and-unmoded issue under blocked, not moding candidates (real admit)", async () => {
    // The bug this guards (issue #113): admit's gate emits `no-mode` at the mode check,
    // BEFORE it resolves `## Blocked by` deps, so a ready+afk issue that is BOTH unmoded
    // AND dependency-blocked is excluded as `no-mode` — not `blocked`. A naive projection
    // would list it under 'Moding-pass candidates' (which the auto-mode pass would never
    // act on) and hide its blocked-ness. Drive the REAL admit so the divergence is covered.
    const blockedUnmoded = issue({
      number: 8,
      labels: ["ready-for-agent", "afk"], // unmoded
      body: "## Blocked by\n- #99\n", // #99 unsatisfied below
      title: "blocked and unmoded",
    });
    const depCleanUnmoded = issue({
      number: 6,
      labels: ["ready-for-agent", "afk"], // unmoded
      body: "## Blocked by\n- #50\n", // #50 satisfied below
      title: "unmoded, deps met",
    });
    const plainUnmoded = issue({ number: 4, labels: ["ready-for-agent", "afk"], title: "just unmoded" });
    const isDependencySatisfied = async (n: number) => n === 50;
    const world: World = {
      isInFlight: () => false,
      getRun: () => undefined,
      isDependencySatisfied,
      openSlots: 5,
      priorityLabels: [],
      hasImplProviderHeadroom: () => true,
    };

    const plan = await admit([blockedUnmoded, depCleanUnmoded, plainUnmoded], world);
    // admit reports ALL three as `no-mode` — it short-circuited before resolving #8's dep.
    expect(plan.excluded.map((e) => [e.issue.number, e.reason])).toEqual([
      [8, "no-mode"],
      [6, "no-mode"],
      [4, "no-mode"],
    ]);

    const view = await projectBacklog(
      [blockedUnmoded, depCleanUnmoded, plainUnmoded],
      plan,
      world.priorityLabels,
      isDependencySatisfied,
    );
    // The blocked-and-unmoded issue is filed under Blocked with its dep mini-graph...
    expect(view.blocked).toEqual([
      { issueNumber: 8, title: "blocked and unmoded", blockers: [{ ref: 99, satisfied: false }] },
    ]);
    // ...and is NOT a moding candidate; only the genuinely dep-satisfied unmoded issues are
    // (proving the projection resolves deps, not just echoes admit's `no-mode` set).
    expect(view.modingCandidates).toEqual([
      { issueNumber: 4, title: "just unmoded" },
      { issueNumber: 6, title: "unmoded, deps met" },
    ]);
  });

  it("groups paused/stuck issues by their human-attention label, sorted, even when held", async () => {
    const issues = [
      issue({ number: 3, labels: ["ready-for-agent", "afk", "mode:tdd", "agent-stuck"] }),
      issue({ number: 1, labels: ["ready-for-agent", "afk", "mode:tdd", "awaiting-answer"] }),
      issue({ number: 2, labels: ["ready-for-agent", "afk", "mode:tdd", "review-maxed"] }),
      issue({ number: 4, labels: ["mode:tdd", "daemon-anomaly"] }),
    ];
    // Paused is read off the labels, independent of admission: even if #1 is held
    // by a still-active run, it still surfaces so a stuck issue never vanishes.
    const view = await projectBacklog(issues, plan({ excluded: [{ issue: issues[1]!, reason: "held" }] }), [], noneSatisfied);
    expect(view.paused).toEqual([
      { issueNumber: 1, title: "Issue 1", state: "awaiting-answer" },
      { issueNumber: 2, title: "Issue 2", state: "review-maxed" },
      { issueNumber: 3, title: "Issue 3", state: "agent-stuck" },
      { issueNumber: 4, title: "Issue 4", state: "daemon-anomaly" },
    ]);
  });
});
