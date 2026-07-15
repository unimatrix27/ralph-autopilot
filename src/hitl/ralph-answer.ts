/**
 * The `ralph-answer` service (DESIGN §6 / §7, ADR-0007): the portable,
 * GitHub-only core behind the CLI. It depends on nothing but a {@link GitHubClient}
 * — no SQLite, no daemon — so it runs on any box that can reach GitHub.
 *
 * It serves open questions one at a time, FIFO: take the oldest, capture the
 * operator's answer, write a `ralph-answer` comment, and swap the human-attention
 * label (`awaiting-answer`, `review-maxed`, or `agent-stuck`) back to
 * `ready-for-agent`. The daemon sees the swap next tick and either resumes the paused
 * agent (`awaiting-answer` / `review-maxed`) or re-admits a fresh run with the
 * guidance injected (`agent-stuck`, #86). `review-maxed` heal-cards and `agent-stuck`
 * stuck-cards flow through this exact path — same queue, same one-at-a-time loop.
 */

import type { GitHubClient, Issue } from "../github/types";
import { formatRalphAnswer, resolveAnswer, type RalphAnswer } from "./answer";
import { isAwaitingAnswerLabel, LABEL_READY } from "./labels";
import { listOpenQuestions, openQuestionForIssue, type OpenQuestionItem } from "./queue";

/** Captures the operator's typed reply to one question; returns the raw input line. */
export type AnswerPrompter = (item: OpenQuestionItem) => Promise<string>;

export type IssueAnswerSubmissionResult =
  | { kind: "submitted"; item: OpenQuestionItem }
  | { kind: "not-submitted" }
  | { kind: "missing-open-question"; label: OpenQuestionItem["label"] };

export class RalphAnswerService {
  constructor(private readonly github: GitHubClient) {}

  /** The next question to answer (oldest first), or `null` if the queue is empty. */
  async next(): Promise<OpenQuestionItem | null> {
    const open = await listOpenQuestions(this.github);
    return open[0] ?? null;
  }

  /** Every open question, FIFO — for rendering a queue overview. */
  async list(): Promise<OpenQuestionItem[]> {
    return listOpenQuestions(this.github);
  }

  /**
   * Write the answer back: post a `ralph-answer` comment, then swap the issue's
   * human-attention label (`item.label`) for `ready-for-agent`. Comment first so the
   * answer is durable before the label change re-arms the daemon. The remove/add pair
   * is one adapter patch, so the answer path has the same partial-failure surface as
   * the web power actions. The swap is generic across all three labels, so a healed
   * `agent-stuck` (#86) re-admits for free, exactly like an answered escalation.
   */
  async submit(item: OpenQuestionItem, answer: RalphAnswer): Promise<void> {
    await this.github.postComment(item.issue.number, formatRalphAnswer(answer));
    await this.github.applyLabelPatch(item.issue.number, { remove: [item.label], add: [LABEL_READY] });
  }

  /**
   * Submit a prepared answer for one live issue when the HITL queue says it has an
   * open answerable question. If an awaiting-answer/review-maxed label has no open
   * question and no already-posted answer, surface that as a domain error so callers
   * do not re-arm a resumable pause without its correlation payload.
   */
  async submitForIssue(issue: Issue, answer: RalphAnswer): Promise<IssueAnswerSubmissionResult> {
    const question = await openQuestionForIssue(this.github, issue);
    if (question.kind === "not-answerable") {
      return { kind: "not-submitted" };
    }

    if (question.kind === "open") {
      await this.submit(question.item, answer);
      return { kind: "submitted", item: question.item };
    }

    if (isAwaitingAnswerLabel(question.label)) {
      if (question.latestQuestion === null || !question.hasParseableAnswerAfterLatestQuestion) {
        return { kind: "missing-open-question", label: question.label };
      }
    }

    return { kind: "not-submitted" };
  }

  /**
   * Serve exactly one question: take the oldest, capture the operator's reply via
   * `prompter`, resolve it (free text / option pick / accept-recommendation), and
   * submit. Returns the answered item, or `null` if the queue was empty.
   */
  async serveOne(prompter: AnswerPrompter): Promise<OpenQuestionItem | null> {
    const item = await this.next();
    if (!item) {
      return null;
    }
    const raw = await prompter(item);
    const answer = resolveAnswer(item.question, raw);
    await this.submit(item, answer);
    return item;
  }
}
