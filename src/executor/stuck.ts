/**
 * The **pre-cutover** terminal side effect of the stuck budget and the wall-clock ceiling
 * (DESIGN §§3,8): a structured stuck-card comment is posted, the run is marked `agent-stuck`,
 * and the event is logged. No PR is opened or recorded; the caller tears the worktree down in
 * its `finally`.
 *
 * Since the triage cutover (ADR-0042 / issue #43) a worker bounding out is a *signal*, not a
 * verdict: `executor.ts` routes `stuck` and finished-without-a-PR to the master queue, and only
 * a completed master adjudication may reach `agent-stuck`. The recorders below therefore run
 * only when **no master is wired at all** — a shape that exists in unit fixtures and nowhere in
 * the live daemon. Their status writes carry the no-master fallback marker that
 * `master/terminal-authority.test.ts` counts, so the hatch cannot widen quietly.
 *
 * The stuck-card comment (#85) makes the terminal self-explaining: the stuck category and the
 * agent's free-text reason — otherwise written only to the daemon host's run log — become an
 * on-issue artifact a human can read. It reuses the `ralph-question` shape escalate posts, so
 * it renders and parses identically. It is **evidence, not a question**: the card adds no
 * awaiting label and indexes no open question, and the GitHub-only answer queue refuses an
 * `agent-stuck` issue outright (`hitl/queue.ts`, ADR-0042 §7) — an answer must never
 * un-terminalize a conclusion.
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
 * The `feature` field every stuck-card carries — the stable, recognisable marker that tells a
 * stuck-card apart from an escalate or master `ralph-question` (they all share the one fenced
 * shape), so a reader of the issue thread can see at a glance which comments are conclusions
 * and which are questions.
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
 * Render a stuck terminal as the `ralph-question` shape (#85). The category lands in the
 * headline (and so the fenced payload) and the agent's reason in `where we stand`, both
 * verbatim, so the on-issue comment carries exactly what the run log holds. The options name
 * the moves an operator can make **on the issue** — re-scope and re-label, or close — because
 * the card is not answerable through `ralph-answer` (ADR-0042 §7).
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
      "Re-enable the run (re-label `ready-for-agent`) to retry from a clean start",
      "Re-scope the issue (edit its body with what the agent was missing, then re-label `ready-for-agent`)",
      "Close the issue",
    ],
    stakes:
      "The agent stopped with no pull request — nothing was implemented or merged. The issue is " +
      "parked on `agent-stuck` for a human, and the daemon will not pick it up again on its own.",
    recommendation:
      "Read the agent's reason above, then edit the issue body with what it was missing and " +
      "re-label `ready-for-agent`, or close it. This card is a conclusion, not a question — " +
      "`ralph-answer` will not serve it, so guidance belongs in the issue itself.",
  };
}

/**
 * Record an agent-stuck terminal against GitHub and the store: post the structured
 * stuck-card comment, set the run status, and log the bounded-out reason. The comment goes up
 * first so the reason is durable on the issue before the status change, mirroring the escalate
 * path. **No-master fallback only** (ADR-0042): `executor.ts` calls this solely when no
 * `masterTriage` is wired.
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
  /* terminal-authority: no-master-fallback */
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
 * {@link STUCK_CARD_FEATURE} so the whole stuck-card family reads as one thing on the issue.
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
      "Re-scope the issue (edit its body) first, if it keeps stopping here",
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
 * worktree down in its `finally`. **No-master fallback only** (ADR-0042): `executor.ts`
 * calls this solely when no `masterEscalation` is wired.
 */
export async function recordFinishedWithoutPr(
  store: ScopedStore,
  github: GitHubClient,
  input: { issueNumber: number; runId: number },
): Promise<void> {
  const { issueNumber, runId } = input;
  await github.postComment(issueNumber, formatRalphQuestion(buildNoPrCardQuestion()));
  /* terminal-authority: no-master-fallback */
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
