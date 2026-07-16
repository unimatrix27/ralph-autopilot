/**
 * Read-only projection of the SQLite runtime store into the model the web control
 * plane's read API serializes (DESIGN §7, ADR-0029). Pure with respect to the
 * store: it only *reads* — no writes, and crucially no GitHub access. The Ink TUI
 * that used to render this is retired (#120); this projection is the part it
 * shared, and is now the web read edge's sole model. Because agents write phase
 * transitions to SQLite as they happen, they surface live between the 30s
 * reconcile ticks.
 */

import type { Store } from "../store/store";
import type {
  BacklogBlocked,
  BacklogEligible,
  BacklogManualHold,
  BacklogModingCandidate,
  BacklogNoProvider,
  BacklogPaused,
  DaemonError,
  OpenQuestion,
  PhaseRoute,
} from "../store/types";
import { decodeAgentPhase, phaseLabel, reviewPhaseNumber } from "../review/phase";

/** An in-flight agent as the fleet summary shows it. */
export interface AgentView {
  /** The target repo slug the run belongs to (aggregate-first; the web filter narrows on it). */
  repo: string;
  issueNumber: number;
  /**
   * The GitHub issue title, captured on the run row at dispatch (issue #13), so the fleet
   * view heads each agent with *which* issue it is. `null` for a run predating the column —
   * the view falls back to the `repo #issue` reference.
   */
  title: string | null;
  /** Display phase: `impl`, `review-1`, `fix-1`, `review-2`, `fix-2`, … */
  phase: string;
  /** Live fix-attempt count for the current review phase (0 in impl). */
  fixAttempt: number;
  /**
   * ISO instant the *current* phase's fresh SDK session started — the absolute
   * anchor a live elapsed timer counts from (falls back to the run start for rows
   * predating the phase clock). The web resolves this client-side against a
   * render-time `now`, so the shared shape never carries a frozen duration
   * (ADR-0031).
   */
  phaseStartedAt: string;
  /**
   * The route the live phase's container was dispatched on (ADR-0037 P3.1, issue #164): its
   * `{ provider, model, account }` (account id only), folded from the run's latest `RouteResolved`
   * fact. `null` when none was recorded — a box-default dispatch or a run predating the recording.
   */
  route: PhaseRoute | null;
}

/** One row in the awaiting-answer / review-maxed / agent-stuck / CI / merge queue. */
export interface QueueItem {
  /** The target repo slug the run belongs to. */
  repo: string;
  issueNumber: number;
  /** Headline of the open question/heal-card, when one is indexed (empty for queues with no question). */
  headline: string;
  /** When the run last changed (entered this state). */
  since: string;
}

/** A recent notable run-log event for the outcomes panel. */
export interface OutcomeView {
  runId: number | null;
  /** The target repo slug, or null for a daemon-global log entry written before a run was scoped. */
  repo: string | null;
  issueNumber: number | null;
  level: string;
  event: string;
  data: Record<string, unknown> | null;
  ts: string;
}

/**
 * Daemon-health readout, derived from the persisted per-tick snapshot. Every instant
 * is **absolute** (ISO-8601), emitted straight from the snapshot — the web Health view
 * computes its own relative durations against a render-time `now`, so the shared shape
 * never carries a value frozen at projection time (ADR-0031).
 */
export interface DaemonHealthView {
  targetRepo: string;
  /** Concurrency cap (`maxConcurrentAgents`). */
  cap: number;
  /** ISO-8601 instant the daemon process started (earliest across repos). */
  startedAt: string;
  /** ISO-8601 instant of the most recent reconcile tick (freshest across repos). */
  lastTickAt: string;
  /** ISO-8601 instant the next tick is due; clamped to `now` when overdue. */
  nextTickAt: string;
  /** The last tick is older than ~2 intervals — the daemon may be down/stalled. */
  stale: boolean;
  lastError: DaemonError | null;
}

/**
 * The aggregate backlog the web read-model consumes: every item is tagged with the
 * repo it came from, since {@link buildSnapshot}'s `tagRepo` always attaches it when
 * it flattens each repo's per-tick snapshot. (The persisted per-repo `BacklogView`
 * is repo-less — its snapshot row already knows `targetRepo`.)
 */
export interface RuntimeBacklog {
  eligible: (BacklogEligible & { repo: string })[];
  blocked: (BacklogBlocked & { repo: string })[];
  paused: (BacklogPaused & { repo: string })[];
  manualHolds: (BacklogManualHold & { repo: string })[];
  modingCandidates: (BacklogModingCandidate & { repo: string })[];
  /** Eligible issues parked on the ADR-0037 no-provider wait, each carrying its reset ETA. */
  noProvider: (BacklogNoProvider & { repo: string })[];
}

