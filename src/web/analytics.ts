/**
 * The pure metric-computation transform behind `/api/analytics` (issue #115): it folds
 * the daemon's durable **run-log history** into the browser-safe Analytics contract —
 * the daily throughput / mean-time-to-merge / anomaly trend, plus the fix-attempt,
 * escalation, and review-maxed distributions. It is the read edge's only logic
 * (ADR-0029): the HTTP handler reads the store and serializes the result, so the
 * thin-edge assertions all live on this pure function (exhaustively unit-tested in the
 * node vitest env).
 *
 * The same two epic (#106) rules the Overview obeys apply:
 *   - **Aggregate across all repos** by default; an optional `repo` narrows *every*
 *     metric (applied once, at the boundary), while `repos` (the full set, computed
 *     before narrowing) is always returned so the UI's filter stays populated.
 *   - Everything is over a **selectable window** of `windowDays` days ending today
 *     (UTC). The daily series is contiguous — one point per day, zeros filled — so a
 *     chart reads as a real timeline.
 *
 * Data source — the `run_log` table (the run history). Each metric reads exactly the
 * events the production code already records:
 *   - throughput / time-to-merge ← `merged` (+ each run's earliest log ts as the start)
 *   - anomaly trend ← `daemon-anomaly`
 *   - fix-attempts ← `review-maxed` (`data.attempts`)
 *   - escalations ← `escalated`; review-maxed ← `review-maxed`
 */
import type { RunLogEntry } from "../store/types";
import type {
  AnalyticsDailyPoint,
  AnalyticsResponse,
  DistributionBucket,
} from "./contract";

/** A run's start anchor for time-to-merge: its earliest observed `run_log` timestamp. */
export interface RunStart {
  runId: number;
  /** ISO-8601 instant of the run's first log entry (its pickup/recovery). */
  startedAt: string;
}

export interface ComputeAnalyticsInput {
  /**
   * Run-log entries from the window's start onward (the store query is `ts >= since`,
   * with `since` = {@link analyticsWindowStart}). Order does not matter — the transform
   * buckets by timestamp.
   */
  events: RunLogEntry[];
  /**
   * Each run's start anchor, across *all* time (not just the window) — a run picked up
   * before the window can still merge inside it, and its time-to-merge needs the start.
   */
  runStarts: RunStart[];
  /** Reference clock — the projection instant; the window ends on its UTC day. */
  now: Date;
  /** The resolved window length in whole days (already clamped via `resolveWindowDays`). */
  windowDays: number;
  /** Narrow every metric to this repo; omit for the all-repos aggregate. */
  repo?: string;
  /**
   * The full set of known target repos (the configured targets), so the filter list is
   * complete even for repos with no history; unioned with every repo seen in the events.
   */
  repos?: string[];
}

const DAY_MS = 86_400_000;

/** UTC midnight (epoch ms) of the day an instant falls on. */
function utcDayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** The `YYYY-MM-DD` UTC day key for an epoch-ms day start. */
function dayKey(dayStartMs: number): string {
  return new Date(dayStartMs).toISOString().slice(0, 10);
}

/**
 * Epoch-ms of 00:00 UTC on the first day of a `windowDays`-day window ending on `now`'s
 * UTC day — the single source of truth for the window's lower bound. Both the store query
 * (`ts >= this`, via {@link analyticsWindowStart}) and the transform's day bucketing (the
 * spine and `since` in {@link computeAnalytics}) derive from this one function, so they
 * structurally cover the exact same days rather than relying on two copies agreeing.
 */
function windowStartMs(now: Date, windowDays: number): number {
  return utcDayStart(now.getTime()) - (windowDays - 1) * DAY_MS;
}

/**
 * The ISO-8601 instant a `windowDays`-day window ending on `now`'s UTC day starts at:
 * 00:00 UTC of the first day. The single source of truth both the store query (`ts >=
 * this`) and the transform's day bucketing use, so they cover the exact same days.
 */
export function analyticsWindowStart(now: Date, windowDays: number): string {
  return new Date(windowStartMs(now, windowDays)).toISOString();
}

/** A mutable per-day accumulator for the daily trend series. */
interface DayAcc {
  /** The UTC `YYYY-MM-DD` key for this day — fixed when the spine is built. */
  date: string;
  merges: number;
  anomalies: number;
  /** Sum of known time-to-merge deltas (ms) for the day's merges, and how many had one. */
  ttmSum: number;
  ttmCount: number;
}

/**
 * Histogram of integer values into contiguous `{ bucket, count }` bars from the
 * smallest to the largest observed value (gaps filled with zero so a bar chart is
 * continuous). Empty input yields an empty array — the window simply held no such data.
 */
function histogram(values: number[]): DistributionBucket[] {
  if (values.length === 0) {
    return [];
  }
  const counts = new Map<number, number>();
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    counts.set(v, (counts.get(v) ?? 0) + 1);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const buckets: DistributionBucket[] = [];
  for (let b = min; b <= max; b++) {
    buckets.push({ bucket: b, count: counts.get(b) ?? 0 });
  }
  return buckets;
}

/** Round a mean to whole milliseconds, or null when there were no samples. */
function meanOrNull(sum: number, count: number): number | null {
  return count > 0 ? Math.round(sum / count) : null;
}

