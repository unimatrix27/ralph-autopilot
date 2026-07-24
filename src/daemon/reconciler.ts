/**
 * The reconciler (CONTEXT: reconcile tick). Every tick it diffs desired state
 * (GitHub labels) against actual state (SQLite + running agents) and acts on the
 * difference. Each tick, in order:
 *
 *   sweep   → orphan / liveness GC (issue #27 AC2): reconcile a `running` row the
 *             daemon isn't executing, terminate a non-terminal run whose issue
 *             closed under it, and prune worktrees no live run references. A wedged
 *             in-flight run past its lifetime ceiling is actively terminated through
 *             the executor's abort handle (issue #61): the slot is freed by
 *             occupySlot's single owner once the killed session settles, never by a
 *             second writer here. `surface` keeps it visible as a `daemon-anomaly`
 *             until it settles terminal.
 *   resume  → resume answered pauses (an operator's answer re-arms a paused run).
 *   fill    → admit (CONTEXT: admission) the open issues and launch executors for
 *             the picked ones, up to `maxConcurrentAgents`.
 *   surface → completeness invariant (issue #27 AC1): classify every open issue and
 *             every non-terminal run into exactly one of {eligible, in-flight,
 *             awaiting-human, terminal}; anything unclassifiable or contradictory
 *             gets a `daemon-anomaly` label + a structured log — never a silent
 *             island.
 *
 * Admission (`admit`) owns the whole pickup decision — the eligibility gate, the
 * per-tick dependency cache, the in-flight / active-run exclusions, and the
 * ordered fill of the open slots. The reconciler computes how many slots are free
 * (after resumes consume theirs), hands `admit` the world it reconciles against,
 * and launches the plan it returns. The sweep and the completeness pass run every
 * tick regardless of slot availability — liveness GC and the no-silent-loss
 * invariant are independent of whether there is room to launch new work.
 *
 * Executors run concurrently; a slot frees the instant its executor settles, so
 * the next tick refills it. An issue is never picked up twice: it is excluded while
 * in flight, while an active run row holds it, and once `ready-for-agent` is removed
 * on pickup. A terminal run row (agent-stuck / merged) does not hold it —
 * re-labelling re-admits it for a fresh run.
 */

import { resolve } from "node:path";
import { freemem as osFreemem } from "node:os";
import { admit, evaluateGate, type World } from "../core/admission";
import {
  PAUSED_LABELS,
  LABEL_READY,
  LABEL_AWAITING_ANSWER,
  LABEL_REVIEW_MAXED,
  LABEL_AGENT_STUCK,
  LABEL_AWAITING_MERGE,
  modeLabelFor,
} from "../core/labels";
import { selectModingCandidates, type ModeClassifier } from "../core/moding";
import { resolveRoute, type RouteWorld, type RoutingSource } from "../providers/resolve";
import type { AutoModeSettings, UsageLimitSettings } from "../config/schema";
import type { ContainerSweeper } from "../container/container-execution";
import { createRunTranscriptSink } from "../executor/transcript-sink";
import type { TranscriptRetentionBudget } from "../store/events/transcript";
import type { UsageMeter } from "./usage-meter";
import type { ChecksResult, ChecksSnapshot, GitHubClient, Issue, PullRequest } from "../github/types";
import type { Logger } from "../log/logger";
import type { ScopedStore } from "../store/store";
import type { BacklogView, DaemonError, Run, RunStatus } from "../store/types";
import type { Executor, PickedIssue } from "../executor/executor";
import type { WorktreeManager } from "../executor/worktree";
import { scanPausedRuns, type ResumableRun } from "../hitl/resume";
import { rehydrateRunsFromGitHub } from "./rehydrate";
import { projectBacklog } from "./backlog";
import { parseBlockedBy } from "../github/blocked";
import {
  classifyIssueState,
  isNonTerminalStatus,
  isSpanClosed,
  LABEL_DAEMON_ANOMALY,
  LABEL_DAEMON_ANOMALY_CREATE,
  type Classification,
  type IssueSnapshot,
} from "./completeness";

/**
 * Human-attention labels other than `daemon-anomaly` — the paused/terminal labels
 * the gate excludes, minus the daemon's own marker. When an issue still carries one
 * of these, a stale `daemon-anomaly` can be cleared (the issue stays visibly parked
 * for a human on the other label); when `daemon-anomaly` is the *only* such surface,
 * clearing it would un-surface a deliberately-parked claim anomaly (issue #28), so
 * it is kept. Derived from {@link PAUSED_LABELS} so the two never drift.
 */
const OTHER_ATTENTION_LABELS: readonly string[] = PAUSED_LABELS.filter((l) => l !== LABEL_DAEMON_ANOMALY);

/**
 * The synthetic run correlation tag for a moding (auto-mode) classification's transcript
 * stream (ADR-0030). The moding pass classifies an issue *before* any run row exists, so
 * its session has no `runs.id`; it captures on `transcript:<repo>#<issue>:moding`.
 */
const MODING_RUN_ID = "moding";

/**
 * The status→label map for the four relocated effects; absent status → no state label.
 * This map is the **single source** of the daemon-set state-label vocabulary —
 * {@link STATE_EFFECT_LABELS} is derived from its values, so a future fifth effect added
 * here cannot drift out of sync with the strip/iterate set.
 */
const STATUS_EFFECT_LABEL: Partial<Record<RunStatus, string>> = {
  "awaiting-answer": LABEL_AWAITING_ANSWER,
  "review-maxed": LABEL_REVIEW_MAXED,
  "agent-stuck": LABEL_AGENT_STUCK,
  "awaiting-merge": LABEL_AWAITING_MERGE,
};

/**
 * The four daemon-set state labels delivered as level-triggered **effects** of the
 * run-status projection (issue #82, ADR-0027). Each maps 1:1 from a run status; every
 * other status (running / awaiting-ci / merged / closed) desires none of them. The
 * reconciler is the single writer of this set — the imperative `addLabel` at the
 * transition points (escalate, review-maxed, stuck, review hand-off) is gone; each
 * tick the {@link Reconciler.surfaceAnomalies} pass diffs desired-vs-actual and applies
 * the difference idempotently. `awaiting-ci` is deliberately NOT here: it stays an
 * inline durable marker (out of scope; only these four relocate). `daemon-anomaly` is
 * not here either — it is sourced from the live completeness classification, never the
 * status projection (avoids a dual source of truth). Derived from the values of
 * {@link STATUS_EFFECT_LABEL} so the map is the lone source of the effect vocabulary;
 * order is irrelevant since each label is reconciled independently.
 */
const STATE_EFFECT_LABELS: readonly string[] = Object.values(STATUS_EFFECT_LABEL);

/**
 * The single daemon-set state label the status projection *desires* for an issue
 * (issue #82, ADR-0027), or `null` for none. The pure core of the effect outbox: the
 * reconciler's per-tick diff and the completeness overlay both read it, so the label
 * the daemon applies and the label completeness compares against can never diverge.
 *
 * Two surfaces dominate and suppress a *new* state label:
 *   - **`ready-for-agent` present** → null. The operator re-armed the issue (the
 *     `ralph-answer` swap-back, or a heal re-admit, ADR untouched intake). The intake
 *     label is authoritative; the diff must never re-add the pause label the swap-back
 *     just cleared, even though the run status still reads paused until the resume lands.
 *   - **`daemon-anomaly` present and the matching label absent** → null. The issue is
 *     surfaced as a #28 claim-park whose *sole* human-attention surface is
 *     `daemon-anomaly`; introducing the state label would let `reconcileAnomalyLabel`
 *     clear that surface. A state label already present (a swept orphan / failed-run
 *     `agent-stuck`, seeded inline by the executor's orphan/failure terminalizers because
 *     those runs can already carry `daemon-anomaly`) is preserved — that present label is
 *     the signal distinguishing a terminalized run from a claim-park, so the diff keeps it.
 */
function desiredStateLabel(status: RunStatus | null, labels: readonly string[]): string | null {
  if (status === null || labels.includes(LABEL_READY)) {
    return null;
  }
  const label = STATUS_EFFECT_LABEL[status];
  if (!label) {
    return null;
  }
  if (labels.includes(LABEL_DAEMON_ANOMALY) && !labels.includes(label)) {
    return null;
  }
  return label;
}

/**
 * The issue's labels with the four {@link STATE_EFFECT_LABELS} replaced by the
 * projection's desired set — the *post-diff* view completeness classifies against, so
 * the ≤1-tick effect latency (ADR-0027) can never trip a false `daemon-anomaly` island
 * (ADR-0016). Strips every state effect label, then re-adds the one the projection
 * desires (if any); all non-effect labels (intake, `daemon-anomaly`, `awaiting-ci`)
 * pass through untouched.
 */
function overlayStateLabels(labels: readonly string[], desired: string | null): string[] {
  const base = labels.filter((l) => !STATE_EFFECT_LABELS.includes(l));
  return desired ? [...base, desired] : base;
}

/** Default consecutive-claim-failure budget before an issue is surfaced as a daemon anomaly. */
export const DEFAULT_MAX_CLAIM_FAILURES = 3;

/** Default run-lifetime backstop (6h): well beyond the per-session wall-clock. */
export const DEFAULT_MAX_RUN_LIFETIME_MS = 6 * 60 * 60 * 1000;

/**
 * Default CI-timeout budget for the off-slot pre-review CI gate (ADR-0022 stage 1):
 * how long a run may sit parked `awaiting-ci` with checks still pending before the
 * poller times it out. Mirrors `merge.ciTimeoutMinutes` (config default 30m).
 */
export const DEFAULT_CI_TIMEOUT_MINUTES = 30;

