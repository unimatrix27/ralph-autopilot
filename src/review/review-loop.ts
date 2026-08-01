/**
 * The harness-owned, CI-gated, rebase-aware review+merge loop (DESIGN §§4–5,
 * ADR-0005/0012/0014/0017). It splits into two entry points the daemon runs in
 * different concurrency pools:
 *
 * {@link ReviewLoop.runReview} — the BUILD flow (high concurrency), in order:
 *
 *   Resolve (pre-review) — bring the branch current with base first (`git rebase
 *     origin/<base>`). A clean rebase proceeds; conflicts go to a fix agent that
 *     resolves them (the harness force-pushes) or escalates a risky one. Review is
 *     never spent on a branch that does not even merge.
 *
 *   Phase 0 — CI gate (await CI *before* review, issue #41), on the rebased code.
 *     Poll the PR's checks until terminal. **red** → SKIP review, treat the failing
 *     checks as the fix worklist, run the bounded fix loop (≤`maxFixAttempts`),
 *     push, re-await CI; still red (or `timeout`) → **master triage** (source `ci`; the
 *     `ReviewMaxed` fact is preserved as history — ADR-0042, no heal-card).
 *     **green / no checks** → proceed. On a repo with no checks this is a no-op.
 *
 *   Phase 1 — normal review (correctness/security/spec/tests). The review agent
 *     ingests the PR comments already present and emits a worklist; a fix agent
 *     resolves the gating items, keeps build+test green, pushes. ≤3 fix attempts.
 *     Clean → advance. Maxout → **master triage** (source `review-maxed`) and
 *     **stop** — never enter Phase 2 on behaviourally-wrong code.
 *
 *   Phase 2 — behaviour-conserving thermo (structural). Same shape,
 *     behaviour-preserving fixes only. Maxout → **master triage** (source `review-maxed`).
 *
 *   Both phases clean → `awaiting-merge` (the build flow does NOT merge; it hands
 *     off to the single-concurrency integration flow).
 *
 * {@link ReviewLoop.runIntegration} — the INTEGRATION flow (single concurrency,
 *   run under the reconciler's merge lease): resolve before merge, then, keyed on
 *   whether the branch moved, either merge directly (not moved) or re-gate CI and —
 *   unless the move was a pure fast-forward replay whose net branch diff is unchanged
 *   (issue #65) — re-review P1+P2 under the lease, before `gh pr merge <pr> --squash
 *   --delete-branch`. The issue auto-closes via `Closes #n`; the lease frees.
 *
 * A fix agent that hits a finding implying a risky structural change calls
 * `escalate` instead of applying it blind: the loop checkpoints, posts a
 * `ralph-question`, swaps to `awaiting-answer`, and stops (resume-not-restart).
 */

import { setTimeout as sleep } from "node:timers/promises";
import type {
  CheckState,
  ChecksResult,
  ChecksSnapshot,
  GitHubClient,
  MergeMethod,
  MergeStateStatus,
  MergeStatusSnapshot,
  PrComment,
} from "../github/types";
import type { Issue } from "../github/types";
import type { Logger } from "../log/logger";
import type { ScopedStore } from "../store/store";
import type { MasterLane, MasterRequestSource, Mode, Phase } from "../store/types";
import { BranchDivergedError, type RebaseResult, type WorktreeManager } from "../executor/worktree";
import { AgentOutputParseError, RunnerInfraError, type FixAgentRunner, type ReviewAgentRunner } from "./agents";
import type { EscalationQuestion } from "./escalation";
import {
  harnessEvidence,
  reviewPhaseKey,
  type MasterEscalationPort,
} from "../master/harness-escalation";
import { HostedReviewGate, type HostedGateContext } from "./hosted-gate";
import {
  describeMergeBlock,
  hostedFailureDetail,
  renderHostedWorklist,
  type HostedWorklist,
  type MergeBlockCause,
} from "./hosted-review";
import { recordEscalation } from "../hitl/escalation-checkpoint";
import { WallClockExceededError } from "../executor/wall-clock";
import { createRunTranscriptSink, type TranscriptSink } from "../executor/transcript-sink";
import {
  CI_GATE,
  MERGE,
  MERGE_CONFLICT,
  fixPhase,
  phaseLabel,
  reviewPhase,
  type AgentPhase,
} from "./phase";
import { dedupeWorklist, gatingItems, isClean, type Worklist } from "./worklist";
import { formatReviewComment, isReviewComment, latestReviewComment } from "./review-comment";
import { sanitizeForFence } from "../core/fenced-payload";

/** The fix-attempt "phase" key for the CI gate and merge-time CI re-await. */
const CI_PHASE: Phase = 0;

/**
 * Bound on rebase-conflict resolution rounds (issue #20). A landed resolution can find base has
 * advanced again inside its fix window (a sibling PR merging on a hot repo); the sync loop re-rebases
 * — usually a clean self-heal, a fresh conflict is a new round. This caps the rounds so a
 * pathologically hot base still terminates in a master request that names the RACE (not a phantom push
 * failure). Chosen to match the review fix-attempt budget's spirit (a few tries, then a human).
 */
const MAX_REBASE_ROUNDS = 3;

/**
 * Merge knobs the loop needs (a structural copy of `config.merge`, ADR-0014) so
 * the review module does not depend on the config schema.
 */
export interface MergeConfig {
  method: MergeMethod;
  waitForChecks: boolean;
  ciTimeoutMinutes: number;
  pollIntervalSeconds: number;
  deleteBranch: boolean;
  /**
   * Wall-clock **minutes** one integration keeps re-rebasing against an advancing base before it
   * escalates to the master (issue #31 — the strict-up-to-date treadmill). `0` never re-rebases on
   * `BEHIND` (park on the first, the pre-#31 behaviour). See `config.merge.behindRebaseBudgetMinutes`.
   */
  behindRebaseBudgetMinutes: number;
}

export interface ReviewLoopContext {
  issue: Issue;
  /** The issue's implementation mode; `infra` drops the test gate (DESIGN §3). */
  mode: Mode;
  runId: number;
  /** The active agent record, for live phase reporting (optional). */
  agentId?: number;
  prNumber: number;
  branch: string;
  worktreePath: string;
  logger: Logger;
  abortSignal?: AbortSignal;
  /**
   * Present when re-entering the BUILD flow to heal an answered review-origin pause
   * (issue #9): a master hand-back into the exact phase that was interrupted, or a review-loop
   * fix-agent `escalate`.
   * {@link ReviewLoop.runReview} starts at `phase` (skipping the cleanly-passed
   * earlier phases, including the phase-0 base-sync + CI prologue) and threads
   * `guidance` — the operator's ruling — into that phase's fix attempts. Absent on a
   * first pass (the loop starts at the CI gate).
   */
  resume?: { phase: Phase; guidance: string };
}

/**
 * The outcome of the loop. Two of these are *build flow* hand-offs, not full
 * terminals: `awaiting-ci` (the pre-review CI wait was parked off the build pool,
 * ADR-0022 stage 1 — the reconciler's CI poller advances it via {@link
 * ReviewLoop.resumeAfterCi}) and `awaiting-merge` (review passed — ready for the
 * single-concurrency integration flow). `merged` / `master-triage` / `escalated` are
 * full terminals reached by either flow.
 */
export type ReviewLoopOutcome =
  | { kind: "merged" }
  | { kind: "awaiting-ci" }
  | { kind: "awaiting-merge" }
  /**
   * The exhaustion terminal after the triage cutover (ADR-0042). Was `review-maxed`; the
   * *event* is still `ReviewMaxed`, but the run parks on the master queue rather than on a
   * human-attention label, and no heal-card is posted. Renamed deliberately: the compiler
   * finding every consumer is the point — a caller that still believes this means "a human
   * must act" is a bug the rename surfaces rather than hides.
   */
  | { kind: "master-triage"; phase: Phase }
  | { kind: "escalated"; phase: Phase };

/**
 * The result of {@link ReviewLoop.syncWithBase}: either a terminal outcome it hit
 * while bringing the branch current (escalated / master-triage), or `synced` with
 * whether the rebase actually `moved` the branch. The `moved` flag is what the
 * integration flow keys re-review on — base advancing under a reviewed branch can
 * break it semantically even with no textual conflict.
 */
type SyncResult =
  | { kind: "terminal"; outcome: ReviewLoopOutcome }
  | { kind: "synced"; moved: boolean };

/**
 * The verdict of {@link ReviewLoop.awaitMergeable}: whether branch protection now permits the
 * merge, needs the branch brought current with base again, or has parked. `resync` is the
 * strict-up-to-date treadmill (#31): `BEHIND` (base advanced under the rebased head) or `DIRTY`
 * (base advanced into a textual conflict) — neither clears by waiting, only by re-rebasing, which
 * {@link ReviewLoop.runIntegration} does under the held merge lease. `stuck` is a required check
 * that never greened within the CI budget (or a `DRAFT`) → a master triage request (#25, ADR-0042).
 */
type MergeReadiness =
  | { kind: "mergeable" }
  | { kind: "resync"; state: MergeStateStatus }
  | { kind: "stuck"; outcome: ReviewLoopOutcome };

/** The terminal outcome of a single phase. */
type PhaseOutcome =
  | { kind: "clean" }
  // `cause: "infra"` marks a maxout caused by a daemon-side container infra fault that survived
  // `maxContainerRetries` re-dispatches (issue #220) — the terminal is still master triage
  // (resume-from-WIP preserves the PR) but the evidence names the infra fault honestly, so the
  // master can tell a box problem from a code problem.
  | { kind: "maxed"; worklist: Worklist; attempts: number; cause?: "infra" }
  | { kind: "escalated"; question: EscalationQuestion };

/**
 * The verdict of one assess step inside {@link ReviewLoop.boundedFixLoop}:
 * - `clean`    — nothing gating; the loop returns clean.
 * - `blocked`  — gating items remain; spend a fix attempt (if budget allows).
 * - `hardStop` — gating items that another fix attempt cannot cure (a CI
 *                `timeout`); max out immediately regardless of the attempt budget.
 */
type Assessment =
  | { kind: "clean" }
  | { kind: "blocked"; worklist: Worklist }
  | { kind: "hardStop"; worklist: Worklist };

/**
 * One phase's wiring for {@link ReviewLoop.boundedFixLoop}: the attempt-budget
 * key, whether its fixes must be behaviour-preserving, the assess step (which
 * owns its own per-iteration logging), and the two loop-specific log lines.
 */
interface BoundedFixLoopSpec {
  /** The (run, phase) attempt-budget key, also the `phase` handed to the fix agent. */
  phase: Phase;
  /** Phase 2 fixes must be behaviour-preserving; all others may change behaviour. */
  behaviourPreserving: boolean;
  /**
   * True for the review phases (1, 2): the findings live in the rolling
   * `ralph-review` comment on the PR, so the fix agent is pointed there (issue #47).
   * False for the CI gate, whose worklist is the inline failing checks.
   */
  worklistOnPr: boolean;
  /** Poll/review, log the per-iteration detail, and classify into an {@link Assessment}. */
  assess: () => Promise<Assessment>;
  /**
   * Optional last-chance re-read, run once just before the phase would flip to
   * master triage (issue #125). Returns `true` if the phase is now actually clean —
   * the gate then proceeds instead of maxing. The CI gate uses it to take one more
   * snapshot read, closing the race where a slow CI's green lands inside the poll
   * window after the wire read that would otherwise terminalize. Absent on the review
   * phases (their findings do not race against an external service).
   */
  reconfirm?: () => Promise<boolean>;
  /** Log the maxed verdict (event name + payload differ between gate and review). */
  logMaxed: (worklist: Worklist, attempts: number) => void;
  /** Log a fix attempt about to run (event name + payload differ likewise). */
  logFixAttempt: (attempt: number, worklist: Worklist) => void;
}

