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
 * Whether a parsed `ralph-question` is a stuck-card (versus an escalate or
 * review-maxed heal-card) — it carries {@link STUCK_CARD_FEATURE}. Used by the heal
 * re-admission path (#86) to tell an answered stuck-card (re-admit a fresh run with
 * the operator's guidance injected) apart from a resolved escalation.
 */
export function isStuckCardQuestion(question: EscalationQuestion): boolean {
  return question.feature === STUCK_CARD_FEATURE;
}
