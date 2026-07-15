import { describe, expect, it } from "vitest";
import {
  decide,
  evolve,
  initialIssueState,
  IssueCommandError,
  issueDecider,
  type IssueCommand,
  type IssueState,
} from "./decider";
import type { IssueEvent } from "./event-types";

/** Fold a sequence of events from the initial state — the aggregate fold under test. */
function fold(events: IssueEvent[], from: IssueState = initialIssueState()): IssueState {
  return events.reduce(evolve, from);
}

describe("initialIssueState", () => {
  it("is an empty, run-less state", () => {
    expect(initialIssueState()).toEqual({
      status: "none",
      runId: null,
      prNumber: null,
      fixAttempts: { 0: 0, 1: 0, 2: 0 },
      anomaly: null,
      ended: false,
      route: null,
    });
  });

  it("is a fresh object each call (no shared mutable state)", () => {
    const a = initialIssueState();
    a.fixAttempts[1] = 5;
    expect(initialIssueState().fixAttempts[1]).toBe(0);
  });
});

describe("evolve", () => {
  it("RunStarted begins a running run and clears run-scoped state", () => {
    const state = evolve(initialIssueState(), {
      type: "RunStarted",
      data: { runId: "r1", mode: "tdd" },
    });
    expect(state.status).toBe("running");
    expect(state.runId).toBe("r1");
    expect(state.prNumber).toBeNull();
    expect(state.fixAttempts).toEqual({ 0: 0, 1: 0, 2: 0 });
  });

  it("counts FixAttempted per phase (the fix count IS the event count, ADR-0024)", () => {
    const state = fold([
      { type: "RunStarted", data: { runId: "r1", mode: "tdd" } },
      { type: "FixAttempted", data: { runId: "r1", phase: 1 } },
      { type: "FixAttempted", data: { runId: "r1", phase: 1 } },
      { type: "FixAttempted", data: { runId: "r1", phase: 2 } },
    ]);
    expect(state.fixAttempts).toEqual({ 0: 0, 1: 2, 2: 1 });
  });

  it("ReviewPhaseEntered opens a fresh span: it zeros only that phase's count (ADR-0025)", () => {
    const state = fold([
      { type: "RunStarted", data: { runId: "r1", mode: "tdd" } },
      { type: "FixAttempted", data: { runId: "r1", phase: 1 } },
      { type: "FixAttempted", data: { runId: "r1", phase: 1 } },
      { type: "FixAttempted", data: { runId: "r1", phase: 2 } },
      // Re-entering phase 1 resets its count by construction (no destructive delete);
      // phase 2's count is untouched.
      { type: "ReviewPhaseEntered", data: { runId: "r1", phase: 1 } },
    ]);
    expect(state.fixAttempts).toEqual({ 0: 0, 1: 0, 2: 1 });

    // A FixAttempted after the re-entry counts from the fresh span.
    const next = evolve(state, { type: "FixAttempted", data: { runId: "r1", phase: 1 } });
    expect(next.fixAttempts[1]).toBe(1);
  });

  it("Escalated → awaiting-answer, Resumed → running", () => {
    const escalated = fold([
      { type: "RunStarted", data: { runId: "r1", mode: "tdd" } },
      { type: "Escalated", data: { runId: "r1", kind: "escalate", commentId: 7 } },
    ]);
    expect(escalated.status).toBe("awaiting-answer");
    const resumed = fold(
      [{ type: "Resumed", data: { runId: "r1" } }],
      escalated,
    );
    expect(resumed.status).toBe("running");
  });

  it("QuestionAnswered records the answer without flipping status (resume does)", () => {
    const answered = fold([
      { type: "RunStarted", data: { runId: "r1", mode: "tdd" } },
      { type: "Escalated", data: { runId: "r1", kind: "escalate", commentId: 7 } },
      { type: "QuestionAnswered", data: { runId: "r1", commentId: 7 } },
    ]);
    expect(answered.status).toBe("awaiting-answer");
  });

  it("ReviewPhasePassed is a within-span milestone — status stays running (issue #81)", () => {
    // Passing review phases (even the final thermo phase) does NOT pin awaiting-merge: the
    // integration fast-path may skip the final phase's re-review, so a passed phase is not a
    // reliable hand-off signal. Status stays `running` until the explicit `ReviewPassed` fact.
    const state = fold([
      { type: "RunStarted", data: { runId: "r1", mode: "tdd" } },
      { type: "PrOpened", data: { runId: "r1", prNumber: 42 } },
      { type: "ReviewPhasePassed", data: { runId: "r1", phase: 0 } },
      { type: "ReviewPhasePassed", data: { runId: "r1", phase: 1 } },
      { type: "ReviewPhasePassed", data: { runId: "r1", phase: 2 } },
    ]);
    expect(state.prNumber).toBe(42);
    expect(state.status).toBe("running");
  });

  it("ReviewPassed pins awaiting-merge; CiAwaited pins awaiting-ci (issue #81)", () => {
    const base = fold([{ type: "RunStarted", data: { runId: "r1", mode: "tdd" } }]);
    // The fast-path-safe review→integration hand-off.
    expect(evolve(base, { type: "ReviewPassed", data: { runId: "r1" } }).status).toBe("awaiting-merge");
    // The off-slot pre-review CI park (ADR-0022 stage 1).
    expect(evolve(base, { type: "CiAwaited", data: { runId: "r1" } }).status).toBe("awaiting-ci");
  });

  it("RouteResolved records the dispatched route (ADR-0037 P3.1, issue #164)", () => {
    const state = fold([
      { type: "RunStarted", data: { runId: "r1", mode: "tdd" } },
      {
        type: "RouteResolved",
        data: { runId: "r1", phase: "impl", route: { provider: "claude", model: "opus", account: "c1" } },
      },
    ]);
    expect(state.route).toEqual({ provider: "claude", model: "opus", account: "c1" });
  });

  it("RouteResolved is latest-wins: a re-dispatch overwrites the recorded route (resume granularity)", () => {
    // One container = one route for its whole life (ADR-0038); a route changes only BETWEEN
    // containers. A resume's re-dispatch emits a fresh RouteResolved and the latest wins — there
    // is no per-phase list, so a mid-phase rotation is unrepresentable (the recording is one value).
    const state = fold([
      { type: "RunStarted", data: { runId: "r1", mode: "tdd" } },
      { type: "RouteResolved", data: { runId: "r1", phase: "impl", route: { provider: "claude", account: "c1" } } },
      // Resume re-dispatches the same phase onto a different account.
      { type: "Resumed", data: { runId: "r1" } },
      { type: "RouteResolved", data: { runId: "r1", phase: "impl", route: { provider: "zai", model: "glm-5.2", account: "z3" } } },
    ]);
    expect(state.route).toEqual({ provider: "zai", model: "glm-5.2", account: "z3" });
  });

  it("RunStarted clears a prior run's route (a fresh span has no route until it dispatches)", () => {
    const state = fold([
      { type: "RunStarted", data: { runId: "r1", mode: "tdd" } },
      { type: "RouteResolved", data: { runId: "r1", phase: "impl", route: { provider: "claude", account: "c1" } } },
      // A re-pickup opens a new span: run-scoped state (incl. the route) resets.
      { type: "RunStarted", data: { runId: "r2", mode: "tdd" } },
    ]);
    expect(state.route).toBeNull();
  });

  it("RunEnded { closed } projects the effect-neutral closed terminal (issue #81)", () => {
    // The one sanctioned divergence: a closed-issue orphan-discard has no other status fact,
    // so `closed` is read truthfully (it never merged) — terminal, no daemon-set label.
    const state = fold([
      { type: "RunStarted", data: { runId: "r1", mode: "tdd" } },
      { type: "ReviewPassed", data: { runId: "r1" } },
      { type: "RunEnded", data: { runId: "r1", outcome: "closed" } },
    ]);
    expect(state.status).toBe("closed");
    expect(state.ended).toBe(true);
  });

  it("RunEnded { merged | stuck } leaves the pinned status untouched (issue #81)", () => {
    const merged = fold([
      { type: "RunStarted", data: { runId: "r1", mode: "tdd" } },
      { type: "Merged", data: { runId: "r1", prNumber: 7 } },
      { type: "RunEnded", data: { runId: "r1", outcome: "merged" } },
    ]);
    expect(merged.status).toBe("merged");
    const stuck = fold([
      { type: "RunStarted", data: { runId: "r1", mode: "tdd" } },
      { type: "RunStuck", data: { runId: "r1", reason: "futility" } },
      { type: "RunEnded", data: { runId: "r1", outcome: "stuck" } },
    ]);
    expect(stuck.status).toBe("agent-stuck");
  });

  it("ReviewMaxed / RunStuck / Merged drive terminal-ish status", () => {
    const base = fold([{ type: "RunStarted", data: { runId: "r1", mode: "tdd" } }]);
    expect(evolve(base, { type: "ReviewMaxed", data: { runId: "r1", phase: 1 } }).status).toBe(
      "review-maxed",
    );
    expect(evolve(base, { type: "RunStuck", data: { runId: "r1", reason: "no-green-build" } }).status).toBe(
      "agent-stuck",
    );
    const merged = evolve(base, { type: "Merged", data: { runId: "r1", prNumber: 42 } });
    expect(merged.status).toBe("merged");
    expect(merged.prNumber).toBe(42);
  });

  it("RunEnded marks the run ended; AnomalyDetected/Cleared toggle the anomaly", () => {
    let state = fold([
      { type: "RunStarted", data: { runId: "r1", mode: "tdd" } },
      { type: "RunEnded", data: { runId: "r1", outcome: "merged" } },
    ]);
    expect(state.ended).toBe(true);
    state = evolve(state, { type: "AnomalyDetected", data: { reason: "island" } });
    expect(state.anomaly).toBe("island");
    state = evolve(state, { type: "AnomalyCleared", data: {} });
    expect(state.anomaly).toBeNull();
  });

  it("RunStarted carries the span's branch/worktreePath but folds the same lifecycle (issue #80)", () => {
    // The span records its branch + worktree as history; the lifecycle fold ignores them
    // (the same `running` state as a bare RunStarted) — run status stays derived (ADR-0024).
    const withSpan = fold([
      { type: "RunStarted", data: { runId: "r1", mode: "tdd", branch: "ralph/9-x", worktreePath: "/wt/9" } },
    ]);
    const bare = fold([{ type: "RunStarted", data: { runId: "r1", mode: "tdd" } }]);
    expect(withSpan).toEqual(bare);
    expect(withSpan.status).toBe("running");
  });

  it("RunEnded { closed } marks the run ended (issue #80 outcome)", () => {
    const state = fold([
      { type: "RunStarted", data: { runId: "r1", mode: "tdd" } },
      { type: "RunEnded", data: { runId: "r1", outcome: "closed" } },
    ]);
    expect(state.ended).toBe(true);
  });

  it("a re-pickup (second RunStarted) resets run-scoped state but keeps a standing anomaly", () => {
    const afterFirst = fold([
      { type: "RunStarted", data: { runId: "r1", mode: "tdd" } },
      { type: "FixAttempted", data: { runId: "r1", phase: 1 } },
      { type: "PrOpened", data: { runId: "r1", prNumber: 42 } },
      { type: "AnomalyDetected", data: { reason: "island" } },
    ]);
    const afterSecond = evolve(afterFirst, {
      type: "RunStarted",
      data: { runId: "r2", mode: "infra" },
    });
    expect(afterSecond.runId).toBe("r2");
    expect(afterSecond.fixAttempts).toEqual({ 0: 0, 1: 0, 2: 0 });
    expect(afterSecond.prNumber).toBeNull();
    expect(afterSecond.anomaly).toBe("island"); // cleared only by AnomalyCleared
  });

  it("is a tolerant reader: an unknown event type leaves state unchanged (ADR-0026)", () => {
    const base = fold([{ type: "RunStarted", data: { runId: "r1", mode: "tdd" } }]);
    const after = evolve(base, { type: "SomeFutureEventV9", data: { x: 1 } } as unknown as IssueEvent);
    expect(after).toEqual(base);
  });

  it("does not mutate the input state", () => {
    const base = fold([{ type: "RunStarted", data: { runId: "r1", mode: "tdd" } }]);
    const snapshot = structuredClone(base);
    evolve(base, { type: "FixAttempted", data: { runId: "r1", phase: 1 } });
    expect(base).toEqual(snapshot);
  });
});