/**
 * The genuine per-call-site variances of {@link ReviewLoop.degradeContainerFault} — the shared
 * container-terminal classification used by both {@link ReviewLoop.boundedFixLoop} and the
 * single-shot {@link ReviewLoop.resolveRebaseConflicts}. Everything else (which error kind maps to
 * which degradation, the bounded infra-retry budget, the log lines) is invariant and lives once in
 * the helper, so a new terminal kind or a changed retry budget cannot drift between the two loops.
 */
interface ContainerFaultSpec {
  /** The phase for the log lines (also the fix-agent key). */
  phase: Phase;
  /**
   * The attempt count to report on a wall-clock / parse terminal: the real fix-attempt budget
   * spent in the bounded loop, or a constant `1` for the single-shot rebase resolve. (The infra
   * terminal always reports its own separate re-dispatch count, not this.)
   */
  terminalAttempts: () => number;
  /**
   * Terminalize a runner-reported failure surfaced as {@link AgentOutputParseError}: log the
   * phase-appropriate warn line and return the phase-appropriate blocker worklist. The bounded
   * review phases name the JSON contract ({@link parseFailureWorklist}); the rebase resolve names
   * the rebase/push failure ({@link rebaseFixFailedWorklist}) — its primary cause is a refused
   * force-push, not bad JSON, so it must not surface the "fix your JSON" card.
   */
  onParseFailure: (err: AgentOutputParseError) => Worklist;
  /**
   * Mirror each terminal into the phase's maxout log (the bounded loop's `spec.logMaxed`);
   * absent for the single-shot resolve, whose caller owns that logging.
   */
  logMaxed?: (worklist: Worklist, attempts: number) => void;
}

/**
 * The verdict of {@link ReviewLoop.degradeContainerFault}: either re-dispatch (a transient container
 * infra fault still within the bounded retry budget — the caller `continue`s its own loop) or
 * terminalize the phase with this {@link PhaseOutcome}. A fault that is neither (an unexpected error,
 * or a `UsageLimitError`) is rethrown from the helper, unchanged, to {@link ReviewLoop.withFailureGuard}.
 */
type ContainerFaultDegradation = { kind: "retry" } | { kind: "terminal"; outcome: PhaseOutcome };

export interface ReviewLoopDeps {
  store: ScopedStore;
  github: GitHubClient;
  reviewAgent: ReviewAgentRunner;
  fixAgent: FixAgentRunner;
  logger: Logger;
  /** Fix attempts allowed per phase before the phase escalates (config.review.maxFixAttempts). */
  maxFixAttempts: number;
  /**
   * Bounded daemon-side re-dispatches of a review/fix run that produced **no result** because of a
   * container **infra fault** (a dropped pipe / killed / un-started container) before the phase
   * terminalizes (issue #220, `config.review.maxContainerRetries`). Counted *separately* from
   * {@link maxFixAttempts}: a transient `docker run` hiccup self-heals on retry instead of pulling
   * in a human; `0` disables retry.
   */
  maxContainerRetries: number;
  /** Worktree manager — the rebase-aware merge rebases the branch onto base here. */
  worktrees: WorktreeManager;
  /** The base branch the PR targets (e.g. `main`); the rebase target. */
  baseBranch: string;
  /** Harness-owned merge configuration (CI gate + rebase-aware merge). */
  merge: MergeConfig;
  /**
   * Sleeps `ms` between merge-readiness polls ({@link ReviewLoop.awaitMergeable}).
   * Defaults to a real timer; injected as a no-op in tests so a scripted BLOCKED→CLEAN
   * merge-state sequence is polled without actually waiting.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Monotonic wall-clock (epoch ms) used to bound the BEHIND re-rebase budget
   * ({@link ReviewLoop.runIntegration}, issue #31). Defaults to `Date.now`; injected in tests so a
   * hot-base treadmill terminates deterministically without real time passing.
   */
  now?: () => number;
  /**
   * The triage cutover's door to the master queue (ADR-0042). Every terminal this loop used
   * to reach — a maxed-out phase, a CI gate that never greened, an exhausted rebase, a merge
   * preparation that never became mergeable, an unresolved hosted-review conversation — goes
   * through here instead of manufacturing a `review-maxed` heal-card. Absent (the legacy unit
   * fixtures) → the loop records the `ReviewMaxed` fact alone and stops, which is the same
   * *history* minus the queue entry; it never falls back to posting a heal-card.
   */
  masterEscalation?: MasterEscalationPort;
  /**
   * The GitHub-hosted review gate (issue #43). Present → the merge path classifies a `BLOCKED`
   * into typed causes and reads the hosted reviewer's conversations before spending any CI
   * budget. Absent → the loop behaves as it did before hosted review existed (no hosted gate).
   */
  hostedGate?: HostedReviewGate;
}

/**
 * `mergeStateStatus` values that permit an immediate merge — branch protection is
 * satisfied. `CLEAN` (all required checks passed, branch current), `UNSTABLE` (only
 * NON-required checks pending/failing — `gh pr merge` still succeeds), and `HAS_HOOKS`
 * (pre-receive hooks pass). Every other state (`BLOCKED`/`BEHIND`/`DIRTY`/`DRAFT`/
 * `UNKNOWN`) means "not yet" — the merge poll waits it out.
 */
const MERGEABLE_STATES = new Set<MergeStateStatus>(["CLEAN", "UNSTABLE", "HAS_HOOKS"]);

export class ReviewLoop {
  constructor(private readonly deps: ReviewLoopDeps) {}

  /**
   * Drive the whole loop end to end: the build flow ({@link runReview}) then, if it
   * passed, the integration flow ({@link runIntegration}). The two are separate
   * entry points so the daemon can run them in different concurrency pools (review
   * in the high-concurrency build pool, integration under a single merge lease);
   * `run` is the back-to-back composition, used directly at concurrency 1 and by
   * the unit tests. Idempotent terminals; never throws on outcome.
   *
   * The build flow parks the pre-review CI wait off-slot as `awaiting-ci` (ADR-0022
   * stage 1) — in the daemon a reconciler poller advances it, but `run` has no
   * poller, so it drives that wait inline (a blocking `awaitChecks`, then {@link
   * resumeAfterCi}) before continuing to integration. The observable behaviour is
   * identical to the pre-ADR-0022 loop; only the daemon path frees a slot to wait.
   */
  /**
   * Build the transcript capture sink for one review/fix session (ADR-0030), bound to
   * the run's `(repo, issue, runId)` so the conversation lands on the same per-run
   * stream as the impl session. Best-effort — an append failure is logged, not raised.
   */
  private transcriptSink(ctx: ReviewLoopContext): TranscriptSink {
    return createRunTranscriptSink(this.deps.store, ctx.issue.number, String(ctx.runId), this.deps.logger);
  }

  async run(ctx: ReviewLoopContext): Promise<ReviewLoopOutcome> {
    let outcome = await this.runReview(ctx);
    // The build flow parks the pre-review CI wait off-slot; `run` has no poller, so
    // drive that wait inline (blocking await + resumeAfterCi) before the merge tail.
    if (outcome.kind === "awaiting-ci") {
      const checks = await this.deps.github.awaitChecks(ctx.prNumber, {
        ciTimeoutMinutes: this.deps.merge.ciTimeoutMinutes,
        pollIntervalSeconds: this.deps.merge.pollIntervalSeconds,
      });
      outcome = await this.resumeAfterCi(ctx, checks);
    }
    // One merge tail: review passed (`awaiting-merge`) → integrate; any other
    // outcome (terminal, or a CI continuation that did not reach the merge queue)
    // is returned as-is.
    if (outcome.kind !== "awaiting-merge") return outcome;
    return this.runIntegration(ctx);
  }

  /**
   * Build flow: resolve before review, then — on a first pass — park the pre-review
   * CI wait off the build pool as `awaiting-ci` (ADR-0022 stage 1) and hand back, so
   * the reconciler's CI poller advances it ({@link resumeAfterCi}) without holding a
   * slot to poll. A heal re-entering with operator guidance (which is not durable
   * across a park) runs the gate inline instead; a no-CI repo (`waitForChecks` off)
   * likewise skips the park (its gate is a clean no-op). Ends at `awaiting-merge`
   * (review passed — ready for integration) and deliberately does NOT merge; the
   * integration flow owns the merge. Returns a terminal (`master-triage` /
   * `escalated`) if a phase could not pass.
   */
  async runReview(ctx: ReviewLoopContext): Promise<ReviewLoopOutcome> {
    const log = ctx.logger;
    // A heal re-enters at the maxed-out phase, skipping the earlier phases that
    // already passed cleanly (issue #9); a first pass starts at the CI gate.
    const startPhase: Phase = ctx.resume?.phase ?? CI_PHASE;
    if (ctx.resume) {
      log.info("review.resume", { phase: startPhase });
    }

    // Phase 0 prologue — resolve before review (bring the branch current with base
    // and resolve conflicts/escalate) then handle CI, both BEFORE review (issue #41).
    // A heal re-entering at a later phase (issue #9) skips this cleanly-passed work;
    // the integration flow re-syncs with base and re-awaits CI before landing anyway.
    if (startPhase <= CI_PHASE) {
      // No CI re-await in the sync; the gate handling runs next on the rebased code.
      const preSync = await this.syncWithBase(ctx, { reawaitCi: false });
      if (preSync.kind === "terminal") return preSync.outcome;

      // Park the pre-review CI wait off-slot (ADR-0022 stage 1): yield the build slot
      // and let the reconciler's CI poller read checks each tick and re-admit via
      // resumeAfterCi. Skipped when CI gating is off (the gate is a clean no-op, so a
      // park would only add a needless tick) or on a heal carrying operator guidance
      // (not durable across the park) — both run the gate inline as before.
      if (this.deps.merge.waitForChecks && !ctx.resume) {
        log.info("review.awaiting-ci", { prNumber: ctx.prNumber });
        return { kind: "awaiting-ci" };
      }

      const ciGate = await this.settle(ctx, CI_PHASE, await this.ciGate(ctx));
      if (ciGate) return ciGate;
      log.info("review.ci-gate-clean", {});
    }

    return this.runReviewPhases(ctx, startPhase >= 2 ? 2 : 1);
  }

  /**
   * Re-admit a run whose parked pre-review CI wait has settled (ADR-0022 stage 1).
   * The CI poller already read a terminal verdict off-slot; seed the gate with it so
   * the gate does not re-poll, then run the review phases. Red → the existing bounded
   * CI-fix loop (its post-fix re-awaits stay on-slot, as before); green / none →
   * clean → review; timeout → the existing Phase 0 maxout. Ends at `awaiting-merge`
   * (or a `master-triage` / `escalated` terminal). The build-pool sibling of {@link
   * runReview}'s inline gate — run by the reconciler once it occupies a build slot.
   */
  async resumeAfterCi(ctx: ReviewLoopContext, checks: ChecksResult): Promise<ReviewLoopOutcome> {
    const log = ctx.logger;
    const ciGate = await this.settle(ctx, CI_PHASE, await this.ciGate(ctx, checks));
    if (ciGate) return ciGate;
    log.info("review.ci-gate-clean", {});
    return this.runReviewPhases(ctx, 1);
  }

  /**
   * Run the review phases from `fromPhase` to the `awaiting-merge` hand-off, shared
   * by the first-pass gate ({@link resumeAfterCi} / inline), a heal re-entry
   * ({@link runReview}), and the integration re-review. Phase 2 runs only after
   * Phase 1 is clean (behaviour verified correct first).
   */
  private async runReviewPhases(ctx: ReviewLoopContext, fromPhase: 1 | 2): Promise<ReviewLoopOutcome> {
    const log = ctx.logger;
    if (fromPhase <= 1) {
      const phase1 = await this.settle(ctx, 1, await this.runPhase(ctx, 1));
      if (phase1) return phase1;
      log.info("review.phase-clean", { phase: 1 });
    }

    const phase2 = await this.settle(ctx, 2, await this.runPhase(ctx, 2));
    if (phase2) return phase2;
    log.info("review.phase-clean", { phase: 2 });

    return { kind: "awaiting-merge" };
  }

