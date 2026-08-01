/**
 * **Adoption of pre-cutover states** (ADR-0042, issue #43 "Recovery and migration").
 *
 * The triage cutover changes what happens *next time*. It does nothing, by itself, for the
 * issues already parked when the new build starts: a `review-maxed` heal-card waiting for an
 * operator, or an `agent-stuck` terminal a worker reached without any master ever looking at
 * it. Left alone those are exactly the silent islands the completeness invariant exists to
 * forbid — the code that used to service them is gone, and the code that replaced it does not
 * recognise them.
 *
 * So they are adopted: their run, phase and heal-card evidence are preserved, ONE idempotent
 * master request is appended, and they move to `master-triage`. Nothing is re-asked and nothing
 * is duplicated — the operator who was mid-answer keeps their question (see the deliberate
 * exclusion of `awaiting-answer` below), and a second tick over an already-adopted issue is a
 * no-op because the escalation door dedupes by `(phase, signature)`.
 *
 * Deliberately NOT adopted:
 *
 *  - **`awaiting-answer` with a live unanswered `ralph-question`.** That is a real question a
 *    human is genuinely being asked. Adopting it would throw away the operator's pending
 *    attention and re-decide something already handed to them. (An *answered-but-stranded*
 *    pause is different: the existing compensating resume logic re-arms it, and after the
 *    cutover the resumed owner is the master.)
 *  - **An `agent-stuck` a master already adjudicated** (`MasterStuck` in its stream). That
 *    terminal is a *completed* master decision, and re-queueing it would let the same run
 *    spend the whole intervention budget twice for one conclusion.
 */

import type { Issue } from "../github/types";
import { LABEL_AGENT_STUCK, LABEL_AWAITING_ANSWER, LABEL_REVIEW_MAXED } from "../core/labels";
import type { RecordedStreamEvent } from "../store/event-log";
import type { Run } from "../store/types";
import type { MasterRequestSource } from "../store/types";

/** Why a pre-cutover issue is being adopted — carried into the request as its source. */
export type AdoptionKind = "review-maxed" | "agent-stuck";

/** One adoption the reconciler should perform this tick. */
export interface AdoptionPlan {
  kind: AdoptionKind;
  /** The master-request source the adopted state maps onto. */
  source: MasterRequestSource;
  /** The run-phase key the intervention is counted against. */
  phase: string;
  /** A one-line statement of what the pre-cutover state was. */
  headline: string;
  /** The normalized detail the failure signature is computed from. */
  detail: string;
}

/** The facts {@link planAdoption} decides against — resolved by the caller, so it stays pure. */
export interface AdoptionInput {
  issue: Pick<Issue, "number" | "state" | "labels">;
  /** The run row, or null when rehydrate could not rebuild one. */
  run: Run | null;
  /** The review phase recovered from the heal-card's hidden phase marker, when there was one. */
  healPhase: number | null;
  /** Whether the issue's stream already carries a `MasterStuck` (a completed adjudication). */
  masterAdjudicated: boolean;
  /** Whether a master request is already pending or being adjudicated for this run. */
  masterQueued: boolean;
  /** Whether the latest `ralph-question` on the thread is still unanswered. */
  unansweredQuestion: boolean;
}

/**
 * Decide whether one open issue carries a pre-cutover state to adopt. Pure and total: every
 * combination returns a plan or null, so the migration is matrix-testable rather than
 * discovered in production.
 */
export function planAdoption(input: AdoptionInput): AdoptionPlan | null {
  const { issue, run } = input;
  if (issue.state !== "OPEN") {
    return null;
  }
  // No run row ⇒ no branch, no PR, no transcript: there is nothing for a master to adjudicate.
  // That state is its own island (`paused-label-missing-run`) and the completeness pass owns it —
  // enqueuing an evidence-free master here would hide a rehydrate failure behind a queue entry.
  if (!run) {
    return null;
  }
  // Already queued / already being adjudicated — the cutover has this one.
  if (input.masterQueued || run.status === "master-triage") {
    return null;
  }
  const has = (label: string): boolean => issue.labels.includes(label);

  // A live, unanswered question is a real question: never adopt it, never re-ask it.
  if (has(LABEL_AWAITING_ANSWER) && input.unansweredQuestion) {
    return null;
  }

  if (has(LABEL_REVIEW_MAXED) || run.status === "review-maxed") {
    const phase = input.healPhase ?? 1;
    return {
      kind: "review-maxed",
      source: "review-maxed",
      phase: `review-${phase}`,
      headline: `Adopted a pre-cutover \`review-maxed\` park (phase ${phase})`,
      detail: `pre-cutover review-maxed phase=${phase}`,
    };
  }

  if (has(LABEL_AGENT_STUCK) || run.status === "agent-stuck") {
    if (input.masterAdjudicated) {
      // A master already concluded this run is terminal — that decision stands.
      return null;
    }
    return {
      kind: "agent-stuck",
      source: "stuck",
      phase: "impl",
      headline: "Adopted a pre-cutover `agent-stuck` terminal no master ever reviewed",
      detail: "pre-cutover agent-stuck",
    };
  }

  return null;
}

/** Whether an issue's stream carries a completed master terminal (`MasterStuck`). */
export function hasMasterAdjudication(events: readonly RecordedStreamEvent[]): boolean {
  return events.some((e) => e.type === "MasterStuck");
}

/**
 * The labels an adoption must strip once the request lands. The `master-triage` label arrives
 * through the ordinary level-triggered status effect; these two are the retired surfaces the
 * diff would otherwise leave behind for a tick (or forever, for a label whose status no longer
 * exists). Stripping them here is what makes "converge to exactly one daemon state label" true
 * on the *first* tick rather than eventually.
 */
export const ADOPTED_LABELS: readonly string[] = [LABEL_REVIEW_MAXED, LABEL_AGENT_STUCK];
