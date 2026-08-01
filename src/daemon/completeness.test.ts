/**
 * The completeness-invariant property / matrix test (issue #27 AC3). It proves the
 * core guarantee against regression: across the **full** (label set × run status)
 * matrix — crossed with in-flight, resumable, and issue state — every open issue
 * and every non-terminal run is classified into exactly one of
 * `{eligible, in-flight, awaiting-human, terminal}`, and any combination that is
 * acted on by nothing (an island) or that contradicts itself is surfaced as an
 * `anomaly` rather than classified as a live state. No (label set × run status)
 * combination ever leaves an issue acted-on-by-nothing without surfacing it.
 *
 * The classifier is the single source of truth the reconciler's pickup / resume /
 * sweep paths must agree with; the two islands the original build missed — #8
 * (crash abandons in-flight runs) and #9 (an answered `review-maxed` heal picked
 * up by nothing) — are asserted to land in `anomaly`, structurally.
 */

import { describe, expect, it } from "vitest";
import { evaluateGate } from "../core/admission";
import type { Issue, IssueState } from "../github/types";
import type { RunStatus } from "../store/types";
import {
  anomalyEnqueuesMaster,
  classifyIssueState,
  isNonTerminalStatus,
  OPERATOR_OWNED_ANOMALIES,
  type Classification,
  type IssueSnapshot,
} from "./completeness";
import {
  LABEL_AGENT_STUCK,
  LABEL_AWAITING_ANSWER,
  LABEL_MASTER_TRIAGE,
  LABEL_REVIEW_MAXED,
} from "../core/labels";

/** Representative label sets spanning the daemon's whole label vocabulary. */
const LABEL_SETS: Record<string, string[]> = {
  eligible: ["ready-for-agent", "afk", "mode:tdd"],
  eligibleUi: ["ready-for-agent", "afk", "mode:ui"],
  noAfk: ["ready-for-agent", "mode:tdd"],
  hitl: ["ready-for-agent", "afk", "hitl", "mode:tdd"],
  noMode: ["ready-for-agent", "afk"],
  awaiting: ["awaiting-answer", "afk", "mode:tdd"],
  reviewMaxed: ["review-maxed", "afk", "mode:tdd"],
  awaitingCi: ["awaiting-ci", "afk", "mode:tdd"],
  awaitingMerge: ["awaiting-merge", "afk", "mode:tdd"],
  masterTriage: ["master-triage", "afk", "mode:tdd", "complexity:1"],
  agentStuck: ["agent-stuck", "afk", "mode:tdd"],
  logIssue: ["ready-for-agent", "afk", "mode:tdd", "[log] milestone"],
  needsTriage: ["needs-triage"],
  empty: [],
};

const RUN_STATUSES: Array<RunStatus | null> = [
  null,
  "running",
  "awaiting-answer",
  "review-maxed",
  "awaiting-ci",
  "awaiting-merge",
  "master-triage",
  "agent-stuck",
  "merged",
  "closed",
];

const ISSUE_STATES: Array<IssueState | "gone"> = ["OPEN", "CLOSED", "gone"];

/** The gate verdict for a label set on an OPEN issue, deps always satisfied. */
function gateEligibleFor(labels: string[], state: IssueState | "gone"): boolean {
  if (state !== "OPEN") {
    return false;
  }
  const issue: Issue = { number: 1, title: "t", body: "", state, labels, createdAt: "2026-01-01T00:00:00Z" };
  return evaluateGate(issue, () => true, "owner/repo").eligible;
}

/** Every combination in the matrix, as fully-resolved snapshots. */
function* matrix(): Generator<IssueSnapshot> {
  let n = 0;
  for (const labels of Object.values(LABEL_SETS)) {
    for (const runStatus of RUN_STATUSES) {
      for (const issueState of ISSUE_STATES) {
        for (const inFlight of [false, true]) {
          for (const resumable of [false, true]) {
            for (const wedged of [false, true]) {
              for (const answered of [false, true]) {
                for (const masterUnroutable of [false, true]) {
                  yield {
                    issueNumber: ++n,
                    issueState,
                    // A closed/gone issue exposes no labels to the reconciler.
                    labels: issueState === "OPEN" ? labels : [],
                    runStatus,
                    inFlight,
                    wedged,
                    gateEligible: gateEligibleFor(labels, issueState),
                    resumable,
                    answered,
                    masterUnroutable,
                  };
                }
              }
            }
          }
        }
      }
    }
  }
}