  /**
   * Integration flow (run under the single merge lease): resolve before merge, then
   * merge. Keyed on whether the resolve *moved* the branch and, when it did, whether
   * the move changed the branch's net diff vs base (issue #65):
   *
   *   - not moved → nothing changed since review; the prior gates hold → merge.
   *   - moved, net diff unchanged → a pure fast-forward replay (base advanced only in
   *     files this branch did not touch). `syncWithBase` already re-gated CI; the
   *     merged result is byte-identical to what review saw, so **skip re-review** →
   *     merge.
   *   - moved, net diff changed (or unavailable) → base advanced under a reviewed
   *     branch in a way that altered the merged result (a conflict resolution, or
   *     overlapping base changes). CI catches syntax; review catches the semantics a
   *     moved base can still break — so **re-review P1+P2 under the lease**, then
   *     re-gate CI (re-review may have pushed fixes) before merging.
   *
   * Re-review happens under the lease, never by bouncing back to the build pool: the
   * head always makes terminal progress, so the queue cannot livelock.
   */
  async runIntegration(ctx: ReviewLoopContext): Promise<ReviewLoopOutcome> {
    // Capture the branch's net diff vs base BEFORE the first rebase, so a moved rebase can be
    // classified as a pure fast-forward replay (diff unchanged → skip re-review) vs a
    // semantics-changing one (issue #65). This is the REVIEWED baseline: it stays fixed across
    // re-rebase rounds so re-review fires whenever the effective merged diff drifts from what
    // review saw, no matter how many times the base advanced. branchDiffHash re-fetches
    // origin/<base>, so it compares against current base regardless of when it runs.
    const beforeDiff = await this.deps.worktrees.branchDiffHash(ctx.worktreePath, this.deps.baseBranch);

    // The strict-up-to-date treadmill (#31). The daemon holds the single per-repo merge lease for
    // this whole method, so no *daemon* PR can advance the base under us — a mid-integration
    // `BEHIND` is always an OFF-daemon merge (a human / dependabot). Waiting never clears BEHIND;
    // only a re-rebase does. So on BEHIND (or a DIRTY conflict base moved into) we loop back through
    // syncWithBase (re-rebase → re-run the required check) and re-poll, bounded by a wall-clock
    // budget so a pathologically hot base still terminates in an honest master request instead of an
    // endless rebase→CI loop. Each round re-runs CI (the force-push re-queues the required check),
    // so the budget — not a round count — is the honest bound as the base's churn rate varies.
    const now = this.deps.now ?? ((): number => Date.now());
    const deadline = now() + Math.max(0, this.deps.merge.behindRebaseBudgetMinutes) * 60_000;
    for (let round = 0; ; round++) {
      // A per-run kill (orphan sweep / operator, issue #118) must stop the loop the same way an
      // aborted container op does — throw so the failure guard terminalizes it — rather than keep
      // re-rebasing a run that is being torn down.
      ctx.abortSignal?.throwIfAborted();

      const sync = await this.syncWithBase(ctx, { reawaitCi: true });
      if (sync.kind === "terminal") return sync.outcome;

      if (sync.moved) {
        // Classify the moved rebase: compare the net diff vs base AFTER the rebase (and any CI
        // re-gate fix push) against the reviewed baseline. Unchanged → pure fast-forward replay →
        // skip re-review; changed or unavailable → conservative re-review (issue #65).
        const afterDiff = await this.deps.worktrees.branchDiffHash(ctx.worktreePath, this.deps.baseBranch);
        const netDiffChanged = beforeDiff === null || afterDiff === null || beforeDiff !== afterDiff;
        ctx.logger.info("review.net-diff", {
          changed: netDiffChanged,
          available: beforeDiff !== null && afterDiff !== null,
        });

        // A pure fast-forward replay (moved but net diff unchanged) skips re-review — CI was
        // already re-gated in syncWithBase. Only a move that changed the merged result (or one
        // whose diff could not be compared) is re-reviewed.
        if (netDiffChanged) {
          // Re-review P1+P2 through the shared helper (the same sequence its docstring claims for
          // the integration re-review) rather than re-spelling it here.
          const reviewed = await this.runReviewPhases(ctx, 1);
          if (reviewed.kind !== "awaiting-merge") return reviewed;
          // Re-review may have pushed fixes — re-gate CI before landing.
          const gate = await this.settle(ctx, CI_PHASE, await this.ciGate(ctx));
          if (gate) return gate;
        }
      }

      const readiness = await this.awaitMergeable(ctx);
      if (readiness.kind === "mergeable") return this.merge(ctx);
      if (readiness.kind === "stuck") return readiness.outcome;

      // readiness.kind === "resync": the base advanced (BEHIND/DIRTY) under the held lease. Re-rebase
      // and re-poll while the wall-clock budget lasts; on exhaustion escalate an honest hot-base request.
      if (now() >= deadline) {
        ctx.logger.warn("review.merge-behind-maxed", { rounds: round + 1, state: readiness.state });
        return this.escalateToMaster(ctx, {
          phase: CI_PHASE,
          worklist: mergeBehindWorklist(readiness.state, round + 1),
          attempts: round + 1,
          source: "merge",
          lane: "merge",
          headline: `Merge preparation kept losing the race with an advancing \`${this.deps.baseBranch}\``,
          detail: `merge-behind-treadmill state=${readiness.state}`,
        });
      }
      ctx.logger.info("review.merge-resync", { round: round + 1, state: readiness.state });
    }
  }

  /**
   * Map a single phase's `PhaseOutcome` to the loop's terminal outcome: `maxed` →
   * master triage, `escalated` → escalate, `clean` → `null` (carry on). Centralizes
   * the phase→terminal mapping so each call site can't forget its phase number.
   */
  private async settle(
    ctx: ReviewLoopContext,
    phase: Phase,
    outcome: PhaseOutcome,
  ): Promise<ReviewLoopOutcome | null> {
    if (outcome.kind === "maxed") {
      return this.reviewMaxed(ctx, phase, outcome.worklist, outcome.attempts, outcome.cause);
    }
    if (outcome.kind === "escalated") {
      return this.escalate(ctx, phase, outcome.question);
    }
    return null;
  }

  /**
   * The bounded review→fix→re-assess loop shared by the CI gate and both review
   * phases (issue #41). Reset the (run, phase) attempt budget, then on each
   * iteration: assess (poll CI / review), return clean if nothing gates, max out
   * on a `hardStop` or an exhausted budget, otherwise spend one fix attempt and
   * loop. The attempt accounting, `setPhase`/fix invocation, and escalate mapping
   * live here once; only the assess step and the two loop-specific log lines vary.
   */
  private async boundedFixLoop(
    ctx: ReviewLoopContext,
    spec: BoundedFixLoopSpec,
  ): Promise<PhaseOutcome> {
    const { store } = this.deps;
    // A new phase starts with a fresh fix-attempt budget for this (run, phase) —
    // `ReviewPhaseEntered` opens a fresh span (a non-destructive reset, ADR-0025).
    await store.recordReviewPhaseEntered({ runId: ctx.runId, issueNumber: ctx.issue.number, phase: spec.phase });

    // Bounded re-dispatches for a container infra fault (issue #220), counted separately from the
    // fix-attempt budget so a transient `docker run` hiccup self-heals without a human. Mutated in
    // place by degradeContainerFault, which owns the retry bookkeeping.
    const infraState = { retries: 0 };
    for (;;) {
      try {
        const assessment = await spec.assess();
        if (assessment.kind === "clean") {
          return { kind: "clean" };
        }

        const { worklist } = assessment;
        const attempts = store.getFixAttempts(ctx.runId, spec.phase);
        // A hard stop (CI timeout) will not be cured by another fix attempt; an
        // exhausted budget likewise maxes out. Surface either to a human.
        if (assessment.kind === "hardStop" || attempts >= this.deps.maxFixAttempts) {
          // Last-chance re-read before terminalizing (issue #125): a slow external
          // check (CI) can flip green inside the poll window, after the read that
          // would otherwise max. If the reconfirm finds the phase actually clean,
          // proceed instead of escalating a phase that is, in fact, already clean.
          if (spec.reconfirm && (await spec.reconfirm())) {
            return { kind: "clean" };
          }
          spec.logMaxed(worklist, attempts);
          return { kind: "maxed", worklist, attempts };
        }

        const attempt = await store.recordFixAttempt({ runId: ctx.runId, issueNumber: ctx.issue.number, phase: spec.phase });
        this.setPhase(ctx, fixPhase(spec.phase));
        spec.logFixAttempt(attempt, worklist);
        const fixed = await this.runFix(ctx, {
          phase: spec.phase,
          worklist,
          behaviourPreserving: spec.behaviourPreserving,
          // Review-phase fixes source their findings from the PR's rolling
          // `ralph-review` comment (issue #47); the CI gate's worklist is inline.
          reviewComment: spec.worklistOnPr
            ? { prNumber: ctx.prNumber, phase: spec.phase }
            : undefined,
        });
        if (fixed.kind === "escalated") {
          return fixed;
        }
        // fixed → the fix agent pushed; loop to re-assess on the new commit.
      } catch (err) {
        // Every container terminal (a wall-clock kill, a no-result infra fault, an
        // unparseable/`failed` frame) degrades identically here and in the single-shot rebase
        // resolve — the classification lives once in degradeContainerFault so the two paths cannot
        // drift (#13, #220, #15). A transient infra fault re-dispatches (this loop's `continue` →
        // re-assess); everything else terminalizes or rethrows. The parse-error card names the JSON
        // contract; logMaxed mirrors every terminal into this phase's maxout log.
        const degraded = this.degradeContainerFault(ctx, err, infraState, {
          phase: spec.phase,
          terminalAttempts: () => store.getFixAttempts(ctx.runId, spec.phase),
          onParseFailure: (parseErr) => {
            ctx.logger.warn("review.agent-output-unparseable", {
              phase: spec.phase,
              attempts: parseErr.attempts,
              error: parseErr.lastError,
            });
            return parseFailureWorklist(parseErr);
          },
          logMaxed: spec.logMaxed,
        });
        if (degraded.kind === "retry") {
          continue; // re-loop → re-assess (and re-fix if still blocked)
        }
        return degraded.outcome;
      }
    }
  }

  /**
   * Classify a container review/fix terminal and degrade it gracefully — the single home of the
   * classification shared by {@link boundedFixLoop} and the single-shot {@link resolveRebaseConflicts}
   * (both call a container runner DIRECTLY and must degrade its faults identically, #220/#273):
   *
   * - {@link WallClockExceededError} (a hung session hard-killed at the ceiling, #13) → terminal
   *   `maxed` (master triage, PR preserved); another attempt will not cure a hang.
   * - {@link RunnerInfraError} (NO result — a dropped pipe / killed / un-started container, #220):
   *   a daemon-side fault, not an agent contract violation. Re-dispatch a bounded number of times
   *   (transient hiccups self-heal — the runner pushes direct, so a re-dispatch often already
   *   landed, ADR-0016), counted separately from the fix budget in the caller-owned `infraState`.
   *   Only a PERSISTENT fault terminalizes — to `maxed` with the HONEST infra card carrying the real
   *   docker detail, never the parse-failure ("fix your JSON") card.
   * - {@link AgentOutputParseError} (a runner-reported `failed` frame, or output unparseable after
   *   the runner's bounded re-prompts, #15) → terminal `maxed` with the caller's phase-appropriate
   *   worklist (the review phases name the JSON contract; the rebase resolve names the push failure).
   * - anything else (an unexpected error, or a `UsageLimitError`) → rethrown unchanged to
   *   {@link withFailureGuard}, which leaves the run resumable for the next tick (ADR-0037).
   *
   * Returns `retry` (the caller re-loops) or `terminal` (the caller returns the outcome); the caller
   * keeps its own for-loop so the two attempt-accounting models stay independent.
   */
  private degradeContainerFault(
    ctx: ReviewLoopContext,
    err: unknown,
    infraState: { retries: number },
    spec: ContainerFaultSpec,
  ): ContainerFaultDegradation {
    const { store } = this.deps;
    if (err instanceof WallClockExceededError) {
      const attempts = spec.terminalAttempts();
      const worklist = wallClockWorklist(err);
      ctx.logger.warn("review.wall-clock-exceeded", { phase: spec.phase, wallClockSeconds: err.wallClockSeconds });
      spec.logMaxed?.(worklist, attempts);
      return { kind: "terminal", outcome: { kind: "maxed", worklist, attempts } };
    }
    if (err instanceof RunnerInfraError) {
      if (infraState.retries < this.deps.maxContainerRetries) {
        infraState.retries++;
        ctx.logger.warn("review.container-no-result-retry", {
          phase: spec.phase,
          role: err.role,
          attempt: infraState.retries,
          detail: err.detail,
        });
        store.appendLog({
          runId: ctx.runId,
          issueNumber: ctx.issue.number,
          level: "warn",
          event: "container-no-result-retry",
          data: { phase: spec.phase, role: err.role, attempt: infraState.retries },
        });
        return { kind: "retry" };
      }
      const worklist = containerInfraWorklist(err.detail);
      ctx.logger.warn("review.container-infra-failed", {
        phase: spec.phase,
        role: err.role,
        retries: infraState.retries,
        detail: err.detail,
      });
      spec.logMaxed?.(worklist, infraState.retries);
      return { kind: "terminal", outcome: { kind: "maxed", worklist, attempts: infraState.retries, cause: "infra" } };
    }
    if (err instanceof AgentOutputParseError) {
      const attempts = spec.terminalAttempts();
      const worklist = spec.onParseFailure(err);
      spec.logMaxed?.(worklist, attempts);
      return { kind: "terminal", outcome: { kind: "maxed", worklist, attempts } };
    }
    throw err;
  }

