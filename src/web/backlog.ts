/**
 * The pure render-model transform behind `/api/backlog` (issue #113): it folds the
 * runtime snapshot ({@link buildSnapshot}) into the browser-safe Backlog contract —
 * the sections an operator triages from (eligible in pick-order, blocked with a
 * dependency mini-graph, paused grouped by attention state, manual holds, and
 * moding-pass candidates). Like {@link snapshotToOverview} it is the **read edge's only logic**
 * (ADR-0029): the HTTP handler just calls it and serializes the result, so the
 * thin-edge assertions stay on this pure function (exhaustively unit-tested).
 *
 * Two cross-cutting rules from the epic (#106) live here, mirroring the Overview:
 *   - **Aggregate across all repos** by default; an optional `repo` narrows *every*
 *     section, while `repos` (the full set) is always returned so the UI's filter
 *     stays populated.
 *   - **Pick-order is the daemon's, not ours.** The snapshot's `eligible` list is
 *     already in admission's pick-order (`buildSnapshot` flattens each repo's
 *     `projectBacklog` output, which preserves `LaunchPlan.eligible`); this transform
 *     copies it **verbatim, never re-sorting**, so the view can never diverge from the
 *     order the gate actually uses (ADR-0007). Blocked/paused/manual-hold/moding carry the
 *     snapshot's stable issue-number order.
 */
import type { RuntimeBacklog, RuntimeSnapshot } from "../projection/snapshot";
import type {
  BacklogBlockedItem,
  BacklogEligibleItem,
  BacklogManualHoldItem,
  BacklogModingCandidateItem,
  BacklogNoProviderItem,
  BacklogPausedItem,
  BacklogResponse,
} from "./contract";
import { buildPowerActionCatalog, type PowerActionRef } from "./power-action-affordance";

export interface SnapshotToBacklogOptions {
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
   * The daemon's reconcile interval (s) — the honest "acts next tick (~Ns)" figure the Tier-1 power
   * actions state (issue #114, ADR-0032). Echoed verbatim; defaults to 30 when omitted (tests).
   */
  reconcileIntervalSeconds?: number;
  /** Repo-scoped priority labels used to build set-priority affordances. */
  priorityLabelsFor?: (repo: string) => readonly string[];
}

/**
 * Fold the runtime snapshot's backlog into the Backlog view-model. Pure: every
 * section is derived from `snapshot.backlog` (plus the injected clock for
 * `generatedAt` and the optional repo filter). No GitHub, store, or SDK access.
 */
export function snapshotToBacklog(
  snapshot: RuntimeSnapshot,
  options: SnapshotToBacklogOptions = {},
): BacklogResponse {
  const now = options.now ?? (() => new Date());
  const priorityLabelsFor = options.priorityLabelsFor ?? (() => []);

  // The full, unnarrowed repo set drives the filter dropdown, so it is computed from
  // the whole backlog before any narrowing.
  const repos = collectRepos(snapshot.backlog, options.repos);

  // Apply the repo filter once, at the boundary: narrow every section here so the
  // per-section maps below stay filter-agnostic.
  const byRepo = <T extends { repo: string }>(items: T[]): T[] =>
    options.repo === undefined ? items : items.filter((i) => i.repo === options.repo);

  const eligible: BacklogEligibleItem[] = byRepo(snapshot.backlog.eligible).map((e) => ({
    repo: e.repo,
    issue: e.issueNumber,
    title: e.title,
    priority: e.priority,
    priorityColor: e.priorityColor,
    powerActionSurface: "queued",
  }));

  const blocked: BacklogBlockedItem[] = byRepo(snapshot.backlog.blocked).map((b) => ({
    repo: b.repo,
    issue: b.issueNumber,
    title: b.title,
    // Copy each dependency edge so the response owns no snapshot references.
    blockers: b.blockers.map((dep) => ({ ref: dep.ref, satisfied: dep.satisfied })),
    powerActionSurface: "queued",
  }));

  const paused: BacklogPausedItem[] = byRepo(snapshot.backlog.paused).map((p) => ({
    repo: p.repo,
    issue: p.issueNumber,
    title: p.title,
    state: p.state,
    powerActionSurface: "attention",
  }));

  const manualHolds: BacklogManualHoldItem[] = byRepo(snapshot.backlog.manualHolds).map((h) => ({
    repo: h.repo,
    issue: h.issueNumber,
    title: h.title,
    powerActionSurface: "manual-hold",
  }));

  const modingCandidates: BacklogModingCandidateItem[] = byRepo(snapshot.backlog.modingCandidates).map((m) => ({
    repo: m.repo,
    issue: m.issueNumber,
    title: m.title,
    powerActionSurface: "moding",
  }));

  // The no-provider wait (ADR-0037 P3.2): eligible-but-parked rows, kept in the snapshot's
  // pick-order (never re-sorted), each carrying its reset ETA. They reuse the `queued` surface —
  // they ARE queued, just waiting on a provider's headroom rather than a free slot.
  const noProvider: BacklogNoProviderItem[] = byRepo(snapshot.backlog.noProvider).map((n) => ({
    repo: n.repo,
    issue: n.issueNumber,
    title: n.title,
    resetsAt: n.resetsAt,
    powerActionSurface: "queued",
  }));

  // The static power-action descriptors are emitted once, deduplicated per (repo, surface) —
  // each row carries only its repo + surface tag (issue #114 phase-2 P1).
  const refs: PowerActionRef[] = [eligible, blocked, paused, manualHolds, modingCandidates, noProvider]
    .flat()
    .map((row) => ({ repo: row.repo, surface: row.powerActionSurface }));

  return {
    generatedAt: now().toISOString(),
    repo: options.repo ?? null,
    repos,
    reconcileIntervalSeconds: options.reconcileIntervalSeconds ?? 30,
    eligible,
    blocked,
    paused,
    manualHolds,
    modingCandidates,
    noProvider,
    powerActions: buildPowerActionCatalog(refs, priorityLabelsFor),
  };
}

/** The union of the configured target repos and every repo seen in the backlog, sorted. */
function collectRepos(backlog: RuntimeBacklog, configured: string[] | undefined): string[] {
  const set = new Set<string>(configured ?? []);
  for (const group of [backlog.eligible, backlog.blocked, backlog.paused, backlog.manualHolds, backlog.modingCandidates, backlog.noProvider]) {
    for (const item of group) {
      if (item.repo) {
        set.add(item.repo);
      }
    }
  }
  return [...set].sort();
}
