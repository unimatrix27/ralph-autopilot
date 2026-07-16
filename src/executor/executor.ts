/**
 * The per-issue executor (DESIGN §3). One eligible issue becomes: a git worktree
 * on `ralph/<n>-<slug>`, a run recorded in SQLite, the `ready-for-agent` label
 * removed (so it is never re-picked), an impl agent session, the resulting PR
 * recorded, and the worktree torn down.
 *
 * The work splits in two so the reconciler can complete the *pickup* within a
 * tick and run the long agent session concurrently:
 *   - {@link Executor.claim}: worktree + run record + label removal (the claim);
 *   - {@link Executor.execute}: the agent session, PR recording, and teardown.
 * {@link Executor.run} does both, for callers that want one shot.
 *
 * The PR number is read back from GitHub — a hard fact — never taken from the
 * agent's self-report.
 */

import type { GitHubClient } from "../github/types";
import { isGitHubRateLimitError } from "../github/gh-cli";
import type { Logger } from "../log/logger";
import type { ScopedStore } from "../store/store";
import type { Mode, Phase, RestorePausedStatusInput, ResumePayload, Run } from "../store/types";
import type { ChecksResult, Issue, PullRequest } from "../github/types";
import { LABEL_AWAITING_CI, LABEL_AWAITING_MERGE, LABEL_DAEMON_ANOMALY, LABEL_READY, readTier } from "../core/labels";
import { LABEL_AGENT_STUCK, LABEL_AWAITING_ANSWER, LABEL_REVIEW_MAXED } from "../hitl/labels";
import { branchName, worktreeDirName } from "../core/slug";
import { isUsageLimitError } from "../core/usage";
import type { EscalationCheckpointer } from "../hitl/escalation-checkpoint";
import type { EscalationQuestion } from "../review/escalation";
import { buildHealGuidance } from "../review/prompts";
import { findStuckHealGuidance, type StuckHealGuidance } from "../hitl/heal-readmit";
import type { ResumeInjection } from "./prompts";
import type { AgentRunner, AgentRunResult } from "./agent";
import { createRunTranscriptSink } from "./transcript-sink";
import { RunAbortRegistry } from "./run-abort-registry";
import type { WorktreeManager } from "./worktree";
import type { ReviewLoop, ReviewLoopContext, ReviewLoopOutcome } from "../review/review-loop";
import { recordAgentStuck } from "./stuck";

/** An issue the gate admitted, with its resolved mode. */
export interface PickedIssue {
  issue: Issue;
  mode: Mode;
}

/** A claimed run: the issue has been picked up and is no longer re-pickable. */
export interface ClaimedRun {
  runId: number;
  agentId: number;
  branch: string;
  worktreePath: string;
}

export interface ExecutorResult {
  runId: number;
  branch: string;
  worktreePath: string;
  prNumber: number | null;
}

export interface ExecutorDeps {
  store: ScopedStore;
  github: GitHubClient;
  worktrees: WorktreeManager;
  agentRunner: AgentRunner;
  logger: Logger;
  /**
   * The two-phase review loop, driven on the live worktree once a PR opens
   * (DESIGN §§4–5). Optional: when absent the executor stops at PR-opened (the
   * impl-only slice). When present it runs the CI gate → review → fix →
   * rebase-aware merge before teardown, since the fix agent needs the worktree.
   */
  reviewLoop?: ReviewLoop;
  /**
   * Wires the impl agent's `escalate` tool (DESIGN §6). When present, the agent
   * can pause: calling `escalate` checkpoints its WIP to a draft PR, posts a
   * `ralph-question`, and the slot frees. Absent → the agent has no escalate tool.
   */
  escalation?: EscalationCheckpointer;
  /**
   * Cadence (ms) of the impl-session heartbeat appended to the run log so the
   * web control plane shows live progress during the long impl phase, instead of a
   * static row whose only log line is `pickup` until `agent.result` (issue #42).
   * Defaults to {@link DEFAULT_HEARTBEAT_MS}; `<= 0` disables it.
   */
  heartbeatMs?: number;
  /**
   * The daemon's graceful-drain signal (issue #35). When it is aborted, a session that
   * throws out of the failure guard is an *interruption*, not a fault, and must NOT
   * terminalize to `agent-stuck` (issue #131 / ADR-0033). The OpenAI (Codex) CLI shares
   * the daemon's process group — `@openai/codex-sdk` spawns it without a detached group
   * and hides the child pid (see `providers/codex-backend.ts`) — so a terminal SIGINT
   * kills it mid-session and it throws here; Claude's detached CLI is unaffected and the
   * graceful drain simply lets it finish. Terminalizing a drain-killed run would falsely
   * page a human and bin recoverable work, so when this is aborted the guard leaves the
   * run `running` with its PR open for the next startup's orphan sweep to re-drive
   * (resume-not-restart). Absent → every post-claim throw terminalizes (pre-#131 behaviour).
   */
  drainSignal?: AbortSignal;
  /**
   * The shared runId → AbortController registry (issue #118). When present (production
   * wiring passes ONE shared instance to every executor, plus an abort-only view to the
   * orchestrator), each live session registers its controller here keyed by run id, so
   * `DaemonControl.killRun(runId)` can tear down a specific in-flight run without reaching
   * executor internals. Absent → the executor owns a private registry (the reconciler's
   * orphan sweep still works; only web-driven kill-run needs the shared instance).
   */
  abortRegistry?: RunAbortRegistry;
}

/** Default impl-session heartbeat cadence (issue #42); overridable per deps. */
export const DEFAULT_HEARTBEAT_MS = 30_000;

/** A paused run an operator answer has re-armed, handed to {@link Executor.resume}. */
export interface ResumeRun {
  issue: Issue;
  mode: Mode;
  run: Run;
  /** The operator's answer, injected into the resumed session. */
  answer: ResumeInjection["answer"];
  /**
   * The typed checkpoint payload; its `phase`-presence selects the resume path
   * (issue #9) and its `question` is the injected question, the single source for it.
   */
  context: ResumePayload;
}

/**
 * Build the discriminated {@link RestorePausedStatusInput} from the paused run a deferred
 * resume must re-fold (issue #101). `deferResume` only runs for a run that paused at
 * `awaiting-answer` | `review-maxed` (findResumableRuns filters to those), so the wide
 * `RunStatus` default is unreachable in practice — it throws to fail loud rather than forge
 * a phantom fact onto the issue stream. The discriminant keeps each arm's fields apart:
 * `review-maxed` carries `phase` (informational for the `ReviewMaxed` fold, defaulted to keep
 * it total) plus the heal-card `commentId` so the restore remains non-notifying;
 * `awaiting-answer` carries the question `headline` + `commentId` to re-open-and-answer
 * without re-surfacing it — so the awaiting-answer arm needs no throwaway `phase`.
 */
function restorePausedStatusInput(
  run: Run,
  issueNumber: number,
  context: ResumePayload,
): RestorePausedStatusInput & { issueNumber: number } {
  switch (run.status) {
    case "review-maxed":
      return {
        issueNumber,
        runId: run.id,
        status: "review-maxed",
        phase: context.phase ?? 0,
        commentId: context.commentId ?? null,
      };
    case "awaiting-answer":
      return {
        issueNumber,
        runId: run.id,
        status: "awaiting-answer",
        headline: context.question.headline,
        commentId: context.commentId ?? null,
      };
    default:
      throw new Error(`deferResume: run ${run.id} is not in a paused status (${run.status}); cannot restore`);
  }
}

