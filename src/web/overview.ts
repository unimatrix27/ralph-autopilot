/**
 * The pure render-model transform behind `/api/overview` (issue #108): it folds the
 * runtime snapshot ({@link buildSnapshot}) into the browser-safe Overview contract
 * — the "Needs you" band, the fleet summary, the pipeline funnel, and the
 * recent-activity feed. It is the **read edge's only logic** (ADR-0029): the HTTP
 * handler just calls it and serializes the result, so the thin-edge assertions stay
 * on this pure function (exhaustively unit-tested in the node vitest env).
 *
 * Two cross-cutting rules from the epic (#106) live here:
 *   - **Aggregate across all repos** by default; an optional `repo` narrows *every*
 *     section, while `repos` (the full set) is always returned so the UI's filter
 *     stays populated.
 *   - The "Needs you" band is the **union** of the runtime run-queues (which carry a
 *     wait-time and an escalation/heal headline) and the GitHub-label backlog (the
 *     source of truth for all four attention states, including completeness
 *     anomalies that have no run), so nothing needing the operator is silently lost.
 */
import type { PhaseRoute } from "../store/types";
import type { RuntimeSnapshot, QueueItem } from "../projection/snapshot";
import type {
  ActivityItem,
  FleetAgent,
  NeedsYouItem,
  NeedsYouState,
  OverviewResponse,
  PipelineFunnel,
  Route,
} from "./contract";
import { NEEDS_YOU_STATES } from "./contract";
import { buildPowerActionCatalog } from "./power-action-affordance";

export interface SnapshotToOverviewOptions {
  /** Injected clock for a deterministic `generatedAt` (defaults to the system clock). */
  now?: () => Date;
  /** Narrow every section to this repo; omit for the aggregate (all-repos) view. */
  repo?: string;
  /**
   * The full set of known target repos (the configured targets), so the filter list
   * is complete even for idle repos. Unioned with every repo seen in the snapshot.
   */
  repos?: string[];
  /**
   * The daemon's reconcile interval (s) — echoed for Tier-1 power actions on the
   * Needs-you band. Defaults to 30 for tests and old embedders.
   */
  reconcileIntervalSeconds?: number;
  /** Repo-scoped priority labels used to build per-item power-action affordances. */
  priorityLabelsFor?: (repo: string) => readonly string[];
}

/** Triage rank per attention state — index in {@link NEEDS_YOU_STATES}, most-urgent first. */
const STATE_RANK: Record<NeedsYouState, number> = Object.fromEntries(
  NEEDS_YOU_STATES.map((s, i) => [s, i]),
) as Record<NeedsYouState, number>;

/** Default one-liner when an attention item carries neither a question headline nor an issue title. */
function defaultSummary(state: NeedsYouState): string {
  switch (state) {
    case "daemon-anomaly":
      return "Completeness anomaly — needs repair";
    case "agent-stuck":
      return "Agent self-stopped — needs you";
    case "review-maxed":
      return "Review could not converge — needs a heal";
    case "awaiting-answer":
      return "Awaiting your answer";
  }
}

/** Render a recent run-log outcome event + its data into a one-line activity summary. */
export function activitySummary(event: string, data: Record<string, unknown> | null): string {
  const pr = typeof data?.prNumber === "number" ? `#${data.prNumber}` : null;
  switch (event) {
    case "pr-opened":
      return pr ? `PR ${pr} opened` : "PR opened";
    case "merged":
      return pr ? `Merged PR ${pr}` : "Merged";
    case "escalated":
      return "Escalated for a decision";
    case "agent-stuck":
      return "Agent self-stopped";
    case "review-maxed":
      return "Review maxed out";
    case "awaiting-ci":
      return "Awaiting CI";
    case "awaiting-merge":
      return "Queued for merge";
    case "daemon-anomaly":
      return typeof data?.reason === "string" ? `Anomaly: ${data.reason}` : "Daemon anomaly";
    case "orphan-worktree-pruned":
      return "Orphan worktree pruned";
    default:
      return event;
  }
}

/** A positive issue number, or null (the contract forbids 0 / non-positive issue ids). */
function positiveOrNull(n: number | null): number | null {
  return typeof n === "number" && n > 0 ? n : null;
}

/**
 * Project a node-side {@link PhaseRoute} to the wire {@link Route} (ADR-0037 P3.1, issue #164):
 * the optional `model` becomes an explicit `null` for the wire (always-present, null = the
 * provider's default). `null` route stays null (a box-default / unrecorded dispatch).
 */