  /**
   * Run one fix attempt against `worklist` and map its outcome: `fixed` (the agent
   * resolved the gating items, kept build+test green, and pushed) or `escalated`
   * (a risky structural change the agent refused to apply blind). The single place
   * the fix agent is invoked and its escalate result is lifted to a phase outcome.
   */
  private async runFix(
    ctx: ReviewLoopContext,
    opts: {
      phase: Phase;
      worklist: Worklist;
      behaviourPreserving: boolean;
      rebaseConflict?: boolean;
      /** Set for a review-phase fix: the findings live in this PR's ralph-review comment. */
      reviewComment?: { prNumber: number; phase: Phase };
    },
  ): Promise<{ kind: "fixed" } | { kind: "escalated"; question: EscalationQuestion }> {
    // A heal's operator guidance is scoped to the phase that maxed out: once the
    // loop advances past the re-entered phase the ruling is stale, so later phases
    // get a normal (unguided) fix attempt (issue #9).
    const guidance = ctx.resume?.phase === opts.phase ? ctx.resume.guidance : undefined;
    const outcome = await this.deps.fixAgent.fix({
      issue: ctx.issue,
      mode: ctx.mode,
      // The run id keys the route the container adapter records at dispatch (ADR-0037 P3.1, #164).
      runId: ctx.runId,
      phase: opts.phase,
      worklist: opts.worklist,
      reviewComment: opts.reviewComment,
      branch: ctx.branch,
      worktreePath: ctx.worktreePath,
      // The rebase-conflict prompt names the base to rebase onto (#273).
      baseBranch: this.deps.baseBranch,
      behaviourPreserving: opts.behaviourPreserving,
      guidance,
      rebaseConflict: opts.rebaseConflict,
      logger: ctx.logger,
      abortSignal: ctx.abortSignal,
      transcriptSink: this.transcriptSink(ctx),
    });
    if (outcome.kind === "escalate") {
      return { kind: "escalated", question: outcome.question };
    }
    return { kind: "fixed" };
  }

  /**
   * Phase 0 — await CI to a terminal verdict before any review. Green/none →
   * clean. Red → a bounded fix loop on the failing checks (the fix agent pushes,
   * we re-await). Still red after `maxFixAttempts`, or a `timeout`, → maxed.
   * Shared by the pre-review gate and the merge-time CI re-await (both reset the
   * phase-0 attempt budget at entry).
   *
   * `seed` (ADR-0022 stage 1): when the off-slot CI poller already read a terminal
   * verdict, it is passed here so the FIRST assess uses it instead of re-polling.
   * Every later assess (a post-fix re-await) still polls `awaitChecks` on-slot, as
   * before — only the initial pre-review wait moved off the build pool.
   */
  private async ciGate(ctx: ReviewLoopContext, seed?: ChecksResult): Promise<PhaseOutcome> {
    if (!this.deps.merge.waitForChecks) {
      return { kind: "clean" };
    }
    const { github } = this.deps;
    const log = ctx.logger;
    // The most recent checks verdict, for the loop-specific log lines below.
    let last: ChecksResult | undefined;
    // The poller's verdict seeds the first assess, then is consumed.
    let pending = seed;

    return this.boundedFixLoop(ctx, {
      phase: CI_PHASE,
      behaviourPreserving: false,
      // The CI worklist is the inline failing checks, not a review-agent finding —
      // no ralph-review comment (issue #47).
      worklistOnPr: false,
      assess: async () => {
        this.setPhase(ctx, CI_GATE);
        let checks: ChecksResult;
        if (pending) {
          checks = pending;
          pending = undefined;
        } else {
          checks = await github.awaitChecks(ctx.prNumber, {
            ciTimeoutMinutes: this.deps.merge.ciTimeoutMinutes,
            pollIntervalSeconds: this.deps.merge.pollIntervalSeconds,
          });
        }
        last = checks;
        log.info("review.ci-checks", { state: checks.state, failures: checks.failures.length });
        this.logChecks(ctx, "ci-checks", checks);

        if (ciClean(checks.state)) {
          return { kind: "clean" };
        }
        const worklist = ciWorklist(checks);
        // A timeout will not be cured by another fix attempt — hard stop.
        return checks.state === "timeout"
          ? { kind: "hardStop", worklist }
          : { kind: "blocked", worklist };
      },
      // Before escalating the CI gate, take ONE more lean snapshot read
      // (issue #125): a slow CI's green can land inside the poll window after the
      // verdict that exhausted the budget (or timed out). A latest-run, stably-terminal
      // green/none here means CI actually passed — proceed rather than terminalize.
      reconfirm: async () => {
        this.setPhase(ctx, CI_GATE);
        const snapshot = await github.readChecks(ctx.prNumber);
        log.info("review.ci-reconfirm", { state: snapshot.state });
        this.logChecks(ctx, "ci-reconfirm", snapshot);
        return ciClean(snapshot.state);
      },
      logMaxed: (_worklist, attempts) => log.warn("review.ci-maxed", { state: last!.state, attempts }),
      logFixAttempt: (attempt) =>
        log.info("review.ci-fix-attempt", { attempt, failures: last!.failures.length }),
    });
  }

  /**
   * Append the structured CI-verdict log line shared by the assess (`ci-checks`)
   * and reconfirm (`ci-reconfirm`) reads — same row shape, differing only in the
   * event name. `info` when {@link ciClean}, `warn` otherwise.
   */
  private logChecks(
    ctx: ReviewLoopContext,
    event: "ci-checks" | "ci-reconfirm",
    result: { state: CheckState | ChecksSnapshot["state"]; failures: string[] },
  ): void {
    this.deps.store.appendLog({
      runId: ctx.runId,
      issueNumber: ctx.issue.number,
      level: ciClean(result.state) ? "info" : "warn",
      event,
      data: { state: result.state, failures: result.failures },
    });
  }

  /** Run one phase's review→fix cycle, capped at `maxFixAttempts` fix attempts. */
  private async runPhase(ctx: ReviewLoopContext, phase: 1 | 2): Promise<PhaseOutcome> {
    const { store, github } = this.deps;
    const log = ctx.logger;
    // The id of this phase's rolling `ralph-review` comment, so each pass edits the
    // one comment instead of posting a new one per iteration (issue #47). Held
    // across this call's attempts; the first pass re-derives it from the PR, so a
    // phase that reviews twice (build review, then the ADR-0017 integration
    // re-review) — or a daemon that restarted mid-phase — converges on it.
    let reviewCommentId: number | undefined;

    return this.boundedFixLoop(ctx, {
      phase,
      behaviourPreserving: phase === 2,
      worklistOnPr: true,
      assess: async () => {
        this.setPhase(ctx, reviewPhase(phase));
        // Ingest whatever automated PR comments are present (never wait on them).
        // The daemon's own rolling ralph-review comments are excluded from the
        // ingest: they carry this very review's prior worklist, not a third-party
        // finding (the full list is still used below to recover the comment to edit).
        const allComments = await github.listPullRequestComments(ctx.prNumber);
        const externalComments = allComments.filter((c) => !isReviewComment(c.body));
        const reviewed = await this.deps.reviewAgent.review({
          issue: ctx.issue,
          mode: ctx.mode,
          // The run id keys the route the container adapter records at dispatch (ADR-0037 P3.1, #164).
          runId: ctx.runId,
          phase,
          prNumber: ctx.prNumber,
          branch: ctx.branch,
          worktreePath: ctx.worktreePath,
          prComments: externalComments,
          logger: log,
          abortSignal: ctx.abortSignal,
          transcriptSink: this.transcriptSink(ctx),
        });
        // Deterministic consolidation safety net (DESIGN §4, ADR-0005): collapse
        // duplicate findings (a review item and an ingested bot comment that name
        // the same thing) to one most-severe item before the phase decision, so a
        // non-compliant agent can't double-count. The deduped worklist is the
        // canonical one — it gates the phase and is posted to the PR as the
        // authoritative review→fix handoff.
        const worklist: Worklist = { items: dedupeWorklist(reviewed.items) };
        const blockers = gatingItems(worklist);
        // Post (or edit) the rolling ralph-review comment carrying the deduped
        // worklist — the findings move to the PR (issue #47). Only the findings
        // move; the attempt counters, gating, and phase verdict stay local (below).
        reviewCommentId = await this.publishReviewComment(
          ctx,
          phase,
          worklist,
          allComments,
          reviewCommentId,
        );
        log.info("review.worklist", {
          phase,
          total: worklist.items.length,
          gating: blockers.length,
          ingestedComments: externalComments.length,
        });
        store.appendLog({
          runId: ctx.runId,
          issueNumber: ctx.issue.number,
          level: "info",
          event: "review-worklist",
          data: { phase, total: worklist.items.length, gating: blockers.length, commentId: reviewCommentId },
        });

        return isClean(worklist) ? { kind: "clean" } : { kind: "blocked", worklist };
      },
      logMaxed: (_worklist, attempts) => log.warn("review.maxed", { phase, attempts }),
      logFixAttempt: (attempt, worklist) =>
        log.info("review.fix-attempt", { phase, attempt, gating: gatingItems(worklist).length }),
    });
  }

  /**
   * Post or edit the **one rolling `ralph-review` comment per phase** (issue #47),
   * carrying this pass's deduped worklist as a fenced payload. The first pass posts
   * it (to the PR, not the issue) and remembers its id; later passes edit that
   * comment in place so attempts that resolve items show on the same comment rather
   * than burying the thread. When `knownId` is unset (a fresh `runPhase` call — the
   * build review's sibling, the ADR-0017 integration re-review, or a daemon that
   * restarted mid-phase) the id is re-derived from the PR's existing ralph-review
   * comment for the phase, so the two passes converge on one comment, never a
   * duplicate. Returns the comment id.
   */
  private async publishReviewComment(
    ctx: ReviewLoopContext,
    phase: 1 | 2,
    worklist: Worklist,
    existingComments: PrComment[],
    knownId: number | undefined,
  ): Promise<number> {
    const body = formatReviewComment({ phase, worklist });
    // A usable id is a positive REST comment id: `knownId` from a prior post this
    // call, else the id of the rolling comment already on the PR. The comment
    // listing derives that id from each comment's URL (issue #47), so the
    // recovery path gets the numeric REST id `updateComment` PATCHes by. A 0 from
    // an unparseable URL is not positive and falls through to a fresh post rather
    // than PATCH a non-existent id.
    let id = usableCommentId(knownId);
    if (id === undefined) {
      const existing = latestReviewComment(existingComments, phase);
      id = usableCommentId(existing?.id);
    }
    if (id !== undefined) {
      await this.deps.github.updateComment(id, body);
      return id;
    }
    const posted = await this.deps.github.postComment(ctx.prNumber, body);
    return posted.id;
  }

