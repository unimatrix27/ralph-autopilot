/**
 * The reconciler completeness invariant (issue #27, DESIGN §1/§9). The daemon's
 * defence against *silently* losing work is distributed across many code paths:
 * each must set/clear the right label + run status so the reconciler keeps acting
 * on an issue. Whenever an issue lands in a (label set × run status) combination
 * that **no path classifies**, it becomes a silent "island" — acted on by nothing,
 * seen by no one. With auto-merge (ADR-0009) every island is silent until a human
 * happens to look. Point-fixing found islands (#8, #9) does not prevent the next.
 *
 * This module makes a dead state impossible to *hide*: a single, **total** pure
 * function classifies every open issue and every non-terminal run row into exactly
 * one of `{eligible, in-flight, awaiting-human, terminal}`. Anything that falls
 * through, or any contradiction — a `running` row the daemon isn't executing, a
 * non-terminal run whose issue is closed, an answered pause nothing can resume, a
 * human-attention label with no run to resume — returns an `anomaly`. The
 * reconciler surfaces every anomaly within one tick (a `daemon-anomaly` label + a
 * structured log), so unknown state becomes a *visible* anomaly, never a silent
 * island. The classifier is pure so the guarantee can be matrix-tested against the
 * full state space and guarded against regression as the daemon self-modifies.
 */

import { RE_ADMITTABLE_STATUSES, SPAN_CLOSED_STATUSES } from "../core/admission";
import {
  LABEL_AGENT_STUCK,
  LABEL_AWAITING_ANSWER,
  LABEL_READY,
  LABEL_REVIEW_MAXED,
} from "../core/labels";
import type { IssueState } from "../github/types";
import type { RunStatus } from "../store/types";

/**
 * The visibility label the daemon applies to any open issue / non-terminal run it
 * cannot classify or that contradicts itself. A human-attention state (DESIGN §9):
 * an anomaly is, by construction, something no automated path will advance, so it
 * is surfaced for a human exactly like `awaiting-answer` / `agent-stuck`.
 */
export const LABEL_DAEMON_ANOMALY = "daemon-anomaly";

/**
 * Cosmetics the daemon hands the GitHub adapter when it must self-create the
 * `daemon-anomaly` label on a target repo that has not pre-created it. The label
 * is a human-attention signal, so it self-creates in attention red. Owning these
 * here (with the label constant) keeps the generic adapter free of any per-label
 * knowledge — it carries no `daemon-anomaly` special case.
 */
export const LABEL_DAEMON_ANOMALY_CREATE = {
  color: "B60205",
  description:
    "Reconciler could not classify this issue / run — needs human attention (ralph-autopilot #27)",
} as const;

/**
 * The four legitimate classes every open issue / non-terminal run must fall into:
 * - `eligible`       — desired state says go and nothing blocks; the next fill picks it up;
 * - `in-flight`      — being worked right now (or about to be resumed this tick);
 * - `awaiting-human` — paused on a visible human-attention label, or pre-gate (triage/hitl/blocked);
 * - `terminal`       — done (merged + closed, or a terminal run on a closed issue).
 */
export type IssueClass = "eligible" | "in-flight" | "awaiting-human" | "terminal";

