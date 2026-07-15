/**
 * The `/api/analytics` wire shape (issue #115, epic #106) — trends over time so the
 * operator can gauge productivity and quality at a glance. Like every read contract
 * (ADR-0031) it is a thin serialization of a pure transform: {@link
 * import("../analytics").computeAnalytics} folds the durable run-log history into
 * these shapes, and both the daemon (serialize) and the UI (parse) share this leaf so
 * a drift is a compile error, not a silent mis-render.
 *
 * Two cross-cutting rules from the epic live here, mirroring the Overview:
 *   - **Aggregate across all repos** by default; an optional `repo` narrows *every*
 *     metric, while `repos` (the full set) is always returned so the UI's filter
 *     stays populated.
 *   - Everything is computed over a **selectable window** of days (`windowDays`),
 *     ending today (UTC). The daily series is contiguous — one point per day in the
 *     window, zeros filled — so a chart reads as a real timeline, not a sparse scatter.
 *
 * Browser-safe (zod only); see ./README.md.
 */
import { z } from "zod";

/** A target-repo slug (`owner/name`); the per-metric attribution the repo filter narrows on. */
const repoSlug = z.string();

/** The day-window presets the UI offers; any positive integer is accepted on the wire. */
export const ANALYTICS_WINDOWS = [7, 14, 30, 90] as const;

/** The default window when a request names none. */
export const DEFAULT_ANALYTICS_WINDOW_DAYS = 30;

/** The accepted window bounds — a single day up to a year (keeps the day series sane). */
export const MIN_ANALYTICS_WINDOW_DAYS = 1;
export const MAX_ANALYTICS_WINDOW_DAYS = 365;

/**
 * Resolve a raw `?window=` value into a clamped whole-day window — the single source
 * of truth both the server (parsing the query) and the UI (offering presets) share,
 * so they can never disagree on what a window means. A missing / non-finite / ≤0 value
 * yields the {@link DEFAULT_ANALYTICS_WINDOW_DAYS default}; out-of-range values clamp.
 */
export function resolveWindowDays(raw: number | undefined | null): number {
  if (raw === undefined || raw === null || !Number.isFinite(raw)) {
    return DEFAULT_ANALYTICS_WINDOW_DAYS;
  }
  const n = Math.floor(raw);
  if (n < MIN_ANALYTICS_WINDOW_DAYS) {
    return DEFAULT_ANALYTICS_WINDOW_DAYS;
  }
  return n > MAX_ANALYTICS_WINDOW_DAYS ? MAX_ANALYTICS_WINDOW_DAYS : n;
}

/**
 * One day in the daily trend series — the spine of the throughput, mean-time-to-merge,
 * and anomaly charts. `date` is a UTC `YYYY-MM-DD`; the series is contiguous and
 * oldest-first, so consecutive `date`s differ by exactly one day.
 */
export const analyticsDailyPointSchema = z
  .object({
    /** The UTC calendar day, `YYYY-MM-DD`. */
    date: z.string(),
    /** Merges (PRs merged) on this day — the throughput bar. */
    merges: z.number().int().nonnegative(),
    /** `daemon-anomaly` events on this day — the completeness-health trend (ideally flat at 0). */
    anomalies: z.number().int().nonnegative(),
    /**
     * Mean wall-clock from run start to merge, in milliseconds, over this day's merges
     * whose run start is known; `null` when the day had no such merge (so the line
     * breaks rather than plotting a fake zero).
     */
    meanTimeToMergeMs: z.number().nonnegative().nullable(),
  })
  .strict();
export type AnalyticsDailyPoint = z.infer<typeof analyticsDailyPointSchema>;

/**
 * One bar of a distribution histogram: `count` items fell into integer `bucket`. The
 * bucket's meaning depends on the distribution — fix-attempts consumed, escalations
 * per issue, review-maxouts per issue (see {@link analyticsDistributionsSchema}).
 */
export const distributionBucketSchema = z
  .object({
    bucket: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
  })
  .strict();
export type DistributionBucket = z.infer<typeof distributionBucketSchema>;

/**
 * The three quality distributions, each a histogram (ascending by `bucket`, gaps
 * filled with zero so the bars are contiguous; empty when the window holds no data):
 *   - **fixAttempts** — per `review-maxed` event, bucketed by the number of fix
 *     attempts it consumed before giving up: "when review gives up, how hard had it
 *     tried?"
 *   - **escalations** — per issue with ≥1 escalation, bucketed by how many times it
 *     escalated in the window: "do issues escalate once, or repeatedly?"
 *   - **reviewMaxed** — per issue with ≥1 review-maxout, bucketed by how many times it
 *     maxed out: "do issues max out review once, or repeatedly?"
 */
export const analyticsDistributionsSchema = z
  .object({
    fixAttempts: z.array(distributionBucketSchema),
    escalations: z.array(distributionBucketSchema),
    reviewMaxed: z.array(distributionBucketSchema),
  })
  .strict();
export type AnalyticsDistributions = z.infer<typeof analyticsDistributionsSchema>;

/** Headline scalars for the window — the same facts the daily series sums to, pre-totalled for the cards. */
export const analyticsSummarySchema = z
  .object({
    /** Total merges in the window. */
    totalMerges: z.number().int().nonnegative(),
    /** Mean time-to-merge across the whole window (ms), or `null` if no merge had a known start. */
    meanTimeToMergeMs: z.number().nonnegative().nullable(),
    /** Total escalations in the window. */
    totalEscalations: z.number().int().nonnegative(),
    /** Total review-maxouts in the window. */
    totalReviewMaxed: z.number().int().nonnegative(),
    /** Total completeness anomalies in the window. */
    totalAnomalies: z.number().int().nonnegative(),
  })
  .strict();
export type AnalyticsSummary = z.infer<typeof analyticsSummarySchema>;

/**
 * The full analytics payload. `repo` echoes the active filter (`null` = aggregate
 * across all repos); `repos` is the full, *unnarrowed* set so the filter dropdown
 * stays populated; `windowDays`/`since` echo the resolved window so the UI can label
 * it. Every metric is already narrowed to `repo` when one was requested.
 */
export const analyticsResponseSchema = z
  .object({
    /** ISO-8601 instant this view was projected. */
    generatedAt: z.string(),
    /** The active repo filter, or null when aggregate across all repos. */
    repo: repoSlug.nullable(),
    /** Every known target repo, for the filter — never narrowed by `repo`. */
    repos: z.array(repoSlug),
    /** The resolved window length, in whole days. */
    windowDays: z.number().int().positive(),
    /** ISO-8601 instant the window starts (00:00 UTC of its first day). */
    since: z.string(),
    /** Contiguous daily trend (throughput + anomalies + mean-time-to-merge), oldest first. */
    daily: z.array(analyticsDailyPointSchema),
    /** Pre-totalled headline scalars for the window. */
    summary: analyticsSummarySchema,
    /** The three quality distributions. */
    distributions: analyticsDistributionsSchema,
  })
  .strict();
export type AnalyticsResponse = z.infer<typeof analyticsResponseSchema>;