  /**
   * Bring the branch current with base (issue #41 / ADR-0014): rebase onto base,
   * resolve any conflicts (or escalate a risky structural one), force-push the
   * rewritten history, and — when `reawaitCi` — re-await CI green if the branch
   * moved. The shared "resolve" primitive used both *before review* (so review
   * never runs on a branch that does not merge) and *before merge* (so a branch
   * that went stale while review ran is brought current first). Returns a terminal
   * outcome (escalated / master-triage) if it could not proceed, else `null`.
   *
   * The rebase is what lets high-concurrency runs self-heal the parallel-edit
   * conflict pileup rather than only the first PR landing.
   */
  private async syncWithBase(
    ctx: ReviewLoopContext,
    opts: { reawaitCi: boolean },
  ): Promise<SyncResult> {
    const log = ctx.logger;
    this.setPhase(ctx, MERGE);
    // The daemon's own recorded runner-pushed head (#21): when a prior rebase-conflict self-heal's
    // runner force-pushed the rewritten history, origin diverges from this worktree's pre-rebase
    // local ref by construction. Hand that SHA to each rebase below so it can attribute the divergence
    // to its own write and hard-sync to origin, instead of tripping the #255 guard on resume.
    const trustedRemoteHead = this.deps.store.getRunByIssue(ctx.issue.number)?.runnerPushedSha ?? null;

    // Bounded resolution rounds (issue #20). A rebase conflict is resolved out-of-tree, but base can
    // advance again inside that fix window (a sibling PR merging on a hot repo). A landed resolution
    // that finds base moved loops back through the normal rebase — usually a clean, self-healed
    // re-rebase; a genuinely new conflict is a fresh round, dispatched against its own (newer) base.
    // Bound the rounds so a pathologically hot base still terminates in an honest master request.
    let branchMoved = false;
    for (let round = 0; ; ) {
      let rebase: RebaseResult;
      try {
        rebase = await this.deps.worktrees.rebaseOntoBase(
          ctx.worktreePath,
          ctx.branch,
          this.deps.baseBranch,
          { trustedRemoteHead },
        );
      } catch (err) {
        if (err instanceof BranchDivergedError) {
          // origin/<branch> diverged from this worktree by a rewrite the daemon CANNOT attribute to
          // its own runner push (a hand force-push / unknown rewrite) — the case the #255 guard exists
          // for. But letting it propagate to withFailureGuard would terminalize the run to agent-stuck
          // and AUTO-CLOSE the PR, orphaning any fully-reviewed work on origin (#21 part 4). Park it
          // RECOVERABLE instead: master triage, PR preserved — a master (or, if it cannot, the human
          // it asks) resolves the divergence. Converting a recoverable pause into orphaned work is the
          // defect #273 fixes.
          log.warn("review.rebase-diverged", { branch: ctx.branch });
          return {
            kind: "terminal",
            outcome: await this.escalateToMaster(ctx, {
              phase: CI_PHASE,
              worklist: divergedBranchWorklist(ctx.branch),
              attempts: 1,
              source: "rebase",
              lane: "review",
              headline: `The branch \`${ctx.branch}\` diverged from origin by an unattributable rewrite`,
              detail: `branch-diverged: ${ctx.branch}`,
            }),
          };
        }
        throw err;
      }
      log.info("review.rebase", { kind: rebase.kind, ...(rebase.kind === "clean" ? { moved: rebase.moved } : { files: rebase.files.length }) });

      if (rebase.kind === "clean") {
        // No (further) conflict — the branch is current with base. It moved if THIS rebase moved it
        // or an earlier round's resolution did (a landed resolution necessarily integrated base).
        branchMoved = branchMoved || rebase.moved;
        break;
      }

      // A rebase conflict. If we already resolved MAX_REBASE_ROUNDS conflicts and base STILL advanced
      // into a fresh one, the base is too hot to self-heal — escalate with evidence naming the RACE
      // (base kept advancing), not a phantom push failure (#20). `attempts` reflects the rounds spent.
      if (round >= MAX_REBASE_ROUNDS) {
        log.warn("review.rebase-base-race", { rounds: round });
        return {
          kind: "terminal",
          outcome: await this.escalateToMaster(ctx, {
            phase: CI_PHASE,
            worklist: baseRaceWorklist(round),
            attempts: round,
            source: "rebase",
            lane: "review",
            headline: `Rebase onto \`${this.deps.baseBranch}\` lost the race ${round} times`,
            detail: `rebase-base-race after ${round} rounds onto ${this.deps.baseBranch}`,
          }),
        };
      }
      round++;

      // resolveRebaseConflicts owns the whole conflict job, including confirming the out-of-tree
      // resolution actually landed on the base it was DISPATCHED against (#273/#20): it returns
      // `clean` ONLY when the resolution is verified landed (and adopts it into this worktree), else a
      // maxed/escalated terminal that settle maps here. A confirmed-landed resolution necessarily
      // moved the branch; loop back to re-rebase in case base advanced again inside the fix window.
      const resolved = await this.settle(
        ctx,
        CI_PHASE,
        await this.resolveRebaseConflicts(ctx, rebase.files, rebase.baseSha, round),
      );
      if (resolved) return { kind: "terminal", outcome: resolved };
      branchMoved = true;
    }

    // If the branch moved, the prior CI result is stale — re-await CI green. Skip
    // it pre-review: the CI gate runs next on the rebased code anyway.
    if (branchMoved && opts.reawaitCi) {
      const gate = await this.settle(ctx, CI_PHASE, await this.ciGate(ctx));
      if (gate) return { kind: "terminal", outcome: gate };
    }

    return { kind: "synced", moved: branchMoved };
  }

  /**
   * Hand the rebase conflicts to a fix agent to resolve, then confirm the resolution landed — the
   * complete "resolve the rebase conflict" job (#273). Under the container model the agent runs in a
   * fresh clone of the PR branch: it STARTS the rebase onto base, resolves the conflicts (`git add`
   * + `git rebase --continue`), and reports `fixed` WITHOUT pushing — the runner force-pushes the
   * rewritten history (force-push is blocked in agent sessions, DESIGN §8). This method then
   * verifies origin/<branch> actually integrated the base it was DISPATCHED against — `dispatchBaseSha`,
   * NOT origin's current base, so a sibling PR merging inside the fix window does not falsely fail a
   * perfectly-landed resolution (#20) — via {@link WorktreeManager.verifyBranchRebasedOntoBase}, and
   * returns `clean` ONLY when the resolution is confirmed landed (adopting it into the worktree so the
   * caller can re-rebase against a base that advanced again); a resolution that reported success but
   * did not land maxes out with a {@link rebaseNotLandedWorklist} master request (PR preserved).
   * Both failure worklists — the container-reported-failed one and this not-landed one — are
   * co-located here. `round` is this resolution's round in the caller's bounded loop, reported as the
   * reported `attempts` so it reflects reality (#20). On a conflict implying a risky structural
   * change, the agent escalates rather than resolving blind (never resolve blind, #41).
   */
  private async resolveRebaseConflicts(
    ctx: ReviewLoopContext,
    files: string[],
    dispatchBaseSha: string,
    round: number,
  ): Promise<PhaseOutcome> {
    const log = ctx.logger;
    this.setPhase(ctx, MERGE_CONFLICT);
    const worklist = conflictWorklist(files);
    log.info("review.rebase-conflict", { files: files.length, round });
    // One resolution round (not a review→fix loop): the container fix agent starts + resolves the
    // rebase and the runner force-pushes the result; this method verifies it landed against its
    // dispatch base before returning `clean` (the caller's bounded loop drives further rounds if base
    // advanced again, #20). This path calls runFix DIRECTLY, BYPASSING boundedFixLoop — the only place
    // that catches a container terminal and degrades it gracefully — so it must replicate that
    // degradation here (#273). A container non-success on the rebase-conflict fix — the #241
    // no-net-diff guard throw, a `git push --force-with-lease` rejected by a concurrent push during
    // the fix window (the very parallel-edit self-heal this path exists for), a transient
    // git/network fault (→ runner `failed` → AgentOutputParseError), a dropped-pipe / killed
    // container (→ RunnerInfraError), or a wall-clock kill — would otherwise escape uncaught to
    // withFailureGuard and terminalize the run to agent-stuck with the PR auto-closed: the exact
    // orphaning of fully-reviewed work #273 exists to eliminate (and which this PR claims to fix).
    // Convert each to a healable review-maxed (PR preserved; resume-from-WIP re-runs resolve+verify),
    // retrying an infra fault a bounded number of times first (issue #220), mirroring boundedFixLoop.
    // A UsageLimitError is deliberately NOT caught — it propagates to withFailureGuard, which leaves
    // the run resumable for the next tick's re-drive (ADR-0037), exactly as on the review phases.
    const infraState = { retries: 0 };
    for (;;) {
      try {
        const outcome = await this.runFix(ctx, {
          phase: CI_PHASE,
          worklist,
          behaviourPreserving: false,
          rebaseConflict: true,
        });
        if (outcome.kind === "escalated") {
          return { kind: "escalated", question: outcome.question };
        }
        // The container fix agent redid the rebase and the runner force-pushed the rewritten history
        // (force-push is blocked in agent sessions, DESIGN §8). Record origin/<branch>'s new head as
        // the daemon's OWN runner-pushed SHA (#21) BEFORE the landed-verification below: a resume of
        // a park from EITHER a verify pass OR the #20 landed-verification race must be able to
        // recognise the resulting local/origin divergence as the daemon's own write and hard-sync to
        // origin — otherwise the heal-card's own recommended "re-enable to retry" dead-ends on the
        // #255 guard. Best-effort: a failed head read must not convert a good resolution into a fault
        // (a resume with no recorded head just falls back to the healable divergence park, not orphaning).
        await this.recordRunnerPushedHead(ctx);
        // The daemon-side rebase was aborted, so the daemon worktree's branch ref is NOT the source of
        // that push — a bare `fixed` is not enough. Verify origin/<branch> actually integrated the base
        // it was DISPATCHED against (`dispatchBaseSha`, not origin's current base — a sibling PR merging
        // inside the fix window would otherwise fail a perfectly-landed resolution, #20). A resolution
        // that reported success but did not land (a silent no-op push that once "succeeded" then merged
        // a still-conflicting PR, #273) maxes out healably rather than proceeding to a merge that cannot
        // land. `attempts` is this resolution's `round`; the not-landed maxout flows through
        // settle→reviewMaxed uniformly with the container-fault one below.
        const landed = await this.deps.worktrees.verifyBranchRebasedOntoBase(
          ctx.worktreePath,
          ctx.branch,
          this.deps.baseBranch,
          dispatchBaseSha,
        );
        if (!landed) {
          log.warn("review.rebase-not-landed", { branch: ctx.branch, round });
          return { kind: "maxed", worklist: rebaseNotLandedWorklist(ctx.branch), attempts: round };
        }
        // Adopt the runner-pushed resolution into the daemon worktree (its local ref still holds the
        // diverged pre-resolution history) so the caller can re-rebase against a base that advanced
        // again inside the fix window (#20). Safe now: verification just confirmed origin is the good
        // resolved state.
        await this.deps.worktrees.adoptOriginBranch(ctx.worktreePath, ctx.branch);
        return { kind: "clean" };
      } catch (err) {
        // Degrade a container terminal exactly as boundedFixLoop does — the shared helper owns the
        // classification and the bounded infra-retry so this single-shot path cannot drift from it
        // (#220/#273). A `failed` frame surfaces as AgentOutputParseError carrying the runner's real
        // detail (the #241 no-net-diff guard, a rejected force-push, a git/network fault, or genuinely
        // unparseable output): max out with an HONEST card carrying that detail, never the misleading
        // "fix your JSON" one — the primary cause here is a push failure. `attempts` is this
        // resolution's `round` (#20) and there is no logMaxed (the resolve's caller owns that logging).
        const degraded = this.degradeContainerFault(ctx, err, infraState, {
          phase: CI_PHASE,
          terminalAttempts: () => round,
          onParseFailure: (parseErr) => {
            log.warn("review.rebase-fix-failed", { detail: parseErr.lastError });
            return rebaseFixFailedWorklist(parseErr.lastError);
          },
        });
        if (degraded.kind === "retry") {
          continue; // re-dispatch the rebase-conflict resolve
        }
        return degraded.outcome;
      }
    }
  }