/** Why a (label set × run status) combination is an island the daemon must surface. */
export type AnomalyReason =
  /**
   * An in-flight run that has not advanced within its lifetime ceiling — the
   * per-session wall-clock (#13) failed to settle it, so it sits wedged while still
   * holding a slot. Surfaced for a human and, in parallel, actively terminated by
   * the orphan sweep through the executor's abort handle (#61) — its slot freed by
   * occupySlot's single owner once the killed session settles. The anomaly stays
   * visible while it settles, then self-clears once the run is terminal.
   */
  | "run-wedged-past-lifetime"
  /** A `running` row the daemon is not executing — the crash-abandoned island (#8). */
  | "running-row-not-in-flight"
  /** A non-terminal run (running / paused) whose issue is CLOSED or gone. */
  | "non-terminal-run-on-closed-issue"
  /** Answered (ready re-added) but the run cannot resume — lost resume context (#9). */
  | "paused-run-unresumable"
  /** A paused run row whose human-attention label vanished and that cannot resume. */
  | "paused-run-label-missing"
  /**
   * Answered (a `ralph-answer` follows the latest `ralph-question`) but still parked on
   * its pause label, never re-armed to `ready-for-agent` — a rate-limited resume re-arm
   * stranded it (#132). Invisible to both `ralph-answer` (already-answered) and resume
   * (no `ready-for-agent`); the reconciler re-arms it while this keeps it visible.
   */
  | "answered-pause-stranded"
  /** A human-attention label with no run row to resume — rehydrate could not rebuild it. */
  | "paused-label-missing-run"
  /** A run status the code does not know (corrupt store / a future status) — fail visible. */
  | "unclassified";

/**
 * The verdict for one issue/run: a legitimate {@link IssueClass}, or an anomaly to
 * surface. The non-anomaly arm derives from `IssueClass` so the class vocabulary is
 * spelled exactly once — adding a fifth class is a single edit the compiler enforces.
 */
export type Classification =
  | { kind: IssueClass }
  | { kind: "anomaly"; reason: AnomalyReason };

/**
 * The fully-resolved state of one issue/run, the classifier's sole input. Every
 * async fact (gate eligibility, resumability) is resolved by the caller and frozen
 * here so the classifier is pure and exhaustively matrix-testable.
 */
export interface IssueSnapshot {
  issueNumber: number;
  /**
   * `OPEN` / `CLOSED` for a real issue, or `gone` when a non-terminal run row
   * references an issue GitHub no longer returns (deleted / transferred).
   */
  issueState: IssueState | "gone";
  /** The issue's bare label names, or `[]` for a run whose issue is closed/gone. */
  labels: string[];
  /** The run row's lifecycle status, or `null` when no run row exists. */
  runStatus: RunStatus | null;
  /** Whether an executor promise is currently held for this issue. */
  inFlight: boolean;
  /**
   * Whether an in-flight run has not advanced within its lifetime ceiling — the
   * per-session wall-clock failed to settle it (a backstop should the wall-clock
   * itself fail). Meaningful only when {@link inFlight}; the classifier ignores it
   * otherwise. The caller resolves it from the run's `updatedAt` + the ceiling.
   */
  wedged: boolean;
  /** Whether the issue passes the eligibility gate now (deps resolved by the caller). */
  gateEligible: boolean;
  /**
   * Whether a paused run has been re-armed by an operator answer — `findResumableRuns`
   * would resume it this tick (answer present + resume context intact).
   */
  resumable: boolean;
  /**
   * Whether the comment ledger says this paused run has been answered: a `ralph-answer`
   * follows its latest `ralph-question`. Meaningful only for a paused run still parked
   * on its human-attention label and NOT {@link resumable}. That combination is the #132
   * wedge — an operator answered, the resume began, and a rate-limited re-arm failed,
   * re-parking the run at `awaiting-answer` with no `ready-for-agent`. The run is then
   * invisible to `ralph-answer` (already-answered ⇒ unservable) and to resume (no
   * `ready-for-agent`), so it must surface as an anomaly rather than read as a genuinely
   * unanswered park. The caller resolves it from the comment thread (only for parked,
   * open, non-resumable runs); `false` everywhere else.
   */
  answered: boolean;
}

/**
 * Whether a run status is non-terminal (still holds its issue and must be classified
 * live). A run is *terminal* exactly when it is done with its branch — admission's
 * {@link RE_ADMITTABLE_STATUSES}, the single source of the terminal/re-admittable
 * invariant — so this never re-literalls the set and can never desync from it.
 */
export function isNonTerminalStatus(status: RunStatus): boolean {
  return !RE_ADMITTABLE_STATUSES.has(status);
}