/** The full runtime model the web read API serializes on each poll / live push. */
export interface RuntimeSnapshot {
  runningAgents: AgentView[];
  /** The backlog (eligible / blocked / paused / moding candidates), aggregated across repos with each item repo-tagged. */
  backlog: RuntimeBacklog;
  awaitingAnswer: QueueItem[];
  reviewMaxed: QueueItem[];
  /** Terminal runs that self-stopped on the effort budget (`agent-stuck`) — a human-attention state. */
  agentStuck: QueueItem[];
  /** Runs parked on the off-slot pre-review CI gate (ADR-0022 stage 1) — a live wait. */
  awaitingCi: QueueItem[];
  /** Runs that passed review and are queued for the single-concurrency merge flow. */
  awaitingMerge: QueueItem[];
  recentOutcomes: OutcomeView[];
  /** Daemon health, or `null` before the daemon's first tick wrote a snapshot. */
  daemon: DaemonHealthView | null;
}

/**
 * Run-log events that count as "outcomes" — terminal or milestone moments worth
 * surfacing in the recent-outcomes panel (as opposed to chatter like
 * `review-worklist`).
 */
export const OUTCOME_EVENTS: ReadonlySet<string> = new Set([
  "pr-opened",
  "review-maxed",
  "escalated",
  "agent-stuck",
  "awaiting-ci",
  "awaiting-merge",
  "merged",
  // The completeness invariant (issue #27): a surfaced island and the sweeper's
  // worktree GC are outcomes an operator should see in the dashboard.
  "daemon-anomaly",
  "orphan-worktree-pruned",
]);

export interface SnapshotOptions {
  /** Injected clock for the deterministic stale / overdue-clamp computation in tests. */
  now?: () => Date;
  /** How many recent outcomes to surface (default 10). */
  outcomeLimit?: number;
}

/**
 * Project the current store state into the runtime model, AGGREGATED across every
 * target repo (ADR-0020). Running agents, queues, and outcomes are global lists
 * (keyed by globally-unique run/agent ids), the backlog concatenates every repo's
 * per-tick snapshot, and the health header summarises all repos (the shared cap, the
 * earliest start, the freshest tick, any repo's error). Read-only.
 */
