/**
 * The checkpoint half of the escalate path (DESIGN §6, ADR-0004). Two surfaces
 * over the same store/GitHub side effects:
 *
 *   - {@link recordEscalation}: the comment + label + SQLite half, shared by the
 *     impl-agent `escalate` tool and the review loop's fix-agent escalation —
 *     post a `ralph-question`, swap `ready-for-agent → awaiting-answer`, index the
 *     open question, write resume context, set the run `awaiting-answer`.
 *   - {@link EscalationCheckpointer}: the impl-agent entry point, which *first*
 *     makes the WIP durable in GitHub (commit+push the branch, open a draft PR)
 *     and then records the escalation. The review loop already has a PR, so it
 *     uses {@link recordEscalation} directly.
 *
 * Both leave the run resumable: the daemon resumes the same branch with the
 * answer injected once a `ralph-answer` lands (resume, not restart).
 */

import type { GitHubClient, Issue } from "../github/types";
import type { Logger } from "../log/logger";
import type { ScopedStore } from "../store/store";
import type { Phase, Mode } from "../store/types";
import type { WorktreeManager } from "../executor/worktree";
import { buildEscalationDraftPr, buildPhaseMarker, formatRalphQuestion, type EscalationQuestion } from "../review/escalation";
import { readTier } from "../core/labels";

export interface RecordEscalationInput {
  issueNumber: number;
  runId: number;
  question: EscalationQuestion;
  branch: string;
  /** The review phase, when the escalation came from the review loop. */
  phase?: Phase;
}

/**
 * Record an escalation against GitHub and the store: post the `ralph-question`,
 * add `awaiting-answer`, index the open question, checkpoint resume context, and
 * set the run `awaiting-answer`. Idempotent terminals; the slot frees when the
 * agent session returns. Returns the posted comment's id.
 */
export async function recordEscalation(
  store: ScopedStore,
  github: GitHubClient,
  input: RecordEscalationInput,
): Promise<{ commentId: number }> {
  const { issueNumber, runId, question, branch, phase } = input;
  // A review-loop escalation appends a hidden phase marker so a cold-store rehydrate
  // can tell it apart from an impl-agent escalation and re-enter the review loop at
  // the right phase — the resume context (with the phase) is rebuildable from this
  // comment alone (issue #9). An impl-agent escalation (no phase) posts no marker.
  const body =
    phase !== undefined
      ? `${formatRalphQuestion(question)}\n${buildPhaseMarker(phase)}`
      : formatRalphQuestion(question);
  const { id } = await github.postComment(issueNumber, body);
  // The `awaiting-answer` label is no longer set here: it is a level-triggered effect
  // of the `awaiting-answer` run status the `Escalated` fact (appended by `addQuestion`
  // below) projects — the reconciler's per-tick desired-vs-actual diff applies it
  // (issue #82, ADR-0027). The comment-then-label ≤1-tick split is the accepted latency;
  // the non-idempotent comment + question index + resume context stay inline here.
  await store.addQuestion({
    issueNumber,
    runId,
    kind: "escalate",
    headline: question.headline,
    commentId: id,
  });
  store.setResumeContext(
    runId,
    // `phase`-presence is the resume dispatch axis (issue #9): a review-loop escalate
    // carries it (re-enter the review loop), an impl-agent escalate omits it (resume
    // the impl session). `commentId` keys the resume to *this* question so a stale
    // prior answer in the heal-loop thread is not injected on resume (issue #10).
    { ...(phase !== undefined ? { phase } : {}), question, commentId: id },
    branch,
  );
  // No separate status write (issue #81): the `Escalated` fact appended by `addQuestion`
  // above is what the run-status projection folds into `awaiting-answer`.
  return { commentId: id };
}

/** Everything the impl checkpointer needs about the run being paused. */
export interface CheckpointContext {
  issue: Issue;
  mode: Mode;
  runId: number;
  branch: string;
  worktreePath: string;
  logger: Logger;
}

export interface EscalationCheckpointerDeps {
  store: ScopedStore;
  github: GitHubClient;
  worktrees: WorktreeManager;
}

/**
 * Checkpoints an impl agent's WIP when it calls `escalate`: makes the branch
 * durable (commit+push, draft PR) so nothing is lost while the slot is free, then
 * records the escalation. Used as the `escalate` tool's side effect.
 */
export class EscalationCheckpointer {
  constructor(private readonly deps: EscalationCheckpointerDeps) {}

  /** Returns the (draft) PR number the WIP was checkpointed onto. */
  async checkpoint(ctx: CheckpointContext, question: EscalationQuestion): Promise<{ prNumber: number }> {
    const { store, github, worktrees } = this.deps;

    // 1. Make the WIP durable in GitHub before the slot frees.
    await worktrees.checkpointWip(ctx.worktreePath, ctx.branch);
    const pr = await github.ensureDraftPullRequest(
      ctx.branch,
      buildEscalationDraftPr({
        issueNumber: ctx.issue.number,
        branch: ctx.branch,
        headline: question.headline,
        title: ctx.issue.title,
      }),
    );
    store.upsertRun({
      issueNumber: ctx.issue.number,
      mode: ctx.mode,
      tier: readTier(ctx.issue.labels),
      branch: ctx.branch,
      worktreePath: ctx.worktreePath,
      prNumber: pr.number,
      issueTitle: ctx.issue.title,
    });

    // 2. Record the escalation (comment + label + resume context + status).
    await recordEscalation(store, github, {
      issueNumber: ctx.issue.number,
      runId: ctx.runId,
      question,
      branch: ctx.branch,
    });

    store.appendLog({
      runId: ctx.runId,
      issueNumber: ctx.issue.number,
      level: "info",
      event: "escalated",
      data: { headline: question.headline, prNumber: pr.number },
    });
    ctx.logger.info("agent.escalated", { headline: question.headline, prNumber: pr.number });
    return { prNumber: pr.number };
  }
}