/**
 * The global BUILD-budget port (ADR-0020). The orchestrator implements it over the
 * one cap shared across all repos: `available()` is `max(0, cap − Σ all repos'
 * in-flight BUILD runs)` and `hasCapacity()` is whether one more build agent may
 * start. A per-repo reconciler reads it live each tick, so two repos can never
 * oversubscribe the operator's plan budget on the build pool. The single-concurrency
 * merge lease is deliberately NOT counted here — it stays free per-repo concurrency
 * (≤1 per repo) so integration always progresses even at full build cap (ADR-0017),
 * making the peak `cap + (repos currently integrating)`. (In single-repo use this is
 * just `cap − this repo's build in-flight`.)
 */
export interface ReconcileBudget {
  /** Build slots free right now across all repos. */
  available(): number;
  /** Whether at least one more build agent may start under the global cap. */
  hasCapacity(): boolean;
}

export interface ReconcilerDeps {
  store: ScopedStore;
  github: GitHubClient;
  executor: Executor;
  /**
   * The worktree manager — the same instance the executor holds. Used directly by
   * the startup orphan sweep ({@link Reconciler.pruneOrphanBranches}) and the
   * per-tick orphan-worktree GC ({@link Reconciler.pruneOrphanWorktrees}),
   * repo-wide reconcile operations that are the reconciler's job, not the per-issue
   * executor's (issue #27 AC2, issue #28 AC2).
   */
  worktrees: WorktreeManager;
  /**
   * The container orphan-sweep port (ADR-0038), wired only for a `container`-mode target. Each
   * tick the orphan sweep hands it the branches with a live run so it can kill any running
   * container that backs none of them — the container analogue of {@link pruneOrphanWorktrees}.
   * Absent → in-process mode, where there are no containers to sweep (an exact no-op).
   */
  containers?: ContainerSweeper;
  logger: Logger;
  /** The shared global agent budget (ADR-0020) — read live for fill/merge/recovery. */
  budget: ReconcileBudget;
  /** The global concurrency cap, surfaced in this repo's TUI snapshot header (issue #20). */
  cap: number;
  /**
   * Cap on THIS target's own concurrently-running build agents (issue #27), or omitted for
   * "only the global cap applies". Effective open slots this tick are `min(global free
   * budget, this cap − this target's in-flight build runs)`, so a memory-heavy repo can be
   * bounded well below the global cap while light targets keep the higher ceiling. The
   * complementary box-wide backstop is {@link minFreeMemoryMB}.
   */
  maxAgentsThisTarget?: number;
  /**
   * Box-wide free-RAM floor (MiB) below which admission launches NO new agent this tick
   * (issue #27, `scheduler.minFreeMemoryMB`) — the box-wide OOM backstop `cap` cannot
   * express. `0` / omitted disables the gate (pre-#27 behaviour). Read live each tick
   * through {@link freeMemoryBytes} and folded into admission's `hasMemoryHeadroom`.
   */
  minFreeMemoryMB?: number;
  /**
   * Probe for the box's currently-free RAM in bytes, injected for tests; defaults to
   * `os.freemem()`. Read only when {@link minFreeMemoryMB} is set and something is
   * eligible (admission probes it lazily), so a quiet tick never touches it.
   */
  freeMemoryBytes?: () => number;
  priorityLabels: string[];
  /**
   * Consecutive claim failures tolerated for one issue before the reconciler
   * stops retrying and surfaces it as a `daemon-anomaly` (issue #28, AC3).
   * Defaults to {@link DEFAULT_MAX_CLAIM_FAILURES}.
   */
  maxClaimFailures?: number;
  /**
   * Liveness backstop (issue #27 AC1): an in-flight run whose row has not advanced
   * in this many ms is wedged — the per-session wall-clock failed to settle it — and
   * is surfaced as a `daemon-anomaly` by the completeness pass. `<= 0` disables the
   * backstop. Defaults to {@link DEFAULT_MAX_RUN_LIFETIME_MS}.
   */
  maxRunLifetimeMs?: number;
  /**
   * CI-timeout budget (minutes) for the off-slot pre-review CI gate (ADR-0022 stage
   * 1): a run parked `awaiting-ci` whose checks stay pending beyond this is timed out
   * by the CI poller (the existing Phase 0 timeout handling). Mirrors
   * `merge.ciTimeoutMinutes`; defaults to {@link DEFAULT_CI_TIMEOUT_MINUTES}.
   */
  ciTimeoutMinutes?: number;
  /** The target repo slug this reconciler works (issue #20 read-model header; per-repo scope). */
  targetRepo: string;
  /** Tick cadence (seconds), so the web control plane can show a next-tick countdown (issue #20). */
  reconcileIntervalSeconds: number;
  /**
   * Auto-mode (CONTEXT: moding pass) settings for this target. When `enabled`, the
   * reconciler runs a bounded moding pass each tick that classifies the issues the
   * gate rejects solely for a missing `mode:*` label and applies it. Absent or
   * `enabled: false` → the pass is an exact no-op.
   */
  autoMode?: AutoModeSettings;
  /**
   * The mode classifier the moding pass drives (an SDK session in production, a fake
   * in tests). Required for the pass to run; absent → the pass is a no-op even when
   * `autoMode.enabled` is set.
   */
  modeClassifier?: ModeClassifier;
  /**
   * The shared Claude usage meter (ADR-0020: one OAuth plan budget across all
   * repos). Read each tick to gate admission when a plan window is at/above the
   * threshold or a hit-limit cooldown is active. Absent → the gate is a no-op.
   */
  usageMeter?: UsageMeter;
  /**
   * Separate non-Claude provider cooldown meter (currently z.ai). It deliberately does
   * not receive Claude OAuth telemetry; it only gates fresh work after an endpoint
   * provider reports a transient quota/rate-limit cap.
   */
  providerUsageMeter?: UsageMeter;
  /**
   * The CURRENT routing for this target — read live each tick (a thunk, so a later
   * slice's runtime overlay is a drop-in), supplying the `impl` type's `(provider, model)`
   * preference list and the capability gate. Paired with {@link routeWorld} to resolve
   * the impl route for the no-provider admission wait (ADR-0037 P2.3). Absent → admission
   * always has provider headroom (a provider-routing-agnostic setup / tests).
   */
  routing?: RoutingSource;
  /**
   * The per-provider headroom port route resolution consults (ADR-0037). Each tick the
   * reconciler resolves the impl route through it and folds `{ wait: "no-provider" }` into
   * admission as the `no-provider` exclusion — a wait, not a stuck: the issue keeps
   * `ready-for-agent`, takes no human-attention label, and is re-resolved next tick (picked
   * up automatically once a pool regains headroom). Absent → admission always has headroom.
   */
  routeWorld?: RouteWorld;
  /**
   * The approximate instant an `impl` provider pool is expected to regain headroom (the
   * "resets ~HH:MM" ETA), or null when unknown — stamped onto the backlog's `no-provider`
   * rows so the operator sees *when* the parked queue should resume (ADR-0037 P3.2, #165).
   * A thunk read only when something is parked. Absent → no ETA (the wait still shows).
   */
  implProviderResetsAt?: () => string | null;
  /** Usage-limit guard settings; when `enabled`, the meter gates new admissions. */
  usageLimit?: UsageLimitSettings;
  /**
   * Transcript retention (ADR-0030): the budget the periodic prune enforces over this
   * repo's verbose transcripts, and how often (in ticks) it runs. Absent → no pruning
   * (capture still happens; transcripts just accumulate, e.g. in tests).
   */
  transcriptRetention?: { budget: TranscriptRetentionBudget; everyTicks: number };
  /**
   * Injected clock for the lifetime backstop and snapshot timestamps
   * (issue #20); defaults to the system clock.
   */
  now?: () => Date;
}

export class Reconciler {
  /** Issues currently being executed in the build flow, keyed by issue number. */
  private readonly inFlight = new Map<number, Promise<void>>();
  /**
   * The single-concurrency integration (resolve + merge) lease, keyed by issue
   * number. Size ≤ 1 by construction — only one run merges at a time, so a branch
   * never races `main` against another integrating branch. Separate from
   * {@link inFlight}: it does not consume a build slot and is serviced every tick
   * regardless of how full the build pool is.
   */
  private readonly mergeInFlight = new Map<number, Promise<void>>();
  /**
   * Consecutive claim failures per issue (issue #28, AC3). Incremented on each
   * failed claim, cleared on a successful one; at the budget the issue is
   * surfaced as a `daemon-anomaly` instead of retried forever.
   */
  private readonly claimFailures = new Map<number, number>();
  /**
   * In-flight auto-mode classifications, keyed by issue number (CONTEXT: moding pass).
   * Bounds concurrent classification sessions to `autoMode.maxPerTick` and keeps the
   * pass idempotent across ticks — an issue already being classified is never
   * re-selected. Deliberately NOT a build slot (off the build pool, like the merge
   * lease): pre-pickup triage does not consume the operator's plan cap.
   */
  private readonly modingInFlight = new Map<number, Promise<void>>();
  /**
   * The latest moding pass's select-and-launch chain. Tracked so the whole pass
   * (async candidate selection + the classifications it launches) is awaitable —
   * used by {@link awaitModing} for drain/tests, since the per-issue promises in
   * {@link modingInFlight} aren't populated until selection (which touches GitHub)
   * resolves.
   */
  private modingPass: Promise<void> = Promise.resolve();

  private readonly maxRunLifetimeMs: number;
  /** CI-timeout budget (ms) for the off-slot pre-review CI gate (ADR-0022 stage 1). */
  private readonly ciTimeoutMs: number;
  private readonly now: () => Date;
  /** When this daemon process started — the uptime base for live views (issue #20). */
  private readonly daemonStartedAt: string;
  /** The most recent reconcile error, surfaced in the snapshot until a clean tick. */
  private lastError: DaemonError | null = null;
  /** Tick counter, used to pace the periodic transcript-retention prune (ADR-0030). */
  private tickCount = 0;