export function buildSnapshot(store: Store, options: SnapshotOptions = {}): RuntimeSnapshot {
  const now = options.now ?? (() => new Date());
  const outcomeLimit = options.outcomeLimit ?? 10;
  const nowMs = now().getTime();

  const allRuns = store.listAllRuns();
  const runById = new Map(allRuns.map((run) => [run.id, run]));

  // First open question per run keys the queue headlines.
  const questionByRun = new Map<number, OpenQuestion>();
  for (const q of store.listAllOpenQuestions()) {
    if (q.runId != null && !questionByRun.has(q.runId)) {
      questionByRun.set(q.runId, q);
    }
  }

  const runningAgents: AgentView[] = store.listActiveAgents().map((agent) => {
    const run = runById.get(agent.runId);
    // Decode the stored phase label through the typed union (no regex) — the same
    // vocabulary the review loop encodes with, so the two can't drift.
    const phase = decodeAgentPhase(agent.phase);
    const phaseNum = reviewPhaseNumber(phase);
    // The phase clock falls back to the run start for rows predating the column.
    const phaseStart = agent.phaseStartedAt ?? agent.startedAt;
    return {
      repo: run?.repo ?? "",
      issueNumber: run?.issueNumber ?? 0,
      // The issue title from the run row, plumbed at dispatch (issue #13); null-safe for a
      // missing run row or a pre-migration run.
      title: run?.issueTitle ?? null,
      phase: phaseLabel(phase),
      fixAttempt: phaseNum === null ? 0 : store.getFixAttempts(agent.runId, phaseNum),
      phaseStartedAt: phaseStart,
      // The live phase's route, folded from the run's latest RouteResolved fact (ADR-0037 P3.1).
      route: store.getRunRoute(agent.runId),
    };
  });

  const toQueue = (
    status: "awaiting-answer" | "review-maxed" | "agent-stuck" | "awaiting-ci" | "awaiting-merge",
  ): QueueItem[] =>
    allRuns
      .filter((run) => run.status === status)
      .map((run) => ({
        repo: run.repo,
        issueNumber: run.issueNumber,
        headline: questionByRun.get(run.id)?.headline ?? "",
        since: run.updatedAt,
      }));

  const recentOutcomes: OutcomeView[] = store
    .recentLog(Math.max(outcomeLimit * 5, 50))
    .filter((entry) => OUTCOME_EVENTS.has(entry.event))
    .slice(0, outcomeLimit)
    .map((entry) => ({
      runId: entry.runId,
      repo: entry.repo,
      issueNumber: entry.issueNumber,
      level: entry.level,
      event: entry.event,
      data: entry.data,
      ts: entry.ts,
    }));

  // Every target's per-tick backlog/health snapshot (issue #20). Empty before the
  // first tick or on an old store, so the dashboard renders cleanly without it.
  const persisted = store.listBacklogSnapshots();

  // Flatten every repo's per-tick backlog, tagging each item with the repo it came
  // from (the persisted per-repo snapshot omits it — its row knows `targetRepo`) so
  // the aggregate web views can show + filter by repo (issue #108).
  const tagRepo = <T>(items: T[], repo: string): (T & { repo: string })[] =>
    items.map((item) => ({ ...item, repo }));

  return {
    runningAgents,
    backlog: {
      eligible: persisted.flatMap((s) => tagRepo(s.eligible, s.targetRepo)),
      blocked: persisted.flatMap((s) => tagRepo(s.blocked, s.targetRepo)),
      paused: persisted.flatMap((s) => tagRepo(s.paused, s.targetRepo)),
      // `?? []`: a snapshot row persisted before this field existed lacks it at
      // runtime despite the type. Default it so the reader stays total across upgrade.
      manualHolds: persisted.flatMap((s) => tagRepo(s.manualHolds ?? [], s.targetRepo)),
      // `?? []`: a snapshot row persisted before this field existed (older daemon
      // build) lacks it at runtime despite the type — default it so the reader stays
      // total across an in-place upgrade.
      modingCandidates: persisted.flatMap((s) => tagRepo(s.modingCandidates ?? [], s.targetRepo)),
      // `?? []`: the no-provider wait (ADR-0037 P3.2) is additive — a snapshot row from a daemon
      // build predating it lacks the field, so default it to keep the reader total across upgrade.
      noProvider: persisted.flatMap((s) => tagRepo(s.noProvider ?? [], s.targetRepo)),
    },
    awaitingAnswer: toQueue("awaiting-answer"),
    reviewMaxed: toQueue("review-maxed"),
    agentStuck: toQueue("agent-stuck"),
    awaitingCi: toQueue("awaiting-ci"),
    awaitingMerge: toQueue("awaiting-merge"),
    recentOutcomes,
    daemon: aggregateDaemonHealth(persisted, nowMs),
  };
}

/**
 * Summarise every repo's persisted snapshot into one header readout: the shared cap,
 * the earliest daemon start (longest uptime), the freshest tick, the next-tick due
 * instant, stale if ANY repo is stale, and the first error any repo surfaced — all
 * instants absolute (ISO-8601). `targetRepo` lists the repos. `null` before any repo's
 * first tick. `nowMs` is read only for the stale check and the overdue clamp.
 */
function aggregateDaemonHealth(snapshots: DaemonSnapshotLike[], nowMs: number): DaemonHealthView | null {
  if (snapshots.length === 0) {
    return null;
  }
  const intervalMs = Math.max(...snapshots.map((s) => s.reconcileIntervalSeconds)) * 1000;
  const lastTickMs = Math.max(...snapshots.map((s) => Date.parse(s.generatedAt)));
  const lastTickAgoMs = Math.max(0, nowMs - lastTickMs);
  const earliestStart = Math.min(...snapshots.map((s) => Date.parse(s.daemonStartedAt)));
  const repos = snapshots.map((s) => s.targetRepo).join(", ");
  return {
    targetRepo: snapshots.length > 1 ? `${snapshots.length} targets: ${repos}` : repos,
    cap: Math.max(...snapshots.map((s) => s.cap)),
    startedAt: new Date(earliestStart).toISOString(),
    lastTickAt: new Date(lastTickMs).toISOString(),
    // The next tick is due one interval after the last; clamp to `now` when overdue so it
    // never reads as a past instant ("due now" then — the `stale` flag tells the real story).
    nextTickAt: new Date(Math.max(lastTickMs + intervalMs, nowMs)).toISOString(),
    // A tick is due every interval; if the freshest tick is older than two intervals
    // the daemon is not ticking — surface it as a header error.
    stale: lastTickAgoMs > intervalMs * 2,
    lastError: snapshots.map((s) => s.lastError).find((e) => e != null) ?? null,
  };
}

/** The subset of a persisted snapshot {@link aggregateDaemonHealth} reads. */
type DaemonSnapshotLike = ReturnType<Store["listBacklogSnapshots"]>[number];