  /**
   * Record origin/<branch>'s current head as the daemon's own runner-pushed SHA on the run (#21),
   * after the container rebase-conflict fix's runner force-push. Read on resume (and integration
   * re-sync) to hard-sync a diverged local ref to origin rather than trip the #255 guard (see
   * {@link syncWithBase}). Best-effort by design — a failed head read or store write must not turn
   * a good conflict resolution into a fault; a resume with no recorded head simply falls back to the
   * healable divergence park ({@link divergedBranchWorklist}) instead of orphaning the reviewed PR.
   */
  private async recordRunnerPushedHead(ctx: ReviewLoopContext): Promise<void> {
    try {
      const head = await this.deps.worktrees.remoteBranchHead(ctx.worktreePath, ctx.branch);
      if (head) {
        this.deps.store.setRunnerPushedHead(ctx.issue.number, head);
        ctx.logger.info("review.runner-pushed-head", { branch: ctx.branch });
      }
    } catch (err) {
      ctx.logger.warn("review.runner-pushed-head-failed", { error: String(err) });
    }
  }

  /**
   * Wait for GitHub to report the (rebased) head mergeable before firing the merge
   * (issue #25). The pre-merge rebase force-pushes a new head, which re-queues any
   * REQUIRED status check (e.g. a required "CI Gate"): GitHub re-marks it EXPECTED on
   * the new commit and sets `mergeStateStatus` to BLOCKED until it re-passes — even
   * though the CI gate above already saw green and `gh pr checks` may briefly report
   * no/stale runs in that window. Firing `gh pr merge` into that window is rejected by
   * branch protection ("Required status check … is expected"), which propagates to the
   * failure guard and false-terminalizes a good PR to `agent-stuck` with the PR
   * auto-closed. So poll the AUTHORITATIVE `mergeStateStatus` until it is mergeable;
   * only if it never clears within the CI budget park `review-maxed` (PR preserved,
   * healable) instead of racing the merge. Bounded by read count (not wall-clock) so it
   * terminates deterministically under a no-op sleep in tests and stays bounded in
   * production. Skipped when CI gating is off (no required checks to wait on — the
   * dogfood repo merges directly as before). Returns a terminal outcome if the head
   * never became mergeable, else `null` (proceed to merge).
   */
  private async awaitMergeable(ctx: ReviewLoopContext): Promise<MergeReadiness> {
    if (!this.deps.merge.waitForChecks) {
      return { kind: "mergeable" };
    }
    const naps = this.deps.sleep ?? ((ms: number) => sleep(ms));
    const pollSeconds = Math.max(1, this.deps.merge.pollIntervalSeconds);
    const maxPolls = Math.max(1, Math.ceil((this.deps.merge.ciTimeoutMinutes * 60) / pollSeconds));
    let last: MergeStateStatus = "UNKNOWN";
    for (let poll = 0; poll < maxPolls; poll++) {
      ctx.abortSignal?.throwIfAborted();
      const snapshot = await this.deps.github.readMergeStatus(ctx.prNumber);
      last = snapshot.state;
      ctx.logger.info("review.merge-status", { state: snapshot.state, poll });
      this.deps.store.appendLog({
        runId: ctx.runId,
        issueNumber: ctx.issue.number,
        level: MERGEABLE_STATES.has(snapshot.state) ? "info" : "warn",
        event: "merge-status",
        data: { state: snapshot.state, poll },
      });
      if (MERGEABLE_STATES.has(snapshot.state)) {
        // Branch protection is satisfied — but the hosted reviewer is a gate of its own
        // (issue #43): before firing the merge, wait boundedly for the reviewer to OBSERVE this
        // head, then read its threads. An empty read is "the reviewer has not looked at this head
        // yet", never "the reviewer is happy"; an unreadable read fails closed; a rate-limit
        // defers by re-polling. The merge command stays unreachable until the reviewer has
        // observed the current head (or the bounded wait proves the repo has no hosted reviewer).
        const hosted = await this.hostedObserveVerdict(ctx, snapshot);
        if (hosted.kind !== "defer") {
          return hosted;
        }
        // Rate-limited read: keep polling within the CI budget, exactly as the BLOCKED arm does,
        // rather than merging past an unread gate on transient evidence.
      }
      // The strict-up-to-date treadmill (#31): the base advanced under the rebased head (BEHIND)
      // or into a textual conflict (DIRTY). Neither self-clears by waiting — hand back to the
      // integration loop to re-rebase under the held merge lease, immediately, instead of burning
      // the CI budget on a state that cannot change without a re-rebase. (A stale post-force-push
      // BEHIND self-corrects cheaply: the next syncWithBase rebase is a no-op when base did not
      // actually move, so no wasted CI cycle.)
      if (snapshot.state === "BEHIND" || snapshot.state === "DIRTY") {
        return { kind: "resync", state: snapshot.state };
      }
      // BLOCKED is NOT self-evidently "a required check has not greened" (issue #3430). Type it
      // before spending another poll: an unresolved-conversation blocker never clears by waiting,
      // so polling it would burn the entire CI budget and then blame CI for a green CI. This runs
      // on the FIRST blocked read, so the budget is never spent on a non-CI cause.
      if (snapshot.state === "BLOCKED") {
        const typed = await this.hostedGateVerdict(ctx, snapshot);
        if (typed) {
          return typed;
        }
      }
      if (poll < maxPolls - 1) {
        await naps(pollSeconds * 1000);
      }
    }
    // BLOCKED/DRAFT/UNKNOWN past the CI budget: a required check that never greened (or a draft) —
    // hand it to the master with the blocker typed as far as the evidence allows.
    ctx.logger.warn("review.merge-blocked", { state: last, polls: maxPolls });
    return {
      kind: "stuck",
      outcome: await this.escalateToMaster(ctx, {
        phase: CI_PHASE,
        worklist: mergeBlockedWorklist(last),
        attempts: maxPolls,
        source: "merge",
        lane: "merge",
        headline: `The pull request never became mergeable (\`${last}\`)`,
        detail: `merge-not-mergeable state=${last}`,
      }),
    };
  }

  /**
   * Consult the GitHub-hosted review gate for the current head, and turn its verdict into a
   * {@link MergeReadiness} when it has something to say. Returns `null` when the hosted gate is
   * unwired or reports clean — i.e. "nothing hosted stands in the way; carry on".
   *
   * The three non-null arms map exactly onto the issue's policy:
   *  - **actionable hosted findings** → escalate with the *actual findings* injected, never a
   *    generic "merge blocked". The ordinary fix lane addresses the first worklist; a repeat of
   *    the same normalized signature is what routes it to the master's final adjudication.
   *  - **fail-closed blockers** (unknown bot, missing GraphQL permission, unknown ruleset,
   *    human-review policy) → escalate with the typed cause as evidence.
   *  - **rate-limited** → `null` with a log line: GitHub rate limits defer through the existing
   *    rate-limit path and must never consume a master attempt or become stuck.
   */
  private async hostedGateVerdict(
    ctx: ReviewLoopContext,
    snapshot: MergeStatusSnapshot,
  ): Promise<MergeReadiness | null> {
    const wired = this.hostedGateContext(ctx, snapshot);
    if (!wired) {
      return null;
    }
    const { cause, worklist } = await wired.gate.classify(wired.gateCtx, snapshot, await this.readChecksQuietly(ctx));
    if (cause.kind === "mergeable") {
      return null;
    }
    if (cause.kind === "required-checks" && cause.pending) {
      // The one cause waiting can cure — let the ordinary poll loop fund it.
      return null;
    }
    if (cause.kind === "behind-or-conflict") {
      return { kind: "resync", state: cause.state };
    }
    if (cause.kind === "threads-unavailable" && cause.reason === "rate-limited") {
      ctx.logger.warn("review.hosted-rate-limited", { pr: ctx.prNumber });
      return null;
    }
    return {
      kind: "stuck",
      outcome: await this.escalateHostedBlocker(ctx, cause, worklist, wired.head),
    };
  }

  /**
   * Wait boundedly for the GitHub-hosted reviewer to OBSERVE the current head before a merge, then
   * turn its verdict into a merge decision (issue #43, DESIGN §5a). This is the check the binding
   * decision requires before every merge attempt: "after a verified push Ralph observes the new
   * head, and proceeds only when the gate is stable." Unlike a single {@link hostedGateVerdict}
   * classify read — which reports `mergeable` the instant the current-head worklist is empty — the
   * gate's own {@link HostedReviewGate.observe} never treats "the reviewer has not looked at this
   * head yet" as "the reviewer is happy": it re-reads up to its bounded budget until the reviewer
   * has anchored a thread to this head (or has nothing outstanding at all, i.e. no hosted gate).
   *
   * Three outcomes, mapped to the merge loop:
   *  - **clean** (or no hosted gate wired) → `{ kind: "mergeable" }`: the reviewer observed the
   *    head and nothing hosted blocks; the merge command becomes reachable.
   *  - **findings / fail-closed blocker** → `{ kind: "stuck" }`: escalate the typed blocker with
   *    its actual findings, exactly as {@link hostedGateVerdict} does for classify's cause.
   *  - **rate-limited** → `{ kind: "defer" }`: GitHub rate limits defer through the ordinary
   *    poll path — the caller keeps polling, never merging on transient evidence and never
   *    consuming a master attempt.
   */
  private async hostedObserveVerdict(
    ctx: ReviewLoopContext,
    snapshot: MergeStatusSnapshot,
  ): Promise<{ kind: "mergeable" } | { kind: "stuck"; outcome: ReviewLoopOutcome } | { kind: "defer" }> {
    const wired = this.hostedGateContext(ctx, snapshot);
    if (!wired) {
      return { kind: "mergeable" };
    }
    const verdict = await wired.gate.observe(wired.gateCtx);
    switch (verdict.kind) {
      case "clean":
        return { kind: "mergeable" };
      case "defer":
        // GitHub rate limits defer through the existing rate-limit path — never a master attempt.
        ctx.logger.warn("review.hosted-rate-limited", { pr: ctx.prNumber });
        return { kind: "defer" };
      case "findings":
        return {
          kind: "stuck",
          outcome: await this.escalateHostedBlocker(ctx, verdict.cause, verdict.worklist, verdict.headSha),
        };
      case "blocked":
        return {
          kind: "stuck",
          outcome: await this.escalateHostedBlocker(ctx, verdict.cause, null, verdict.headSha),
        };
    }
  }

  /**
   * Build the {@link HostedGateContext} for the current head, or null when no hosted gate is
   * wired. The head is the merge snapshot's head, falling back to the run's recorded
   * runner-pushed SHA — never a guess, so the gate anchors its observation to a commit it can name.
   */
  private hostedGateContext(
    ctx: ReviewLoopContext,
    snapshot: MergeStatusSnapshot,
  ): { gate: HostedReviewGate; gateCtx: HostedGateContext; head: string | null } | null {
    const gate = this.deps.hostedGate;
    if (!gate) {
      return null;
    }
    const head = snapshot.headSha ?? this.deps.store.getRunByIssue(ctx.issue.number)?.runnerPushedSha ?? null;
    const gateCtx: HostedGateContext = {
      issueNumber: ctx.issue.number,
      runId: ctx.runId,
      prNumber: ctx.prNumber,
      headSha: head,
      logger: ctx.logger,
      ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
    };
    return { gate, gateCtx, head };
  }