  constructor(private readonly deps: ReconcilerDeps) {
    this.maxRunLifetimeMs = deps.maxRunLifetimeMs ?? DEFAULT_MAX_RUN_LIFETIME_MS;
    this.ciTimeoutMs = (deps.ciTimeoutMinutes ?? DEFAULT_CI_TIMEOUT_MINUTES) * 60_000;
    this.now = deps.now ?? ((): Date => new Date());
    this.daemonStartedAt = this.now().toISOString();
  }

  /** Number of executors currently in flight — build pool plus the merge lease. */
  activeCount(): number {
    return this.inFlight.size + this.mergeInFlight.size;
  }

  /** The target repo slug this reconciler works. */
  get targetRepo(): string {
    return this.deps.targetRepo;
  }

  /**
   * Record (or clear) the last reconcile error for this repo's snapshot header
   * (issue #20). The orchestrator owns the tick loop, so it reports a thrown tick to
   * the reconciler here; the next tick's snapshot surfaces it until a clean tick
   * clears it. `null` clears the indicator.
   */
  setLastError(error: DaemonError | null): void {
    this.lastError = error;
  }

  /** Build-pool occupancy for this repo (excludes the merge lease) — the global budget input. */
  inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Merge-lease occupancy for this repo (0 or 1). */
  mergeCount(): number {
    return this.mergeInFlight.size;
  }

  /**
   * Whether this repo is fully idle for a drain (issue #35): no build run, no merge
   * lease, and an empty `awaiting-merge` queue. A finished review run does not merge
   * itself — it joins the queue — so "idle" requires the queue empty too, else the
   * orchestrator's drain pump would stop with work still to integrate.
   */
  isIdle(): boolean {
    return (
      this.inFlight.size === 0 &&
      this.mergeInFlight.size === 0 &&
      this.deps.store.listRunsByStatus("awaiting-merge").length === 0
    );
  }

  /** Every in-flight promise (build pool + merge lease) — the orchestrator's drain pump races these. */
  inFlightPromises(): Promise<void>[] {
    return [...this.inFlight.values(), ...this.mergeInFlight.values()];
  }

  /** Issue numbers still in flight (build pool + merge lease) for this repo. */
  stillInFlight(): number[] {
    return [...this.inFlight.keys(), ...this.mergeInFlight.keys()];
  }

  /** The in-flight promise for an issue, or a resolved promise if it is not running. */
  activePromiseFor(issueNumber: number): Promise<void> {
    return this.inFlight.get(issueNumber) ?? Promise.resolve();
  }

  /** Wait for every in-flight executor to settle — build pool and merge lease (no gating, no timeout). */
  async awaitInFlight(): Promise<void> {
    await Promise.all([...this.inFlight.values(), ...this.mergeInFlight.values()]);
  }

  /**
   * Startup reconciliation (DESIGN §1/§7, ADR-0003): rebuild runtime state from
   * GitHub before the first tick, so a restart re-derives reality rather than
   * abandoning in-flight work.
   *
   *   1. End stale active-agent rows — nothing runs on a fresh process.
   *   2. Rebuild missing run rows from open PRs carrying the launch marker (a cold
   *      store, where SQLite was lost) — paused runs get their question index and
   *      resume context back so resume works; in-flight review runs come back as
   *      `running`.
   *   3. Reconcile every orphaned `running` row (rebuilt above *or* surviving a
   *      warm-store crash): re-drive its review loop if its PR survives, else mark
   *      it terminal and remove its worktree (no orphaned worktrees survive — AC3).
   *
   * Orphaned `running` rows number at most `maxConcurrentAgents` by construction
   * (that many ran before the crash), so re-driving them all respects the cap.
   */
  async rehydrate(): Promise<void> {
    const { store, github, logger } = this.deps;
    // Stale active-agent rows are ended once globally by the orchestrator before any
    // repo rehydrates (the agents table is not repo-scoped), so this per-repo pass
    // goes straight to rebuilding run rows from GitHub.
    const rebuilt = await rehydrateRunsFromGitHub(github, store, logger);
    if (rebuilt.length > 0) {
      logger.info("rehydrate.rebuilt", { issues: rebuilt });
    }

    for (const run of store.listRunsByStatus("running")) {
      if (this.inFlight.has(run.issueNumber)) {
        continue;
      }
      await this.reconcileOrphanRunningRow(run);
    }

    // Prune `ralph/*` branches + worktrees with no live run (issue #28, AC2):
    // survivors of vanished runs would otherwise collide with a fresh `worktree
    // add` on re-pickup. Re-driven runs are still `running` (kept); discarded
    // ones are now terminal (their branches pruned). Best-effort.
    await this.pruneOrphanBranches();
  }

  /**
   * Reconcile one orphaned `running` row — a row the daemon believes is executing
   * but holds no slot for (a crash survivor, or the #8 island re-found mid-loop).
   * Re-drive its review if the issue and PR both survive (and a slot is free), else
   * mark it terminal and prune its worktree. Shared by {@link rehydrate} (startup)
   * and {@link sweep} (periodic) so both converge on one pass.
   */
  private async reconcileOrphanRunningRow(run: Run): Promise<void> {
    const target = await this.resolveRunTarget(run);
    if (!target.live) {
      // A daemon crash/OOM restart can leave the run's container still executing (it commits,
      // pushes, and opens its OWN PR — issue #29). Discarding it here would false-stick a live run
      // to `agent-stuck` and a later sweep would kill the healthy container. So before discarding a
      // no-PR orphan, check the container: if the issue is still OPEN and a container is alive for
      // this branch, the run is genuinely in flight — leave the row `running` and let it finish
      // (its PR lands, re-driven on a later reconcile). A genuinely dead run (no live container) or
      // a resolved issue still discards, exactly as before. The liveness probe fails toward discard
      // so a probe fault never wedges cleanup; a wedged survivor is caught by the lifetime backstop.
      if (target.issue?.state === "OPEN" && run.branch && (await this.hasLiveContainer(run.branch))) {
        this.deps.logger.info("orphan.container-alive", { issue: run.issueNumber, branch: run.branch });
        return;
      }
      await this.discardOrphanSafely(run, target.issue);
      return;
    }
    if (this.deps.budget.hasCapacity()) {
      this.launchRecovery(run, target.issue, target.pr);
    }
    // Re-drivable but no open slot → leave it; the next sweep retries, and the
    // completeness pass surfaces it as `daemon-anomaly` until it is re-driven.
  }

  /**
   * Discard an orphaned run via the executor, swallowing and logging any failure.
   * The single home for the guarded orphan-discard: every site that gives up on a
   * run (startup/periodic orphan reconcile, a closed paused issue, a wedged run
   * past its lifetime) routes through here so the call + error log stay identical.
   */
  private async discardOrphanSafely(run: Run, issue: Issue | null): Promise<void> {
    try {
      await this.deps.executor.discardOrphan(run, issue);
    } catch (err) {
      this.deps.logger.error("executor.discard-orphan-failed", { issue: run.issueNumber, error: String(err) });
    }
  }

  /**
   * Whether a ralph-managed container is currently running for `branch` (issue #29) — the liveness
   * check the orphan reconcile consults before discarding a no-PR `running` row so it never
   * false-sticks a run whose container survived a daemon crash. In-process / no-container mode has
   * no container to be alive (→ `false`, discard as before). A failed probe fails toward `false`
   * (discard) so a docker hiccup never blocks orphan cleanup — the prior behaviour, never a wedge.
   */
  private async hasLiveContainer(branch: string): Promise<boolean> {
    const { containers } = this.deps;
    if (!containers) {
      return false;
    }
    try {
      return (await containers.runningBranches()).has(branch);
    } catch (err) {
      this.deps.logger.warn("orphan.container-liveness-failed", { branch, error: String(err) });
      return false;
    }
  }

  /**
   * Close out an `agent-stuck` run whose issue resolved out-of-band (issue #274),
   * swallowing and logging any failure. The guarded home for the close-out, mirroring
   * {@link discardOrphanSafely}: the executor's `closeOutStuckRun` does its writes
   * unguarded and throws, and the swallow lives here so terminalization keeps a single
   * error boundary. On a write failure the swallow logs and the sweep still falls
   * through to `reconcileAnomalyLabel` with the run row; the next tick retries.
   */
  private async closeOutStuckRunSafely(run: Run): Promise<void> {
    try {
      await this.deps.executor.closeOutStuckRun(run);
    } catch (err) {
      this.deps.logger.error("reconcile.stuck-run-close-out-failed", {
        issue: run.issueNumber,
        runId: run.id,
        error: String(err),
      });
    }
  }

  /**
   * Resolve a run's live target and decide whether it is still drivable. The single
   * home for the invariant 'a PR/issue concluded out-of-band is an orphan', shared by
   * every off-slot worker that re-finds a run's `(issue, PR)`: the orphan reconcile,
   * the merge worker, and the CI poller. Reads the issue and (branch-scoped) PR, then
   * folds the both-must-be-OPEN test — `live: true` carries the non-null issue + PR the
   * caller drives, `live: false` carries whatever issue was found (or `null`) so the
   * caller can route it through its own discard. Each caller keeps its own discard /
   * recover action and slot placement; only this read + decision is consolidated.
   */
  private async resolveRunTarget(
    run: Run,
  ): Promise<{ live: true; issue: Issue; pr: PullRequest } | { live: false; issue: Issue | null }> {
    const { github } = this.deps;
    const issue = await github.getIssue(run.issueNumber);
    const pr = run.branch ? await github.findPullRequestForBranch(run.branch) : null;
    if (issue?.state === "OPEN" && pr?.state === "OPEN") {
      return { live: true, issue, pr };
    }
    return { live: false, issue: issue ?? null };
  }