/**
 * Fold the run-log history into the Analytics view-model. Pure: every metric is derived
 * from `events` + `runStarts` (plus the injected clock and the optional repo filter).
 * No store, GitHub, or SDK access.
 */
export function computeAnalytics(input: ComputeAnalyticsInput): AnalyticsResponse {
  const { events, now, windowDays } = input;

  // The full, unnarrowed repo set drives the filter dropdown — computed from every
  // event before any narrowing, unioned with the configured targets.
  const repos = collectRepos(events, input.repos);

  // Apply the repo filter once, at the boundary, so no metric below can leak cross-repo
  // data by forgetting to narrow.
  const scoped = input.repo === undefined ? events : events.filter((e) => e.repo === input.repo);

  // ---- the contiguous day spine: one bucket per day in the window -----------
  // The lower bound is `windowStartMs` — the same function the store query draws from
  // (control-plane.ts), so the read window and this spine cover the same days by
  // construction; the upper bound is today's UTC day.
  const firstDayStart = windowStartMs(now, windowDays);
  const todayStart = utcDayStart(now.getTime());
  const days: DayAcc[] = [];
  const dayIndex = new Map<string, DayAcc>();
  for (let d = firstDayStart; d <= todayStart; d += DAY_MS) {
    const date = dayKey(d);
    const acc: DayAcc = { date, merges: 0, anomalies: 0, ttmSum: 0, ttmCount: 0 };
    days.push(acc);
    dayIndex.set(date, acc);
  }

  // Run start anchors (run id → earliest log instant), for time-to-merge.
  const startByRun = new Map<number, number>();
  for (const s of input.runStarts) {
    const t = Date.parse(s.startedAt);
    if (!Number.isNaN(t)) {
      startByRun.set(s.runId, t);
    }
  }

  // ---- fold every in-window event into the day spine + the running totals ---
  let totalMerges = 0;
  let totalEscalations = 0;
  let totalReviewMaxed = 0;
  let totalAnomalies = 0;
  let overallTtmSum = 0;
  let overallTtmCount = 0;
  // Per-issue counts for the escalation / review-maxed distributions.
  const escalationsByIssue = new Map<string, number>();
  const reviewMaxedByIssue = new Map<string, number>();
  // Per-event fix-attempt values for the fix-attempts distribution.
  const fixAttemptValues: number[] = [];

  for (const e of scoped) {
    const tsMs = Date.parse(e.ts);
    if (Number.isNaN(tsMs)) {
      continue;
    }
    // `dayKey` already truncates to the UTC calendar day, so it keys the spine directly.
    const acc = dayIndex.get(dayKey(tsMs));
    // Events outside the window's days are dropped (a generous store query may overscan).
    switch (e.event) {
      case "merged": {
        if (!acc) break;
        acc.merges += 1;
        totalMerges += 1;
        const start = e.runId === null ? undefined : startByRun.get(e.runId);
        if (start !== undefined && tsMs >= start) {
          const ttm = tsMs - start;
          acc.ttmSum += ttm;
          acc.ttmCount += 1;
          overallTtmSum += ttm;
          overallTtmCount += 1;
        }
        break;
      }
      case "daemon-anomaly": {
        if (!acc) break;
        acc.anomalies += 1;
        totalAnomalies += 1;
        break;
      }
      case "escalated": {
        if (!acc || e.issueNumber === null) break;
        const key = `${e.repo ?? ""}#${e.issueNumber}`;
        escalationsByIssue.set(key, (escalationsByIssue.get(key) ?? 0) + 1);
        totalEscalations += 1;
        break;
      }
      case "review-maxed": {
        if (!acc) break;
        totalReviewMaxed += 1;
        if (e.issueNumber !== null) {
          const key = `${e.repo ?? ""}#${e.issueNumber}`;
          reviewMaxedByIssue.set(key, (reviewMaxedByIssue.get(key) ?? 0) + 1);
        }
        const attempts = e.data?.attempts;
        if (typeof attempts === "number" && Number.isFinite(attempts) && attempts >= 0) {
          fixAttemptValues.push(Math.floor(attempts));
        }
        break;
      }
      default:
        break;
    }
  }

  const daily: AnalyticsDailyPoint[] = days.map((acc) => ({
    date: acc.date,
    merges: acc.merges,
    anomalies: acc.anomalies,
    meanTimeToMergeMs: meanOrNull(acc.ttmSum, acc.ttmCount),
  }));

  return {
    generatedAt: now.toISOString(),
    repo: input.repo ?? null,
    repos,
    windowDays,
    since: new Date(firstDayStart).toISOString(),
    daily,
    summary: {
      totalMerges,
      meanTimeToMergeMs: meanOrNull(overallTtmSum, overallTtmCount),
      totalEscalations,
      totalReviewMaxed,
      totalAnomalies,
    },
    distributions: {
      fixAttempts: histogram(fixAttemptValues),
      escalations: histogram([...escalationsByIssue.values()]),
      reviewMaxed: histogram([...reviewMaxedByIssue.values()]),
    },
  };
}

/** The union of the configured target repos and every repo seen in the events, sorted. */
function collectRepos(events: RunLogEntry[], configured: string[] | undefined): string[] {
  const set = new Set<string>(configured ?? []);
  for (const e of events) {
    if (e.repo) {
      set.add(e.repo);
    }
  }
  return [...set].sort();
}