const KINDS = new Set<Classification["kind"]>([
  "eligible",
  "in-flight",
  "awaiting-human",
  "terminal",
  "anomaly",
]);

describe("classifyIssueState — totality over the full matrix (AC3)", () => {
  it("returns exactly one known class for every (label × status × flags) combination", () => {
    let count = 0;
    for (const snapshot of matrix()) {
      count++;
      const result = classifyIssueState(snapshot);
      expect(KINDS.has(result.kind), `unknown kind for ${JSON.stringify(snapshot)}`).toBe(true);
      if (result.kind === "anomaly") {
        expect(result.reason.length).toBeGreaterThan(0);
      }
    }
    // 14 label sets × 10 statuses × 3 issue states × 2 in-flight × 2 resumable × 2 wedged
    // × 2 answered × 2 master-unroutable.
    expect(count).toBe(14 * 10 * 3 * 2 * 2 * 2 * 2 * 2);
  });

  it("never lets a non-terminal run on a CLOSED or gone issue pass as a live state", () => {
    for (const snapshot of matrix()) {
      if (snapshot.issueState === "OPEN" || snapshot.inFlight) {
        continue;
      }
      if (snapshot.runStatus && isNonTerminalStatus(snapshot.runStatus)) {
        const result = classifyIssueState(snapshot);
        expect(result.kind, JSON.stringify(snapshot)).toBe("anomaly");
      }
    }
  });

  it("classifies an in-flight issue as in-flight regardless of labels or status, unless wedged", () => {
    for (const snapshot of matrix()) {
      if (!snapshot.inFlight) {
        continue;
      }
      const result = classifyIssueState(snapshot);
      if (snapshot.wedged) {
        // The wall-clock failed to settle it: a wedged in-flight run is an anomaly,
        // never a healthy in-flight state (#27 AC1; auto-termination tracked in #61).
        expect(result, JSON.stringify(snapshot)).toEqual({ kind: "anomaly", reason: "run-wedged-past-lifetime" });
      } else {
        expect(result.kind, JSON.stringify(snapshot)).toBe("in-flight");
      }
    }
  });

  it("only ever reports `eligible` for an open, gate-eligible issue with no holding run", () => {
    for (const snapshot of matrix()) {
      if (classifyIssueState(snapshot).kind !== "eligible") {
        continue;
      }
      expect(snapshot.issueState).toBe("OPEN");
      expect(snapshot.gateEligible).toBe(true);
      expect(snapshot.inFlight).toBe(false);
      // A non-terminal run row holds the issue, so `eligible` must not co-occur with one.
      const holding = snapshot.runStatus !== null && isNonTerminalStatus(snapshot.runStatus);
      expect(holding).toBe(false);
    }
  });

  it("only ever reports `terminal` for a non-open issue", () => {
    for (const snapshot of matrix()) {
      if (classifyIssueState(snapshot).kind === "terminal") {
        expect(snapshot.issueState).not.toBe("OPEN");
      }
    }
  });
});

