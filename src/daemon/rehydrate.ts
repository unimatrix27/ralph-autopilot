/**
 * Startup reconciliation (DESIGN §1/§7, ADR-0003 — "restart the daemon and it
 * re-derives reality"). The SQLite store holds only runtime state and is
 * rebuildable from GitHub; this module is the rebuild step the daemon runs once
 * before its first reconcile tick.
 *
 * It re-derives in-flight runs from the open PRs carrying a `<!-- ralph-launch:
 * … -->` marker (a PR that came from a ralph run, not a human). For each marker
 * whose run row is missing from the store (a cold store — SQLite was lost), it
 * rebuilds:
 *   - a **paused** run (the issue carries `awaiting-answer` / `review-maxed`, or a
 *     `ralph-question` comment with the label already swapped back by an answer
 *     that landed while the daemon was down): the run row, the open-question
 *     index entry, and the resume context — so `findResumableRuns` works on an
 *     empty store and the run resumes (resume, not restart);
 *   - an **in-flight review** run otherwise (a PR exists, no human-attention
 *     state): a `running` row, which the reconciler's orphan pass re-drives.
 *
 * Reconciling the orphaned `running` rows themselves (re-drive review if a PR
 * survives, else mark terminal + remove the worktree) lives in the reconciler,
 * which owns the executor and the concurrency slots; this module only rebuilds
 * the rows so both warm- and cold-store crashes converge on that one pass.
 */

import {
  LABEL_AGENT_STUCK,
  LABEL_AWAITING_CI,
  LABEL_AWAITING_MERGE,
  LABEL_MASTER_TRIAGE,
  readMode,
  readTier,
} from "../core/labels";
import { parseMasterRequestComment, type MasterRequestPayload } from "../master/request";
import { parseLaunchMarker } from "../github/marker";
import type { GitHubClient, PrComment } from "../github/types";
import type { Logger } from "../log/logger";
import { latestRalphQuestion } from "../hitl/answer";
import { LABEL_AWAITING_ANSWER, LABEL_REVIEW_MAXED, LABEL_READY } from "../hitl/labels";
import type { EscalationQuestion } from "../review/escalation";
import type { ScopedStore } from "../store/store";
import type { PausedStatus, Phase, ResumePayload } from "../store/types";

/**
 * The attempt number a rebuilt master `ask-human` is re-adopted under. A cold store has no
 * record of which of the two per-phase attempts asked — nothing on GitHub carries it — so the
 * rebuild pins the first. That is the conservative reconstruction in the direction that matters:
 * re-adopting attempt 1 spends no fresh budget (`readoptedAttemptBudget`) and still forbids a
 * second `ask-human` on it, so the answered master cannot re-ask; at worst the phase keeps one
 * more autonomous attempt than it had, which is strictly better than losing the answer.
 */
const REBUILT_MASTER_ATTEMPT = 1;

/** The paused-run state a rebuilt run is reconstructed into, derived from GitHub. */
interface PausedReconstruction {
  status: PausedStatus;
  question: EscalationQuestion;
  commentId: number;
  /** The review phase recovered from a review-origin pause's hidden marker (issue #9); else `null`. */
  phase: Phase | null;
  /**
   * The master request the outstanding question was asked *under*, or `null` for a pre-cutover
   * worker escalation. After the cutover `ask_human` is the master's alone and every master
   * session is preceded by its own fenced `ralph-master-request` comment, so "a request comment
   * pre-dates the live question" is exactly the provenance test — and it is the only one that
   * survives a lost store (ADR-0042).
   */
  masterRequest: MasterRequestPayload | null;
}

/**
 * Rebuild missing run rows from the open PRs carrying a launch marker. A no-op
 * for any run already in the store (a warm-store restart — the row survived).
 * Returns the issue numbers it rebuilt, for logging.
 */
