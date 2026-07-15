/**
 * The human-attention label states (DESIGN §9). An agent that pauses swaps
 * `ready-for-agent` for one of these; the `ralph-answer` CLI swaps it back to
 * `ready-for-agent` on answer, and the daemon resumes the run next tick.
 *
 * `awaiting-answer` (escalate) and `review-maxed` (heal-card) both carry an open
 * `ralph-question` and flow through the same one-at-a-time answer queue. `agent-stuck`
 * joins them when it carries an open stuck-card (#86): answering re-admits a fresh run
 * with the operator's guidance rather than resuming a paused one.
 */

import { LABEL_AGENT_STUCK, LABEL_AWAITING_ANSWER, LABEL_REVIEW_MAXED } from "../core/labels";

// The label names are defined canonically in the label vocabulary
// (`core/labels.ts`, the lowest layer) and re-exported here for the HITL call sites:
//   - `LABEL_AWAITING_ANSWER`: set when an agent calls `escalate`
//     (`ready-for-agent → awaiting-answer`);
//   - `LABEL_REVIEW_MAXED`: set when a review phase exhausts its fix attempts
//     still blocked (heal-card);
//   - `LABEL_AGENT_STUCK`: set when an agent self-stops on its stuck budget or
//     the daemon kills it on a wall-clock overrun — a terminal state with no PR.
//   - `LABEL_DAEMON_ANOMALY`: set when the daemon cannot even claim an issue
//     after repeated attempts (issue #28) — a daemon-side fault, surfaced for a
//     human rather than retried forever.
export { LABEL_READY, LABEL_AGENT_STUCK, LABEL_DAEMON_ANOMALY } from "../core/labels";
export { LABEL_AWAITING_ANSWER, LABEL_REVIEW_MAXED };

/**
 * The two pauses whose runs **resume** on answer — the awaiting-answer (escalate)
 * and review-maxed (heal-card) families. Distinct from `agent-stuck`, which is a
 * terminal that **re-admits** a fresh run on answer rather than resuming (#86).
 */
export const AWAITING_LABELS = [LABEL_AWAITING_ANSWER, LABEL_REVIEW_MAXED] as const;
export type AwaitingAnswerLabel = (typeof AWAITING_LABELS)[number];

/**
 * The labels the `ralph-answer` queue serves from: every human-attention state that
 * carries an answerable open `ralph-question`. The two resume-on-answer pauses
 * ({@link AWAITING_LABELS}) plus `agent-stuck`, whose stuck-card (#85) became
 * healable in #86 — answering it swaps `agent-stuck → ready-for-agent`, re-admitting
 * a fresh run with the operator's guidance injected. The `<paused-label> →
 * ready-for-agent` swap is generic, so surfacing the label is the whole of the work.
 */
export const ANSWERABLE_LABELS = [...AWAITING_LABELS, LABEL_AGENT_STUCK] as const;
export type AnswerableLabel = (typeof ANSWERABLE_LABELS)[number];

/** What answering a label-backed `ralph-question` does on the daemon's next tick. */
export type AnswerConsequence = "resume-from-wip" | "readmit-fresh";

/** Whether an answerable label is a paused run that resumes from its WIP branch. */
export function isAwaitingAnswerLabel(label: AnswerableLabel): label is AwaitingAnswerLabel {
  return (AWAITING_LABELS as readonly string[]).includes(label);
}

/**
 * The answer consequence for a canonical HITL label. The resume side is backed by
 * {@link AWAITING_LABELS}; `agent-stuck` is the only answerable label that re-admits a fresh run.
 */
export function consequenceForAnswerableLabel(label: AnswerableLabel): AnswerConsequence {
  if (isAwaitingAnswerLabel(label)) {
    return "resume-from-wip";
  }
  if (label === LABEL_AGENT_STUCK) {
    return "readmit-fresh";
  }
  const exhaustive: never = label;
  return exhaustive;
}