  /**
   * Sweep orphaned `ralph/*` branches/worktrees, keeping only live runs' branches
   * (issue #28, AC2). A non-terminal run still holds its branch; "terminal" routes
   * through the shared {@link isNonTerminalStatus} so the terminal/re-admittable
   * invariant has one source of truth (admission's `RE_ADMITTABLE_STATUSES`).
   */
  private async pruneOrphanBranches(): Promise<void> {
    const keep = new Set<string>();
    for (const run of this.deps.store.listRuns()) {
      if (run.branch && isNonTerminalStatus(run.status)) {
        keep.add(run.branch);
      }
    }
    try {
      const pruned = await this.deps.worktrees.pruneOrphans(keep);
      if (pruned.length > 0) {
        this.deps.logger.info("rehydrate.pruned-orphans", { branches: pruned });
      }
    } catch (err) {
      this.deps.logger.error("rehydrate.prune-failed", { error: String(err) });
    }
  }

  /** Re-drive an orphaned run's review in the background, occupying a slot until it settles. */
  private launchRecovery(run: Run, issue: Issue, pr: PullRequest): void {
    this.occupySlot(run.issueNumber, "executor.recover-failed", () => this.deps.executor.recoverReview(run, issue, pr));
  }

  /** Hold a build slot for `issueNumber` until its work settles, then free it. */
  private occupySlot(issueNumber: number, errorEvent: string, work: () => Promise<unknown>): void {
    this.occupy(this.inFlight, issueNumber, errorEvent, work);
  }

  /**
   * Hold a slot in `set` for `issueNumber` until `work()` settles, then free it.
   * The single home for the cap-accounting invariant: a slot is held from the
   * moment the work starts until its promise settles, then deleted. A rejection is
   * logged under `errorEvent` and swallowed — the slot frees either way. Shared by
   * the build pool ({@link inFlight}) and the merge lease ({@link mergeInFlight}).
   */
  private occupy(
    set: Map<number, Promise<void>>,
    issueNumber: number,
    errorEvent: string,
    work: () => Promise<unknown>,
  ): void {
    const promise = work()
      .then(
        () => {},
        (err) => {
          this.deps.logger.error(errorEvent, { issue: issueNumber, error: String(err) });
        },
      )
      .finally(() => {
        set.delete(issueNumber);
      });
    set.set(issueNumber, promise);
  }

  /**
   * Service the single-concurrency integration flow: if the merge lease is free,
   * take the oldest `awaiting-merge` run (FIFO by `updated_at`) and run its
   * resolve+merge under the lease. The integrating run keeps status
   * `awaiting-merge` (the lease, not the status, marks "currently integrating"), so
   * a crash mid-integration re-picks it on restart. Idempotent and cheap when the
   * queue is empty or the lease is held; safe to call every tick and during drain.
   */
  serviceMergeWorker(): void {
    if (this.mergeInFlight.size > 0) {
      return; // single concurrency: one integration at a time (per repo).
    }
    // Exclude a run still occupying its build slot: a build run is marked
    // `awaiting-merge` *before* its slot frees (the status flips, then `addLabel`
    // and the worktree teardown still run under the slot). Leasing it now would
    // re-attach its worktree while the build executor is tearing the same path
    // down — the teardown then pulls the worktree out from under the live
    // integration. Waiting for `inFlight` to clear guarantees the clean handoff.
    const run = this.deps.store
      .listRunsByStatus("awaiting-merge")
      .find((r) => !this.mergeInFlight.has(r.issueNumber) && !this.inFlight.has(r.issueNumber));
    if (!run) {
      return;
    }
    this.occupy(this.mergeInFlight, run.issueNumber, "executor.integrate-failed", async () => {
      const target = await this.resolveRunTarget(run);
      // PR/issue concluded out-of-band (e.g. merged or closed by a human while the
      // run sat in the queue) — there is nothing to integrate; terminalize it.
      if (!target.live) {
        await this.deps.executor.discardOrphan(run, target.issue);
        return;
      }
      await this.deps.executor.integrate(run, target.issue, target.pr);
    });
  }

  /**
   * Service the off-slot pre-review CI gate (ADR-0022 stage 1) — a sibling of the
   * merge worker for the *pre-review* CI wait rather than the *pre-merge* one. For
   * each run parked `awaiting-ci`, take one lean `gh pr checks` read and, on a
   * terminal verdict (or once the wait exceeds the CI-timeout budget), re-admit the
   * run into review by occupying a build slot: green/none → review, red → the
   * existing CI-fix loop, timeout → the existing Phase 0 maxout. A still-pending run
   * under the timeout stays parked, consuming no slot — so the *wait* never costs
   * `maxConcurrentAgents` (read off-budget like the merge lease); only the
   * advancement into review takes a slot, gated on the build budget so a full pool
   * defers it to a later tick. Oldest park first (FIFO by `updated_at`). Safe to call
   * every tick; cheap and read-free when the queue is empty or the pool is full.
   */
  async serviceCiPoller(): Promise<void> {
    for (const run of this.deps.store.listRunsByStatus("awaiting-ci")) {
      // No build slot to advance into — leave every remaining park untouched (and
      // unread, to spare the rate limit) and retry next tick.
      if (!this.deps.budget.hasCapacity()) {
        return;
      }
      // Already advancing in the build pool (a prior tick's occupySlot, or the merge
      // lease holding the same issue) — never read or re-admit it twice.
      if (this.inFlight.has(run.issueNumber) || this.mergeInFlight.has(run.issueNumber)) {
        continue;
      }
      await this.pollCiRun(run);
    }
  }

  /**
   * Read one parked run's CI once and act on it. The PR/issue concluded out-of-band
   * (closed/merged by a human while parked) → discard it, exactly as the merge worker
   * does for its queue. A transient `gh` fault on the read → leave parked, retry next
   * tick. A terminal verdict (or a pending wait past the CI timeout) → occupy a build
   * slot and run the review continuation; a still-pending wait under the timeout →
   * stay parked.
   */
  private async pollCiRun(run: Run): Promise<void> {
    const { github } = this.deps;
    const target = await this.resolveRunTarget(run);
    if (!target.live) {
      await this.discardOrphanSafely(run, target.issue);
      return;
    }
    const { issue, pr } = target;
    let snapshot: ChecksSnapshot;
    try {
      snapshot = await github.readChecks(pr.number);
    } catch (err) {
      this.deps.logger.warn("ci-poll.read-failed", { issue: run.issueNumber, error: String(err) });
      return;
    }
    const verdict = this.ciVerdict(run, snapshot);
    if (!verdict) {
      return; // still pending, under the CI timeout — stay parked off-budget.
    }
    this.deps.logger.info("ci-poll.advance", { issue: run.issueNumber, prNumber: pr.number, state: verdict.state });
    this.occupySlot(run.issueNumber, "executor.ci-resume-failed", () =>
      this.deps.executor.resumeAfterCi(run, issue, pr, verdict),
    );
  }

  /**
   * Map a parked run's CI snapshot to the terminal verdict the review continuation
   * needs, or `null` to keep waiting. A terminal read (`green` / `none` / `red`)
   * passes straight through; a still-`pending` read becomes a `timeout` only once the
   * run has been parked beyond the CI-timeout budget (the *wait*, not a single read,
   * decides a timeout — `gh pr checks` never reports one), else `null`. Reuses the gh
   * `classifyChecks` verdict the snapshot carries — no new CI verdict logic.
   */
  private ciVerdict(run: Run, snapshot: ChecksSnapshot): ChecksResult | null {
    if (snapshot.state !== "pending") {
      return { state: snapshot.state, failures: snapshot.failures };
    }
    if (this.ciTimeoutMs > 0) {
      const parkedMs = this.now().getTime() - Date.parse(run.updatedAt);
      if (!Number.isNaN(parkedMs) && parkedMs > this.ciTimeoutMs) {
        return { state: "timeout", failures: snapshot.failures };
      }
    }
    return null;
  }