export async function rehydrateRunsFromGitHub(
  github: GitHubClient,
  store: ScopedStore,
  logger: Logger,
): Promise<number[]> {
  const rebuilt: number[] = [];
  for (const pr of await github.listOpenPullRequests()) {
    if (pr.state !== "OPEN") {
      continue;
    }
    const marker = parseLaunchMarker(pr.body);
    if (!marker) {
      continue;
    }
    const issueNumber = marker.issueNumber;
    if (store.getRunByIssue(issueNumber)) {
      continue; // warm store — the run row survived the restart.
    }
    const issue = await github.getIssue(issueNumber);
    if (!issue || issue.state !== "OPEN") {
      continue; // concluded (merged/closed) while the daemon was down — nothing to rebuild.
    }
    // A terminal label is terminal, PR or no PR (ADR-0042). Before the cutover an `agent-stuck`
    // issue had no marker PR, so it could never reach this loop; the cutover made a WIP
    // checkpoint mandatory before every escalation and `terminalStuck` deliberately leaves that
    // draft PR open, so a master's terminal now looks exactly like an in-flight review run
    // here. Rebuilding it as `running` would strip the `agent-stuck` label on the next tick
    // (the status projection desires none for `running`) and re-drive review on the surviving
    // PR — resurrecting a decision a master already made. `agent-stuck` is a human-attention
    // state with no run row to rebuild: the completeness pass classifies it `awaiting-human`
    // off the label alone, so skipping it here surfaces nothing and loses nothing.
    if (issue.labels.includes(LABEL_AGENT_STUCK)) {
      logger.info("rehydrate.terminal-skipped", { issue: issueNumber, prNumber: pr.number });
      continue;
    }
    const mode = readMode(issue.labels) ?? "tdd";
    const paused = await reconstructPaused(github, issueNumber, issue.labels);
    // A run that passed review and is queued for integration carries the durable
    // `awaiting-merge` label — distinct from an in-flight review run (which has no
    // such marker and is rebuilt as `running` for the orphan pass to re-drive).
    // The merge worker picks awaiting-merge runs up; they must NOT be recovered as
    // a fresh review (that would re-review and merge outside the single lease).
    const awaitingMerge = !paused && issue.labels.includes(LABEL_AWAITING_MERGE);
    // A run parked on the off-slot pre-review CI gate carries the durable
    // `awaiting-ci` label (ADR-0022 stage 1) — rebuild the parked wait so the CI
    // poller resumes it, distinct from an in-flight review run rebuilt as `running`
    // (which would re-review from scratch). `awaiting-merge` wins if both somehow
    // appear: it is strictly further along (past CI + review).
    const awaitingCi = !paused && !awaitingMerge && issue.labels.includes(LABEL_AWAITING_CI);
    // A run queued for master escalation carries the durable `master-triage` label plus a
    // fenced `ralph-master-request` comment holding its whole evidence payload (ADR-0041).
    // Both are needed: the label says *that* it is queued, the comment says *what* the master
    // must adjudicate. Rebuilding from the comment is what makes "GitHub is the source of
    // truth" real for the master queue — a lost store re-derives the escalation rather than
    // silently dropping it back into ordinary admission.
    const masterRequest =
      !paused && !awaitingMerge && !awaitingCi && issue.labels.includes(LABEL_MASTER_TRIAGE)
        ? await reconstructMasterRequest(github, issueNumber)
        : null;
    const status =
      paused?.status ??
      (awaitingMerge
        ? "awaiting-merge"
        : awaitingCi
          ? "awaiting-ci"
          : masterRequest
            ? "master-triage"
            : "running");

    // The run row holds only non-derived bookkeeping; the rebuilt status is re-established
    // as an event below (issue #83 dropped the `runs.status` column). rehydrate only ever
    // runs on a *cold* store (a surviving run row short-circuits above), so the event log
    // is empty here too — these appends start a fresh stream, never duplicate one.
    const run = store.upsertRun({
      issueNumber,
      mode,
      tier: readTier(issue.labels),
      branch: marker.branch,
      prNumber: pr.number,
      issueTitle: issue.title,
    });

    if (paused) {
      // Re-index the open question and write resume context so the run resumes
      // off a cold store exactly as it would have off the live one (issue #10:
      // key the resume to *this* question's comment id, so a stale prior answer
      // in the heal-loop thread is not injected).
      if (paused.masterRequest) {
        // A MASTER asked this question (ADR-0042), so the answer must resume the master's
        // checkpointed adjudication — not the worker that could not make the call. The fold
        // reads `awaitingHuman` ONLY from `MasterHumanQuestionRequested`, and re-adopting the
        // asking attempt additionally needs its `MasterInterventionStarted`, so both are
        // re-appended in the order the live path wrote them. Without this the rebuilt pause is
        // indistinguishable from a pre-cutover worker escalation and the operator's answer is
        // routed to the worker.
        await store.recordMasterInterventionStarted({
          issueNumber,
          runId: run.id,
          attempt: REBUILT_MASTER_ATTEMPT,
          phase: paused.masterRequest.phase,
          signature: paused.masterRequest.signature,
        });
        await store.recordMasterHumanQuestion({
          issueNumber,
          runId: run.id,
          attempt: REBUILT_MASTER_ATTEMPT,
          phase: paused.masterRequest.phase,
          headline: paused.question.headline,
          commentId: paused.commentId,
        });
      } else {
        await store.addQuestion({
          issueNumber,
          runId: run.id,
          kind: paused.status === "review-maxed" ? "heal-card" : "escalate",
          headline: paused.question.headline,
          commentId: paused.commentId,
        });
      }
      store.setResumeContext(run.id, reconstructResumePayload(paused), marker.branch);
      if (paused.status === "review-maxed") {
        // The status projection folds the heal-card's `Escalated` (from `addQuestion`) into
        // `awaiting-answer`; a maxout's status is `review-maxed`, so append the `ReviewMaxed`
        // fact on top. An `awaiting-answer` pause needs no extra fact — `Escalated` pins it.
        await store.recordReviewMaxed({ runId: run.id, issueNumber, phase: paused.phase ?? 1 });
      }
    } else if (awaitingMerge) {
      // A run queued for integration: `ReviewPassed` projects `awaiting-merge`.
      await store.recordReviewPassed({ runId: run.id, issueNumber });
    } else if (awaitingCi) {
      // A run parked on the off-slot CI gate: `CiAwaited` projects `awaiting-ci`.
      await store.recordCiAwaited({ runId: run.id, issueNumber });
    } else if (masterRequest) {
      // A queued master escalation: `MasterTriageRequested` projects `master-triage`, and
      // exactly ONE is appended per rebuilt run — so the recovered queue holds exactly one
      // pending intervention and no session can be duplicated (ADR-0041).
      await store.recordMasterTriageRequested({
        runId: run.id,
        issueNumber,
        source: masterRequest.source,
        phase: masterRequest.phase,
        lane: masterRequest.lane,
        signature: masterRequest.signature,
        headline: masterRequest.evidence.headline,
        ...(masterRequest.evidence.recommendation !== undefined
          ? { recommendation: masterRequest.evidence.recommendation }
          : {}),
        prNumber: pr.number,
      });
    }
    // An in-flight review run carries no status fact: its stream folds to `none`, which the
    // run-read defaults to `running` — the status the reconciler's orphan pass re-drives.

    store.appendLog({
      runId: run.id,
      issueNumber,
      level: "info",
      event: "rehydrate",
      data: { branch: marker.branch, prNumber: pr.number, status },
    });
    logger.info("rehydrate.run", {
      issue: issueNumber,
      branch: marker.branch,
      prNumber: pr.number,
      status,
    });
    rebuilt.push(issueNumber);
  }
  return rebuilt;
}