export function toWireRoute(route: PhaseRoute | null): Route | null {
  if (!route) {
    return null;
  }
  return { provider: route.provider, model: route.model ?? null, account: route.account };
}

/** The mutable accumulator one (repo, issue) needs-you item is built up from both sources. */
interface NeedsYouAcc {
  repo: string;
  issue: number;
  state: NeedsYouState;
  /** From a run queue (the runtime status); null until a run sets it. */
  since: string | null;
  /** Escalation/heal-card headline from a run queue; empty when none. */
  headline: string;
  /** Issue title from the GitHub-label backlog; null until the backlog sets it. */
  title: string | null;
}

/**
 * Fold the runtime snapshot into the Overview view-model. Pure: every section is
 * derived from `snapshot` (plus the injected clock for `generatedAt` and the
 * optional repo filter). No GitHub, store, or SDK access.
 */
export function snapshotToOverview(
  snapshot: RuntimeSnapshot,
  options: SnapshotToOverviewOptions = {},
): OverviewResponse {
  const now = options.now ?? (() => new Date());
  const priorityLabelsFor = options.priorityLabelsFor ?? (() => []);

  // The full, unnarrowed repo set drives the filter dropdown, so it is computed from
  // the whole snapshot before any narrowing.
  const repos = collectRepos(snapshot, options.repos);

  // Apply the repo filter once, at the boundary: narrow every section here so the
  // rest of the transform is filter-agnostic and no later section can leak cross-repo
  // data by forgetting to narrow.
  const view = options.repo === undefined ? snapshot : narrowSnapshot(snapshot, options.repo);

  // ---- "Needs you" band: union of run-queues + label backlog --------------
  const acc = new Map<string, NeedsYouAcc>();
  const seedFromQueue = (items: QueueItem[], state: NeedsYouState): void => {
    for (const item of items) {
      const key = `${item.repo}#${item.issueNumber}`;
      acc.set(key, {
        repo: item.repo,
        issue: item.issueNumber,
        state,
        since: item.since,
        headline: item.headline,
        title: acc.get(key)?.title ?? null,
      });
    }
  };
  // The runtime run-status is the authoritative state for a run; it also carries the
  // wait-time and the escalation/heal headline.
  seedFromQueue(view.awaitingAnswer, "awaiting-answer");
  seedFromQueue(view.reviewMaxed, "review-maxed");
  seedFromQueue(view.agentStuck, "agent-stuck");
  // The GitHub-label backlog is the source of truth for *all four* states — it adds
  // anything a run queue missed (notably completeness anomalies with no run) and
  // supplies the issue title as a summary fallback.
  for (const p of view.backlog.paused) {
    const key = `${p.repo}#${p.issueNumber}`;
    const existing = acc.get(key);
    if (existing) {
      existing.title = p.title;
    } else {
      acc.set(key, { repo: p.repo, issue: p.issueNumber, state: p.state, since: null, headline: "", title: p.title });
    }
  }

  const needsYou: NeedsYouItem[] = [...acc.values()]
    .map((e) => ({
      state: e.state,
      repo: e.repo,
      issue: e.issue,
      waitingSince: e.since,
      summary: e.headline.length > 0 ? e.headline : (e.title ?? defaultSummary(e.state)),
      powerActionSurface: "attention" as const,
    }))
    .sort(byUrgency);

  // ---- fleet summary: running agents with phase + elapsed -----------------
  // The malformed-row drop (no run row → empty repo / non-positive issue) is a
  // per-section invariant, so it stays here rather than in the repo narrowing.
  const fleet: FleetAgent[] = view.runningAgents
    .filter((a) => a.repo !== "" && a.issueNumber > 0)
    .map((a) => ({
      repo: a.repo,
      issue: a.issueNumber,
      phase: a.phase,
      fixAttempt: a.fixAttempt,
      phaseStartedAt: a.phaseStartedAt,
      route: toWireRoute(a.route),
    }))
    .sort((x, y) => Date.parse(x.phaseStartedAt) - Date.parse(y.phaseStartedAt) || x.issue - y.issue);

  // ---- recent-activity feed (newest-first, already filtered to outcomes) ---
  const activity: ActivityItem[] = view.recentOutcomes.map((o) => ({
    repo: o.repo,
    issue: positiveOrNull(o.issueNumber),
    event: o.event,
    ts: o.ts,
    summary: activitySummary(o.event, o.data),
  }));

  // ---- pipeline funnel: current holding counts + recent merge throughput --
  const funnel: PipelineFunnel = {
    eligible: view.backlog.eligible.length,
    inFlight: fleet.length,
    awaitingCi: view.awaitingCi.length,
    awaitingMerge: view.awaitingMerge.length,
    merged: activity.filter((a) => a.event === "merged").length,
  };

  return {
    generatedAt: now().toISOString(),
    repo: options.repo ?? null,
    repos,
    reconcileIntervalSeconds: options.reconcileIntervalSeconds ?? 30,
    needsYou,
    fleet,
    funnel,
    activity,
    // The static "attention" descriptors are emitted once, deduplicated per repo — each
    // item carries only its repo + surface tag (issue #114 phase-2 P1).
    powerActions: buildPowerActionCatalog(
      needsYou.map((item) => ({ repo: item.repo, surface: item.powerActionSurface })),
      priorityLabelsFor,
    ),
  };
}