  /**
   * One reconcile pass: sweep liveness, resume answered pauses, fill open slots,
   * then surface anomalies. The sweep and the completeness pass run every tick
   * regardless of slot availability — liveness GC and the no-silent-loss invariant
   * are independent of whether there is room to launch new work.
   */
  async tick(): Promise<void> {
    // Service the single-concurrency merge worker first, independent of the build
    // pool and the sweep: it must keep draining the awaiting-merge queue even when
    // every build slot is full — review runs feed that queue. (Self-update and the
    // drain gate are owned by the orchestrator, which simply stops calling tick() and
    // pumps the merge worker itself while draining.)
    this.serviceMergeWorker();

    // Orphan / liveness GC first (issue #27 AC2) — independent of slot availability.
    try {
      await this.sweep();
    } catch (err) {
      this.deps.logger.error("reconcile.sweep-failed", { error: String(err) });
    }

    // Two-tier transcript retention (ADR-0030): periodically prune this repo's verbose
    // transcripts past the budget (oldest-first). Best-effort and paced, never on the
    // critical path — a failure is logged and swallowed; the domain timeline is permanent.
    this.tickCount += 1;
    await this.pruneTranscripts();

    // Resolve desired + actual state once for this tick, shared by fill and surface.
    const issues = await this.deps.github.listOpenIssues();
    // Fail loud on any `## Blocked by` section the gate cannot fully evaluate
    // (cross-repo refs, zero-parse sections) before anything acts on this tick's
    // issue set (issue #8).
    this.surfaceBlockedByAnomalies(issues);
    // One scan of the paused runs yields both the re-armed runs to resume and the
    // answered-but-stranded runs a rate-limited resume re-arm left wedged (#132). The
    // stranded set feeds the completeness pass, which both surfaces them as anomalies
    // and idempotently re-arms them (the retry-until-it-lands self-heal).
    const { resumable, strandedAnswered } = await scanPausedRuns(this.deps.github, this.deps.store);

    // Usage-limit gates: Claude's OAuth plan meter remains Claude-only, while endpoint
    // providers (currently z.ai) have a separate cooldown meter. Either gate pauses NEW
    // sessions — no resumes, no fill, no moding — so a transient cap never converts the
    // backlog to `agent-stuck` / `review-maxed`. In-flight runs and read-only surfacing
    // are unaffected; the gate self-heals when its cooldown clears.
    const claudeUsageGate =
      this.deps.usageMeter && this.deps.usageLimit?.enabled
        ? this.deps.usageMeter.gate(this.deps.usageLimit.admitBelowPercent)
        : { admit: true as const };
    const providerUsageGate =
      this.deps.providerUsageMeter && this.deps.usageLimit?.enabled
        ? this.deps.providerUsageMeter.gate(this.deps.usageLimit.admitBelowPercent)
        : { admit: true as const };
    const usageGate = claudeUsageGate.admit ? providerUsageGate : claudeUsageGate;
    if (!usageGate.admit) {
      this.deps.logger.warn("admission.usage-gated", {
        repo: this.deps.targetRepo,
        reason: usageGate.reason,
        detail: usageGate.detail,
        source: claudeUsageGate.admit ? "provider" : "claude",
      });
    }

    // Resume answered pauses first: an operator's answer re-arms a run, and the
    // same agent continues from its WIP branch (resume, not restart). Held back while
    // usage-gated — a resumed session would only hit the same limit and lose its
    // checkpoint; it waits for the cooldown to clear.
    if (usageGate.admit) {
      this.resumeAnswered(resumable);
      // Then advance runs whose parked pre-review CI wait has settled (ADR-0022 stage
      // 1), before fill so a CI-green review (work already begun) takes a freed slot
      // ahead of a fresh impl pickup. Awaited so the slots it consumes are reflected
      // in `budget.available()` below. Held back while usage-gated — the review
      // session it starts would only hit the same plan limit.
      await this.serviceCiPoller();
    }

    // Admission owns the whole pickup decision — the label gate, the in-flight /
    // active-run exclusions, the per-tick dependency cache, and the ordered fill of
    // the open slots. It also returns the full classification (the uncapped eligible
    // queue + resolved blocked exclusions) the backlog snapshot is projected from.
    // Run it every tick — even at the cap, where `openSlots` is 0 and `picked` is
    // empty — so the web control plane's view of what is *waiting* stays live and
    // never diverges from the real pickup decision (issue #20, ADR-0007: the daemon
    // already computes eligibility each tick, so read models need no GitHub of their own).
    const world: World = {
      isInFlight: (n) => this.inFlight.has(n),
      getRun: (n) => this.deps.store.getRunByIssue(n),
      isDependencySatisfied: (n) => this.deps.github.isDependencySatisfied(n),
      // Free slots come from the shared global budget (ADR-0020), read live after
      // resumes have consumed theirs — so two repos filling in the same tick can
      // never oversubscribe the operator's plan cap.
      // Zero slots while usage-gated: `admit` still runs (so the snapshot's waiting
      // queue stays live) but `picked` comes back empty — no new agents start.
      // Capped by this target's own agent budget (issue #27): a heavy repo is bounded
      // below the global cap so it cannot consume every slot and OOM the box.
      openSlots: usageGate.admit ? this.availableSlots() : 0,
      priorityLabels: this.deps.priorityLabels,
      // Re-resolve the impl route every tick (ADR-0037 P2.3): when no allowed provider
      // has a headroom account, admission excludes the otherwise-eligible queue with
      // `no-provider` — a wait, not a stuck (no escalation, no human-attention label) —
      // and the next tick re-resolves, admitting automatically once a pool recovers.
      // `admit` calls this lazily (only when something is eligible), so a quiet tick
      // never probes the meter; absent routing/routeWorld → always-headroom (tests).
      hasImplProviderHeadroom: () => this.hasImplProviderHeadroom(),
      // Box-wide OOM backstop (issue #27): when free RAM is under `minFreeMemoryMB`,
      // admission holds ALL new launches (`no-memory`, a wait not a stuck) — the global
      // cap counts agents but is blind to how much RAM a container will spike to. Probed
      // lazily (only when something is eligible); disabled when the floor is 0.
      hasMemoryHeadroom: () => this.hasMemoryHeadroom(),
      repo: this.deps.targetRepo,
    };
    const plan = await admit(issues, world);

    // No silent cap (issue #27): when the box-wide memory floor holds new launches, log
    // the withheld count + floor so the pause is visible in the daemon log — an operator
    // seeing zero pickups can tell "held for RAM" apart from "nothing eligible". A wait,
    // not a stuck: these issues keep `ready-for-agent` and re-admit once memory frees.
    const withheldForMemory = plan.excluded.filter((e) => e.reason === "no-memory");
    if (withheldForMemory.length > 0) {
      this.deps.logger.warn("admission.no-memory", {
        withheld: withheldForMemory.length,
        issues: withheldForMemory.map((e) => e.issue.number),
        minFreeMemoryMB: this.deps.minFreeMemoryMB,
      });
    }

    // Persist the backlog/health snapshot every tick — even at the cap, where no
    // open slots make `picked` empty — so live views stay current (issue #20).
    // `projectBacklog` resolves deps for admission's `no-mode` exclusions (which the
    // gate short-circuited) so a blocked-and-unmoded issue is shown as blocked, not as
    // a moding candidate (issue #113); reuses the same GitHub dependency port as admit.
    // When something is parked on the no-provider wait, stamp its reset ETA (ADR-0037 P3.2)
    // — resolved lazily so a tick with no such wait never probes the meter.
    const noProviderResetsAt = plan.excluded.some((e) => e.reason === "no-provider")
      ? this.deps.implProviderResetsAt?.() ?? null
      : null;
    this.persistSnapshot(
      await projectBacklog(
        issues,
        plan,
        this.deps.priorityLabels,
        (n) => this.deps.github.isDependencySatisfied(n),
        this.deps.targetRepo,
        noProviderResetsAt,
      ),
    );

    for (const candidate of plan.picked) {
      await this.launch(candidate);
    }

    // Auto-mode (CONTEXT: moding pass): a bounded, background pass that classifies the
    // issues the gate rejected solely for a missing `mode:*` label and applies it, so
    // they become eligible next tick. Launched fire-and-forget so it never blocks the
    // tick; an exact no-op when auto-mode is off. Skipped while usage-gated — its
    // classification is itself an SDK session that would only hit the same limit.
    if (usageGate.admit) {
      this.serviceModing(issues);
    }

    // Completeness invariant (issue #27 AC1): runs after fill/resume/sweep have
    // settled, so a just-picked-up or just-resumed issue reads as in-flight.
    try {
      await this.surfaceAnomalies(
        issues,
        new Set(resumable.map((r) => r.issue.number)),
        new Set(strandedAnswered.map((s) => s.issue.number)),
      );
    } catch (err) {
      this.deps.logger.error("reconcile.surface-anomalies-failed", { error: String(err) });
    }
  }

  /**
   * Write the per-tick backlog/health snapshot for the web control plane (issue #20).
   * A failure here must never break the tick — the snapshot is a read-model, rebuilt
   * next tick — so it is logged and swallowed.
   */
  private persistSnapshot(view: BacklogView): void {
    try {
      this.deps.store.saveBacklogSnapshot({
        generatedAt: this.now().toISOString(),
        targetRepo: this.deps.targetRepo,
        cap: this.deps.cap,
        reconcileIntervalSeconds: this.deps.reconcileIntervalSeconds,
        daemonStartedAt: this.daemonStartedAt,
        lastError: this.lastError,
        ...view,
      });
    } catch (err) {
      this.deps.logger.error("reconcile.snapshot-failed", { error: String(err) });
    }
  }

  /**
   * The orphan / liveness sweeper (issue #27 AC2, issue #61). A periodic GC over
   * every non-terminal run plus the tracked worktrees, remediating only the
   * slot-safe cases:
   *   - a `running` row the daemon isn't executing → reconcile (re-drive/terminate);
   *   - a non-terminal run whose issue closed under it → terminate + prune;
   *   - an in-flight run wedged past its lifetime ceiling (the per-session
   *     wall-clock failed to settle it) → actively terminate via the executor's
   *     abort handle ({@link terminateWedged}). Slot-safe because the slot frees
   *     through occupySlot's single owner once the killed session settles, never a
   *     second writer here;
   *   - a tracked worktree no live run/agent references → prune.
   * In healthy operation every `running` row is in flight and within its lifetime,
   * so the run loop is a no-op and only the worktree GC runs.
   */
  private async sweep(): Promise<void> {
    for (const run of this.deps.store.listRuns()) {
      if (!isNonTerminalStatus(run.status)) {
        continue; // terminal (merged / agent-stuck) — nothing to sweep.
      }
      if (this.inFlight.has(run.issueNumber)) {
        // In flight — the executor owns it. A healthy run is left to its executor.
        // A run wedged past its lifetime ceiling (the per-session wall-clock failed
        // to settle it) is actively terminated through the executor's abort handle
        // (issue #61): aborting its live session kills the session + its subprocess
        // tree, after which the run terminalizes to `agent-stuck`, its worktree is
        // pruned, and the slot frees through occupySlot's single owner — the
        // reconciler never writes the in-flight map here, so the "single home"
        // cap-accounting invariant holds. The completeness pass keeps surfacing it as
        // a `daemon-anomaly` until it settles terminal, then self-clears the label.
        if (this.isOverLifetime(run)) {
          this.terminateWedged(run);
        }
        continue;
      }
      if (run.status === "running") {
        await this.reconcileOrphanRunningRow(run);
      } else {
        // A paused run not in flight: terminate only if its issue closed under it
        // (no live progress, nothing to resume). An open paused issue waits for a
        // human answer — left for resume; the completeness pass flags it only if it
        // is genuinely unresumable / its label vanished.
        const issue = await this.deps.github.getIssue(run.issueNumber);
        if (!issue || issue.state !== "OPEN") {
          await this.discardOrphanSafely(run, issue);
        }
      }
    }
    await this.pruneOrphanWorktrees();
    // Container orphan sweep runs only in container mode — gated at the call site so the
    // in-process path adds no extra await to the tick.
    if (this.deps.containers) {
      await this.sweepOrphanContainers();
    }
  }