export class Executor {
  /**
   * The runId → AbortController registry — the executor's single owner of the
   * session-kill capability (issue #61), now exposed as a shared registry (issue
   * #118) so the orchestrator's `DaemonControl.killRun(runId)` can tear down a
   * specific in-flight run without reaching executor internals. A run-level
   * {@link AbortController} is linked into every SDK session the run drives
   * (impl/resume, then review/fix), so one abort tears the whole run's live session
   * down. The reconciler's orphan sweep asks the executor to {@link terminate} a run
   * wedged past its lifetime ceiling (the per-session wall-clock failed to settle
   * it); aborting the controller kills the live `query()` iteration and — through
   * the per-session reaper linked to the same signal — its subprocess tree. The
   * aborted session then throws, the failure guard terminalizes the run to
   * `agent-stuck` and prunes the worktree, and the build slot frees through
   * occupySlot's single owner — never a second writer to the reconciler's in-flight
   * map. Defaults to a private instance when no shared one is injected (a test or
   * headless embed): the orphan sweep still works; only web-driven kill-run needs
   * the shared instance wired by the daemon and exposed to the orchestrator as an
   * abort-only port.
   */
  private readonly abortRegistry: RunAbortRegistry;

  constructor(private readonly deps: ExecutorDeps) {
    this.abortRegistry = deps.abortRegistry ?? new RunAbortRegistry();
  }

  /**
   * Terminate a run's live session by run id — the slot-safe kill the reconciler's
   * orphan sweep uses on a run wedged past its lifetime ceiling (issue #61), and the
   * same primitive the orchestrator's `DaemonControl.killRun(runId)` drives for a
   * web-driven kill (issue #118). Aborts the run-level controller, which ends the
   * live SDK `query()` iteration and reaps its subprocess tree; the session then
   * throws and {@link withFailureGuard} terminalizes the run to `agent-stuck` +
   * prunes its worktree, after which the reconciler's slot frees through
   * occupySlot's single `.finally`. The executor never touches the in-flight map, so
   * the "single home" cap-accounting invariant holds. Returns whether a live session
   * was found to abort (`false` when the run already settled — the kill raced the
   * session's own exit, which is fine).
   */
  terminate(runId: number): boolean {
    const aborted = this.abortRegistry.abort(runId);
    if (aborted) {
      this.deps.logger.warn("executor.terminate", { runId });
    }
    return aborted;
  }

