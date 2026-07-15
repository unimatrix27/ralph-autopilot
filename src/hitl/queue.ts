/**
 * The GitHub-only open-question queue the `ralph-answer` CLI serves from
 * (ADR-0007). The label *is* the index: every issue carrying `awaiting-answer`
 * (escalate), `review-maxed` (heal-card), or `agent-stuck` (an open stuck-card,
 * #85/#86) has an open `ralph-question` comment. No SQLite, no daemon — the whole
 * queue is re-derivable from GitHub on any box.
 *
 * Questions are ordered FIFO by issue age, matching the daemon's own scheduling
 * order, so the operator works the oldest pause first.
 */

import type { GitHubClient, Issue, PrComment } from "../github/types";
import type { EscalationQuestion } from "../review/escalation";
import type { Phase } from "../store/types";
import { isRalphAnswerComment, latestAnswerAfter, latestRalphQuestion } from "./answer";
import { ANSWERABLE_LABELS, isAwaitingAnswerLabel } from "./labels";

/** One open question awaiting an operator answer. */
export interface OpenQuestionItem {
  issue: Issue;
  question: EscalationQuestion;
  /**
   * Which human-attention label the issue carries — swapped back to
   * `ready-for-agent` on answer. `awaiting-answer` / `review-maxed` resume the paused
   * run; `agent-stuck` re-admits a fresh run with the operator's guidance (#86).
   */
  label: (typeof ANSWERABLE_LABELS)[number];
  /**
   * The review phase a review-origin pause carries (recovered from its hidden `ralph-phase`
   * marker), or `null` for an impl-agent escalation. Surfaced so a control surface (the Inbox,
   * issue #112) can name the precise consequence — "re-enter phase-1 review" vs "resume the impl
   * session" — without re-scanning the comment thread.
   */
  phase: Phase | null;
}

/**
 * Whether a `ralph-answer` comment already follows the live question (the comment
 * with `questionId`). Comments arrive chronological, so an answer *after* the
 * latest question means it has been answered and the awaiting label is merely
 * lagging its removal — don't re-serve it. Guards against a window where the daemon
 * (or a prior `ralph-answer` run) posted the answer but the label swap hasn't
 * landed yet, which would otherwise let the CLI serve the same question twice.
 */
function alreadyAnswered(comments: PrComment[], questionId: number): boolean {
  const at = comments.findIndex((c) => c.id === questionId);
  if (at === -1) {
    return false;
  }
  return comments.slice(at + 1).some((c) => isRalphAnswerComment(c.body));
}

/**
 * The answerable label the issue carries, in `ANSWERABLE_LABELS` precedence
 * (awaiting-answer → review-maxed → agent-stuck), or `null` if none. Derived
 * straight from the canonical tuple so the answerable set lives in ONE place: the
 * `OpenQuestionItem['label']` type is `(typeof ANSWERABLE_LABELS)[number]`, so
 * adding a label means editing `ANSWERABLE_LABELS` alone — no parallel union or
 * runtime ladder to drift. The tuple is literal-typed, so `.find` returns exactly
 * `OpenQuestionItem['label'] | undefined`.
 */
function answerableLabel(issue: Issue): OpenQuestionItem["label"] | null {
  return ANSWERABLE_LABELS.find((l) => issue.labels.includes(l)) ?? null;
}

type LatestQuestion = ReturnType<typeof latestRalphQuestion>;

export type OpenQuestionForIssueResult =
  | { kind: "not-answerable" }
  | { kind: "open"; item: OpenQuestionItem }
  | {
      kind: "not-open";
      label: OpenQuestionItem["label"];
      latestQuestion: LatestQuestion;
      hasParseableAnswerAfterLatestQuestion: boolean;
    };

/**
 * The per-issue question read used by both the FIFO queue and targeted writes.
 * It is the single place that combines the answerable label, latest question,
 * and label-lag/answered checks into an {@link OpenQuestionItem}.
 */
export async function openQuestionForIssue(
  github: GitHubClient,
  issue: Issue,
): Promise<OpenQuestionForIssueResult> {
  const label = answerableLabel(issue);
  if (!label) {
    return { kind: "not-answerable" };
  }

  if (issue.state !== "OPEN" && !isAwaitingAnswerLabel(label)) {
    return {
      kind: "not-open",
      label,
      latestQuestion: null,
      hasParseableAnswerAfterLatestQuestion: false,
    };
  }

  const comments = await github.listIssueComments(issue.number);
  // The latest ralph-question on the issue is the live one — unless it has
  // already been answered and the label simply hasn't been swapped back yet.
  const latest = latestRalphQuestion(comments);
  const hasParseableAnswerAfterLatestQuestion =
    latest !== null && latestAnswerAfter(comments, latest.commentId) !== null;
  if (issue.state === "OPEN" && latest && !alreadyAnswered(comments, latest.commentId)) {
    return {
      kind: "open",
      item: { issue, question: latest.question, label, phase: latest.phase },
    };
  }
  return {
    kind: "not-open",
    label,
    latestQuestion: latest,
    hasParseableAnswerAfterLatestQuestion,
  };
}

/**
 * Every open question across the target repo, FIFO by issue age. Reads each
 * answerable issue's comments and parses the latest `ralph-question`. Escalate,
 * heal-card, and stuck-card questions all flow through here — same shape, one queue.
 * An `agent-stuck` issue is surfaced only when it actually carries an open (unanswered)
 * stuck-card; a bare `agent-stuck` terminal with no card stays parked, not served.
 */
export async function listOpenQuestions(github: GitHubClient): Promise<OpenQuestionItem[]> {
  const issues = (await github.listOpenIssues()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const items: OpenQuestionItem[] = [];
  for (const issue of issues) {
    const result = await openQuestionForIssue(github, issue);
    if (result.kind === "open") {
      items.push(result.item);
    }
  }
  return items;
}
