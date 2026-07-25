/**
 * The terminal side effect of the stuck budget and the wall-clock ceiling
 * (DESIGN §§3,8). Both an agent's self-stop (the `stuck` tool) and the daemon's
 * wall-clock kill converge here: the issue is labelled `agent-stuck`, a structured
 * stuck-card comment is posted, the run is marked `agent-stuck`, and the event is
 * logged. No PR is opened or recorded; the caller tears the worktree down in its
 * `finally`.
 *
 * `ready-for-agent` was already removed on pickup, so the only label change is to
 * add `agent-stuck` — the single human-attention state for a bounded-out run.
 *
 * The stuck-card comment (#85) makes the terminal self-explaining: the stuck
 * category and the agent's free-text reason — otherwise written only to the daemon
 * host's run log — become an on-issue artifact a human (and the follow-up heal
 * path) can read. It reuses the `ralph-question`/heal-card shape escalate and
 * review-maxed already post, so it renders and parses identically. This is
 * **visibility only**: it adds no awaiting/heal label and indexes no open question,
 * so the issue stays terminal on `agent-stuck` — neither picked up nor surfaced for
 * answering (making it answerable is the follow-up).
 */

import type { GitHubClient } from "../github/types";
import type { ScopedStore } from "../store/store";
import { type EscalationQuestion, formatRalphQuestion } from "../review/escalation";
import type { StuckCategory, StuckReport } from "./stuck-tool";

export interface RecordAgentStuckInput {
  issueNumber: number;
  runId: number;
  report: StuckReport;
}

/**
 * The `feature` field every stuck-card carries — the stable, recognisable marker
 * that tells a stuck-card apart from an escalate or review-maxed `ralph-question`
 * (they all share the one fenced shape). The heal re-admission path (#86) keys on
 * this to decide whether an answered question is *stuck-heal* guidance (re-admit a
 * fresh run with it injected) rather than a resolved escalation. Owned here with the
 * builder so the marker and its recogniser ({@link isStuckCardQuestion}) cannot drift.
 */
export const STUCK_CARD_FEATURE = "Bounded-effort run (no PR opened)";

/** Plain-language gloss of each stuck category, for the human reading the issue. */
const STUCK_CATEGORY_BLURB: Record<StuckCategory, string> = {
  "fix-iterations": "retried the same failure too many times",
  "no-green-build": "made many edits but could not get the build/tests green",
  futility: "judged the task cannot be completed as scoped",
  "wall-clock": "was killed by the daemon for exceeding its wall-clock ceiling",
};

/**
 * Render a stuck terminal as the `ralph-question`/heal-card shape (#85). The
 * category lands in the headline (and so the fenced payload) and the agent's reason
 * in `where we stand`, both verbatim, so the on-issue comment carries exactly what
 * the run log holds. The options are the standard heal moves — provide guidance and
 * re-enable / re-scope / close — even though answering is not yet wired (follow-up).
 */
export function buildStuckCardQuestion(report: StuckReport): EscalationQuestion {
  return {
    headline: `Agent stuck: ${report.category}`,
    feature: STUCK_CARD_FEATURE,
    whereWeStand: [
      `The run bounded out — the agent ${STUCK_CATEGORY_BLURB[report.category]}.`,
      "",
      "Agent's reason:",
      report.reason,
    ].join("\n"),
    decision: "How should this stuck run be resolved?",
    options: [
      "Provide guidance and re-enable the run (heal) so the agent retries with it injected",
      "Re-scope the issue (edit it and re-label `ready-for-agent`)",
      "Close the issue",
    ],
    stakes:
      "The agent stopped with no pull request — nothing was implemented or merged. The issue is " +
      "parked on `agent-stuck` for a human, and the daemon will not pick it up again on its own.",
    recommendation:
      "Read the agent's reason above, then either provide concrete guidance to unblock a retry, " +
      "re-scope the issue, or close it.",
  };
}

/**
 * Record an agent-stuck terminal against GitHub and the store: post the structured
 * stuck-card comment, add the `agent-stuck` label, set the run status, and log the
 * bounded-out reason. The comment goes up first so the reason is durable on the
 * issue before the label change, mirroring the escalate path.
 */