  /**
   * Kill any run container with no corresponding live run (ADR-0038's "kill containers with no
   * live run" pass) — the container analogue of {@link pruneOrphanWorktrees}. A daemon crash or a
   * lost run row mid-flight can leave a container running with nothing to reap it; this hands the
   * sweeper the branches of every non-terminal run so it can stop the strays. An exact no-op in
   * in-process mode (no {@link ReconcilerDeps.containers} port). Best-effort: a Docker failure is
   * logged and swallowed so it never wedges the tick — the next sweep retries.
   */
  private async sweepOrphanContainers(): Promise<void> {
    const { containers, store, logger } = this.deps;
    if (!containers) {
      return; // in-process mode — no containers to sweep.
    }
    const liveBranches = new Set<string>();
    for (const run of store.listRuns()) {
      if (run.branch && isNonTerminalStatus(run.status)) {
        liveBranches.add(run.branch);
      }
    }
    try {
      const killed = await containers.sweepOrphans(liveBranches);
      if (killed.length > 0) {
        logger.warn("sweep.orphan-containers-killed", { containers: killed });
      }
    } catch (err) {
      logger.error("sweep.orphan-containers-failed", { error: String(err) });
    }
  }

  /**
   * Actively terminate an in-flight run wedged past its lifetime ceiling (issue
   * #61). Ask the executor — the single owner of the run's session-kill handle — to
   * abort the run's live session; the slot then frees through occupySlot's single
   * `.finally` once the aborted session settles, so the reconciler never writes the
   * in-flight map and the "single home" cap-accounting invariant holds. Idempotent
   * across ticks: while the abort is settling the run is still in flight and over
   * lifetime, so a re-entrant sweep re-issues a harmless abort on the already-aborted
   * controller (and `terminate` returns `false` once the session has settled out).
   */
  private terminateWedged(run: Run): void {
    const terminated = this.deps.executor.terminate(run.id);
    this.deps.logger.warn("sweep.wedged-run-terminated", {
      issue: run.issueNumber,
      runId: run.id,
      terminated,
    });
    this.deps.store.appendLog({
      runId: run.id,
      issueNumber: run.issueNumber,
      level: "warn",
      event: "wedged-run-terminated",
      data: { terminated },
    });
  }

  /**
   * Whether `maxRunLifetimeMs` has elapsed since a run's row last advanced — the
   * in-flight run is wedged (the per-session wall-clock failed to settle it). Drives
   * both the sweep's active termination ({@link terminateWedged}, issue #61) and the
   * completeness pass's `daemon-anomaly` surfacing. `<= 0` disables the backstop.
   */
  private isOverLifetime(run: Run): boolean {
    if (this.maxRunLifetimeMs <= 0) {
      return false;
    }
    const updated = Date.parse(run.updatedAt);
    return !Number.isNaN(updated) && this.now().getTime() - updated > this.maxRunLifetimeMs;
  }

  /**
   * Prune tracked worktrees no live run or agent references — a worktree left
   * behind by a crash or an interrupted teardown (issue #27 AC2). A worktree is
   * "live" iff an active agent or an in-flight non-terminal run points at it.
   */
  private async pruneOrphanWorktrees(): Promise<void> {
    const { store, worktrees, logger } = this.deps;
    let tracked: string[];
    try {
      tracked = await worktrees.list();
    } catch (err) {
      logger.warn("sweep.worktree-list-failed", { error: String(err) });
      return;
    }
    if (tracked.length === 0) {
      return;
    }
    const referenced = new Set<string>();
    for (const agent of store.listActiveAgents()) {
      referenced.add(resolve(agent.worktreePath));
    }
    for (const run of store.listRuns()) {
      if (isNonTerminalStatus(run.status) && run.worktreePath && this.inFlight.has(run.issueNumber)) {
        referenced.add(resolve(run.worktreePath));
      }
    }
    for (const path of tracked) {
      if (referenced.has(resolve(path))) {
        continue;
      }
      try {
        await worktrees.remove(path);
        logger.warn("sweep.orphan-worktree-pruned", { worktree: path });
        store.appendLog({ level: "warn", event: "orphan-worktree-pruned", data: { worktree: path } });
      } catch (err) {
        logger.warn("sweep.worktree-prune-failed", { worktree: path, error: String(err) });
      }
    }
  }

  /**
   * The completeness invariant (issue #27 AC1). Classify every open issue and
   * every non-terminal run row into exactly one of {eligible, in-flight,
   * awaiting-human, terminal}; surface anything unclassifiable or contradictory as
   * a `daemon-anomaly` label + a structured log, and clear the label once an issue
   * is no longer anomalous. Runs after fill/resume/sweep have settled, so a just
   * picked-up or just-resumed issue reads as in-flight.
   */
  private async surfaceAnomalies(
    issues: Issue[],
    resumable: Set<number>,
    answeredParked: Set<number>,
  ): Promise<void> {
    const { store, github } = this.deps;
    // Snapshot the in-flight set *before* the first `await`, the moment the pass
    // begins after fill/resume have launched. An executor that settles mid-pass (its
    // `then/finally` frees the slot on a microtask the `await`s below yield to) must
    // still read as in-flight here — it was being worked this tick; the next tick
    // re-derives. Classifying against a moving `this.inFlight` would flag a
    // just-launched `running` row as an orphan island.
    const inFlight = new Set(this.inFlight.keys());
    const depSatisfied = await this.resolveDeps(issues);
    const classified = new Set<number>();

    for (const issue of issues) {
      classified.add(issue.number);
      const run = store.getRunByIssue(issue.number);
      const isInFlight = inFlight.has(issue.number);
      // Deliver the daemon-set state-label effect (issue #82, ADR-0027): diff the
      // projection's desired label against the actual GitHub labels and apply the
      // difference idempotently. A failed write retries next tick; a label dropped
      // off-projection is reconciled next tick — the reconciler is the single writer.
      // Only when a run backs the projection: a state label with *no run* is the
      // `paused-label-missing-run` island (rehydrate could not rebuild the run), which
      // the diff must neither strip nor mask — it stays for the completeness pass below.
      let effectiveLabels: string[] = issue.labels;
      if (run) {
        const desired = desiredStateLabel(run.status, issue.labels);
        await this.reconcileStateLabel(issue.number, issue.labels, desired);
        // Classify against the *post-diff* labels (the projection's desired set), so the
        // ≤1-tick effect latency can never trip a false `daemon-anomaly` island —
        // reconciling ADR-0027's accepted latency with the ADR-0016 invariant.
        effectiveLabels = overlayStateLabels(issue.labels, desired);
      }
      const snapshot: IssueSnapshot = {
        issueNumber: issue.number,
        issueState: issue.state,
        labels: effectiveLabels,
        runStatus: run?.status ?? null,
        inFlight: isInFlight,
        wedged: isInFlight && run != null && this.isOverLifetime(run),
        gateEligible: this.isGateEligible({ ...issue, labels: effectiveLabels }, depSatisfied),
        resumable: resumable.has(issue.number),
        answered: answeredParked.has(issue.number),
      };
      await this.reconcileAnomalyLabel(issue.number, effectiveLabels, classifyIssueState(snapshot), run ?? null);
      // Self-heal the #132 wedge in the same pass that surfaces it: an answered pause
      // never re-armed to `ready-for-agent` (a rate-limited resume re-arm). Re-add the
      // intake label idempotently so `scanPausedRuns` resumes it next tick; the
      // `daemon-anomaly` above keeps it visible until the re-arm lands. A still-failing
      // write is simply retried on the next tick — retry-until-it-lands (#132 AC1).
      if (run && answeredParked.has(issue.number)) {
        await this.reArmAnsweredPause(issue.number, run);
      }
    }

    // Every run whose issue is NOT in the open set: a `running` / paused run whose
    // issue closed or vanished under it (the named contradiction), plus an
    // `agent-stuck` run whose issue later resolved out-of-band. The non-terminal
    // contradiction surfaces as an anomaly the sweep terminates; the `agent-stuck`
    // close-out is a span close (issue #274): a human merged a separate PR or closed
    // the issue directly, bypassing the daemon's re-admit-and-merge flow, so the
    // stuck run's never-closed span is pinned at `agent-stuck` and surfaces forever
    // in the web HITL queue until this closes it. (`merged` / `closed` rows are
    // span-closed already — `isSpanClosed` skips them here; only `agent-stuck`,
    // span-OPEN, needs the out-of-band close — that span-closed/span-OPEN split is
    // the crux of #274.)
    for (const run of store.listRuns()) {
      if (classified.has(run.issueNumber) || isSpanClosed(run.status)) {
        continue;
      }
      const issue = await github.getIssue(run.issueNumber);
      if (issue && issue.state === "OPEN") {
        continue; // a race (the issue reappeared open) — the open-issue loop owns it.
      }
      // An `agent-stuck` run whose issue concluded out-of-band: `RunStuck` does not
      // close its span, so close it now as the effect-neutral `closed` terminal (issue
      // #274). The projected status flips off `agent-stuck`, dropping the row from the
      // web HITL queue; a stale `daemon-anomaly` (if any) self-clears via the reconcile
      // below. Idempotent — the next tick reads `closed` and skips this run.
      if (run.status === "agent-stuck") {
        await this.closeOutStuckRunSafely(run);
      }
      const isInFlight = inFlight.has(run.issueNumber);
      const snapshot: IssueSnapshot = {
        issueNumber: run.issueNumber,
        issueState: issue ? issue.state : "gone",
        labels: issue?.labels ?? [],
        runStatus: run.status,
        inFlight: isInFlight,
        wedged: isInFlight && this.isOverLifetime(run),
        gateEligible: false,
        resumable: false,
        // A closed/gone issue is terminal under the run, never an answered-but-parked
        // wedge (#132 only strands an OPEN paused issue) — the open-issue loop owns that.
        answered: false,
      };
      await this.reconcileAnomalyLabel(run.issueNumber, issue?.labels ?? [], classifyIssueState(snapshot), run);
    }
  }

