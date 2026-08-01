import { describe, expect, it } from "vitest";
import type { RecordedStreamEvent } from "../store/event-log";
import {
  evaluateMasterBudget,
  MAX_MASTER_INTERVENTIONS_PER_PHASE,
  readoptedAttemptBudget,
  resolutionAllowed,
  resumeAttempt,
} from "./budget";
import { emptyMasterHistory, foldMasterHistory } from "./history";

let position = 0;
const ev = (type: string, data: unknown): RecordedStreamEvent => ({
  type,
  data,
  streamPosition: ++position,
  globalPosition: position,
});

const started = (): RecordedStreamEvent => ev("RunStarted", { runId: "r1", mode: "tdd" });
const requested = (signature: string): RecordedStreamEvent =>
  ev("MasterTriageRequested", {
    runId: "r1",
    source: "escalate",
    phase: "impl",
    lane: "impl",
    signature,
    headline: "h",
  });
const intervention = (attempt: number, signature: string, resolution: string): RecordedStreamEvent[] => [
  ev("MasterInterventionStarted", { runId: "r1", attempt, phase: "impl", signature }),
  ev("MasterResolutionSelected", { runId: "r1", attempt, phase: "impl", resolution, rationale: "why" }),
  ev("MasterInterventionCompleted", { runId: "r1", attempt, phase: "impl", resolution }),
];