export async function recordAgentStuck(
  store: ScopedStore,
  github: GitHubClient,
  input: RecordAgentStuckInput,
): Promise<void> {
  const { issueNumber, runId, report } = input;
  await github.postComment(issueNumber, formatRalphQuestion(buildStuckCardQuestion(report)));
  // The `agent-stuck` label is no longer set here: it is a level-triggered effect of the
  // `agent-stuck` run status the `RunStuck` fact (appended below) projects — the
  // reconciler's per-tick desired-vs-actual diff applies it (issue #82, ADR-0027). The
  // non-idempotent stuck-card comment stays inline (the reason goes up before the label).
  await store.recordRunStuck({ runId, issueNumber, reason: "" });
  // Close the run span as a bounded-out terminal (issue #80).
  await store.recordRunEnded({ runId, issueNumber, outcome: "stuck" });
  store.appendLog({
    runId,
    issueNumber,
    level: "warn",
    event: "agent-stuck",
    data: { category: report.category, reason: report.reason },
  });
}

/**
 * Render the stuck-card for a session that ended **cleanly but opened no PR** (the
 * no-PR terminal). The impl agent returned a non-error, non-escalate, non-stuck
 * result — yet no pull request exists on its branch and its workspace is gone, so
 * nothing was implemented. The dominant cause is a single-shot session that launched
 * a long build/test in the background and ended before it finished (and before
 * committing): the run is never re-invoked when the backgrounded job completes, so
 * the work is lost. This is distinct from a crash-orphan (the session finished; it
 * just produced nothing), so it earns its own self-explaining card rather than the
 * bare, next-tick `agent-stuck` the generic orphan sweep would apply. It reuses
 * {@link STUCK_CARD_FEATURE} so the heal path (#86) treats an answered card exactly
 * like any other stuck-heal — the operator's answer re-admits a fresh run.
 */
export function buildNoPrCardQuestion(): EscalationQuestion {
  return {
    headline: "Agent finished without opening a PR",
    feature: STUCK_CARD_FEATURE,
    whereWeStand: [
      "The implementation session ended cleanly — no escalate, no self-stop, no error — but opened no",
      "pull request, and its workspace has been discarded, so nothing was implemented or merged.",
      "",
      "The usual cause: the session launched a long build/test in the background and then ended before it",
      "finished (and before committing). A single-shot run is not re-invoked when a backgrounded job",
      "completes, so the work is lost. The impl prompt's foreground/commit-before-stop contract targets",
      "exactly this; a re-admitted run should not repeat it.",
    ].join("\n"),
    decision: "How should this run be resolved?",
    options: [
      "Re-enable the run (re-label `ready-for-agent`) to retry from a clean start",
      "Provide guidance and re-enable the run (heal) so the retry has it injected",
      "Close the issue",
    ],
    stakes:
      "No pull request was opened — nothing landed. The issue is parked on `agent-stuck` for a human, " +
      "and the daemon will not pick it up again on its own.",
    recommendation:
      "This is usually transient — re-label `ready-for-agent` to retry. If it recurs on the same issue, " +
      "read the run's transcript for what the session did before it stopped.",
  };
}

/**
 * Record a **finished-without-a-PR** terminal against GitHub and the store — the
 * clean-session-no-PR counterpart of {@link recordAgentStuck}. Posts the
 * self-explaining {@link buildNoPrCardQuestion} card, then marks the run
 * `agent-stuck` (the `RunStuck` status the reconciler diff projects the label from,
 * ADR-0027) and closes the run span. Terminalizing inline here — rather than leaving
 * the row `running` for the next-tick orphan sweep — makes the terminal immediate and
 * self-explaining, and keeps the orphan sweep for genuine crashes (a `running` row
 * with no live agent), not clean finishes. No PR is recorded; the caller tears the
 * worktree down in its `finally`.
 */
export async function recordFinishedWithoutPr(
  store: ScopedStore,
  github: GitHubClient,
  input: { issueNumber: number; runId: number },
): Promise<void> {
  const { issueNumber, runId } = input;
  await github.postComment(issueNumber, formatRalphQuestion(buildNoPrCardQuestion()));
  await store.recordRunStuck({ runId, issueNumber, reason: "" });
  await store.recordRunEnded({ runId, issueNumber, outcome: "stuck" });
  store.appendLog({
    runId,
    issueNumber,
    level: "warn",
    event: "agent-no-pr",
    data: {},
  });
}

/**
 * Whether a parsed `ralph-question` is a stuck-card (versus an escalate or
 * review-maxed heal-card) — it carries {@link STUCK_CARD_FEATURE}. Used by the heal
 * re-admission path (#86) to tell an answered stuck-card (re-admit a fresh run with
 * the operator's guidance injected) apart from a resolved escalation.
 */
export function isStuckCardQuestion(question: EscalationQuestion): boolean {
  return question.feature === STUCK_CARD_FEATURE;
}