/**
 * Whether a run's **span is already closed** — a `RunEnded` fact exists for it
 * (`merged` / the effect-neutral `closed`). Wraps admission's
 * {@link SPAN_CLOSED_STATUSES}, the single source of the span-closed subset, so this
 * never re-literalls it and can never desync. Distinct from {@link isNonTerminalStatus}:
 * `agent-stuck` is *terminal* for re-admission (so `isNonTerminalStatus` is false) yet
 * its span is still OPEN — `RunStuck` closes no span (issue #274) — so `isSpanClosed`
 * is false too. The two predicates disagree only on `agent-stuck`, which is the whole
 * crux of #274: re-admittable is not the same as span-closed.
 */
export function isSpanClosed(status: RunStatus): boolean {
  return SPAN_CLOSED_STATUSES.has(status);
}

/**
 * Classify one issue/run into exactly one {@link Classification}. **Total**: every
 * combination of (labels × run status × in-flight × gate × resumable × issue state)
 * returns a verdict, and anything contradictory or unknown returns an `anomaly`
 * rather than falling through — so a state the daemon does not understand becomes a
 * *visible* anomaly, never a silent island (issue #27 AC1).
 */
export function classifyIssueState(s: IssueSnapshot): Classification {
  const has = (label: string): boolean => s.labels.includes(label);
  const open = s.issueState === "OPEN";

  // 1. Being worked right now is never an island: the executor holds a slot and
  //    the run settles within the wall-clock, after which the next tick re-derives.
  //    In-flight is authoritative regardless of (now necessarily stale) labels —
  //    UNLESS the run is wedged past its lifetime ceiling: the wall-clock failed to
  //    settle it, so the slot is held by work that may never finish. That is not a
  //    healthy in-flight state; surface it for a human while the orphan sweep kills
  //    the session through the executor's abort handle (#61) — the anomaly stays
  //    visible until the freed slot settles the run terminal, then self-clears.
  if (s.inFlight) {
    return s.wedged ? { kind: "anomaly", reason: "run-wedged-past-lifetime" } : { kind: "in-flight" };
  }

  // 2. A non-terminal run row must map to a live path, or it is an island.
  switch (s.runStatus) {
    case "running":
      // Not in flight (step 1) yet `running`: the daemon believes it is executing
      // this run but holds no slot for it — the crash-abandoned island (#8). The
      // orphan sweeper re-drives or terminates it; surfaced either way.
      return {
        kind: "anomaly",
        reason: open ? "running-row-not-in-flight" : "non-terminal-run-on-closed-issue",
      };

    case "awaiting-answer":
    case "review-maxed": {
      if (!open) {
        // A paused run whose issue closed under it (merged out-of-band / closed by
        // hand): nothing will ever resume it. Surface + let the sweep reconcile.
        return { kind: "anomaly", reason: "non-terminal-run-on-closed-issue" };
      }
      if (s.resumable) {
        // The answer landed and the run is resumable → `resumeAnswered` acts this tick.
        return { kind: "in-flight" };
      }
      // Still paused: legitimate iff the matching human-attention label is visible.
      const hasMatchingLabel =
        s.runStatus === "awaiting-answer" ? has(LABEL_AWAITING_ANSWER) : has(LABEL_REVIEW_MAXED);
      if (hasMatchingLabel) {
        // ...UNLESS the comment ledger already carries an answer to its latest
        // question. That is the #132 wedge: an operator answered, the resume began,
        // and a rate-limited re-arm failed — re-parking the run at its pause label
        // with no `ready-for-agent`. It is now invisible to `ralph-answer`
        // (already-answered ⇒ unservable) and to resume (no `ready-for-agent`), so it
        // is acted on by nothing despite being answered. Surface it; the reconciler
        // re-arms it in parallel so this self-clears once the re-arm lands (#132 AC2).
        if (s.answered) {
          return { kind: "anomaly", reason: "answered-pause-stranded" };
        }
        return { kind: "awaiting-human" };
      }
      // The label is gone but the run cannot resume: an answered heal whose resume
      // context/question was lost (#9), or a hand-removed label. Acted on by nothing.
      return {
        kind: "anomaly",
        reason: has(LABEL_READY) ? "paused-run-unresumable" : "paused-run-label-missing",
      };
    }

    case "awaiting-ci":
      // Parked on the off-slot pre-review CI gate (ADR-0022 stage 1). The CI poller
      // reads its checks every tick, independent of the build pool, and re-admits it
      // into review when they settle — so the daemon is acting on it: in-flight in
      // the completeness sense, even though it holds no build slot while it waits. A
      // closed issue under it (merged/closed out-of-band) is the same island as any
      // other non-terminal run — surfaced + swept.
      return open
        ? { kind: "in-flight" }
        : { kind: "anomaly", reason: "non-terminal-run-on-closed-issue" };

    case "awaiting-merge":
      // Queued for (or undergoing) the single-concurrency integration flow
      // (ADR-0017). The merge worker leases it every tick, independent of the
      // build pool — so the daemon is acting on it: in-flight in the completeness
      // sense, even though it holds no build slot (the lease lives in a separate
      // size-1 set). A closed issue under it (merged/closed out-of-band) is the
      // same island as any other non-terminal run — surfaced + swept.
      return open
        ? { kind: "in-flight" }
        : { kind: "anomaly", reason: "non-terminal-run-on-closed-issue" };

    case "agent-stuck":
    case "merged":
    case "closed":
    case null:
      // Terminal row (`agent-stuck` / `merged` / the effect-neutral `closed`, issue #81)
      // or no row: the label-driven branch below decides. `closed` carries no daemon-set
      // label, so it falls through exactly like `merged` — terminal once its issue is
      // closed/gone, eligible again only if the issue is reopened + re-labelled.
      break;

    default:
      // A status string the code does not know (corrupt store, a future status).
      // Fail visible rather than silently skipping it.
      return { kind: "anomaly", reason: "unclassified" };
  }

  // 3. No non-terminal run row. Decide from issue state, the gate, and labels.
  if (!open) {
    // A closed/gone issue with a terminal or absent run row is done.
    return { kind: "terminal" };
  }

  if (s.gateEligible) {
    // OPEN + ready + afk + mode + deps satisfied + (no run / a re-admittable run) →
    // the next fill picks it up (a terminal run row does not hold the issue).
    return { kind: "eligible" };
  }

  // Not gate-eligible. A terminal `agent-stuck` parks the issue on a visible label
  // until a human re-labels (re-admit) or closes it — a human-attention state. This
  // branch is load-bearing precedence, not redundancy: it must stay AHEAD of the
  // pause-label branch below so that an issue carrying BOTH `agent-stuck` and a stale
  // pause label with no run row classifies as awaiting-human (parked for a human),
  // not as a `paused-label-missing-run` anomaly. Removing it would flip that verdict.
  if (has(LABEL_AGENT_STUCK)) {
    return { kind: "awaiting-human" };
  }

  // A human-attention pause label (awaiting-answer / review-maxed) with NO run row
  // to resume is an island: rehydrate could not rebuild the run (PR gone, store
  // lost), so an operator answer would resume nothing. Surface it.
  if (has(LABEL_AWAITING_ANSWER) || has(LABEL_REVIEW_MAXED)) {
    if (s.runStatus === null) {
      return { kind: "anomaly", reason: "paused-label-missing-run" };
    }
    // A terminal run row carrying a pause label still makes the issue visible to a
    // human; treat as awaiting-human (the human re-labels or closes it).
    return { kind: "awaiting-human" };
  }

  // Not eligible, no daemon state label: the issue is pre-gate — `hitl`, untriaged
  // (`needs-triage` / `needs-info`), missing `afk`/`mode`, blocked by a dependency,
  // or a `[log]` issue. A human or the triage funnel owns the next step; the daemon
  // legitimately does not act, and the issue is plainly visible on GitHub — never a
  // hidden island. Reported as awaiting-human.
  return { kind: "awaiting-human" };
}