  /** Escalate a typed hosted/human/ruleset merge blocker with its actual evidence. */
  private async escalateHostedBlocker(
    ctx: ReviewLoopContext,
    cause: MergeBlockCause,
    worklist: HostedWorklist | null,
    head: string | null,
  ): Promise<ReviewLoopOutcome> {
    const findings = cause.kind === "hosted-review" ? cause.findings : [];
    // The signature is built from thread identity + latest finding content + verification, so a
    // push that changes only the head SHA cannot present the same failure as a new one.
    const detail =
      findings.length > 0
        ? hostedFailureDetail({ findings })
        : `merge-blocked ${cause.kind}: ${describeMergeBlock(cause)}`;
    return this.escalateToMaster(ctx, {
      phase: CI_PHASE,
      worklist: hostedBlockerWorklist(cause),
      attempts: 1,
      source: cause.kind === "hosted-review" ? "hosted-review" : "merge",
      lane: "merge",
      headline: `Merge gated by the GitHub-hosted review: ${describeMergeBlock(cause)}`,
      detail,
      ...(worklist
        ? {
            extraEvidence: [
              `Head under review: \`${head ?? "(unreported)"}\``,
              "",
              renderHostedWorklist(worklist),
            ].join("\n"),
          }
        : {}),
    });
  }

  /** One best-effort CI snapshot for blocker attribution; never throws, never polls. */
  private async readChecksQuietly(ctx: ReviewLoopContext): Promise<ChecksSnapshot | null> {
    try {
      return await this.deps.github.readChecks(ctx.prNumber);
    } catch {
      return null;
    }
  }

  /**
   * Merge the PR directly (a deterministic harness action), then mark the run merged. The caller
   * ({@link runIntegration}) has already confirmed branch protection reports the rebased head
   * mergeable ({@link awaitMergeable}), so this only fires the merge and records the terminal.
   */
  private async merge(ctx: ReviewLoopContext): Promise<ReviewLoopOutcome> {
    const { store, github } = this.deps;
    await github.mergePullRequest(ctx.prNumber, {
      method: this.deps.merge.method,
      deleteBranch: this.deps.merge.deleteBranch,
    });
    // The `merged` status fact (issue #81), then the span-closing terminal marker.
    await store.recordMerged({ runId: ctx.runId, issueNumber: ctx.issue.number, prNumber: ctx.prNumber });
    // Close the run span as merged (issue #80) — the canonical successful terminal.
    await store.recordRunEnded({ runId: ctx.runId, issueNumber: ctx.issue.number, outcome: "merged" });
    store.appendLog({
      runId: ctx.runId,
      issueNumber: ctx.issue.number,
      level: "info",
      event: "merged",
      data: { prNumber: ctx.prNumber, method: this.deps.merge.method },
    });
    ctx.logger.info("review.merged", { prNumber: ctx.prNumber, method: this.deps.merge.method });
    return { kind: "merged" };
  }

  /**
   * The exhaustion terminal, after the triage cutover (ADR-0042): a phase that spent its fix
   * attempts, a CI gate that never greened, an exhausted rebase, or a merge preparation that
   * never became mergeable **enqueues a master triage request** — it no longer posts a
   * heal-card, no longer indexes an operator question, and no longer parks on `review-maxed`.
   *
   * `review-maxed` survives as an *event*: the `ReviewMaxed` fact is appended in the same
   * durable transition as the request, so the phase exhaustion stays readable in history and in
   * the master's context while the projected state is `master-triage`. That ordering is the
   * whole point — a reader between the two writes would otherwise see a human-attention state
   * for work the daemon is about to do itself.
   *
   * `cause: "infra"` (a persistent container infra fault, issue #220) is carried as evidence
   * rather than as a different card: the master can tell a box problem from a code problem, and
   * telling it which is which is more useful than picking a template for a human who is no
   * longer being paged.
   */
  private async escalateToMaster(
    ctx: ReviewLoopContext,
    input: {
      phase: Phase;
      worklist: Worklist;
      attempts: number;
      source: MasterRequestSource;
      lane: MasterLane;
      cause?: "infra";
      /** Overrides the derived headline when the caller knows a more precise one. */
      headline?: string;
      /** Overrides the derived normalized detail (the signature's raw material). */
      detail?: string;
      /** Extra evidence appended verbatim — e.g. a rendered hosted-review worklist. */
      extraEvidence?: string;
    },
  ): Promise<ReviewLoopOutcome> {
    const { store } = this.deps;
    const { phase, worklist, attempts, cause } = input;
    const blockers = gatingItems(worklist).map(
      (i) => `[${i.severity}] ${i.title}${i.detail ? ` — ${i.detail}` : ""}`,
    );
    const concern = phase === 0 ? "CI" : phase === 1 ? "correctness" : "quality";
    const headline =
      input.headline ??
      (cause === "infra"
        ? `Phase-${phase} review blocked by a container infrastructure fault`
        : phase === 0
          ? "CI gate maxed out (could not get checks green)"
          : `Phase-${phase} ${concern} review maxed out after ${attempts} fix attempt(s)`);
    const detail = input.detail ?? (blockers.join(" ; ") || headline);

    // The `ReviewMaxed` fact is preserved as history for phase exhaustion — the source fact
    // ADR-0042 requires be kept — and the request is committed with it.
    const escalated = await this.deps.masterEscalation?.escalate({
      issueNumber: ctx.issue.number,
      runId: ctx.runId,
      source: input.source,
      lane: input.lane,
      phase: reviewPhaseKey(phase),
      branch: ctx.branch,
      prNumber: ctx.prNumber,
      issue: ctx.issue,
      sourceFacts: [{ kind: "review-maxed", phase }],
      evidence: harnessEvidence({
        headline,
        detail,
        attemptedFixes:
          cause === "infra"
            ? `The review/fix container produced no result after ${attempts} re-dispatch(es) — a daemon-side infrastructure fault, not a code defect.`
            : `The fix agent spent ${attempts} attempt(s) on this phase. Remaining blockers:\n${blockers
                .map((b) => `- ${b}`)
                .join("\n")}${input.extraEvidence ? `\n\n${input.extraEvidence}` : ""}`,
        uncertainty:
          cause === "infra"
            ? "Whether the fault is the container host or something about this run's workspace."
            : "Whether the remaining blockers are genuine defects or a review rubric misreading the change.",
      }),
      logger: ctx.logger,
    });

    if (!escalated) {
      // No master wired: keep the `ReviewMaxed` fact so history and the projection still
      // record the exhaustion. Deliberately NOT a heal-card — the cutover removed that
      // surface, and manufacturing one here would re-create the state it retired.
      await store.recordReviewMaxed({ issueNumber: ctx.issue.number, runId: ctx.runId, phase });
    }
    store.setResumeContext(
      ctx.runId,
      // Keep the maxed-out phase in the resume context so a master `resolved-and-continue`
      // re-enters the review loop exactly where it stopped (resume-not-restart, issue #9).
      { phase, question: masterHandbackQuestion(headline, blockers) },
      ctx.branch,
    );
    store.appendLog({
      runId: ctx.runId,
      issueNumber: ctx.issue.number,
      level: "warn",
      event: "review-maxed",
      data: { phase, attempts, source: input.source, escalated: escalated?.kind ?? "unwired" },
    });
    ctx.logger.warn("review.master-triage", { phase, attempts, source: input.source });
    return { kind: "master-triage", phase };
  }

  /**
   * Back-compat shim for the four legacy call sites that max out a *review phase*. Kept as a
   * one-liner rather than inlined nine times so the source/lane pairing lives in one place.
   */
  private async reviewMaxed(
    ctx: ReviewLoopContext,
    phase: Phase,
    worklist: Worklist,
    attempts: number,
    cause?: "infra",
  ): Promise<ReviewLoopOutcome> {
    return this.escalateToMaster(ctx, {
      phase,
      worklist,
      attempts,
      source: phase === 0 ? "ci" : "review-maxed",
      lane: "review",
      ...(cause ? { cause } : {}),
    });
  }

  /** Escalate terminal: checkpoint, post a ralph-question, swap to awaiting-answer. */
  private async escalate(
    ctx: ReviewLoopContext,
    phase: Phase,
    question: EscalationQuestion,
  ): Promise<ReviewLoopOutcome> {
    const { store, github } = this.deps;
    // The review/fix path already has a PR, so it records the escalation directly
    // (the impl-agent path additionally checkpoints WIP to a draft PR first).
    await recordEscalation(store, github, {
      issueNumber: ctx.issue.number,
      runId: ctx.runId,
      question,
      branch: ctx.branch,
      phase,
    });
    store.appendLog({
      runId: ctx.runId,
      issueNumber: ctx.issue.number,
      level: "info",
      event: "escalated",
      data: { phase, headline: question.headline },
    });
    ctx.logger.info("review.escalated", { phase, headline: question.headline });
    return { kind: "escalated", phase };
  }

  private setPhase(ctx: ReviewLoopContext, phase: AgentPhase): void {
    if (ctx.agentId !== undefined) {
      this.deps.store.setAgentPhase(ctx.agentId, phaseLabel(phase));
    }
  }
}

/**
 * A comment id usable for an in-place edit: a positive, finite REST comment id.
 * The comment listing parses the numeric REST id out of each comment's URL (issue
 * #47), so the recovered id is the one `updateComment` PATCHes by. This guard
 * rejects the degenerate cases — `undefined`, a 0 from an unparseable URL, or a
 * stray non-positive value — so any of those falls through to a fresh post rather
 * than PATCH a non-existent id.
 */
function usableCommentId(id: number | undefined): number | undefined {
  return id !== undefined && Number.isFinite(id) && id > 0 ? id : undefined;
}

/**
 * The 'CI passed, proceed' predicate: `green` (all checks passed) or `none` (the
 * repo reports no checks). Shared by every gate decision and log level in
 * {@link ReviewLoop.ciGate} — true for both a polled {@link ChecksResult} and a
 * single {@link ChecksSnapshot} read, which share the `green`/`none` literals.
 */
function ciClean(state: CheckState | ChecksSnapshot["state"]): boolean {
  return state === "green" || state === "none";
}

/** Turn a red/timeout CI verdict into the fix agent's worklist (one P0 per failure). */
function ciWorklist(checks: ChecksResult): Worklist {
  if (checks.state === "timeout") {
    return {
      items: [
        {
          severity: "P0",
          title: "CI did not reach a terminal state before the timeout",
          detail:
            checks.failures.length > 0
              ? `Still pending: ${checks.failures.join(", ")}`
              : undefined,
          source: "review",
        },
      ],
    };
  }
  if (checks.failures.length === 0) {
    return { items: [{ severity: "P0", title: "CI is red", source: "review" }] };
  }
  return {
    items: checks.failures.map((name) => ({
      severity: "P0" as const,
      title: `CI check failing: ${name}`,
      source: "review" as const,
    })),
  };
}

/**
 * The heal-card worklist for a PR that never reached a mergeable `mergeStateStatus`
 * within the CI budget after the pre-merge rebase (issue #25). Usually a required
 * status check re-queued by the rebase force-push that never went green (BLOCKED), or a
 * conflict/behind state that did not resolve. Honest by construction — it names the
 * stuck merge-state so the operator inspects the required checks / rebase, not a
 * phantom code defect. The reviewed work is intact on the PR; resume-from-WIP retries
 * the rebase-aware merge once the check clears.
 */
/**
 * The worklist for a typed hosted/human/ruleset merge blocker (issue #43). Deliberately carries
 * the *actual* finding text rather than a generic "merge blocked": the whole defect of #3430 was
 * that the evidence reaching the agent named the wrong cause.
 */
