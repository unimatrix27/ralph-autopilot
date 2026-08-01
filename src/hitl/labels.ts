/**
 * The human-attention label states (DESIGN §9 / §13a).
 *
 * Since the master-triage cutover there are exactly two of them (ADR-0042 §7/§8):
 * `awaiting-answer` — the only state that means a human decision is *requested*, a question
 * only a completed master may ask — and `agent-stuck` — the only terminal, selectable only by
 * a completed master adjudication. An agent that pauses swaps `ready-for-agent` for
 * `awaiting-answer`; the `ralph-answer` CLI swaps it back on answer and the daemon resumes the
 * checkpointed master next tick.
 *
 * `agent-stuck` is deliberately **not answerable** (ADR-0042 §7). It carries a self-explaining
 * card, but the card is evidence, not a question: a master already investigated the run and
 * concluded no further autonomous action or human decision would resolve it. Answering it would
 * silently un-terminalize that adjudication into a fresh worker run with no master involvement.
 * The operator's real options are to re-scope the issue (re-label it `ready-for-agent`, handing
 * it back to the daemon) or to close it.
 *
 * The pre-cutover `review-maxed` heal-card is retired (ADR-0042 §6) and adopted into
 * `master-triage` on sight; it stays answerable only so an operator already mid-answer on one
 * can finish.
 */

import { LABEL_AGENT_STUCK, LABEL_AWAITING_ANSWER, LABEL_REVIEW_MAXED } from "../core/labels";

// The label names are defined canonically in the label vocabulary
// (`core/labels.ts`, the lowest layer) and re-exported here for the HITL call sites:
//   - `LABEL_AWAITING_ANSWER`: set when a master asks the one question it may ask
//     (`ready-for-agent → awaiting-answer`);
//   - `LABEL_REVIEW_MAXED`: pre-cutover only — set when a review phase exhausted its fix
//     attempts still blocked (heal-card). No live path applies it (ADR-0042 §6);
//   - `LABEL_AGENT_STUCK`: the terminal a completed master adjudication selects — no PR will
//     merge from the run, and the daemon will not pick the issue up again on its own.
//   - `LABEL_DAEMON_ANOMALY`: set when the daemon cannot even claim an issue
//     after repeated attempts (issue #28) — a daemon-side fault, surfaced for a
//     human rather than retried forever.
export { LABEL_READY, LABEL_AGENT_STUCK, LABEL_DAEMON_ANOMALY } from "../core/labels";
export { LABEL_AWAITING_ANSWER, LABEL_REVIEW_MAXED };

/**
 * The pauses whose runs **resume** on answer — the awaiting-answer (master question) and
 * review-maxed (pre-cutover heal-card) families. Distinct from `agent-stuck`, which is a
 * terminal and resumes nothing ({@link TERMINAL_ATTENTION_LABELS}).
 */
export const AWAITING_LABELS = [LABEL_AWAITING_ANSWER, LABEL_REVIEW_MAXED] as const;
export type AwaitingAnswerLabel = (typeof AWAITING_LABELS)[number];

/**
 * The labels the `ralph-answer` queue serves from: every human-attention state that carries an
 * answerable open `ralph-question`. That is **exactly** the resume-on-answer pauses — the same
 * tuple, not a copy of it, so the two sets cannot drift apart. `agent-stuck` is excluded by
 * construction (ADR-0042 §7): a terminal has no open decision to make, and the
 * `<paused-label> → ready-for-agent` swap the answer path applies must never reach one.
 */
export const ANSWERABLE_LABELS = AWAITING_LABELS;
export type AnswerableLabel = (typeof ANSWERABLE_LABELS)[number];

/**
 * The terminal human-attention labels — the states only a completed master adjudication may
 * select (ADR-0042 §7). They are surfaced to the operator and are never served by the answer
 * queue; the operator re-scopes or closes the issue instead of answering it.
 */
export const TERMINAL_ATTENTION_LABELS = [LABEL_AGENT_STUCK] as const;
export type TerminalAttentionLabel = (typeof TERMINAL_ATTENTION_LABELS)[number];

/** What answering a label-backed `ralph-question` does on the daemon's next tick. */
export type AnswerConsequence = "resume-from-wip";

/** Whether a label is a paused run that resumes from its WIP branch on answer. */
export function isAwaitingAnswerLabel(label: string): label is AwaitingAnswerLabel {
  return (AWAITING_LABELS as readonly string[]).includes(label);
}

/**
 * Whether a label is a terminal a master adjudication selected — the check that keeps the
 * answer queue off it. Takes a bare `string` so a raw issue-label list can be tested directly.
 */
export function isTerminalAttentionLabel(label: string): label is TerminalAttentionLabel {
  return (TERMINAL_ATTENTION_LABELS as readonly string[]).includes(label);
}

/**
 * The answer consequence for a canonical HITL label. Every answerable label resumes the paused
 * run from its checkpointed WIP: with the terminal removed from {@link ANSWERABLE_LABELS} there
 * is no re-admit-on-answer path left (ADR-0042 §7). The exhaustiveness check below makes adding
 * an answerable label with a different consequence a compile error rather than a silent default.
 */
export function consequenceForAnswerableLabel(label: AnswerableLabel): AnswerConsequence {
  if (isAwaitingAnswerLabel(label)) {
    return "resume-from-wip";
  }
  const exhaustive: never = label;
  return exhaustive;
}
