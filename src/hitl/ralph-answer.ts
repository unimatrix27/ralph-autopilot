/**
 * The `ralph-answer` service (DESIGN §6 / §7, ADR-0007): the portable,
 * GitHub-only core behind the CLI. It depends on nothing but a {@link GitHubClient}
 * — no SQLite, no daemon — so it runs on any box that can reach GitHub.
 *
 * It serves open questions one at a time, FIFO: take the oldest, capture the
 * operator's answer, write a `ralph-answer` comment, and swap the human-attention
 * label (`awaiting-answer`, or a pre-cutover `review-maxed` an operator was already
 * mid-answer on) back to `ready-for-agent`. The daemon sees the swap next tick and resumes
 * the checkpointed session.
 *
 * It refuses the `agent-stuck` terminal (ADR-0042 §7): the queue never lists it, and a
 * targeted submit returns {@link IssueAnswerSubmissionResult} `terminal-not-answerable`
 * carrying the operator-facing explanation {@link renderTerminalRefusal} builds — a refusal
 * that says *why* and *what to do instead*, never a silent no-op.
 */

import type { GitHubClient, Issue } from "../github/types";
import { formatRalphAnswer, resolveAnswer, type RalphAnswer } from "./answer";
import { isTerminalAttentionLabel, LABEL_READY, type TerminalAttentionLabel } from "./labels";
import { listOpenQuestions, openQuestionForIssue, type OpenQuestionItem } from "./queue";

/** Captures the operator's typed reply to one question; returns the raw input line. */
export type AnswerPrompter = (item: OpenQuestionItem) => Promise<string>;

export type IssueAnswerSubmissionResult =
  | { kind: "submitted"; item: OpenQuestionItem }
  | { kind: "not-submitted" }
  /**
   * The issue is parked on a master-selected terminal, which no answer may lift. `message` is
   * the rendered, operator-facing refusal — print it or return it verbatim.
   */
  | { kind: "terminal-not-answerable"; label: TerminalAttentionLabel; message: string }
  | { kind: "missing-open-question"; label: OpenQuestionItem["label"] };

/**
 * Render the refusal for a terminal an operator tried to answer — same plain-text block idiom
 * as {@link import("./render").renderQuestion}, because it lands in the same terminal. It leads
 * with the consequence-shaped facts the operator needs to rule: that a master already
 * adjudicated, that there is therefore nothing to answer, and what their actual options are.
 */
export function renderTerminalRefusal(issue: Issue, label: TerminalAttentionLabel): string {
  return [
    "",
    "────────────────────────────────────────────────────────",
    `#${issue.number} · ${issue.title}  [${label} — terminal, not answerable]`,
    "────────────────────────────────────────────────────────",
    "▸ A completed master adjudication ended this run. There is no question to answer.",
    "",
    `Why:            a fresh highest-tier master investigated this issue and concluded that`,
    `                neither another autonomous action nor a human decision would resolve it.`,
    `                \`${label}\` records that conclusion; the daemon will not pick the issue`,
    `                up again on its own.`,
    "",
    `STAKES:         answering would un-terminalize a finished adjudication into a fresh`,
    `                worker run with no master involvement — the same wall, one more time.`,
    "",
    `Your options:   1. Re-scope the issue (edit it), then re-label it \`${LABEL_READY}\` to`,
    `                   hand it back to the daemon with the new scope.`,
    "                2. Close the issue.",
    "                Read the master's card on the issue first — it names what it hit.",
    "",
  ].join("\n");
}

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
   * Every issue parked on a master-selected terminal, FIFO by issue age. These are *not*
   * questions and are never served — but an operator who came here to answer something needs to
   * see that the daemon stopped on this issue deliberately, rather than read an empty queue as
   * "nothing is wrong" (ADR-0042 §7). Rendering is the caller's; this only names them.
   */
  async listTerminals(): Promise<{ issue: Issue; label: TerminalAttentionLabel }[]> {
    const issues = (await this.github.listOpenIssues()).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    const parked: { issue: Issue; label: TerminalAttentionLabel }[] = [];
    for (const issue of issues) {
      const label = issue.labels.find(isTerminalAttentionLabel);
      if (label) {
        parked.push({ issue, label });
      }
    }
    return parked;
  }

  /**
   * Write the answer back: post a `ralph-answer` comment, then swap the issue's
   * human-attention label (`item.label`) for `ready-for-agent`. Comment first so the
   * answer is durable before the label change re-arms the daemon. The remove/add pair
   * is one adapter patch, so the answer path has the same partial-failure surface as
   * the web power actions. It only ever runs on an {@link OpenQuestionItem}, whose label is
   * an answerable pause by type — the terminal cannot reach this swap (ADR-0042 §7).
   */
  async submit(item: OpenQuestionItem, answer: RalphAnswer): Promise<void> {
    await this.github.postComment(item.issue.number, formatRalphAnswer(answer));
    await this.github.applyLabelPatch(item.issue.number, { remove: [item.label], add: [LABEL_READY] });
  }

  /**
   * Submit a prepared answer for one live issue when the HITL queue says it has an
   * open answerable question. A master-selected terminal is refused with its rendered
   * explanation rather than silently ignored. If an answerable label has no open
   * question and no already-posted answer, surface that as a domain error so callers
   * do not re-arm a resumable pause without its correlation payload.
   */
  async submitForIssue(issue: Issue, answer: RalphAnswer): Promise<IssueAnswerSubmissionResult> {
    const question = await openQuestionForIssue(this.github, issue);
    if (question.kind === "terminal") {
      return {
        kind: "terminal-not-answerable",
        label: question.label,
        message: renderTerminalRefusal(issue, question.label),
      };
    }
    if (question.kind === "not-answerable") {
      return { kind: "not-submitted" };
    }

    if (question.kind === "open") {
      await this.submit(question.item, answer);
      return { kind: "submitted", item: question.item };
    }

    if (question.latestQuestion === null || !question.hasParseableAnswerAfterLatestQuestion) {
      return { kind: "missing-open-question", label: question.label };
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