  /**
   * Whether the issue would pass the eligibility gate — ignoring the daemon's own
   * `daemon-anomaly` marker. The gate excludes `daemon-anomaly` (it is one of the
   * {@link PAUSED_LABELS}, issue #28), but for the completeness invariant that label
   * is the daemon's *output*, not an input: an otherwise-eligible issue still
   * carrying a stale `daemon-anomaly` must read as `eligible` so the pass clears the
   * marker and the next fill re-admits it (the ADR-0016 self-heal). This is the one
   * place the marker is held out of the gate.
   */
  private isGateEligible(issue: Issue, depSatisfied: (n: number) => boolean): boolean {
    if (!issue.labels.includes(LABEL_DAEMON_ANOMALY)) {
      return evaluateGate(issue, depSatisfied, this.deps.targetRepo).eligible;
    }
    const withoutMarker = { ...issue, labels: issue.labels.filter((l) => l !== LABEL_DAEMON_ANOMALY) };
    return evaluateGate(withoutMarker, depSatisfied, this.deps.targetRepo).eligible;
  }

  /**
   * Whether a fresh impl launch can resolve a route right now (ADR-0037 P2.3) — the
   * per-tick verdict admission folds in as the `no-provider` wait. Re-resolves the impl
   * route through the live routing + the per-provider headroom port: a `{ wait:
   * "no-provider" }` (every allowed pool gated) means no headroom, so the
   * otherwise-eligible queue waits (kept `ready-for-agent`, no human-attention label) and
   * is re-resolved next tick. With routing/routeWorld unwired (tests / a
   * routing-agnostic setup) there is always headroom — the no-provider path is inert.
   */
  private hasImplProviderHeadroom(): boolean {
    const { routing, routeWorld } = this.deps;
    if (!routing || !routeWorld) {
      return true;
    }
    return !("wait" in resolveRoute(routing(), this.deps.targetRepo, "impl", routeWorld));
  }

  /**
   * Open build slots for this target this tick: the global free budget (ADR-0020),
   * capped by this target's own agent ceiling (issue #27) so a memory-heavy repo can be
   * bounded well below the global cap while light targets keep the higher one. The
   * per-target remaining is `maxAgentsThisTarget − this target's in-flight build runs`
   * (floored at 0); absent → only the global budget applies. `admit` slices the ordered
   * queue to this, so the count is authoritative for both launches and the read model.
   */
  private availableSlots(): number {
    const global = this.deps.budget.available();
    const perTarget = this.deps.maxAgentsThisTarget;
    if (perTarget === undefined) {
      return global;
    }
    return Math.max(0, Math.min(global, perTarget - this.inFlight.size));
  }

  /**
   * Whether the box has enough free RAM to launch another agent container this tick — the
   * per-tick verdict admission folds in as the `no-memory` wait (issue #27). Reads the live
   * free-memory probe against `scheduler.minFreeMemoryMB`; a floor of 0 (or an unset probe)
   * disables the gate → always-headroom, exactly the pre-#27 behaviour. Called lazily by
   * `admit` (only when something is eligible), so a quiet tick never reads free memory.
   */
  private hasMemoryHeadroom(): boolean {
    const floorMB = this.deps.minFreeMemoryMB ?? 0;
    if (floorMB <= 0) {
      return true;
    }
    const freeBytes = (this.deps.freeMemoryBytes ?? osFreemem)();
    return freeBytes >= floorMB * 1024 * 1024;
  }

  /** Resolve every distinct `## Blocked by` dependency once for the completeness pass. */
  private async resolveDeps(issues: Issue[]): Promise<(n: number) => boolean> {
    const cache = new Map<number, boolean>();
    for (const issue of issues) {
      for (const dep of parseBlockedBy(issue.body, this.deps.targetRepo).refs) {
        if (!cache.has(dep)) {
          cache.set(dep, await this.deps.github.isDependencySatisfied(dep));
        }
      }
    }
    return (n: number): boolean => cache.get(n) ?? false;
  }

  /**
   * Surface every `## Blocked by` section the gate cannot fully evaluate (issue #8):
   * a cross-repo ref gates the issue closed (an unsatisfiable blocker in `admit` /
   * `evaluateGate`) and is warned here, and a section whose non-empty list items
   * yielded zero refs is warned — the original silent failure, where dependency
   * chains written as markdown links parsed as `[]` and launched concurrently.
   * Logged every tick while the body stays wrong, like `dependency.query-failed`:
   * fail loud until a human fixes the section.
   */
  private surfaceBlockedByAnomalies(issues: Issue[]): void {
    for (const issue of issues) {
      const parsed = parseBlockedBy(issue.body, this.deps.targetRepo);
      if (parsed.crossRepo.length > 0) {
        this.deps.logger.warn("blocked-by.cross-repo-ref", {
          repo: this.deps.targetRepo,
          issue: issue.number,
          refs: parsed.crossRepo,
        });
      }
      if (parsed.refs.length === 0 && parsed.crossRepo.length === 0 && parsed.unparsed.length > 0) {
        this.deps.logger.warn("blocked-by.no-refs-parsed", {
          repo: this.deps.targetRepo,
          issue: issue.number,
          items: parsed.unparsed,
        });
      }
    }
  }

  /**
   * Deliver the daemon-set state-label effect for one open issue (issue #82,
   * ADR-0027): reconcile the four {@link STATE_EFFECT_LABELS} so that exactly the
   * projection's `desired` one is present and the other three are absent. Idempotent
   * and self-healing — an already-correct set is a no-op, a label dropped/added
   * off-projection is reconciled here, and a failed write simply retries next tick.
   * Only ever touches the four relocated labels; intake, `daemon-anomaly`, and
   * `awaiting-ci` pass through untouched. A failed write is logged and swallowed so a
   * label glitch never breaks the completeness pass.
   */
  private async reconcileStateLabel(
    issueNumber: number,
    labels: readonly string[],
    desired: string | null,
  ): Promise<void> {
    const { github, logger } = this.deps;
    for (const label of STATE_EFFECT_LABELS) {
      const present = labels.includes(label);
      try {
        if (label === desired && !present) {
          await github.addLabel(issueNumber, label);
        } else if (label !== desired && present) {
          await github.removeLabel(issueNumber, label);
        }
      } catch (err) {
        logger.warn("daemon.state-label-failed", { issue: issueNumber, label, error: String(err) });
      }
    }
  }

  /**
   * Apply or clear the `daemon-anomaly` label to match a classification. On the
   * first tick an issue is anomalous, add the label + emit the structured anomaly
   * (log line and run-log row); while it persists the label is the continuous
   * signal, so the edge is logged once, not every tick. When the issue is no longer
   * anomalous, clear the label *only* once it has moved on — it is being worked, is
   * eligible again, or is terminal, or another human-attention label now carries it
   * (the daemon self-heals — the sweep terminated the orphan, or an operator fixed
   * the state). A still-awaiting-human issue whose only visible surface is
   * `daemon-anomaly` keeps it: that is a deliberately-parked claim anomaly
   * (issue #28), not a stale marker to strip.
   */
  private async reconcileAnomalyLabel(
    issueNumber: number,
    labels: string[],
    classification: Classification,
    run: Run | null,
  ): Promise<void> {
    const { store, github, logger } = this.deps;
    const hasLabel = labels.includes(LABEL_DAEMON_ANOMALY);

    if (classification.kind === "anomaly") {
      if (hasLabel) {
        return; // already surfaced; the label persists as the standing signal.
      }
      try {
        await github.addLabel(issueNumber, LABEL_DAEMON_ANOMALY, LABEL_DAEMON_ANOMALY_CREATE);
      } catch (err) {
        logger.error("daemon.anomaly-label-failed", { issue: issueNumber, error: String(err) });
      }
      logger.warn("daemon.anomaly", {
        issue: issueNumber,
        reason: classification.reason,
        runStatus: run?.status ?? null,
      });
      await store.recordAnomalyDetected({ issueNumber, reason: classification.reason });
      store.appendLog({
        runId: run?.id ?? null,
        issueNumber,
        level: "warn",
        event: "daemon-anomaly",
        data: { reason: classification.reason, runStatus: run?.status ?? null },
      });
      return;
    }

    if (hasLabel && this.shouldClearAnomaly(classification, labels)) {
      try {
        await github.removeLabel(issueNumber, LABEL_DAEMON_ANOMALY);
      } catch (err) {
        logger.warn("daemon.anomaly-clear-failed", { issue: issueNumber, error: String(err) });
      }
      logger.info("daemon.anomaly-cleared", { issue: issueNumber, class: classification.kind });
      await store.recordAnomalyCleared({ issueNumber });
      store.appendLog({
        runId: run?.id ?? null,
        issueNumber,
        level: "info",
        event: "daemon-anomaly-cleared",
        data: { class: classification.kind },
      });
    }
  }