/**
 * Recover a queued master escalation's durable request payload from the issue thread — the
 * LATEST `ralph-master-request` comment, since a run may have escalated more than once and
 * only the most recent one is outstanding. `null` when the label is present but no parseable
 * request is: the run is then rebuilt as `running` and the ordinary orphan pass re-drives it,
 * which is the right failure mode (visible work, not a queued escalation nobody can read).
 */
async function reconstructMasterRequest(
  github: GitHubClient,
  issueNumber: number,
): Promise<MasterRequestPayload | null> {
  return latestMasterRequestBefore(await github.listIssueComments(issueNumber), null);
}

/**
 * The latest parseable `ralph-master-request` in a thread, optionally restricted to comments
 * that PRE-DATE `beforeCommentId`. The bounded form is the master-provenance test for an
 * outstanding question: after the cutover every master session is preceded by its own request
 * comment and only a master may then post a `ralph-question`, so "a request comment precedes
 * the live question" identifies a master-authored question exactly — while a pre-cutover worker
 * escalation, which has no request comment at all, correctly reads as worker-authored.
 * Comment ids order the thread here, the same correlation `latestAnswerAfter` uses.
 */
function latestMasterRequestBefore(
  comments: readonly PrComment[],
  beforeCommentId: number | null,
): MasterRequestPayload | null {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const comment = comments[i]!;
    if (beforeCommentId !== null && comment.id >= beforeCommentId) {
      continue;
    }
    const payload = parseMasterRequestComment(comment.body);
    if (payload) {
      return payload;
    }
  }
  return null;
}

