/**
 * The **master loop budget** (ADR-0041) — the pure rule that stops the master from becoming
 * the very loop it was built to break. Three constraints, all decided here so the engine
 * cannot quietly reinterpret them:
 *
 *  1. **At most two interventions per run phase.** A third cannot launch. Not "should not":
 *     {@link evaluateMasterBudget} returns `exhausted`, and the engine's only move then is a
 *     terminal — never another session.
 *  2. **A repeated normalized failure signature cannot repeat the same recovery.** The second
 *     look at the same failure is *forced final adjudication*: a materially different
 *     resolution, `ask-human`, or `terminal-stuck`. A changed head SHA does not make a
 *     signature new (that is {@link import("./signature").normalizeFailureSignature}'s job).
 *  3. **A human answer resumes the checkpointed master once.** It does not erase prior
 *     autonomous attempts, so an answered `ask-human` re-enters the same budget with the
 *     same count — there is no path to an infinite redispatch loop through the HITL door.
 *
 * Pure and total: given a folded {@link MasterHistory}, a phase, and a signature, the verdict
 * is a value. The engine applies it; the prompt *shows* it to the master, so the master
 * cannot propose a move the harness will then silently refuse.
 */

import type { MasterResolution } from "../store/types";
import { interventionsInPhase, type MasterHistory, type MasterInterventionRecord } from "./history";

/** The binding ceiling: two master interventions per run phase (ADR-0041). */
export const MAX_MASTER_INTERVENTIONS_PER_PHASE = 2;

/**
 * The resolutions that count as **final adjudication** — the only moves left once a failure
 * signature repeats and every materially-different autonomous recovery has been spent.
 */
export const FINAL_ADJUDICATION_RESOLUTIONS: readonly MasterResolution[] = ["ask-human", "terminal-stuck"];

/** The autonomous (non-final) resolutions — the ones "repeat the same recovery" can forbid. */
export const AUTONOMOUS_RESOLUTIONS: readonly MasterResolution[] = [
  "resolved-and-continue",
  "redispatch-tier-1",
  "retry-pipeline",
];

export interface MasterBudgetInput {
  history: MasterHistory;
  /** The run phase this request belongs to — the counting unit. */
  phase: string;
  /** The request's normalized failure signature. */
  signature: string;
}

/** The budget's verdict on whether — and how — another master intervention may run. */
export type MasterBudgetVerdict =
  | {
      allowed: true;
      /** 1-based attempt number within this phase. */
      attempt: number;
      /** Interventions already spent in this phase. */
      spent: number;
      /** Interventions still available after this one. */
      remaining: number;
      /**
       * True when this exact signature has already been adjudicated in this phase. The
       * master is then **forced** to adjudicate finally: it may not repeat any resolution
       * already tried for this signature ({@link forbiddenResolutions}).
       */
      repeatedSignature: boolean;
      /**
       * Resolutions the master may not choose. Empty on a fresh signature; on a repeat it is
       * every resolution already tried for it — so "materially different resolution,
       * `ask-human`, or `terminal-stuck`" is enforced, not merely requested.
       */
      forbiddenResolutions: MasterResolution[];
      /** Whether this is the last permitted intervention in the phase. */
      finalAttempt: boolean;
    }
  | {
      allowed: false;
      reason: "budget-exhausted";
      spent: number;
      /** The prior interventions, so the terminal can name what was already tried. */
      prior: MasterInterventionRecord[];
    };

/**
 * Decide whether another master intervention may launch for `(phase, signature)`, and under
 * what constraint. An in-progress intervention is *not* double-counted — restart recovery
 * re-adopts the open attempt rather than spending a fresh one (see {@link resumeAttempt}).
 */
export function evaluateMasterBudget(input: MasterBudgetInput): MasterBudgetVerdict {
  const inPhase = interventionsInPhase(input.history, input.phase);
  const spent = inPhase.length;

  if (spent >= MAX_MASTER_INTERVENTIONS_PER_PHASE) {
    return { allowed: false, reason: "budget-exhausted", spent, prior: inPhase };
  }

  const sameSignature = inPhase.filter((i) => i.signature === input.signature);
  const repeatedSignature = sameSignature.length > 0;
  // Only *decided* resolutions can be forbidden; an intervention that died before selecting
  // one forbids nothing (we would otherwise punish a crash by narrowing the master's options).
  const forbiddenResolutions = repeatedSignature
    ? [...new Set(sameSignature.map((i) => i.resolution).filter((r): r is MasterResolution => r !== null))]
    : [];
  const attempt = spent + 1;

  return {
    allowed: true,
    attempt,
    spent,
    remaining: MAX_MASTER_INTERVENTIONS_PER_PHASE - attempt,
    repeatedSignature,
    forbiddenResolutions,
    finalAttempt: attempt >= MAX_MASTER_INTERVENTIONS_PER_PHASE,
  };
}

