/**
 * Heal re-admission (#86, CONTEXT: heal-card; "Option A"). `agent-stuck` is a
 * healable human-attention state: the operator answers its stuck-card through the
 * same `ralph-answer` path as an escalation, which swaps `agent-stuck →
 * ready-for-agent`. But a stuck run kept no WIP branch, so healing **re-admits, not
 * resumes** — the next tick launches a *fresh* run, and that run's implementation
 * prompt must carry the operator's guidance so the new agent begins knowing why the
 * last attempt stopped (the load-bearing part of #86).
 *
 * This is the single GitHub-only signal for that guidance: the issue's own
 * comments. The latest `ralph-question` is the open stuck-card (it carries the stuck
 * category + the agent's reason), and the `ralph-answer` that post-dates it is the
 * operator's guidance. Reads nothing but GitHub — no SQLite, no daemon — so a
 * cold-store restart between the stuck terminal and the answer changes nothing
 * (a stuck run leaves no run row to rehydrate).
 */

import type { GitHubClient } from "../github/types";
import type { EscalationQuestion } from "../review/escalation";
import { isStuckCardQuestion } from "../executor/stuck";
import { latestAnswerAfter, latestRalphQuestion, type RalphAnswer } from "./answer";

/** The operator's guidance for a healed stuck issue, threaded into the fresh impl prompt. */
export interface StuckHealGuidance {
  /** The stuck-card the prior attempt posted — its fields say why it stopped. */
  question: EscalationQuestion;
  /** The operator's answer to that stuck-card — the guidance to inject. */
  answer: RalphAnswer;
}

/**
 * The unconsumed stuck-heal guidance for an issue, or `null` if there is none. There
 * is guidance exactly when the latest `ralph-question` is a **stuck-card** and a
 * `ralph-answer` post-dates it. Keying on the stuck-card marker (not merely "an
 * answered question") keeps a resolved escalation on a reopened/re-run issue from
 * being mistaken for stuck-heal guidance.
 */
export async function findStuckHealGuidance(
  github: GitHubClient,
  issueNumber: number,
): Promise<StuckHealGuidance | null> {
  const comments = await github.listIssueComments(issueNumber);
  const latest = latestRalphQuestion(comments);
  if (!latest || !isStuckCardQuestion(latest.question)) {
    return null;
  }
  // The operator's guidance is the newest ralph-answer that post-dates the card.
  const answer = latestAnswerAfter(comments, latest.commentId);
  return answer ? { question: latest.question, answer } : null;
}