  /**
   * Claim an issue: create its worktree, record the run, and remove
   * `ready-for-agent`. After this resolves the issue cannot be picked up again.
   */
  async claim({ issue, mode }: PickedIssue): Promise<ClaimedRun> {
    const { store, github, worktrees } = this.deps;
    const branch = branchName(issue.number, issue.title);
    const dirName = worktreeDirName(issue.number, issue.title);

    // Worktree first: a creation failure must not claim the issue.
    //
    // Choose attach vs create by whether real, unmerged work already exists for this
    // branch (#241). A re-admitted heal (`agent-stuck → ready-for-agent`, #86) of an
    // issue that already pushed reviewed work re-enters HERE as a fresh pick — and
    // `create()` clears the "stale" branch (delete-remote + reset-to-base), which
    // WIPES that work and auto-closes its PR (the #241 data-loss). An OPEN PR on the
    // branch is the durable signal that the branch carries work to preserve, so we
    // `attach` (resume from the pushed branch) rather than `create`. Only a branch
    // with no open PR is a true fresh start.
    // Best-effort: a failing PR read (rate-limit/network) must not block the claim.
    // On error we fall back to `create` — today's behaviour — so this is a strict
    // improvement: the common heal path (read succeeds) is now protected, and the
    // rare read-failure case is no worse than before.
    let existingPr: Awaited<ReturnType<typeof github.findPullRequestForBranch>> = null;
    try {
      existingPr = await github.findPullRequestForBranch(branch);
    } catch (err) {
      this.deps.logger.warn("claim.pr-lookup-failed", {
        issue: issue.number,
        branch,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const resumeExistingWork = existingPr?.state === "OPEN";
    const worktreePath = resumeExistingWork
      ? await worktrees.attach(branch, dirName)
      : await worktrees.create(branch, dirName);
    if (resumeExistingWork) {
      this.deps.logger.info("claim.attach-existing-pr", {
        issue: issue.number,
        branch,
        pr: existingPr?.number,
      });
    }

    // Everything after the worktree exists must be unwound on failure, or the
    // claim leaks the worktree and leaves a permanent `running` row that wedges
    // the issue (it would never re-pass the gate, and the row would block re-pickup).
    try {
      const run = store.upsertRun({
        issueNumber: issue.number,
        mode,
        tier: readTier(issue.labels),
        branch,
        worktreePath,
        // Plumb the issue title once, at dispatch (issue #13): durable on the run row for the
        // fleet/run views, without any read-time GitHub call.
        issueTitle: issue.title,
      });
      const agent = store.addAgent({ runId: run.id, worktreePath, branch });
      // Open the run span (issue #80): a re-pickup appends a new `RunStarted` (abandoning
      // any prior open span, no destructive delete, ADR-0022), which resets the issue's
      // resume context for the fresh span.
      await store.recordRunStarted({ runId: run.id, issueNumber: issue.number, mode, branch, worktreePath });
      store.appendLog({ runId: run.id, issueNumber: issue.number, level: "info", event: "pickup", data: { branch, mode } });
      await github.removeLabel(issue.number, LABEL_READY);

      return { runId: run.id, agentId: agent.id, branch, worktreePath };
    } catch (err) {
      store.deleteRunByIssue(issue.number);
      try {
        await worktrees.remove(worktreePath);
      } catch (cleanupErr) {
        this.deps.logger.warn("claim.rollback-worktree-failed", {
          issue: issue.number,
          error: String(cleanupErr),
        });
      }
      throw err;
    }
  }

  /** Run the impl agent for a claimed issue, record its PR, and tear down. */
  async execute(claimed: ClaimedRun, { issue, mode }: PickedIssue): Promise<ExecutorResult> {
    const log = this.deps.logger.child({ issue: issue.number, branch: claimed.branch });
    // A fresh run on an issue whose prior attempt bounded out and was healed via
    // `ralph-answer` carries the operator's guidance into its impl prompt (#86). The
    // signal is GitHub-only (the issue's stuck-card + answer comments), so it survives
    // a cold store. Reading it is best-effort: a transient GitHub blip must not
    // terminalize a launchable run — the agent still runs from the issue body.
    let stuckHeal: StuckHealGuidance | undefined;
    try {
      stuckHeal = (await findStuckHealGuidance(this.deps.github, issue.number)) ?? undefined;
    } catch (err) {
      log.warn("heal-readmit.read-failed", { error: String(err) });
    }
    if (stuckHeal) {
      log.info("agent.heal-readmit", { headline: stuckHeal.question.headline });
    }
    return this.withFailureGuard(
      {
        issueNumber: issue.number,
        runId: claimed.runId,
        agentId: claimed.agentId,
        branch: claimed.branch,
        worktreePath: claimed.worktreePath,
        log,
      },
      (abortSignal) =>
        this.driveSession({
          issue,
          mode,
          runId: claimed.runId,
          agentId: claimed.agentId,
          branch: claimed.branch,
          worktreePath: claimed.worktreePath,
          stuckHeal,
          abortSignal,
          log,
        }),
    );
  }

  /**
   * Resume a paused run once its answer lands — resume, not restart (CONTEXT).
   * Re-attach the WIP branch, record the same run as running, then dispatch on
   * whether the checkpoint carries a review `phase` (issue #9):
   *   - a phase (review-loop fix-agent `escalate`, or any `review-maxed` heal) →
   *     re-enter the build-flow review ({@link runReviewLoop} → {@link ReviewLoop.runReview})
   *     at that phase with the operator's answer injected as fix guidance, ending at
   *     `awaiting-merge` — NOT a fresh impl pass (the PR is reviewed, not re-built);
   *   - no phase (impl-agent `escalate`) → drive the impl agent with the answer
   *     injected (the draft PR opened at checkpoint carries the work forward).
   */
  async resume(input: ResumeRun): Promise<ExecutorResult> {
    const { store, github, worktrees } = this.deps;
    const { issue, mode, run, context } = input;
    const branch = run.branch ?? branchName(issue.number, issue.title);
    const dirName = worktreeDirName(issue.number, issue.title);
    const log = this.deps.logger.child({ issue: issue.number, branch });

    // Re-arm: clear every human-attention label so the run is not re-picked while
    // it is back in flight (the answer already swapped one of these off).
    await github.removeLabel(issue.number, LABEL_READY);
    await github.removeLabel(issue.number, LABEL_AWAITING_ANSWER);
    await github.removeLabel(issue.number, LABEL_REVIEW_MAXED);

    const worktreePath = await worktrees.attach(branch, dirName);
    store.upsertRun({
      issueNumber: issue.number,
      mode,
      tier: readTier(issue.labels),
      branch,
      worktreePath,
      prNumber: run.prNumber,
      issueTitle: issue.title,
    });
    for (const q of store.listOpenQuestions()) {
      if (q.runId === run.id) {
        await store.answerQuestion(q.id);
      }
    }
    const agent = store.addAgent({ runId: run.id, worktreePath, branch });
    // Record the resume on the run span (issue #80) — the paused span continues, it does
    // not start a new one (no `RunStarted`).
    await store.recordResumed({ runId: run.id, issueNumber: issue.number });
    // `phase` (undefined for an impl-agent escalate) makes the dispatch visible: a
    // phase means review-loop re-entry, its absence an impl-session resume (#9).
    store.appendLog({ runId: run.id, issueNumber: issue.number, level: "info", event: "resume", data: { branch, phase: context.phase } });
    log.info("agent.resume", { branch, phase: context.phase });

    return this.withFailureGuard(
      { issueNumber: issue.number, runId: run.id, agentId: agent.id, branch, worktreePath, log },
      async (abortSignal) => {
        // A review-origin pause carries the phase it paused at: a `review-maxed` heal
        // (always) or a review-loop fix-agent `escalate` (which records its phase).
        // Both re-enter the review loop there with the answer injected as fix
        // guidance, ending at `awaiting-merge`. An impl-agent `escalate` has no phase
        // — resume its impl/fix session (#9). Both run under the failure guard, so a
        // throw out of either terminalizes the run and tears down the worktree.
        try {
          const reviewPhase = context.phase;
          if (reviewPhase !== undefined) {
            return await this.resumeReview(input, reviewPhase, context.question, agent.id, branch, worktreePath, abortSignal, log);
          }
          return await this.driveSession({
            issue,
            mode,
            runId: run.id,
            agentId: agent.id,
            branch,
            worktreePath,
            prNumber: run.prNumber,
            resume: { question: context.question, answer: input.answer },
            abortSignal,
            log,
          });
        } catch (err) {
          if (!isGitHubRateLimitError(err)) {
            throw err; // a genuine fault → the failure guard terminalizes (agent-stuck).
          }
          // A transient GitHub rate-limit during resume must DEFER, not terminalize
          // (issue #101 AC3): restore the prior paused state so the next tick re-resumes
          // from the WIP branch once GitHub is reachable. The work is checkpointed on the
          // branch; nothing is lost. Same family as the merge defer (AC2) and ADR-0023.
          await this.deferResume(run, issue, context, log);
          return { runId: run.id, branch, worktreePath, prNumber: run.prNumber };
        }
      },
    );
  }

  /**
   * Defer a resume that hit a transient GitHub rate-limit (issue #101 AC3): restore the
   * run's prior paused status and re-arm `ready-for-agent`, so {@link
   * import("../hitl/resume").findResumableRuns} re-picks it next tick (its answer comment
   * and resume context are durable on GitHub / the store). Every step is best-effort and
   * guarded — leaving the run paused-and-re-armed is the invariant; a transient blip on
   * one step must not throw out of the deferral and route into terminalization. The WIP
   * is on the branch (the worktree teardown in the failure guard's `finally` is harmless —
   * resume re-attaches it).
   */
  private async deferResume(run: Run, issue: Issue, context: ResumePayload, log: Logger): Promise<void> {
    const { store, github } = this.deps;
    log.warn("resume.deferred-rate-limit", { status: run.status });
    try {
      store.appendLog({
        runId: run.id,
        issueNumber: issue.number,
        level: "warn",
        event: "resume-deferred",
        data: { status: run.status, reason: "github-rate-limit" },
      });
    } catch (err) {
      log.warn("resume-deferred.append-failed", { error: String(err) });
    }
    // Restore the prior paused status (awaiting-answer / review-maxed) so the run leaves
    // `running` and re-enters the resumable set — never a silent `running` island. Status
    // is *derived* from the issue event stream now (issue #83), so the store appends the
    // matching lifecycle fact, never pokes a column; {@link ScopedStore.restorePausedStatus}
    // owns the event-model detail (re-`Escalated` must not re-surface the answered question).
    try {
      await store.restorePausedStatus(restorePausedStatusInput(run, issue.number, context));
    } catch (err) {
      log.warn("resume-deferred.status-restore-failed", { error: String(err) });
    }
    // Re-arm `ready-for-agent` (resume removed it on entry): findResumableRuns requires it.
    try {
      await github.addLabel(issue.number, LABEL_READY);
    } catch (err) {
      log.warn("resume-deferred.relabel-failed", { error: String(err) });
    }
  }

  /**
   * Re-enter the build-flow review to heal an answered review-origin pause (issue #9):
   * a `review-maxed` maxout or a review-loop fix-agent `escalate`. Re-run from the
   * paused phase against the still-open PR, injecting the operator's ruling into that
   * phase's fix attempts, and hand back off to `awaiting-merge` — the integration
   * flow owns the merge (ADR-0017), so this does NOT merge in one shot. No impl agent
   * session — the implementation is done; only the blocked review tail remains.
   */
  private async resumeReview(
    input: ResumeRun,
    phase: Phase,
    question: EscalationQuestion,
    agentId: number,
    branch: string,
    worktreePath: string,
    abortSignal: AbortSignal,
    log: Logger,
  ): Promise<ExecutorResult> {
    const { issue, mode, run, answer } = input;
    const prNumber = run.prNumber;
    if (prNumber === null) {
      // A review-origin pause paused while reviewing an open PR, so it always has
      // one; guard defensively rather than re-review a PR that does not exist.
      log.warn("resume.review-no-pr", {});
      return { runId: run.id, branch, worktreePath, prNumber: null };
    }
    await this.runReviewLoop({
      issue,
      mode,
      runId: run.id,
      agentId,
      prNumber,
      branch,
      worktreePath,
      abortSignal,
      log,
      resume: { phase, guidance: buildHealGuidance(question, answer) },
    });
    return { runId: run.id, branch, worktreePath, prNumber };
  }

  /**
   * Re-drive the review loop for an orphaned `running` run whose PR survived a
   * crash (startup reconciliation, DESIGN §1/§7). Re-attach the WIP branch's
   * worktree, record a fresh agent, and run the review+merge loop against the
   * existing PR — the impl is already done, only review/merge remains. No impl
   * agent session (the PR is the work); the worktree is torn down on return.
   *
   * The caller (reconciler) has already confirmed `pr` is OPEN and threads it in,
   * so this recovers a known-open PR — no refetch, no null-PR branch.
   */
  async recoverReview(run: Run, issue: Issue, pr: PullRequest): Promise<ExecutorResult> {
    return this.driveRecoveredReview(run, issue, pr, { event: "recover" });
  }

  /**
   * Advance a run whose parked pre-review CI wait has settled (ADR-0022 stage 1),
   * driven by the reconciler's CI poller once it has occupied a build slot. Re-attach
   * the worktree (the build flow tore it down when the slot freed), leave the parked
   * `awaiting-ci` state, and run the review continuation with the poller's terminal CI
   * verdict seeded in — so the gate does not re-poll. On success the run hands off to
   * `awaiting-merge`; `review-maxed` / `escalated` set their own terminal state inside
   * the loop. Re-entrant: a crash mid-continuation leaves a `running` row the orphan
   * sweep re-drives from phase 0, which re-parks `awaiting-ci`.
   */
  async resumeAfterCi(run: Run, issue: Issue, pr: PullRequest, checks: ChecksResult): Promise<ExecutorResult> {
    return this.driveRecoveredReview(run, issue, pr, {
      event: "ci-resume",
      data: { ciState: checks.state },
      // Leave the parked state once back to `running` (it now holds a build slot for
      // the continuation): drop the durable awaiting-ci marker — the run has left the
      // parked queue regardless of how the continuation ends.
      afterRunning: async (log) => {
        try {
          await this.deps.github.removeLabel(issue.number, LABEL_AWAITING_CI);
        } catch (err) {
          log.warn("awaiting-ci.unlabel-failed", { error: String(err) });
        }
      },
      // Seed the continuation with the poller's terminal CI verdict so the gate does
      // not re-poll (the off-slot wait already settled it).
      drive: (ctx, reviewLoop) => reviewLoop.resumeAfterCi(ctx, checks),
    });
  }

  /**
   * Re-attach an existing-PR run's worktree and re-drive its review under the failure
   * guard — the shared scaffold behind {@link recoverReview} (a crash survivor,
   * re-driven from phase 0) and {@link resumeAfterCi} (a parked `awaiting-ci` wait
   * that settled, re-driven from the CI-seeded gate). Both re-attach the WIP worktree,
   * record the run back to `running` + a fresh agent, log the recovery, and run the
   * review loop (which the guard tears the worktree down after). The two differ only
   * in `afterRunning` (a post-`running` side effect — resumeAfterCi drops the durable
   * `awaiting-ci` label; recoverReview has none), the recovery `event` name + extra
   * `data`, and the review `drive` (first-pass review vs the CI-seeded continuation).
   *
   * The caller (reconciler) has already confirmed `pr` is OPEN and threads it in, so
   * this recovers a known-open PR — no refetch, no null-PR branch.
   */
  private async driveRecoveredReview(
    run: Run,
    issue: Issue,
    pr: PullRequest,
    opts: {
      event: string;
      data?: Record<string, unknown>;
      afterRunning?: (log: Logger) => Promise<void>;
      drive?: (ctx: ReviewLoopContext, reviewLoop: ReviewLoop) => Promise<ReviewLoopOutcome>;
    },
  ): Promise<ExecutorResult> {
    const { store, worktrees } = this.deps;
    const branch = run.branch ?? branchName(issue.number, issue.title);
    const dirName = worktreeDirName(issue.number, issue.title);
    const log = this.deps.logger.child({ issue: issue.number, branch });

    const worktreePath = await worktrees.attach(branch, dirName);
    const prNumber = pr.number;
    store.upsertRun({ issueNumber: issue.number, mode: run.mode, tier: run.tier, branch, worktreePath, prNumber, issueTitle: issue.title });
    if (opts.afterRunning) {
      await opts.afterRunning(log);
    }
    const agent = store.addAgent({ runId: run.id, worktreePath, branch });
    const data = { branch, prNumber, ...opts.data };
    store.appendLog({ runId: run.id, issueNumber: issue.number, level: "info", event: opts.event, data });
    log.info(`agent.${opts.event}`, data);

    return this.withFailureGuard(
      { issueNumber: issue.number, runId: run.id, agentId: agent.id, branch, worktreePath, log },
      async (abortSignal) => {
        await this.runReviewLoop(
          { issue, mode: run.mode, runId: run.id, agentId: agent.id, prNumber, branch, worktreePath, abortSignal, log },
          opts.drive,
        );
        return { runId: run.id, branch, worktreePath, prNumber };
      },
    );
  }

  /**
   * Discard an orphaned `running` run with no live PR to re-drive (startup
   * reconciliation): a crash before the impl agent opened a PR. Mark the run
   * terminal — `agent-stuck` for an open issue (surfaced for a human, re-admitted
   * if re-labelled `ready-for-agent`), the effect-neutral `closed` (issue #81) for an
   * issue that closed while the daemon was down — and remove the worktree so none
   * survive the restart (AC3).
   */
  async discardOrphan(run: Run, issue: Issue | null): Promise<void> {
    const { store, github, worktrees } = this.deps;
    const log = this.deps.logger.child({ issue: run.issueNumber, branch: run.branch ?? "" });

    if (issue && issue.state === "OPEN") {
      // A swept orphan can already carry `daemon-anomaly` (the completeness pass flagged
      // it a running-row-not-in-flight island before this terminalized it). Seed
      // `agent-stuck` inline rather than relocating it to the reconciler diff (issue #82):
      // the diff yields the state label to a standing `daemon-anomaly` (the #28 claim-park
      // keeps it as the sole surface), so it would NOT introduce `agent-stuck` here — the
      // label would never appear and `daemon-anomaly` would never clear. The inline seed is
      // exactly the signal that distinguishes a swept orphan (→ `agent-stuck`, clears the
      // stale anomaly) from a claim-park (→ `daemon-anomaly` stays). The diff maintains the
      // label from the projection thereafter.
      await github.addLabel(run.issueNumber, LABEL_AGENT_STUCK);
      // The open-issue orphan bounded out → `agent-stuck` (RunStuck), surfaced for a human.
      await store.recordRunStuck({ runId: run.id, issueNumber: run.issueNumber, reason: "" });
    }
    // The closed-issue orphan needs no status write (issue #81): the `RunEnded { closed }`
    // below is its status fact — the effect-neutral `closed` terminal, read truthfully
    // rather than as `merged` (it never merged). The open case appended its `agent-stuck`
    // fact above; this `RunEnded` only marks the span ended for those.
    await store.recordRunEnded({
      runId: run.id,
      issueNumber: run.issueNumber,
      outcome: issue && issue.state === "OPEN" ? "stuck" : "closed",
    });
    store.appendLog({
      runId: run.id,
      issueNumber: run.issueNumber,
      level: "warn",
      event: "orphan-discarded",
      data: { hadPr: run.prNumber !== null, issueState: issue?.state ?? "GONE" },
    });
    log.warn("orphan.discarded", { issueState: issue?.state ?? "GONE", hadPr: run.prNumber !== null });

    if (run.worktreePath) {
      try {
        await worktrees.remove(run.worktreePath);
      } catch (err) {
        log.warn("worktree.remove-failed", { error: String(err) });
      }
    }
  }

  /**
   * Close out an `agent-stuck` run whose issue resolved out-of-band (issue #274):
   * a human merged a separate PR or closed the issue directly, bypassing the
   * daemon's re-admit-and-merge flow. `RunStuck` does not close the run's span, so
   * without this the projected status is pinned at `agent-stuck` and the row
   * surfaces forever in the web HITL queue. Append a `RunEnded { outcome: "closed"
   * }` so the span closes and the status flips to the effect-neutral `closed`
   * terminal — no executor discard (the run is already terminal; its worktree, if
   * any, is handled by the orphan-worktree GC). Idempotent via the caller's guard.
   *
   * Per-issue lifecycle terminalization — the same 'mark terminal + log' shape as
   * {@link discardOrphan} — so it lives here in the executor, not the reconciler;
   * the reconciler keeps only the decision to close the run out. Distinct from
   * `discardOrphan` on purpose: an out-of-band close-out is a benign span close
   * (info-level `stuck-run-closed-out-of-band`, no worktree removal), not an orphan
   * we gave up on (warn-level `orphan-discarded`, immediate worktree removal).
   * Unguarded like `discardOrphan`: the writes throw and the reconciler owns the
   * guarded swallow (its close-out wrapper, mirroring `discardOrphanSafely`), so
   * terminalization keeps one error boundary — on a write failure the swallow logs
   * and the next tick retries the close-out.
   */
  async closeOutStuckRun(run: Run): Promise<void> {
    await this.deps.store.recordRunEnded({
      runId: run.id,
      issueNumber: run.issueNumber,
      outcome: "closed",
    });
    this.deps.logger.info("reconcile.stuck-run-closed-out-of-band", {
      issue: run.issueNumber,
      runId: run.id,
    });
    this.deps.store.appendLog({
      runId: run.id,
      issueNumber: run.issueNumber,
      level: "info",
      event: "stuck-run-closed-out-of-band",
      data: {},
    });
  }

  /**
   * Surface a persistently-unclaimable issue as a `daemon-anomaly`: swap off
   * `ready-for-agent`, add the human-attention label (which excludes it from the
   * gate), record a terminal run row, and log the anomaly for live views. A human
   * clears the underlying fault and re-labels `ready-for-agent` to retry.
   *
   * Per-issue lifecycle work — the same shape as {@link discardOrphan}
   * (mark terminal + add a human-attention label + log) — so it lives here in the
   * executor, not the reconciler. The reconciler keeps only the consecutive
   * claim-failure tally and the threshold decision (issue #28, AC3).
   */
  async surfaceClaimAnomaly({ issue, mode }: PickedIssue, failures: number, error: string): Promise<void> {
    const { store, github, logger } = this.deps;
    const issueNumber = issue.number;
    try {
      await github.removeLabel(issueNumber, LABEL_READY);
      await github.addLabel(issueNumber, LABEL_DAEMON_ANOMALY);
    } catch (labelErr) {
      logger.error("claim.anomaly-label-failed", { issue: issueNumber, error: String(labelErr) });
    }
    const run = store.upsertRun({
      issueNumber,
      mode,
      tier: readTier(issue.labels),
      branch: branchName(issueNumber, issue.title),
      issueTitle: issue.title,
    });
    const anomalyReason = `claim-failed-after-${failures}-attempts`;
    // The terminal status is event-sourced (issue #83): append the `RunStuck` fact so the
    // run row reads back `agent-stuck` from the projection. The same commit also appends
    // `AnomalyDetected`, because `daemon-anomaly` is the on-issue human surface.
    await store.recordRunStuckWithAnomaly({ runId: run.id, issueNumber, reason: "", anomalyReason });
    store.appendLog({
      runId: run.id,
      issueNumber,
      level: "error",
      event: "daemon-anomaly",
      data: { reason: anomalyReason, failures, error },
    });
    logger.error("claim.anomaly", { issue: issueNumber, failures, error });
  }

  /** Claim and execute in one shot. */
  async run(picked: PickedIssue): Promise<ExecutorResult> {
    const claimed = await this.claim(picked);
    return this.execute(claimed, picked);
  }

  /**
   * Drive one impl/resume agent session, then — unless it escalated — record its
   * PR and run the review loop. Shared by {@link execute} and {@link resume}; does
   * not tear the worktree down (the callers do, in a `finally`).
   */
  private async driveSession(params: {
    issue: Issue;
    mode: Mode;
    runId: number;
    agentId: number;
    branch: string;
    worktreePath: string;
    prNumber?: number | null;
    resume?: ResumeInjection;
    /** Set on a fresh run re-admitted after a healed stuck terminal (#86): the operator's guidance, injected into the impl prompt. */
    stuckHeal?: StuckHealGuidance;
    /** Run-level abort signal (issue #61); links into this session so the orphan sweep can kill a wedged run. */
    abortSignal?: AbortSignal;
    log: Logger;
  }): Promise<ExecutorResult> {
    const { store, github } = this.deps;
    const { issue, mode, runId, agentId, branch, worktreePath, resume, stuckHeal, abortSignal, log } = params;

    // Wire the `escalate` tool if a checkpointer is configured. Calling it
    // checkpoints WIP to a draft PR and posts a ralph-question; the run pauses.
    let escalatedPr: number | null = null;
    const onEscalate = this.deps.escalation
      ? async (question: EscalationQuestion): Promise<void> => {
          const { prNumber } = await this.deps.escalation!.checkpoint(
            { issue, mode, runId, branch, worktreePath, logger: log },
            question,
          );
          escalatedPr = prNumber;
        }
      : undefined;

    // Emit a periodic heartbeat for live views: the daemon logs nothing
    // else between `pickup` and `agent.result`, so without this the impl phase
    // shows as a static row with no live progress (issue #42). The agent row
    // carries no stored phase during impl; a `null` phase decodes to the `impl`
    // label (see review/phase.ts: `decodeAgentPhase`), and the review loop sets
    // the phase thereafter.
    const stopHeartbeat = this.startHeartbeat(runId, issue.number, log);

    let result: AgentRunResult;
    try {
      result = await this.deps.agentRunner.run({
        issue,
        mode,
        runId,
        worktreePath,
        branch,
        logger: log,
        onEscalate,
        resume,
        stuckHeal,
        abortSignal,
        transcriptSink: this.transcriptSinkFor(runId, issue.number, log),
      });
    } finally {
      stopHeartbeat();
    }
    log.info("agent.finished", { ok: result.ok, escalated: result.escalated, stuck: result.stuck?.category });

    if (result.limited) {
      // Transient Claude usage/session-limit hit (the OAuth plan window is
      // exhausted) — NOT a fault and NOT `agent-stuck`. Restore `ready-for-agent`
      // and drop the run so the issue is re-admitted cleanly once the usage
      // cooldown (tripped on the shared meter by the agent runner) expires. The
      // session aborted, so there is no work to preserve; the worktree is torn down
      // by the failure guard's `finally` on return.
      log.warn("agent.usage-limited", { issue: issue.number });
      store.appendLog({ runId, issueNumber: issue.number, level: "warn", event: "usage-limited", data: {} });
      try {
        await github.addLabel(issue.number, LABEL_READY);
      } catch (err) {
        log.warn("usage-limited.relabel-failed", { error: String(err) });
      }
      store.deleteRunByIssue(issue.number);
      return { runId, branch, worktreePath, prNumber: null };
    }

    if (result.escalated) {
      // Terminal for this slot: the checkpoint already posted the question and
      // swapped to awaiting-answer. No review; the daemon resumes on answer.
      return { runId, branch, worktreePath, prNumber: escalatedPr };
    }

    if (result.stuck) {
      // Bounded out (stuck-budget self-stop or wall-clock kill): label the issue
      // `agent-stuck`, no PR, no review. The worktree is torn down by the caller.
      await recordAgentStuck(store, github, { issueNumber: issue.number, runId, report: result.stuck });
      log.warn("agent.stuck", { category: result.stuck.category });
      return { runId, branch, worktreePath, prNumber: null };
    }

    // Record the PR read back from GitHub (a hard fact), or fall back to the
    // checkpointed draft PR carried in on resume. The agent has already SUCCEEDED
    // here; if reading its PR back throws (e.g. a GitHub rate-limit blip that
    // outlived the gh client's retries), do NOT let it propagate into the failure
    // guard — that would terminalize a run whose work actually landed to
    // `agent-stuck` and page a human for nothing (issue 2071). Leave the row
    // `running` and return: the next tick's orphan sweep (`reconcileOrphanRunningRow`)
    // re-reads the PR once GitHub is reachable and re-drives the review, exactly
    // like a crash survivor. A definitive null (read succeeded, no PR) still falls
    // through to the `no-pr` discard path below.
    let pr: PullRequest | null;
    try {
      pr = await github.findPullRequestForBranch(branch);
    } catch (err) {
      log.warn("agent.pr-read-failed", { error: String(err) });
      return { runId, branch, worktreePath, prNumber: params.prNumber ?? null };
    }
    const prNumber = pr?.number ?? params.prNumber ?? null;
    if (prNumber === null) {
      log.warn("agent.no-pr", { ok: result.ok });
      return { runId, branch, worktreePath, prNumber: null };
    }

    store.upsertRun({ issueNumber: issue.number, mode, tier: readTier(issue.labels), branch, worktreePath, prNumber, issueTitle: issue.title });
    store.appendLog({ runId, issueNumber: issue.number, level: "info", event: "pr-opened", data: { prNumber } });

    await this.runReviewLoop({ issue, mode, runId, agentId, prNumber, branch, worktreePath, abortSignal, log });
    return { runId, branch, worktreePath, prNumber };
  }

  /**
   * Run the *build flow* review (resolve → CI gate → P1 → P2) against an open PR.
   * The pre-review CI wait is parked off-slot (ADR-0022 stage 1): on a first pass the
   * loop hands back `awaiting-ci` before any blocking poll. On success it hands the
   * run off to the single-concurrency integration flow (`awaiting-merge`). Either
   * hand-off sets the run status, adds the durable label (so a cold-store restart
   * rebuilds the parked wait / merge queue), and frees the slot — the reconciler's
   * CI poller / merge worker picks it up. `review-maxed` / `escalated` set their own
   * terminal state inside the loop. The single home for the review tail — the
   * `reviewLoop` guard, the `review.finished` log, and the hand-off — shared by
   * {@link driveSession}, {@link recoverReview}, and {@link resumeAfterCi}. The
   * `drive` thunk selects which review entry point runs (a first-pass {@link
   * ReviewLoop.runReview} by default; the CI-seeded {@link ReviewLoop.resumeAfterCi}
   * for a settled park), so the tail is never re-spelled per call site. A no-op when
   * no `reviewLoop` is configured (the impl-only slice).
   */
  private async runReviewLoop(
    params: {
      issue: Issue;
      mode: Mode;
      runId: number;
      agentId: number;
      prNumber: number;
      branch: string;
      worktreePath: string;
      /** Run-level abort signal (issue #61); links into the review/fix sessions so the orphan sweep can kill a wedged run. */
      abortSignal?: AbortSignal;
      log: Logger;
      /** Set on a review-origin heal: re-enter at this phase with the operator's guidance (issue #9). */
      resume?: { phase: Phase; guidance: string };
    },
    drive: (ctx: ReviewLoopContext, reviewLoop: ReviewLoop) => Promise<ReviewLoopOutcome> = (ctx, reviewLoop) =>
      reviewLoop.runReview(ctx),
  ): Promise<void> {
    if (!this.deps.reviewLoop) {
      return;
    }
    const { issue, mode, runId, agentId, prNumber, branch, worktreePath, abortSignal, log, resume } = params;
    const outcome = await drive(
      { issue, mode, runId, agentId, prNumber, branch, worktreePath, abortSignal, logger: log, resume },
      this.deps.reviewLoop,
    );
    log.info("review.finished", { outcome: outcome.kind });
    await this.handleReviewHandoff(outcome.kind, { issue, runId, prNumber, log });
  }

  /**
   * Apply a build-flow review/CI outcome's durable hand-off: park `awaiting-ci`
   * (ADR-0022 stage 1) or queue `awaiting-merge` (ADR-0017). Each sets the run status,
   * then frees the slot for the matching reconciler poller. `review-maxed` / `escalated`
   * are no-ops here — the loop already set their terminal state. Shared by the
   * first-pass review ({@link runReviewLoop}) and the post-CI resume ({@link
   * resumeAfterCi}).
   *
   * The `awaiting-merge` label is no longer set here: it is a level-triggered effect of
   * the `awaiting-merge` run status the `ReviewPassed` fact projects — the reconciler's
   * per-tick desired-vs-actual diff applies it (issue #82, ADR-0027). `awaiting-ci` is
   * NOT one of the four relocated effects, so it stays an inline durable marker here.
   */
  private async handleReviewHandoff(
    kind: ReviewLoopOutcome["kind"],
    ctx: { issue: Issue; runId: number; prNumber: number; log: Logger },
  ): Promise<void> {
    const { issue, runId, prNumber, log } = ctx;
    // Only the two park outcomes carry a durable hand-off; `review-maxed` /
    // `escalated` (and `merged`) already set their terminal state in the loop.
    if (kind !== "awaiting-ci" && kind !== "awaiting-merge") {
      return;
    }
    if (kind === "awaiting-ci") {
      // The status fact `CiAwaited` (the run parked off the build pool, issue #81).
      await this.deps.store.recordCiAwaited({ runId, issueNumber: issue.number });
      // `awaiting-ci` is out of scope of the four relocated effects (issue #82): keep
      // its durable label inline so a cold-store restart rebuilds the parked CI wait.
      try {
        await this.deps.github.addLabel(issue.number, LABEL_AWAITING_CI);
      } catch (err) {
        log.warn("awaiting-ci.label-failed", { error: String(err) });
      }
    } else {
      // The fast-path-safe review→integration hand-off fact `ReviewPassed` (issue #81).
      await this.deps.store.recordReviewPassed({ runId, issueNumber: issue.number });
    }
    this.deps.store.appendLog({ runId, issueNumber: issue.number, level: "info", event: kind, data: { prNumber } });
  }

  /**
   * Integration flow (single concurrency, driven by the reconciler's merge lease):
   * re-attach the worktree of an `awaiting-merge` run and run the resolve+merge
   * step against its existing PR. Re-attach (not a fresh impl) preserves WIP; the
   * run keeps status `awaiting-merge` until {@link ReviewLoop.runIntegration}
   * terminalizes it (merged / review-maxed / escalated). The `awaiting-merge`
   * label is cleared on return regardless of outcome (the run has left the queue).
   * Re-entrant: a crash mid-integration re-attaches and re-resolves from the last
   * pushed commit (force-push uses `--force-with-lease`).
   */
  async integrate(run: Run, issue: Issue, pr: PullRequest): Promise<ExecutorResult> {
    const { store, github, worktrees } = this.deps;
    const branch = run.branch ?? branchName(issue.number, issue.title);
    const dirName = worktreeDirName(issue.number, issue.title);
    const log = this.deps.logger.child({ issue: issue.number, branch });

    const worktreePath = await worktrees.attach(branch, dirName);
    const prNumber = pr.number;
    // Refresh the re-attached worktree path; keep status awaiting-merge (the merge
    // lease, not the status, marks "currently integrating", so a crash re-picks it).
    store.upsertRun({ issueNumber: issue.number, mode: run.mode, tier: run.tier, branch, worktreePath, prNumber, issueTitle: issue.title });
    const agent = store.addAgent({ runId: run.id, worktreePath, branch });
    store.appendLog({ runId: run.id, issueNumber: issue.number, level: "info", event: "integrate", data: { branch, prNumber } });
    log.info("agent.integrate", { branch, prNumber });

    return this.withFailureGuard(
      { issueNumber: issue.number, runId: run.id, agentId: agent.id, branch, worktreePath, log },
      async (abortSignal) => {
        // A transient GitHub rate-limit on the merge/pre-merge path must DEFER, not
        // terminalize (issue #101 AC2): the run already passed review + CI, so leave it
        // `awaiting-merge` (status untouched + its queue label kept) for the next tick's
        // merge worker to retry — no PR close, no `agent-stuck` swap. Same defect class
        // as ADR-0023 on the Claude side: a self-clearing external limit self-heals.
        let deferred = false;
        try {
          if (this.deps.reviewLoop) {
            const outcome = await this.deps.reviewLoop.runIntegration({
              issue,
              mode: run.mode,
              runId: run.id,
              agentId: agent.id,
              prNumber,
              branch,
              worktreePath,
              abortSignal,
              logger: log,
            });
            log.info("integrate.finished", { outcome: outcome.kind });
          }
          return { runId: run.id, branch, worktreePath, prNumber };
        } catch (err) {
          if (!isGitHubRateLimitError(err)) {
            throw err; // a genuine fault → the failure guard terminalizes (agent-stuck).
          }
          deferred = true;
          log.warn("integrate.deferred-rate-limit", { prNumber, error: String(err) });
          // Best-effort run-log line: a throw here (e.g. a transient SQLITE_BUSY) must not
          // re-raise past the defer into withFailureGuard — that would terminalize the run
          // `agent-stuck`, the exact outcome the defer exists to prevent. Same guard as the
          // symmetric deferResume append.
          try {
            store.appendLog({
              runId: run.id,
              issueNumber: issue.number,
              level: "warn",
              event: "integrate-deferred",
              data: { prNumber, reason: "github-rate-limit" },
            });
          } catch (appendErr) {
            log.warn("integrate-deferred.append-failed", { error: String(appendErr) });
          }
          // Return normally — the run stays `awaiting-merge` (no status write happened),
          // so the next tick re-leases and retries the merge.
          return { runId: run.id, branch, worktreePath, prNumber };
        } finally {
          // The run has left the merge queue (merged, or terminalized to review-maxed /
          // awaiting-answer, or a thrown failure) — drop the queue marker so it never
          // lingers as a stale awaiting-merge. A rate-limit DEFER is the one exception:
          // it stays queued, so the label is kept for the retry.
          if (!deferred) {
            try {
              await github.removeLabel(issue.number, LABEL_AWAITING_MERGE);
            } catch (err) {
              log.warn("awaiting-merge.unlabel-failed", { error: String(err) });
            }
          }
        }
      },
    );
  }

  /**
   * Build the transcript capture sink for an impl/resume session (ADR-0030), bound to
   * this run's `(repo, issue, runId)`. Capture is a best-effort side-channel: an append
   * failure is logged and dropped, never surfaced into the run. The runId is the run's
   * correlation tag (the same `String(run.id)` the domain events carry, ADR-0022).
   */
  private transcriptSinkFor(runId: number, issueNumber: number, log: Logger) {
    return createRunTranscriptSink(this.deps.store, issueNumber, String(runId), log);
  }

  /**
   * Start a periodic `impl-heartbeat` run-log line while an impl agent session
   * runs, and return a function that stops it. Lets the web control plane show live
   * progress during the long impl phase (issue #42). A transient append failure
   * is swallowed — the next tick retries; the heartbeat never breaks a session.
   */
  private startHeartbeat(runId: number, issueNumber: number, log: Logger): () => void {
    const intervalMs = this.deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    if (intervalMs <= 0) {
      return () => {};
    }
    const startedMs = Date.now();
    const timer = setInterval(() => {
      try {
        this.deps.store.appendLog({
          runId,
          issueNumber,
          level: "debug",
          event: "impl-heartbeat",
          data: { elapsedSeconds: Math.round((Date.now() - startedMs) / 1000) },
        });
      } catch (err) {
        log.debug("heartbeat.append-failed", { error: String(err) });
      }
    }, intervalMs);
    // Don't let the heartbeat alone keep the process alive; the agent session does.
    timer.unref();
    return () => clearInterval(timer);
  }

  /**
   * Drive one session (impl / resume / recover) under the post-claim failure
   * invariant (issue #34). On *any* throw out of `drive`, terminalize the run
   * before re-raising: without this the row stays `status=running` with no live
   * agent — a silent island the gate skips (`running` ∉ re-admittable), resume
   * ignores (only paused statuses), and any PR it opened orphans (#9's live
   * wedge). The worktree is torn down either way in `finally`; the throw still
   * propagates so the reconciler logs it and frees the slot.
   */
  private async withFailureGuard<T>(
    ctx: {
      issueNumber: number;
      runId: number;
      agentId: number;
      branch: string;
      worktreePath: string;
      log: Logger;
    },
    drive: (abortSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    // Register the run-level abort handle so the reconciler's orphan sweep can
    // {@link terminate} this run if it wedges past its lifetime ceiling (#61), and so
    // the orchestrator's abort-only DaemonControl.killRun(runId) path can tear it down
    // from the web (#118). Its signal threads through every session `drive` runs;
    // aborting it kills the live session and routes us into the catch below —
    // terminalize + teardown — exactly as a session that threw on its own. Released in
    // the same `finally` that frees the worktree, so a settled run is never terminable
    // through a stale handle.
    const controller = new AbortController();
    const releaseAbort = this.abortRegistry.register(ctx.runId, controller);
    try {
      return await drive(controller.signal);
    } catch (err) {
      // Drain/shutdown in progress (issue #131 / ADR-0033): a throw here is an
      // interruption, not a fault. The Codex CLI shares the daemon's process group
      // (codex-backend.ts — the SDK gives no detached group and hides the child pid),
      // so a terminal SIGINT kills it mid-session and it surfaces as a thrown error;
      // Claude's detached CLI is unaffected, so the graceful drain lets it finish.
      // Terminalizing this to `agent-stuck` + closing the PR would falsely page a human
      // and bin recoverable work, so skip recordExecutorFailure: leave the run row
      // `running` and the PR open. The next startup's orphan sweep re-drives it from the
      // surviving PR (resume-not-restart) — a drain-killed Codex session is recovered
      // exactly like a crash survivor. The slot still frees through occupySlot's `.finally`.
      if (this.deps.drainSignal?.aborted) {
        ctx.log.warn("executor.session-interrupted", { issue: ctx.issueNumber, reason: "drain" });
        throw err;
      }
      // A transient Claude usage/session-limit hit mid-session (the review/fix path, where
      // the impl runner's `limited` return cannot reach — issue: ADR-0028 failover). NOT a
      // fault: terminalizing a reviewed PR to `agent-stuck` is the exact outcome the defer
      // exists to prevent. The backend already tripped the bound login's cooldown (flipping
      // the meter onto the login with headroom), so leave the run resumable — row `running`,
      // PR open, like the drain case — and the per-tick orphan sweep re-drives it on the
      // other login. The slot still frees through occupySlot's `.finally`.
      if (isUsageLimitError(err)) {
        ctx.log.warn("executor.session-usage-limited", { issue: ctx.issueNumber });
        throw err;
      }
      await this.recordExecutorFailure(ctx, err);
      throw err;
    } finally {
      releaseAbort();
      await this.teardown(ctx.agentId, ctx.worktreePath, ctx.log);
    }
  }

  /**
   * Terminalize a run whose session threw after claim (issue #34): set the row to
   * `agent-stuck`, label the issue for human attention, and close any orphaned PR
   * so none dangles. Every step is best-effort and individually guarded — the
   * critical invariant (the run leaves `running`) must hold even if a GitHub call
   * fails, and this must never mask the original error with one of its own.
   */
  private async recordExecutorFailure(
    ctx: { issueNumber: number; runId: number; branch: string; log: Logger },
    error: unknown,
  ): Promise<void> {
    const { store, github } = this.deps;
    const { issueNumber, runId, branch, log } = ctx;

    // The one non-negotiable: get the run off `running`. A terminal `agent-stuck`
    // row no longer holds the issue — re-labelling `ready-for-agent` re-admits it.
    // The status fact is `RunStuck` (issue #81); awaited so its append settles before the
    // read-back below, guarded so a transient append fault cannot mask the original error.
    try {
      await store.recordRunStuck({ runId, issueNumber, reason: "" });
    } catch (err) {
      log.error("executor.terminalize-failed", { error: String(err) });
    }

    // Close the run span as a bounded-out terminal (issue #80), mirroring
    // recordAgentStuck — this is the same `agent-stuck` disposition reached via a
    // thrown/aborted session, so its span must close with the same `stuck` outcome.
    // Best-effort and guarded: a transient append failure must not throw out of this
    // method and mask the original error, nor skip the human-surfacing label below.
    try {
      await store.recordRunEnded({ runId, issueNumber, outcome: "stuck" });
    } catch (err) {
      log.warn("executor.record-run-ended-failed", { error: String(err) });
    }

    // Find the orphaned PR: the one recorded on the row (a review/fix-phase
    // failure) or one the impl agent opened on GitHub before throwing (an
    // impl-phase failure, before the row recorded it — #9's PR #31). The row
    // read is guarded too: a transient SQLITE_BUSY here must not throw out of
    // this method and skip the human-surfacing label + PR close below.
    let prNumber: number | null = null;
    try {
      prNumber = store.getRunByIssue(issueNumber)?.prNumber ?? null;
    } catch (err) {
      log.warn("executor.lookup-run-failed", { error: String(err) });
    }
    if (prNumber === null) {
      try {
        const pr = await github.findPullRequestForBranch(branch);
        if (pr && pr.state === "OPEN") {
          prNumber = pr.number;
        }
      } catch (err) {
        log.warn("executor.find-orphan-pr-failed", { error: String(err) });
      }
    }

    // Best-effort bookkeeping: a transient append failure must not throw out of
    // this method and skip the human-surfacing label + PR close below (the very
    // failure startHeartbeat already swallows for the same reason).
    try {
      store.appendLog({
        runId,
        issueNumber,
        level: "error",
        event: "executor-failed",
        data: { error: String(error), prNumber },
      });
    } catch (err) {
      log.warn("executor.append-log-failed", { error: String(err) });
    }
    log.warn("executor.terminalized", { status: "agent-stuck", prNumber });

    // Seed `agent-stuck` inline rather than relocating it to the reconciler diff (issue
    // #82): a run terminalized here can already carry `daemon-anomaly` (a session aborted
    // by the orphan sweep was surfaced as a run-wedged-past-lifetime island while it
    // settled). The diff yields a state label to a standing `daemon-anomaly` (the #28
    // claim-park rule), so it would not introduce `agent-stuck` — the seed is what flips a
    // terminalized run off the stale anomaly onto its human-attention label. The per-tick
    // diff maintains the label from the `agent-stuck` status thereafter.
    try {
      await github.addLabel(issueNumber, LABEL_AGENT_STUCK);
    } catch (err) {
      log.warn("executor.label-failed", { error: String(err) });
    }

    if (prNumber !== null) {
      try {
        await github.closePullRequest(
          prNumber,
          "Closed automatically: the executor failed mid-run, so this PR has no " +
            "live agent. The issue is labelled `agent-stuck` for human attention — " +
            "re-label it `ready-for-agent` to retry from a clean run.",
        );
        store.appendLog({
          runId,
          issueNumber,
          level: "warn",
          event: "orphan-pr-closed",
          data: { prNumber },
        });
      } catch (err) {
        log.warn("executor.close-orphan-pr-failed", { prNumber, error: String(err) });
      }
    }
  }

  private async teardown(agentId: number, worktreePath: string, log: Logger): Promise<void> {
    this.deps.store.endAgent(agentId);
    try {
      await this.deps.worktrees.remove(worktreePath);
    } catch (err) {
      log.warn("worktree.remove-failed", { error: String(err) });
    }
  }
}