function hostedBlockerWorklist(cause: MergeBlockCause): Worklist {
  if (cause.kind === "hosted-review") {
    return {
      items: cause.findings.map((f) => ({
        // The hosted reviewer's own severity, mapped onto the harness worklist vocabulary
        // (which has no `P2` — the low tier there is `nit`).
        severity: f.severity === "P0" ? ("P0" as const) : f.severity === "P2" ? ("nit" as const) : ("P1" as const),
        title: `Hosted review conversation unresolved: ${f.path ?? "(no file)"}${f.line !== null ? `:${f.line}` : ""}`,
        detail: `${f.finding.trim()}\n\n(${f.evidence})`,
        source: "review" as const,
      })),
    };
  }
  return {
    items: [
      {
        severity: "P0",
        title: `Merge gated: ${describeMergeBlock(cause)}`,
        detail:
          cause.kind === "human-review"
            ? "The repository's human-review policy is not satisfied. Ralph may implement and reply, " +
              "but approval and conversation resolution belong to a human reviewer."
            : cause.kind === "unknown-bot"
              ? "A conversation was raised by a bot identity Ralph cannot classify as the hosted " +
                "reviewer. It is neither safe to resolve nor safe to ignore, so the merge fails closed."
              : cause.kind === "threads-unavailable"
                ? `The review threads could not be read (${cause.reason}): ${cause.detail}. Without that ` +
                  "evidence the hosted gate cannot be evaluated, so the merge fails closed."
                : `GitHub reports the pull request unmergeable and no blocker could be identified: ${describeMergeBlock(cause)}.`,
        source: "review",
      },
    ],
  };
}

/**
 * The question half of the resume context a master hand-back rides on. A resumed phase is being
 * *told*, not asked — the master's guidance arrives as the answer — so this states the situation
 * the phase stopped in rather than posing a decision to a human. It is never posted to GitHub.
 */
function masterHandbackQuestion(headline: string, blockers: string[]): EscalationQuestion {
  return {
    headline,
    feature: "Master escalation (ADR-0042 triage cutover)",
    whereWeStand: [
      "This phase exhausted its bounded recovery and was handed to a highest-tier master session.",
      ...(blockers.length > 0 ? ["", "Remaining blockers:", ...blockers.map((b) => `- ${b}`)] : []),
    ].join("\n"),
    decision: "Continue this phase under the master's guidance.",
    stakes:
      "The run is queued for autonomous adjudication. No operator has been paged; the master " +
      "resolves it, or asks a specific question if it cannot.",
    recommendation: "Follow the master's brief when it arrives; escalate rather than improvising.",
  };
}

function mergeBlockedWorklist(state: MergeStateStatus): Worklist {
  return {
    items: [
      {
        severity: "P0",
        title: `The PR never reached a mergeable state (GitHub mergeStateStatus: ${state})`,
        detail:
          `After the pre-merge rebase, GitHub branch protection kept the PR non-mergeable ` +
          `(mergeStateStatus=${state}) past the CI budget — most often a REQUIRED status check ` +
          `re-queued by the rebase force-push that never went green, or a merge-conflict / behind ` +
          `state that did not resolve. The reviewed work is intact on the PR. Inspect the required ` +
          `checks (and rebase state) on the PR, then re-enable the run to retry the rebase-aware merge.`,
        source: "review",
      },
    ],
  };
}

/**
 * The heal-card worklist for the BEHIND re-rebase budget elapsing (issue #31 — the strict
 * up-to-date treadmill). Honest by construction: it names the hot base (an off-daemon merge kept
 * landing while this PR's required check re-ran, so the daemon re-rebased `rounds` times without
 * ever catching a stable base) rather than a phantom code defect. The reviewed work is intact on
 * the PR; resume-from-WIP retries the rebase-aware merge once the base quiets.
 */
function mergeBehindWorklist(state: MergeStateStatus, rounds: number): Worklist {
  return {
    items: [
      {
        severity: "P0",
        title: `The base kept advancing under the PR for ${rounds} rebase round(s) (mergeStateStatus: ${state})`,
        detail:
          `This repo requires branches be up to date before merging (strict status checks). An ` +
          `off-daemon merge (a human / dependabot) landed each time this PR's required check re-ran ` +
          `after the daemon rebased, leaving it ${state} again — the daemon re-rebased ${rounds} time(s) ` +
          `over the whole behindRebaseBudgetMinutes budget without catching a stable base. The reviewed ` +
          `work is intact on the PR. Wait for the base to quiet (or pause the racing source), then ` +
          `re-enable the run to retry the rebase-aware merge.`,
        source: "review",
      },
    ],
  };
}

/** The heal-card worklist for a review/fix session killed at the wall-clock (issue #13). */
function wallClockWorklist(err: WallClockExceededError): Worklist {
  return {
    items: [
      {
        severity: "P0",
        title: `A review/fix session was killed after exceeding the ${err.wallClockSeconds}s wall-clock ceiling`,
        detail:
          "The session hung and was hard-killed (query aborted, subprocess tree reaped). " +
          "It needs a human to look at why it stalled before the run can proceed.",
        source: "review",
      },
    ],
  };
}

/**
 * The heal-card worklist for a container infra fault that survived `maxContainerRetries`
 * re-dispatches (issue #220). Honest by construction — it names the daemon-side infrastructure
 * fault and carries the real docker exit code / stderr tail, so the operator fixes the box rather
 * than chasing a non-existent code/JSON problem.
 */
function containerInfraWorklist(detail: string): Worklist {
  return {
    items: [
      {
        severity: "P0",
        title: "A review/fix container failed to produce a result after repeated retries (daemon infra fault)",
        detail:
          `This is an infrastructure failure, NOT a code defect: the container did not return a ` +
          `result frame even after retries. Fix the container host (docker / credentials / disk), ` +
          `then re-enable the run to re-run the review from the existing PR. Container failure: ${detail}`,
        source: "review",
      },
    ],
  };
}

/** The heal-card worklist for an agent whose structured output would not parse (#15). */
function parseFailureWorklist(err: AgentOutputParseError): Worklist {
  // The diagnostic reaches the operator inside the heal-card's fenced JSON payload: a raw backtick
  // run in the agent's output tail would close that fence early and make the question unparseable to
  // ralph-answer, so sanitizeForFence (core/fenced-payload.ts, the codec that owns the fence) swaps
  // every backtick for a lookalike before it enters the worklist.
  return {
    items: [
      {
        severity: "P0",
        title: `A review/fix agent did not return parseable JSON after ${err.attempts} attempts`,
        detail: sanitizeForFence(
          `Parser error: ${err.lastError}. The agent's final message must be exactly one valid JSON ` +
            `object — double-quoted strings, no backticks used as delimiters. Last output tail: ${err.rawTail}`,
        ),
        source: "review",
      },
    ],
  };
}

/**
 * The heal-card worklist for a branch whose local worktree ref and origin have diverged by a
 * rewrite the daemon could NOT attribute to its own runner push (issue #21 part 4): a hand
 * force-push, or an unknown rewrite — the case the #255 guard exists for. Rather than let that
 * guard terminalize the run to `agent-stuck` and auto-close a fully-reviewed PR (orphaning the
 * work), the run parks HEALABLE with this card: the PR is preserved on origin, and a human resolves
 * the divergence (or confirms which side is truth) before re-enabling the run.
 */
function divergedBranchWorklist(branch: string): Worklist {
  return {
    items: [
      {
        severity: "P0",
        title: `origin/${branch} has diverged from the daemon worktree by an unattributable rewrite`,
        detail:
          `The local worktree ref and origin/${branch} have diverged — neither is an ancestor of ` +
          `the other — and the divergence does NOT match the daemon's own recorded rebase-conflict ` +
          `push, so it cannot be trusted as the daemon's write (a hand force-push, or an unknown ` +
          `rewrite). The reviewed work is preserved on the PR; nothing was clobbered. Inspect ` +
          `origin/${branch} vs the local branch, resolve the divergence so one side is authoritative, ` +
          `then re-enable the run to retry the resolve+verify.`,
        source: "review",
      },
    ],
  };
}

/** Turn rebase-conflict paths into the fix agent's worklist (one P0 per file). */
function conflictWorklist(files: string[]): Worklist {
  if (files.length === 0) {
    return {
      items: [{ severity: "P0", title: "Resolve rebase conflicts with the base branch", source: "review" }],
    };
  }
  return {
    items: files.map((file) => ({
      severity: "P0" as const,
      title: `Resolve rebase conflict in ${file}`,
      source: "review" as const,
    })),
  };
}

/**
 * The heal-card worklist for a rebase-conflict resolution that did NOT land on origin (#273):
 * the container fix agent reported `fixed` but `origin/<branch>` still does not contain base
 * (it still conflicts, or was wiped to base). Honest by construction — it names the failure mode
 * so the operator knows the self-heal did not converge, not that the code is wrong. The PR (with
 * its fully-reviewed work) is preserved: resume-from-WIP re-runs the resolve+verify.
 */
function rebaseNotLandedWorklist(branch: string): Worklist {
  return {
    items: [
      {
        severity: "P0",
        title: `The rebase-conflict resolution did not land on origin/${branch}`,
        detail:
          `A sibling PR merged into base mid-review and the rebase-conflict self-heal ran, but ` +
          `verification found origin/${branch} still does not cleanly contain base — the container ` +
          `fix either did not complete the rebase or its force-push landed nothing. The reviewed ` +
          `work is intact on the branch. Inspect the conflict (a human resolution may be needed), ` +
          `then re-enable the run to retry the resolve+verify.`,
        source: "review",
      },
    ],
  };
}

/**
 * The heal-card worklist for a rebase-conflict self-heal that could not converge because base kept
 * advancing under it (#20): each time the container landed a resolution, another sibling PR had
 * already merged into base and introduced a fresh conflict, `rounds` times over. This is a hot-base
 * RACE, not a failed or no-op push — the wording says so explicitly, so the operator does not chase a
 * phantom push failure (the exact misdiagnosis #20 fixes). The reviewed work is intact on the branch;
 * resume-from-WIP retries the resolve once the base quiesces.
 */
function baseRaceWorklist(rounds: number): Worklist {
  return {
    items: [
      {
        severity: "P0",
        title: `The base branch advanced ${rounds} times during rebase-conflict resolution`,
        detail:
          `Each time the container fix agent landed a resolution, another sibling PR had already ` +
          `merged into base and introduced a fresh conflict, so the self-heal could not converge in ` +
          `${rounds} rounds. This is a hot-base race, NOT a failed or no-op push — every resolution ` +
          `landed exactly as dispatched. The reviewed work is intact on the branch. Wait for the base ` +
          `to quiesce (or reduce merge concurrency), then re-enable the run to retry the resolve; a ` +
          `human resolution may help only if a genuinely hard conflict persists.`,
        source: "review",
      },
    ],
  };
}

/**
 * The heal-card worklist for a rebase-conflict fix the container reported as `failed` (#273): the
 * runner-owned push refused (the #241 no-net-diff guard — never wipe a branch to base-equivalent),
 * a `git push --force-with-lease` rejected by a concurrent push to the branch during the fix
 * window (the parallel-edit self-heal this path exists for), a transient git/network fault, or the
 * agent could not resolve the conflict. Distinct from {@link rebaseNotLandedWorklist} (the fix
 * reported `fixed` but verification found nothing landed): here the fix container itself failed.
 * Carries the container's real failure detail so the operator sees the true reason, never a
 * misleading "did not return parseable JSON" card. The PR (fully-reviewed work) is preserved;
 * resume-from-WIP re-runs the resolve+verify once the cause clears.
 */
function rebaseFixFailedWorklist(detail: string): Worklist {
  // The detail reaches the operator inside the heal-card's fenced JSON payload: a raw backtick in a
  // git error would close that fence early, so sanitizeForFence (core/fenced-payload.ts, the codec
  // that owns the fence) swaps every backtick for a lookalike.
  return {
    items: [
      {
        severity: "P0",
        title: "The rebase-conflict resolution container reported a failure",
        detail: sanitizeForFence(
          `A sibling PR merged into base mid-review and the rebase-conflict self-heal ran, but the ` +
            `fix container returned a failure instead of landing the resolved rebase — the runner's ` +
            `force-push was refused (a concurrent push to the branch, or the #241 no-net-diff guard) ` +
            `or the resolution itself failed. The reviewed work is intact on the branch. Inspect the ` +
            `conflict (a human resolution may be needed), then re-enable the run to retry the ` +
            `resolve+verify. Container failure: ${detail}`,
        ),
        source: "review",
      },
    ],
  };
}
