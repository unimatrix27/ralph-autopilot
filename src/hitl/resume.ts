/**
 * Resume detection (DESIGN §6, CONTEXT: resume, not restart). The operator's
 * `ralph-answer` (via the CLI) swaps an issue's awaiting label back to
 * `ready-for-agent` and leaves a `ralph-answer` comment. Each tick the daemon
 * looks for its own paused runs that have been re-armed this way and resumes them
 * from their WIP branch with the question and answer injected.
 *
 * "The same agent" in a fresh-context world means the same run, branch, and
 * checkpointed WIP — re-attached from GitHub — not a literal persisted session
 * (ADR-0008). What is preserved is the work and the decision context.
 */

import type { GitHubClient, Issue, PrComment } from "../github/types";
import type { ScopedStore } from "../store/store";
import type { PausedStatus, ResumePayload, Run } from "../store/types";
import { latestAnswerAfter, latestRalphQuestion, type RalphAnswer } from "./answer";
import { LABEL_READY } from "./labels";

/** A paused run an operator answer has re-armed, ready to resume. */
export interface ResumableRun {
  issue: Issue;
  run: Run;
  answer: RalphAnswer;
  /**
   * The typed checkpoint payload, so {@link import("../executor/executor").Executor.resume}
   * can dispatch on its `phase` — a phase (review-loop escalate, or any review-maxed
   * heal) → review-loop re-entry; no phase (impl-agent escalate) → impl resume
   * (issue #9). It also carries the injected `question`, the single source for it.
   */
  context: ResumePayload;
}

/**
 * A paused run that the operator has answered (a `ralph-answer` follows its latest
 * `ralph-question`) but that is NOT re-armed with `ready-for-agent` — the #132 wedge.
 * A rate-limited `deferResume` re-arm leaves a run here: answered, so `ralph-answer`
 * skips it (already-answered), yet without `ready-for-agent`, so resume never looks at
 * it. The reconciler idempotently re-arms these each tick so the failed re-arm is
 * retried until it lands, instead of stranding the issue at `awaiting-answer`.
 */
export interface StrandedAnsweredRun {
  issue: Issue;
  run: Run;
}

/** Both verdicts a single scan of the paused runs yields (#132). */
export interface PausedRunScan {
  /** Answered + re-armed (`ready-for-agent`) + resume context intact — resume this tick. */
  resumable: ResumableRun[];
  /** Answered but the re-arm to `ready-for-agent` never landed — re-arm + surface. */
  strandedAnswered: StrandedAnsweredRun[];
}

// The two PAUSED statuses (the resumable subset). Declared wide so `.includes(run.status)`
// accepts any RunStatus, but its members are tied to `PausedStatus` so the list never drifts.
const PAUSED: readonly Run["status"][] = ["awaiting-answer", "review-maxed"] satisfies readonly PausedStatus[];

/**
 * Resolve a re-armed (`ready-for-agent`) paused run's answer + resume context into a
 * {@link ResumableRun}, or `null` if it cannot resume yet (no resume context, or no
 * `ralph-answer` correlated to its paused question). The single home of the resume
 * correlation: `context.commentId` (issue #9) keys the answer to the exact question the
 * run paused on, so a re-escalation in the same thread cannot inject a stale reply.
 */
function resolveResumable(
  issue: Issue,
  run: Run,
  comments: PrComment[],
  store: ScopedStore,
): ResumableRun | null {
  const ctx = store.getResumeContext(run.id);
  if (!ctx) {
    return null;
  }
  // The payload is typed at the store boundary (issue #9): `context.question` is the
  // injected escalation/heal-card question and `commentId` keys the resume to it.
  const { commentId } = ctx.context;
  const answer = latestAnswerAfter(comments, commentId ?? null);
  if (!answer) {
    return null;
  }
  return { issue, run, answer, context: ctx.context };
}

/**
 * Whether the comment ledger says a paused run has been answered: a `ralph-answer`
 * post-dates the latest `ralph-question`. Comment-ledger based (not store based) so it
 * still catches the #132 wedge even when resume context was lost on a restart — the
 * label alone would otherwise read the answered-but-not-re-armed run as a genuine park.
 */
function isAnsweredAwaitingReArm(comments: PrComment[]): boolean {
  const latestQuestion = latestRalphQuestion(comments);
  return latestQuestion !== null && latestAnswerAfter(comments, latestQuestion.commentId) !== null;
}

/**
 * Scan the daemon's paused runs once and split them into the two verdicts in
 * {@link PausedRunScan}. A re-armed run (`ready-for-agent`) with an answer + resume
 * context is `resumable`; a still-parked run (no `ready-for-agent`) whose latest
 * question is already answered is `strandedAnswered` — the #132 wedge a rate-limited
 * resume re-arm leaves behind. One comment read per open paused run feeds both, so
 * resume detection and the stranded-answer safety net never diverge.
 */
export async function scanPausedRuns(github: GitHubClient, store: ScopedStore): Promise<PausedRunScan> {
  const resumable: ResumableRun[] = [];
  const strandedAnswered: StrandedAnsweredRun[] = [];
  for (const run of store.listRuns()) {
    if (!PAUSED.includes(run.status)) {
      continue;
    }
    const issue = await github.getIssue(run.issueNumber);
    if (!issue || issue.state !== "OPEN") {
      continue;
    }
    const comments = await github.listIssueComments(run.issueNumber);
    if (issue.labels.includes(LABEL_READY)) {
      // Re-armed by the operator's answer (the `ralph-answer` swap-back): resume it.
      const resumed = resolveResumable(issue, run, comments, store);
      if (resumed) {
        resumable.push(resumed);
      }
    } else if (isAnsweredAwaitingReArm(comments)) {
      // Answered, but the `ready-for-agent` re-arm never landed (#132): the run is
      // invisible to both `ralph-answer` and resume. Hand it to the reconciler to
      // idempotently re-arm — its answer + resume context are durable on GitHub / the store.
      strandedAnswered.push({ issue, run });
    }
  }
  return { resumable, strandedAnswered };
}

/**
 * The paused runs whose issues now carry `ready-for-agent` again *and* have a
 * `ralph-answer` comment — i.e. the operator has answered. Each carries the
 * original question (from resume context) and the parsed answer, for injection.
 * A thin projection of {@link scanPausedRuns} — the resume path's view of the same scan.
 */
export async function findResumableRuns(github: GitHubClient, store: ScopedStore): Promise<ResumableRun[]> {
  return (await scanPausedRuns(github, store)).resumable;
}