describe("master loop budget (ADR-0041)", () => {
  it("allows two interventions per run phase and refuses the third", () => {
    const first = evaluateMasterBudget({ history: emptyMasterHistory(), phase: "impl", signature: "s1" });
    expect(first).toMatchObject({ allowed: true, attempt: 1, spent: 0, finalAttempt: false });

    const afterOne = foldMasterHistory([started(), requested("s1"), ...intervention(1, "s1", "redispatch-tier-1")]);
    const second = evaluateMasterBudget({ history: afterOne, phase: "impl", signature: "s2" });
    expect(second).toMatchObject({ allowed: true, attempt: 2, spent: 1, finalAttempt: true });

    const afterTwo = foldMasterHistory([
      started(),
      requested("s1"),
      ...intervention(1, "s1", "redispatch-tier-1"),
      ...intervention(2, "s2", "retry-pipeline"),
    ]);
    const third = evaluateMasterBudget({ history: afterTwo, phase: "impl", signature: "s3" });
    expect(third).toEqual(expect.objectContaining({ allowed: false, reason: "budget-exhausted", spent: 2 }));
    expect(MAX_MASTER_INTERVENTIONS_PER_PHASE).toBe(2);
  });

  it("counts per phase — a different phase has its own budget", () => {
    const history = foldMasterHistory([
      started(),
      ev("MasterInterventionStarted", { runId: "r1", attempt: 1, phase: "impl", signature: "s1" }),
      ev("MasterInterventionCompleted", { runId: "r1", attempt: 1, phase: "impl", resolution: "retry-pipeline" }),
      ev("MasterInterventionStarted", { runId: "r1", attempt: 1, phase: "review-1", signature: "s9" }),
      ev("MasterInterventionCompleted", { runId: "r1", attempt: 1, phase: "review-1", resolution: "retry-pipeline" }),
    ]);
    expect(evaluateMasterBudget({ history, phase: "impl", signature: "x" })).toMatchObject({ spent: 1 });
    expect(evaluateMasterBudget({ history, phase: "review-1", signature: "x" })).toMatchObject({ spent: 1 });
    expect(evaluateMasterBudget({ history, phase: "merge", signature: "x" })).toMatchObject({ spent: 0 });
  });

  it("forbids repeating the same resolution for a repeated signature", () => {
    const history = foldMasterHistory([started(), requested("s1"), ...intervention(1, "s1", "redispatch-tier-1")]);
    const verdict = evaluateMasterBudget({ history, phase: "impl", signature: "s1" });
    expect(verdict).toMatchObject({ allowed: true, repeatedSignature: true });
    expect(verdict.allowed && verdict.forbiddenResolutions).toEqual(["redispatch-tier-1"]);
    expect(resolutionAllowed(verdict, "redispatch-tier-1")).toBe(false);
    expect(resolutionAllowed(verdict, "retry-pipeline")).toBe(true);
    expect(resolutionAllowed(verdict, "ask-human")).toBe(true);
    expect(resolutionAllowed(verdict, "terminal-stuck")).toBe(true);
  });

  it("treats a fresh signature as unconstrained", () => {
    const history = foldMasterHistory([started(), requested("s1"), ...intervention(1, "s1", "redispatch-tier-1")]);
    const verdict = evaluateMasterBudget({ history, phase: "impl", signature: "different" });
    expect(verdict).toMatchObject({ allowed: true, repeatedSignature: false });
    expect(verdict.allowed && verdict.forbiddenResolutions).toEqual([]);
    expect(resolutionAllowed(verdict, "redispatch-tier-1")).toBe(true);
  });

  it("permits only final adjudication once the budget is exhausted", () => {
    const history = foldMasterHistory([
      started(),
      ...intervention(1, "s1", "redispatch-tier-1"),
      ...intervention(2, "s1", "retry-pipeline"),
    ]);
    const verdict = evaluateMasterBudget({ history, phase: "impl", signature: "s1" });
    expect(verdict.allowed).toBe(false);
    expect(resolutionAllowed(verdict, "retry-pipeline")).toBe(false);
    expect(resolutionAllowed(verdict, "ask-human")).toBe(true);
    expect(resolutionAllowed(verdict, "terminal-stuck")).toBe(true);
  });

  it("re-adopts an interrupted attempt instead of spending a fresh one", () => {
    const history = foldMasterHistory([
      started(),
      requested("s1"),
      ev("MasterInterventionStarted", { runId: "r1", attempt: 1, phase: "impl", signature: "s1" }),
    ]);
    const open = resumeAttempt(history);
    expect(open).toMatchObject({ attempt: 1, phase: "impl", completed: false });
    // The pending request was consumed by that start — no second session may be handed it.
    expect(history.pending).toBeNull();
  });

  it("resets the per-run budget on a genuinely new run span but keeps cross-span facts", () => {
    const history = foldMasterHistory([
      started(),
      ev("ComplexityPromoted", { tier: 1, from: 2 }),
      ...intervention(1, "s1", "redispatch-tier-1"),
      ...intervention(2, "s1", "ask-human"),
      ev("RunStarted", { runId: "r2", mode: "tdd" }),
    ]);
    expect(history.interventions).toEqual([]);
    expect(history.promoted).toBe(true);
    expect(evaluateMasterBudget({ history, phase: "impl", signature: "s1" })).toMatchObject({
      allowed: true,
      attempt: 1,
      repeatedSignature: false,
    });
  });

  it("does not forbid a resolution an interrupted (undecided) attempt never chose", () => {
    const history = foldMasterHistory([
      started(),
      ev("MasterInterventionStarted", { runId: "r1", attempt: 1, phase: "impl", signature: "s1" }),
      ev("MasterInterventionCompleted", { runId: "r1", attempt: 1, phase: "impl", resolution: "" }),
    ]);
    const verdict = evaluateMasterBudget({ history, phase: "impl", signature: "s1" });
    expect(verdict.allowed && verdict.forbiddenResolutions).toEqual([]);
  });

  it("a crash-resumed attempt inherits the repeated-signature constraint it was interrupted mid-way through", () => {
    // Attempt 1 tried `retry-pipeline` on signature s1; the pipeline failed with the SAME
    // signature; attempt 2 started and the daemon died before it decided. Re-adopting attempt 2
    // must NOT be told the signature is fresh — that is exactly how the loop this budget exists
    // to prevent gets back in.
    const history = foldMasterHistory([
      started(),
      requested("s1"),
      ...intervention(1, "s1", "retry-pipeline"),
      ev("MasterInterventionStarted", { runId: "r1", attempt: 2, phase: "impl", signature: "s1" }),
    ]);
    const open = resumeAttempt(history)!;
    const verdict = readoptedAttemptBudget(history, open, false);

    expect(verdict).toMatchObject({ allowed: true, attempt: 2, repeatedSignature: true, finalAttempt: true });
    expect(verdict.allowed && verdict.forbiddenResolutions).toEqual(["retry-pipeline"]);
    expect(resolutionAllowed(verdict, "retry-pipeline")).toBe(false);
    expect(resolutionAllowed(verdict, "ask-human")).toBe(true);
  });

  it("a crash-resumed attempt on a FRESH signature stays unconstrained", () => {
    const history = foldMasterHistory([
      started(),
      ...intervention(1, "s1", "retry-pipeline"),
      ev("MasterInterventionStarted", { runId: "r1", attempt: 2, phase: "impl", signature: "different" }),
    ]);
    const verdict = readoptedAttemptBudget(history, resumeAttempt(history)!, false);
    expect(verdict).toMatchObject({ repeatedSignature: false });
    expect(verdict.allowed && verdict.forbiddenResolutions).toEqual([]);
  });

  it("a HUMAN-resumed attempt may not ask again, on top of whatever it already inherited", () => {
    const history = foldMasterHistory([
      started(),
      ...intervention(1, "s1", "retry-pipeline"),
      ev("MasterInterventionStarted", { runId: "r1", attempt: 2, phase: "impl", signature: "s1" }),
      ev("MasterHumanQuestionRequested", { runId: "r1", attempt: 2, phase: "impl", headline: "h" }),
    ]);
    const open = history.interventions.find((i) => i.attempt === 2)!;
    const verdict = readoptedAttemptBudget(history, open, true);
    expect(verdict.allowed && verdict.forbiddenResolutions.sort()).toEqual(["ask-human", "retry-pipeline"]);
    expect(resolutionAllowed(verdict, "terminal-stuck")).toBe(true);
  });

  it("never refuses an already-open attempt — it constrains its resolutions instead", () => {
    // Pathological: two completed attempts AND an open third (a state the engine cannot
    // produce, but the fold must survive). Refusing would strand the run with no session and
    // no terminal, so the attempt runs under final-adjudication-only constraints.
    const history = foldMasterHistory([
      started(),
      ...intervention(1, "s1", "retry-pipeline"),
      ...intervention(2, "s1", "redispatch-tier-1"),
      ev("MasterInterventionStarted", { runId: "r1", attempt: 3, phase: "impl", signature: "s1" }),
    ]);
    const verdict = readoptedAttemptBudget(history, resumeAttempt(history)!, false);
    expect(verdict.allowed).toBe(true);
    expect(resolutionAllowed(verdict, "retry-pipeline")).toBe(false);
    expect(resolutionAllowed(verdict, "ask-human")).toBe(true);
    expect(resolutionAllowed(verdict, "terminal-stuck")).toBe(true);
  });
});