/**
 * The attempt an interrupted master session must re-adopt after a daemon restart, or null
 * when none is open. The engine calls this **before** {@link evaluateMasterBudget} so a
 * crash between `MasterInterventionStarted` and its outcome resumes the *same* numbered
 * attempt instead of spending a second one — the "rehydrates exactly one pending master
 * intervention and never duplicates a session" guarantee.
 */
export function resumeAttempt(history: MasterHistory): MasterInterventionRecord | null {
  return history.inProgress;
}

/**
 * The verdict for **re-adopting an already-open attempt** — a daemon that died mid-session, or a
 * human answer resuming a checkpointed master.
 *
 * Re-adopting spends no fresh budget (that is the whole point), but it must inherit the *same*
 * constraints a fresh attempt at that number would have carried. Getting this wrong is a real
 * loop: attempt 1 tries `retry-pipeline` on signature X, the pipeline fails with the same X,
 * attempt 2 starts, the daemon crashes, and the re-adopted attempt 2 — told the signature is
 * fresh — proposes `retry-pipeline` again. So the verdict is computed by evaluating the ordinary
 * rule against the history **with this attempt removed**, then pinning the attempt number back.
 *
 * A human-resumed attempt additionally forbids `ask-human`: an answered question that could ask
 * again is the one loop a human in the middle would otherwise make unbounded. This holds whether
 * the resume is happening on THIS call (`humanResumed`) or already happened on a prior tick and the
 * resumed session then deferred or crashed before deciding. In that deferred case the next tick
 * re-adopts the still-open attempt with no answer in hand — `humanResumed` is false — so only the
 * durable `open.humanResumes` count (folded from the stream) still remembers that asking again would
 * reopen the ask → answer → ask cycle. Reading it here mirrors how the repeated-signature constraint
 * is already inherited durably from the fold below.
 */
export function readoptedAttemptBudget(
  history: MasterHistory,
  open: MasterInterventionRecord,
  humanResumed: boolean,
): MasterBudgetVerdict {
  const without: MasterHistory = {
    ...history,
    interventions: history.interventions.filter((i) => i !== open),
  };
  const base = evaluateMasterBudget({ history: without, phase: open.phase, signature: open.signature });
  const inherited = base.allowed ? base.forbiddenResolutions : [...AUTONOMOUS_RESOLUTIONS];
  // The transient flag OR the durable fold — either means a human has resumed this attempt, and a
  // second `ask-human` on it would re-arm the loop the budget exists to break. `open.humanResumes`
  // is what survives a deferral/crash after the resume, so it must gate ask-human independently.
  const humanResumedEver = humanResumed || open.humanResumes > 0;
  const forbiddenResolutions = humanResumedEver ? [...new Set([...inherited, "ask-human" as const])] : inherited;
  return {
    // An attempt that is already open is never refused — refusing it would strand the run in
    // `master-triage` with no session and no terminal. Its *resolutions* are constrained instead.
    allowed: true,
    attempt: open.attempt,
    spent: open.attempt - 1,
    remaining: Math.max(0, MAX_MASTER_INTERVENTIONS_PER_PHASE - open.attempt),
    repeatedSignature: base.allowed ? base.repeatedSignature : true,
    forbiddenResolutions,
    finalAttempt: open.attempt >= MAX_MASTER_INTERVENTIONS_PER_PHASE,
  };
}

/**
 * Whether a chosen resolution is permissible under a verdict. The engine calls this on the
 * master's answer: a forbidden repeat is coerced to final adjudication rather than executed,
 * so "repeated signatures cannot repeat an identical resolution even when head SHA changed"
 * holds even against a master that ignores its instructions.
 */
export function resolutionAllowed(verdict: MasterBudgetVerdict, resolution: MasterResolution): boolean {
  if (!verdict.allowed) {
    return FINAL_ADJUDICATION_RESOLUTIONS.includes(resolution);
  }
  return !verdict.forbiddenResolutions.includes(resolution);
}