  /**
   * Whether a stale `daemon-anomaly` should be cleared now the issue is no longer
   * an anomaly. Clear it once the issue has moved on (eligible / in-flight /
   * terminal); when it is still `awaiting-human`, clear only if another
   * human-attention label carries it — otherwise `daemon-anomaly` is the sole
   * surface (a deliberately-parked claim anomaly, issue #28) and must stay.
   */
  private shouldClearAnomaly(classification: Classification, labels: string[]): boolean {
    if (classification.kind !== "awaiting-human") {
      return true;
    }
    return labels.some((l) => OTHER_ATTENTION_LABELS.includes(l));
  }

  /**
   * Re-arm an answered pause a failed resume re-arm left stranded (#132). A rate-limited
   * `deferResume` can leave an answered run at `awaiting-answer` with no `ready-for-agent`
   * — invisible to `ralph-answer` (already-answered) and to resume (no `ready-for-agent`).
   * Idempotently re-add `ready-for-agent` so {@link scanPausedRuns} resumes it next tick;
   * a still-failing write is simply retried on the next tick (the completeness pass keeps
   * surfacing it as `daemon-anomaly` meanwhile, so it is never silent). Best-effort: a
   * failed write is logged and swallowed so one rate-limited re-arm never breaks the pass.
   */
  private async reArmAnsweredPause(issueNumber: number, run: Run): Promise<void> {
    const { github, store, logger } = this.deps;
    try {
      await github.addLabel(issueNumber, LABEL_READY);
      logger.warn("resume.stranded-answer-rearmed", { issue: issueNumber, status: run.status });
      store.appendLog({
        runId: run.id,
        issueNumber,
        level: "warn",
        event: "stranded-answer-rearmed",
        data: { status: run.status },
      });
    } catch (err) {
      logger.warn("resume.stranded-answer-rearm-failed", { issue: issueNumber, error: String(err) });
    }
  }

  /** Resume the answered, re-armed paused runs in `resumable`, up to the cap. */
  private resumeAnswered(resumable: ResumableRun[]): void {
    for (const item of resumable) {
      if (!this.deps.budget.hasCapacity()) {
        return;
      }
      if (this.inFlight.has(item.issue.number)) {
        continue;
      }
      this.launchResume(item);
    }
  }

  /** Resume a re-armed run in the background, occupying a slot until it settles. */
  private launchResume(item: ResumableRun): void {
    this.occupySlot(item.issue.number, "executor.resume-failed", () =>
      this.deps.executor.resume({
        issue: item.issue,
        mode: item.run.mode,
        run: item.run,
        answer: item.answer,
        context: item.context,
      }),
    );
  }

  /**
   * Claim an issue (awaited, so the pickup — run record + label removal — is
   * done before the tick returns) and run its agent session in the background.
   * The slot is occupied until the agent session settles.
   *
   * A claim failure is counted, not silently retried forever: after
   * `maxClaimFailures` consecutive failures the issue is surfaced as a
   * `daemon-anomaly` so it stops being re-selected and stops starving the
   * scheduler (issue #28, AC3). A success clears the count.
   */
  private async launch(candidate: PickedIssue): Promise<void> {
    const issueNumber = candidate.issue.number;
    let claimed;
    try {
      claimed = await this.deps.executor.claim(candidate);
    } catch (err) {
      await this.recordClaimFailure(candidate, err);
      return;
    }
    this.claimFailures.delete(issueNumber);
    this.occupySlot(issueNumber, "executor.failed", () => this.deps.executor.execute(claimed, candidate));
  }

  /**
   * Tally a failed claim and, at the budget, surface the issue for a human
   * instead of looping every tick (issue #28, AC3).
   */
  private async recordClaimFailure(candidate: PickedIssue, err: unknown): Promise<void> {
    const issueNumber = candidate.issue.number;
    const failures = (this.claimFailures.get(issueNumber) ?? 0) + 1;
    this.claimFailures.set(issueNumber, failures);
    const budget = this.deps.maxClaimFailures ?? DEFAULT_MAX_CLAIM_FAILURES;
    this.deps.logger.error("executor.claim-failed", {
      issue: issueNumber,
      attempt: failures,
      budget,
      error: String(err),
    });
    if (failures >= budget) {
      await this.deps.executor.surfaceClaimAnomaly(candidate, failures, String(err));
      this.claimFailures.delete(issueNumber);
    }
  }

  /**
   * The auto-mode moding pass (CONTEXT: moding pass). When enabled, select up to
   * `maxPerTick` issues the gate rejects *solely* for a missing `mode:*` label and
   * classify each in the background, applying the chosen label so it becomes eligible
   * next tick. An exact no-op when auto-mode is off or no classifier is wired.
   *
   * Bounded two ways: `maxPerTick` caps the *concurrent* classifications (a session
   * spanning ticks still holds its slot, so a slow backlog can't stampede the SDK),
   * and {@link selectModingCandidates} caps the per-tick selection. Off the build pool
   * (like the merge lease): triage does not consume the operator's plan cap. Launched
   * fire-and-forget — the candidate selection touches GitHub for deps, so it must not
   * block the tick — with every failure logged, never surfaced as a `daemon-anomaly`
   * (no-silent-loss: an unclassifiable issue stays a plainly-visible unmoded issue).
   */
  private serviceModing(issues: Issue[]): void {
    const autoMode = this.deps.autoMode;
    const classifier = this.deps.modeClassifier;
    if (!autoMode?.enabled || !classifier) {
      return;
    }
    const budget = autoMode.maxPerTick - this.modingInFlight.size;
    if (budget <= 0) {
      return; // every classification slot is occupied by an in-flight session.
    }
    this.modingPass = this.runModingPass(issues, classifier, budget);
  }

  /** Await the in-flight moding pass and every classification it has launched (drain/tests). */
  async awaitModing(): Promise<void> {
    await this.awaitModingLaunched();
    await Promise.all([...this.modingInFlight.values()]);
  }

  /** Await only the moding pass's select-and-launch chain, not the classifications it started. */
  async awaitModingLaunched(): Promise<void> {
    await this.modingPass;
  }

  /** Select moding candidates (bounded) and launch a background classification for each. */
  private async runModingPass(issues: Issue[], classifier: ModeClassifier, budget: number): Promise<void> {
    // Exclude issues already being classified so the selection budget is spent only on
    // fresh work — an in-flight issue would otherwise consume a candidate slot and then
    // be skipped below, starving a waiting issue of this tick's budget.
    const available = issues.filter((issue) => !this.modingInFlight.has(issue.number));
    let candidates: Issue[];
    try {
      candidates = await selectModingCandidates(
        available,
        (n) => this.deps.github.isDependencySatisfied(n),
        budget,
        this.deps.targetRepo,
      );
    } catch (err) {
      this.deps.logger.error("moding.select-failed", { error: String(err) });
      return;
    }
    for (const issue of candidates) {
      // Re-check the cap and the per-issue guard: selection ran async, so a concurrent
      // pass may have filled the slot or already claimed this issue in the meantime.
      if (this.modingInFlight.size >= (this.deps.autoMode?.maxPerTick ?? 0)) {
        break;
      }
      if (this.modingInFlight.has(issue.number)) {
        continue;
      }
      this.startModing(issue, classifier);
    }
  }

  /**
   * Prune this repo's verbose transcripts past the retention budget (ADR-0030), paced to
   * `transcriptRetention.everyTicks` so the grouped scan does not run every 30s. No-op
   * when retention is unconfigured. Best-effort: a prune failure is logged and swallowed
   * (the verbose tier is rebuildable-by-recapture; the domain timeline is never touched).
   */
  private async pruneTranscripts(): Promise<void> {
    const retention = this.deps.transcriptRetention;
    if (!retention || this.tickCount % retention.everyTicks !== 0) {
      return;
    }
    try {
      const { pruned } = await this.deps.store.pruneTranscripts(retention.budget, this.now());
      if (pruned.length > 0) {
        this.deps.logger.info("transcript.pruned", { repo: this.deps.targetRepo, count: pruned.length });
      }
    } catch (err) {
      this.deps.logger.error("transcript.prune-failed", { error: String(err) });
    }
  }

  /** Classify one issue in the background, holding a moding slot until it settles. */
  private startModing(issue: Issue, classifier: ModeClassifier): void {
    const log = this.deps.logger.child({ issue: issue.number });
    const work = this.classifyAndLabel(issue, classifier, log)
      .catch((err) => log.error("moding.failed", { error: String(err) }))
      .finally(() => {
        this.modingInFlight.delete(issue.number);
      });
    this.modingInFlight.set(issue.number, work);
  }

  /**
   * Classify one unmoded issue and apply the resulting `mode:*` label. A `null`
   * verdict (the classifier could not decide — already logged) leaves the issue
   * unmoded: it is plainly visible on GitHub and re-tried a later tick, never
   * guess-labelled and never surfaced as an anomaly.
   */
  private async classifyAndLabel(issue: Issue, classifier: ModeClassifier, log: Logger): Promise<void> {
    // The moding pass has no run row, so its transcript captures on the synthetic
    // per-issue stream `transcript:<repo>#<issue>:moding` (ADR-0030) — uniform capture
    // across impl/resume/review/fix/moding, all through the one session chokepoint.
    const transcriptSink = createRunTranscriptSink(this.deps.store, issue.number, MODING_RUN_ID, log);
    const decision = await classifier.classify({ issue, logger: log, transcriptSink });
    if (!decision) {
      return; // could not decide — leave unmoded (logged by the classifier).
    }
    await this.deps.github.addLabel(issue.number, modeLabelFor(decision.mode));
    log.info("moding.applied", { mode: decision.mode, reason: decision.reason });
    this.deps.store.appendLog({
      issueNumber: issue.number,
      level: "info",
      event: "auto-moded",
      data: { mode: decision.mode, reason: decision.reason },
    });
  }
}