describe("classifyIssueState — the known islands are surfaced, not hidden (AC1)", () => {
  const base: IssueSnapshot = {
    issueNumber: 1,
    issueState: "OPEN",
    labels: [],
    runStatus: null,
    inFlight: false,
    wedged: false,
    gateEligible: false,
    resumable: false,
    answered: false,
    masterUnroutable: false,
  };

  it("#8 — a `running` row the daemon is not executing is an anomaly", () => {
    const result = classifyIssueState({
      ...base,
      labels: ["ready-for-agent", "afk", "mode:tdd"],
      gateEligible: true,
      runStatus: "running",
    });
    expect(result).toEqual({ kind: "anomaly", reason: "running-row-not-in-flight" });
  });

  it("an in-flight run wedged past its lifetime ceiling (wall-clock failed) is an anomaly", () => {
    // The slot is held by a session the per-session wall-clock failed to settle.
    // In-flight is normally authoritative, but a wedged run is not healthy: surface
    // it (the daemon cannot silently reclaim a slot only its executor can free).
    const result = classifyIssueState({
      ...base,
      labels: ["ready-for-agent", "afk", "mode:tdd"],
      runStatus: "running",
      inFlight: true,
      wedged: true,
    });
    expect(result).toEqual({ kind: "anomaly", reason: "run-wedged-past-lifetime" });
  });

  it("#9 — an answered review-maxed heal that cannot resume is an anomaly", () => {
    // The operator answered: the CLI swapped `review-maxed` → `ready-for-agent`.
    // The run row is still `review-maxed`, but resume context was lost (not resumable):
    // nothing picks it up — the island #9 found.
    const result = classifyIssueState({
      ...base,
      labels: ["ready-for-agent", "afk", "mode:tdd"],
      gateEligible: true,
      runStatus: "review-maxed",
      resumable: false,
    });
    expect(result).toEqual({ kind: "anomaly", reason: "paused-run-unresumable" });
  });

  it("a `running` run whose issue is CLOSED is an anomaly", () => {
    const result = classifyIssueState({ ...base, issueState: "CLOSED", runStatus: "running" });
    expect(result).toEqual({ kind: "anomaly", reason: "non-terminal-run-on-closed-issue" });
  });

  it("a paused label with no run row to resume is an anomaly", () => {
    const result = classifyIssueState({
      ...base,
      labels: ["awaiting-answer", "afk", "mode:tdd"],
      runStatus: null,
    });
    expect(result).toEqual({ kind: "anomaly", reason: "paused-label-missing-run" });
  });

  it("#132 — an awaiting-answer pause whose latest question is already answered is an anomaly", () => {
    // The #132 wedge: an operator answered (a `ralph-answer` follows the latest
    // `ralph-question`), the daemon began resuming, but the rate-limited re-arm
    // failed — re-parking the run at `awaiting-answer` with no `ready-for-agent`.
    // It is now invisible to `ralph-answer` (already-answered ⇒ unservable) and to
    // resume (no `ready-for-agent`); surface it rather than park it silently.
    const result = classifyIssueState({
      ...base,
      labels: ["awaiting-answer", "afk", "mode:tdd"],
      runStatus: "awaiting-answer",
      resumable: false,
      answered: true,
    });
    expect(result).toEqual({ kind: "anomaly", reason: "answered-pause-stranded" });
  });

  it("#132 — a review-maxed pause whose latest question is already answered is an anomaly too", () => {
    // The same stranding can happen on the review-origin pause (the defer path
    // restores either paused status). An answered heal stuck at `review-maxed`
    // with no `ready-for-agent` is the same answered-but-stranded island.
    const result = classifyIssueState({
      ...base,
      labels: ["review-maxed", "afk", "mode:tdd"],
      runStatus: "review-maxed",
      resumable: false,
      answered: true,
    });
    expect(result).toEqual({ kind: "anomaly", reason: "answered-pause-stranded" });
  });

  it("a paused run whose human-attention label vanished is an anomaly", () => {
    // run row review-maxed, but neither review-maxed nor ready-for-agent present.
    const result = classifyIssueState({
      ...base,
      labels: ["afk", "mode:tdd"],
      runStatus: "review-maxed",
    });
    expect(result).toEqual({ kind: "anomaly", reason: "paused-run-label-missing" });
  });

  it("a run status the code does not know is surfaced, not skipped", () => {
    const result = classifyIssueState({
      ...base,
      runStatus: "frobnicating" as unknown as RunStatus,
    });
    expect(result).toEqual({ kind: "anomaly", reason: "unclassified" });
  });
});

