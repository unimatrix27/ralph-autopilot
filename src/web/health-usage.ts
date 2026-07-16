/**
 * The pure render-model transform behind `/api/health/usage` (issue #116): it folds
 * three pure reads into the browser-safe health+usage contract —
 *   - the runtime snapshot ({@link buildSnapshot}) for daemon liveness and the live
 *     completeness islands (the `daemon-anomaly` backlog),
 *   - the anomaly run-log (latest reason per island, read unbounded so a long-standing
 *     anomaly's once-logged reason is never aged out of the recent-outcomes window), and
 *   - the {@link UsageMeter} state for the ADR-0028 dual-login utilization / cooldowns.
 *
 * It is the **read edge's only logic** (ADR-0029): the HTTP handler builds these
 * inputs through the port and serializes the result, so the thin-edge assertions stay
 * on this pure function (exhaustively unit-tested in the node vitest env). No GitHub,
 * store, or SDK access — every input is plain data.
 *
 * Daemon instants are **absolute** ISO timestamps the snapshot already carries
 * (ADR-0031), so the daemon section is a straight pass-through and the UI ticks
 * uptime / time-to-next-tick live between polls against its own render-time clock.
 */
import type { RuntimeSnapshot } from "../projection/snapshot";
import type { UsageState } from "../core/usage";
import { toWireUsage } from "./usage-projection";
import type {
  AnomalyItem,
  DaemonHealth,
  HealthUsageResponse,
  UsageLogin,
  UsageSummary,
} from "./contract";

/**
 * The read-only usage picture the transform folds — the shape
 * {@link import("../daemon/usage-meter").UsageMeter}'s `snapshot()` returns: the active
 * login pointer, the full configured login id list (so a never-streamed login still
 * appears), and the per-login {@link UsageState}.
 */
export interface UsageMeterSnapshot {
  /** The login new sessions currently bind to. */
  activeId: string;
  /** Every configured login id (ADR-0028); the box-default single login is `["default"]`. */
  ids: string[];
  /** Per-login usage state, keyed by login id; a login absent here has streamed nothing yet. */
  states: Record<string, UsageState>;
  /** The operator-disabled login ids (issue #10) — marked on the wire, excluded from `paused`. */
  disabledIds: string[];
}

/**
 * The subset of a run-log row the anomaly join reads (a `RunLogEntry` is structurally
 * assignable). The reason lives in `data.reason`; `ts` is the absolute log instant.
 */
export interface AnomalyLogRow {
  repo: string | null;
  issueNumber: number | null;
  data: Record<string, unknown> | null;
  ts: string;
}

export interface BuildHealthUsageOptions {
  /** Injected clock for a deterministic `generatedAt` and the gate/cooldown evaluation. */
  now?: () => Date;
  /** The "stop at N%" plan-budget threshold (`usageLimit.admitBelowPercent`) the gate uses. */
  admitBelowPercent: number;
}

/** Shown when an island carries the `daemon-anomaly` label but no reason is recoverable from the log. */
const UNKNOWN_REASON = "unclassified — reason not recorded";

/**
 * Fold the snapshot + anomaly log + usage state into the health+usage view-model.
 * Pure: every section derives from its inputs plus the injected clock and threshold.
 */
export function buildHealthUsage(
  snapshot: RuntimeSnapshot,
  anomalyLog: AnomalyLogRow[],
  usage: UsageMeterSnapshot,
  options: BuildHealthUsageOptions,
): HealthUsageResponse {
  const now = options.now ?? ((): Date => new Date());
  const nowMs = now().getTime();

  return {
    generatedAt: now().toISOString(),
    daemon: toDaemonHealth(snapshot),
    anomalies: toAnomalies(snapshot, anomalyLog),
    usage: toUsage(usage, nowMs, options.admitBelowPercent),
  };
}

/**
 * Daemon liveness, or null before the first tick. The snapshot's {@link DaemonHealthView}
 * already carries absolute ISO instants (ADR-0031), so this is a straight pass-through —
 * the UI counts uptime / time-to-next-tick live against its own render clock. `inFlight`
 * is the live running-agent count off the same snapshot.
 */
function toDaemonHealth(snapshot: RuntimeSnapshot): DaemonHealth | null {
  const d = snapshot.daemon;
  if (d === null) {
    return null;
  }
  return {
    targets: d.targetRepo,
    cap: d.cap,
    inFlight: snapshot.runningAgents.length,
    startedAt: d.startedAt,
    lastTickAt: d.lastTickAt,
    nextTickAt: d.nextTickAt,
    stale: d.stale,
    lastError: d.lastError,
  };
}

/**
 * The surfaced completeness islands: anchor on the **live** backlog (issues currently
 * parked under `daemon-anomaly` — the set a human must repair), enriched with the latest
 * logged reason + instant for each. The anomaly edge is logged once (the label is the
 * standing signal), so the reason is read from the unbounded anomaly log, not the
 * bounded recent-outcomes feed. Repo+issue ordered for a stable list.
 */
function toAnomalies(snapshot: RuntimeSnapshot, anomalyLog: AnomalyLogRow[]): AnomalyItem[] {
  // Latest reason per (repo, issue). The log is newest-first, so the first seen wins.
  const reasonByKey = new Map<string, { reason: string | null; ts: string }>();
  for (const row of anomalyLog) {
    if (row.repo === null || row.issueNumber === null || row.issueNumber <= 0) {
      continue;
    }
    const key = `${row.repo}#${row.issueNumber}`;
    if (!reasonByKey.has(key)) {
      const reason = typeof row.data?.reason === "string" ? row.data.reason : null;
      reasonByKey.set(key, { reason, ts: row.ts });
    }
  }

  return snapshot.backlog.paused
    .filter((p) => p.state === "daemon-anomaly")
    .map((p) => {
      const logged = reasonByKey.get(`${p.repo}#${p.issueNumber}`);
      return {
        repo: p.repo,
        issue: p.issueNumber,
        reason: logged?.reason ?? UNKNOWN_REASON,
        title: p.title,
        since: logged?.ts ?? null,
      };
    })
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.issue - b.issue);
}

/**
 * The dual-login usage picture (ADR-0028). Every configured login appears (even a
 * never-streamed one — optimistically un-gated until its first session); `gated` reuses
 * the same proactive-gate predicate admission uses, so the UI's "would this admit?" read
 * can't drift from the daemon's. `paused` is the whole-daemon hold: every **enabled**
 * login gated — an operator-disabled login (issue #10) is marked but counts toward
 * neither side (its gating never pauses; its headroom never un-pauses), mirroring the
 * meter's own gate so the UI's read can't drift from admission's.
 */
function toUsage(usage: UsageMeterSnapshot, nowMs: number, admitBelowPercent: number): UsageSummary {
  const disabledIds = new Set(usage.disabledIds);
  const logins: UsageLogin[] = usage.ids.map((id) => ({
    id,
    disabled: disabledIds.has(id),
    ...toWireUsage(usage.states[id], { active: id === usage.activeId, nowMs, admitBelowPercent }),
  }));
  const enabled = logins.filter((l) => !l.disabled);

  return {
    admitBelowPercent,
    activeId: usage.activeId,
    paused: enabled.length > 0 && enabled.every((l) => l.gated),
    logins,
  };
}