/**
 * Narrow every section of the snapshot to a single repo — the one boundary the repo
 * filter is applied at. Each repo-tagged list keeps only its `repo === repo` rows;
 * the activity feed's null-repo (daemon-global) rows are dropped under a filter,
 * which the same `o.repo === repo` comparison does. The result is a normal snapshot,
 * so the downstream transform need not know a filter was ever applied.
 */
function narrowSnapshot(snapshot: RuntimeSnapshot, repo: string): RuntimeSnapshot {
  const byRepo = <T extends { repo: string }>(items: T[]): T[] => items.filter((i) => i.repo === repo);
  return {
    ...snapshot,
    runningAgents: byRepo(snapshot.runningAgents),
    backlog: {
      eligible: byRepo(snapshot.backlog.eligible),
      blocked: byRepo(snapshot.backlog.blocked),
      paused: byRepo(snapshot.backlog.paused),
      manualHolds: byRepo(snapshot.backlog.manualHolds),
      modingCandidates: byRepo(snapshot.backlog.modingCandidates),
      noProvider: byRepo(snapshot.backlog.noProvider),
    },
    awaitingAnswer: byRepo(snapshot.awaitingAnswer),
    reviewMaxed: byRepo(snapshot.reviewMaxed),
    agentStuck: byRepo(snapshot.agentStuck),
    awaitingCi: byRepo(snapshot.awaitingCi),
    awaitingMerge: byRepo(snapshot.awaitingMerge),
    recentOutcomes: snapshot.recentOutcomes.filter((o) => o.repo === repo),
  };
}

/** Triage comparator: most-urgent state first, then longest-waiting (oldest), then issue. */
function byUrgency(a: NeedsYouItem, b: NeedsYouItem): number {
  const rank = STATE_RANK[a.state] - STATE_RANK[b.state];
  if (rank !== 0) {
    return rank;
  }
  // Oldest wait first (most urgent); unknown waits (null) sort last within a state.
  const at = a.waitingSince === null ? Infinity : Date.parse(a.waitingSince);
  const bt = b.waitingSince === null ? Infinity : Date.parse(b.waitingSince);
  if (at !== bt) {
    return at - bt;
  }
  return a.issue - b.issue;
}

/** The union of the configured target repos and every repo seen in the snapshot, sorted. */
function collectRepos(snapshot: RuntimeSnapshot, configured: string[] | undefined): string[] {
  const set = new Set<string>(configured ?? []);
  for (const a of snapshot.runningAgents) {
    if (a.repo) {
      set.add(a.repo);
    }
  }
  const queues = [
    snapshot.awaitingAnswer,
    snapshot.reviewMaxed,
    snapshot.agentStuck,
    snapshot.awaitingCi,
    snapshot.awaitingMerge,
  ];
  for (const q of queues) {
    for (const item of q) {
      set.add(item.repo);
    }
  }
  for (const o of snapshot.recentOutcomes) {
    if (o.repo) {
      set.add(o.repo);
    }
  }
  for (const group of [
    snapshot.backlog.eligible,
    snapshot.backlog.blocked,
    snapshot.backlog.paused,
    snapshot.backlog.manualHolds,
    snapshot.backlog.modingCandidates,
    snapshot.backlog.noProvider,
  ]) {
    for (const item of group) {
      if (item.repo) {
        set.add(item.repo);
      }
    }
  }
  return [...set].sort();
}