describe("classifyIssueState — healthy states are not false-flagged (AC1)", () => {
  const base: IssueSnapshot = {
    issueNumber: 1,
    issueState: "OPEN",
    labels: [],
    runStatus: null,
    inFlight: false,
    wedged: false,
    gateEligible: false,
    resumable: false,
    answered: false,
    masterUnroutable: false,
  };

  it("an eligible issue with no run is `eligible`", () => {
    expect(
      classifyIssueState({
        ...base,
        labels: LABEL_SETS.eligible,
        gateEligible: true,
      }),
    ).toEqual({ kind: "eligible" });
  });

  it("a no-provider issue is `eligible`, never an island or daemon-anomaly (ADR-0037 P2.3, AC3)", () => {
    // The no-provider wait (ADR-0037) holds an otherwise-eligible issue at admission
    // WITHOUT touching its labels or starting a run: it keeps `ready-for-agent`, takes
    // no human-attention label, and no run row exists (it never launched). That is
    // byte-for-byte the eligible-with-no-run snapshot, so the completeness invariant
    // classifies it `eligible` (no island, never `daemon-anomaly`) — the next tick
    // re-resolves and admits it once a pool regains headroom.
    expect(
      classifyIssueState({
        ...base,
        labels: LABEL_SETS.eligible,
        gateEligible: true,
        runStatus: null,
        inFlight: false,
      }),
    ).toEqual({ kind: "eligible" });
  });

  it("an eligible issue with a terminal (merged / stuck) run is re-admitted as `eligible`", () => {
    for (const runStatus of ["merged", "agent-stuck"] as RunStatus[]) {
      expect(
        classifyIssueState({ ...base, labels: LABEL_SETS.eligible, gateEligible: true, runStatus }),
      ).toEqual({ kind: "eligible" });
    }
  });

  it("an answered, resumable pause is treated as in-flight (resumed this tick)", () => {
    for (const runStatus of ["awaiting-answer", "review-maxed"] as RunStatus[]) {
      expect(
        classifyIssueState({
          ...base,
          labels: LABEL_SETS.eligible, // label swapped back to ready-for-agent
          gateEligible: true,
          runStatus,
          resumable: true,
        }),
      ).toEqual({ kind: "in-flight" });
    }
  });

  it("an awaiting-ci run on an OPEN issue is in-flight (the CI poller owns it)", () => {
    // Parked off the build pool on the pre-review CI gate (ADR-0022 stage 1). The CI
    // poller reads its checks every tick and re-admits it — so it is being worked,
    // never a silent island, even though it holds no build slot while it waits.
    expect(
      classifyIssueState({ ...base, labels: LABEL_SETS.awaitingCi, runStatus: "awaiting-ci" }),
    ).toEqual({ kind: "in-flight" });
  });

  it("an awaiting-ci run whose issue closed under it is a non-terminal-on-closed anomaly", () => {
    expect(
      classifyIssueState({ ...base, issueState: "CLOSED", labels: [], runStatus: "awaiting-ci" }),
    ).toEqual({ kind: "anomaly", reason: "non-terminal-run-on-closed-issue" });
  });

  it("an awaiting-merge run on an OPEN issue is in-flight (the merge worker owns it)", () => {
    // The integration lease leases it every tick independent of the build pool,
    // so it is being worked — never a silent island (ADR-0017).
    expect(
      classifyIssueState({ ...base, labels: LABEL_SETS.awaitingMerge, runStatus: "awaiting-merge" }),
    ).toEqual({ kind: "in-flight" });
  });

  it("an awaiting-merge run whose issue closed under it is a non-terminal-on-closed anomaly", () => {
    expect(
      classifyIssueState({ ...base, issueState: "CLOSED", labels: [], runStatus: "awaiting-merge" }),
    ).toEqual({ kind: "anomaly", reason: "non-terminal-run-on-closed-issue" });
  });

  it("a master-triage run on an OPEN issue is IN-FLIGHT, never awaiting-human (ADR-0041)", () => {
    // The master queue services it every tick, before fresh admission, on the ordinary cap.
    // Classifying it as awaiting-human would page an operator for work the daemon is doing —
    // the exact inversion this slice exists to remove.
    expect(
      classifyIssueState({ ...base, labels: LABEL_SETS.masterTriage, runStatus: "master-triage" }),
    ).toEqual({ kind: "in-flight" });
  });

  it("a master-triage run whose issue closed under it is a non-terminal-on-closed anomaly", () => {
    expect(
      classifyIssueState({ ...base, issueState: "CLOSED", labels: [], runStatus: "master-triage" }),
    ).toEqual({ kind: "anomaly", reason: "non-terminal-run-on-closed-issue" });
  });

  it("a master-triage run the tier-1 config cannot dispatch is an ANOMALY, not in-flight", () => {
    // The defect is in config.yaml, not the issue, and no tick fixes it — so reporting it as
    // "the daemon is working on it" would hide the escalation forever.
    expect(
      classifyIssueState({
        ...base,
        labels: LABEL_SETS.masterTriage,
        runStatus: "master-triage",
        masterUnroutable: true,
      }),
    ).toEqual({ kind: "anomaly", reason: "master-route-unconfigured" });
  });

  it("does not report master-route-unconfigured for any other status", () => {
    for (const runStatus of ["running", "awaiting-ci", "awaiting-merge", "merged"] as RunStatus[]) {
      const result = classifyIssueState({ ...base, runStatus, masterUnroutable: true });
      expect(result.kind === "anomaly" && result.reason).not.toBe("master-route-unconfigured");
    }
  });

  it("a still-paused run on its visible label is awaiting-human", () => {
    expect(
      classifyIssueState({ ...base, labels: LABEL_SETS.awaiting, runStatus: "awaiting-answer" }),
    ).toEqual({ kind: "awaiting-human" });
    expect(
      classifyIssueState({ ...base, labels: LABEL_SETS.reviewMaxed, runStatus: "review-maxed" }),
    ).toEqual({ kind: "awaiting-human" });
  });

  it("a genuinely-unanswered pause is awaiting-human, never the #132 answered-but-stranded anomaly", () => {
    // `answered` is false (the operator has not replied yet): the run is legitimately
    // parked for a human, so it must stay `awaiting-human` — the anomaly fires only
    // once the comment ledger actually carries an answer to the latest question.
    expect(
      classifyIssueState({ ...base, labels: LABEL_SETS.awaiting, runStatus: "awaiting-answer", answered: false }),
    ).toEqual({ kind: "awaiting-human" });
  });

  it("an agent-stuck issue parked for a human is awaiting-human, not an island", () => {
    expect(
      classifyIssueState({ ...base, labels: LABEL_SETS.agentStuck, runStatus: "agent-stuck" }),
    ).toEqual({ kind: "awaiting-human" });
  });

  it("the heal lifecycle stays total: stuck-with-card → answered/ready → in-flight, no island (#86, AC4)", () => {
    // 1. Stuck, carrying its open stuck-card (a comment — labels unchanged): parked for
    //    a human. The card adds no label, so this is the same awaiting-human verdict.
    expect(
      classifyIssueState({ ...base, labels: LABEL_SETS.agentStuck, runStatus: "agent-stuck" }),
    ).toEqual({ kind: "awaiting-human" });

    // 2. Operator answered: the queue swapped `agent-stuck → ready-for-agent`. The run row
    //    is still the terminal `agent-stuck` (re-admittable, holds nothing), so the gate
    //    admits it for a FRESH run — `eligible`, not a resumable pause, never an anomaly.
    expect(
      classifyIssueState({ ...base, labels: LABEL_SETS.eligible, gateEligible: true, runStatus: "agent-stuck" }),
    ).toEqual({ kind: "eligible" });

    // 3. Re-admitted and executing: in-flight. The cycle closed with no new island/anomaly.
    expect(
      classifyIssueState({ ...base, labels: LABEL_SETS.eligible, gateEligible: true, runStatus: "running", inFlight: true }),
    ).toEqual({ kind: "in-flight" });
  });

  it("an answered stuck issue is NOT treated as a resumable pause (re-admit, not resume) (#86)", () => {
    // `resumable` is a no-op for a terminal `agent-stuck` row: there is no paused run to
    // resume, so even with resumable=true the verdict is `eligible` (a fresh re-admit),
    // never `in-flight` the way an answered awaiting-answer/review-maxed pause would be.
    expect(
      classifyIssueState({
        ...base,
        labels: LABEL_SETS.eligible,
        gateEligible: true,
        runStatus: "agent-stuck",
        resumable: true,
      }),
    ).toEqual({ kind: "eligible" });
  });

  it("pre-gate issues (hitl / triage / no-mode / log) are awaiting-human, never anomalies", () => {
    for (const key of ["hitl", "needsTriage", "noMode", "noAfk", "logIssue", "empty"] as const) {
      const result = classifyIssueState({ ...base, labels: LABEL_SETS[key] });
      expect(result.kind, key).toBe("awaiting-human");
    }
  });

  it("a merged run on a closed issue is terminal", () => {
    expect(
      classifyIssueState({ ...base, issueState: "CLOSED", runStatus: "merged" }),
    ).toEqual({ kind: "terminal" });
  });

  it("a closed (effect-neutral terminal, #81) run on a closed issue is terminal", () => {
    // `closed` is re-admittable like `merged`, so a closed issue carrying it is done —
    // read truthfully as the effect-neutral terminal, never mislabelled `merged`.
    expect(
      classifyIssueState({ ...base, issueState: "CLOSED", runStatus: "closed" }),
    ).toEqual({ kind: "terminal" });
  });
});