describe("decide", () => {
  it("StartRun emits RunStarted from the initial state", () => {
    expect(decide({ type: "StartRun", data: { runId: "r1", mode: "tdd" } }, initialIssueState())).toEqual(
      { type: "RunStarted", data: { runId: "r1", mode: "tdd" } },
    );
  });

  it("StartRun carries the span's branch/worktreePath through to RunStarted (issue #80)", () => {
    expect(
      decide(
        { type: "StartRun", data: { runId: "r1", mode: "tdd", branch: "ralph/9-x", worktreePath: "/wt/9" } },
        initialIssueState(),
      ),
    ).toEqual({ type: "RunStarted", data: { runId: "r1", mode: "tdd", branch: "ralph/9-x", worktreePath: "/wt/9" } });
  });

  it("EndRun emits RunEnded with the closed outcome (issue #80)", () => {
    const started = fold([{ type: "RunStarted", data: { runId: "r1", mode: "tdd" } }]);
    expect(decide({ type: "EndRun", data: { runId: "r1", outcome: "closed" } }, started)).toEqual({
      type: "RunEnded",
      data: { runId: "r1", outcome: "closed" },
    });
  });

  it("rejects run-scoped commands before any run has started", () => {
    const runScoped: IssueCommand[] = [
      { type: "OpenPr", data: { runId: "r1", prNumber: 1 } },
      { type: "RecordFixAttempt", data: { runId: "r1", phase: 1 } },
      { type: "EnterReviewPhase", data: { runId: "r1", phase: 1 } },
      { type: "Escalate", data: { runId: "r1", kind: "escalate", commentId: null } },
      { type: "Resume", data: { runId: "r1" } },
      { type: "PassReviewPhase", data: { runId: "r1", phase: 1 } },
      { type: "MaxReview", data: { runId: "r1", phase: 1 } },
      { type: "MarkStuck", data: { runId: "r1", reason: "futility" } },
      { type: "RecordMerge", data: { runId: "r1", prNumber: 1 } },
      { type: "EndRun", data: { runId: "r1", outcome: "merged" } },
      { type: "RecordRoute", data: { runId: "r1", phase: "impl", route: { provider: "claude", account: "c1" } } },
    ];
    for (const command of runScoped) {
      expect(() => decide(command, initialIssueState())).toThrow(IssueCommandError);
    }
  });

  it("allows anomaly + late-answer commands without a run", () => {
    expect(decide({ type: "DetectAnomaly", data: { reason: "island" } }, initialIssueState())).toEqual({
      type: "AnomalyDetected",
      data: { reason: "island" },
    });
    expect(decide({ type: "ClearAnomaly", data: {} }, initialIssueState())).toEqual({
      type: "AnomalyCleared",
      data: {},
    });
    expect(
      decide({ type: "AnswerQuestion", data: { runId: "r1", commentId: 7 } }, initialIssueState()),
    ).toEqual({ type: "QuestionAnswered", data: { runId: "r1", commentId: 7 } });
  });

  it("permits run-scoped commands once a run is running", () => {
    const running = evolve(initialIssueState(), {
      type: "RunStarted",
      data: { runId: "r1", mode: "tdd" },
    });
    expect(decide({ type: "RecordFixAttempt", data: { runId: "r1", phase: 2 } }, running)).toEqual({
      type: "FixAttempted",
      data: { runId: "r1", phase: 2 },
    });
    expect(decide({ type: "EnterReviewPhase", data: { runId: "r1", phase: 1 } }, running)).toEqual({
      type: "ReviewPhaseEntered",
      data: { runId: "r1", phase: 1 },
    });
    expect(
      decide(
        { type: "RecordRoute", data: { runId: "r1", phase: "impl", route: { provider: "claude", account: "c1" } } },
        running,
      ),
    ).toEqual({
      type: "RouteResolved",
      data: { runId: "r1", phase: "impl", route: { provider: "claude", account: "c1" } },
    });
  });

  it("decide → evolve round-trips: applying the decided event advances state", () => {
    let state = initialIssueState();
    const apply = (command: IssueCommand) => {
      const decided = decide(command, state);
      const events = Array.isArray(decided) ? decided : [decided];
      state = events.reduce(evolve, state);
    };
    apply({ type: "StartRun", data: { runId: "r1", mode: "tdd" } });
    apply({ type: "RecordFixAttempt", data: { runId: "r1", phase: 1 } });
    apply({ type: "RecordMerge", data: { runId: "r1", prNumber: 9 } });
    expect(state.status).toBe("merged");
    expect(state.fixAttempts[1]).toBe(1);
    expect(state.prNumber).toBe(9);
  });

  it("exposes the decider triple", () => {
    expect(issueDecider.decide).toBe(decide);
    expect(issueDecider.evolve).toBe(evolve);
    expect(issueDecider.initialState).toBe(initialIssueState);
  });
});