/**
 * Reconstruct the paused state of an issue from GitHub, or `null` if it is not
 * paused (an in-flight review run). An issue is paused when it carries an
 * awaiting label *or* — when an answer landed while the daemon was down, swapping
 * the label back to `ready-for-agent` — it still has an open `ralph-question`
 * comment. Either way the run must resume (inject the answer), never restart.
 */
async function reconstructPaused(
  github: GitHubClient,
  issueNumber: number,
  labels: string[],
): Promise<PausedReconstruction | null> {
  const labelStatus: PausedReconstruction["status"] | null = labels.includes(LABEL_REVIEW_MAXED)
    ? "review-maxed"
    : labels.includes(LABEL_AWAITING_ANSWER)
      ? "awaiting-answer"
      : null;

  // An in-flight review run has `ready-for-agent` removed (it was taken on pickup)
  // and no awaiting label — there is no open question to rebuild.
  if (!labelStatus && !labels.includes(LABEL_READY)) {
    return null;
  }

  const comments = await github.listIssueComments(issueNumber);
  const latest = latestRalphQuestion(comments);
  if (!latest) {
    // No parseable question: a `ready-for-agent` PR with no open question is an
    // in-flight review run, not a pause.
    return null;
  }
  return {
    status: labelStatus ?? "awaiting-answer",
    question: latest.question,
    commentId: latest.commentId,
    phase: latest.phase,
    // Only an `awaiting-answer` pause can be a master `ask_human`: a `review-maxed` park is a
    // pre-cutover heal-card by construction (no live path posts one), so its question is never
    // master-authored even if a request comment happens to sit earlier in the thread.
    masterRequest:
      (labelStatus ?? "awaiting-answer") === "awaiting-answer"
        ? latestMasterRequestBefore(comments, latest.commentId)
        : null,
  };
}

/**
 * The typed resume payload for a rebuilt paused run (issue #9). Both review-origin
 * pauses re-enter the review loop, so their payload carries the phase — recovered
 * from the same hidden marker on the comment (review-maxed heal-card or review-loop
 * `escalate` alike), the only thing that survives a cold store. The loop re-reviews
 * the re-entered phase fresh against current code, so no stale worklist is carried.
 * An impl-agent escalate (no marker) carries just the question.
 */
function reconstructResumePayload(paused: PausedReconstruction): ResumePayload {
  // `phase`-presence is the resume axis (issue #9). A review-maxed always re-enters the
  // review loop, so it always carries a phase — a markerless legacy heal-card (none
  // stamped its phase before issue #9) falls back to the CI gate, a safe full re-run.
  // An escalate re-enters the review loop only when a marker phase was recovered;
  // without one it stays an impl-agent escalation (no phase → impl resume).
  const phase = paused.status === "review-maxed" ? (paused.phase ?? 0) : (paused.phase ?? undefined);
  return { phase, question: paused.question, commentId: paused.commentId };
}