/**
 * The triage cutover's completeness enumeration (ADR-0042, issue #43). After the cutover every
 * folded issue state must be exactly one of: actively progressing, durably queued for a master,
 * awaiting a concrete human answer, terminal after a master, or a loud operator-owned anomaly.
 * There is no sixth arm, and in particular there is no "parked on a heal-card" arm any more.
 */
describe("the post-cutover lifecycle enumeration (ADR-0042)", () => {
  const base: IssueSnapshot = {
    issueNumber: 1,
    issueState: "OPEN",
    labels: [],
    runStatus: null,
    inFlight: false,
    wedged: false,
    gateEligible: false,
    resumable: false,
    answered: false,
    masterUnroutable: false,
  };

  it("classifies a queued master triage as in-flight — the daemon is working, nobody is paged", () => {
    expect(
      classifyIssueState({ ...base, runStatus: "master-triage", labels: [LABEL_MASTER_TRIAGE] }),
    ).toEqual({ kind: "in-flight" });
  });

  it("classifies a master triage the daemon cannot route as a loud operator-owned anomaly", () => {
    expect(
      classifyIssueState({
        ...base,
        runStatus: "master-triage",
        labels: [LABEL_MASTER_TRIAGE],
        masterUnroutable: true,
      }),
    ).toEqual({ kind: "anomaly", reason: "master-route-unconfigured" });
  });

  it("classifies a terminal-after-master `agent-stuck` as awaiting-human", () => {
    expect(classifyIssueState({ ...base, runStatus: "agent-stuck", labels: [LABEL_AGENT_STUCK] })).toEqual({
      kind: "awaiting-human",
    });
  });

  it("classifies a master `ask-human` pause as awaiting-human", () => {
    expect(
      classifyIssueState({ ...base, runStatus: "awaiting-answer", labels: [LABEL_AWAITING_ANSWER] }),
    ).toEqual({ kind: "awaiting-human" });
  });

  it("still classifies a pre-cutover `review-maxed` park, so migration is never a silent island", () => {
    expect(classifyIssueState({ ...base, runStatus: "review-maxed", labels: [LABEL_REVIEW_MAXED] })).toEqual({
      kind: "awaiting-human",
    });
  });

  it("keeps the master path's own defects operator-owned — a master cannot repair a master", () => {
    expect(anomalyEnqueuesMaster("master-route-unconfigured", true)).toBe(false);
    expect(anomalyEnqueuesMaster("unclassified", true)).toBe(false);
  });

  it("routes every OTHER issue-scoped anomaly to a master when there is context to adjudicate", () => {
    for (const reason of [
      "run-wedged-past-lifetime",
      "running-row-not-in-flight",
      "paused-run-unresumable",
      "paused-run-label-missing",
      "answered-pause-stranded",
      "paused-label-missing-run",
      "non-terminal-run-on-closed-issue",
    ] as const) {
      expect(anomalyEnqueuesMaster(reason, true), reason).toBe(true);
      // …and never without an issue + run to scope it to.
      expect(anomalyEnqueuesMaster(reason, false), `${reason} without context`).toBe(false);
    }
  });

  it("names every operator-owned anomaly exactly once (the boundary is one list, not a habit)", () => {
    expect(new Set(OPERATOR_OWNED_ANOMALIES).size).toBe(OPERATOR_OWNED_ANOMALIES.length);
  });
});
