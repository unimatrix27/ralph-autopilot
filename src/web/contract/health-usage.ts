/**
 * The `/api/health/usage` wire shape (ADR-0031) — the operator's "is the daemon
 * alive, and why might it be holding back?" view (issue #116). It is the richer
 * companion to the minimal liveness `/api/health` probe ({@link ./health}): the
 * latter proves the *web server* is serving, this surfaces the *daemon's* own
 * health, the completeness anomalies it has parked, and its ADR-0028 dual-login
 * usage so the operator can see why work is (or is not) being admitted.
 *
 * Like every read shape it is a thin serialization of pure reads (ADR-0029): a pure
 * transform (`buildHealthUsage`) folds the runtime snapshot, the anomaly run-log,
 * and the usage-meter state into these shapes, and both the daemon (serialize) and
 * the UI (parse) share this leaf so a drift is a compile error, not a mis-render.
 *
 * Every instant on the wire is **absolute** (ISO-8601) so the UI computes
 * uptime / time-to-next-tick / cooldown-remaining live between polls (ADR-0031),
 * rather than rendering a value that froze at projection time.
 */
import { z } from "zod";
import { issueNumber, repoSlug } from "./primitives";

/**
 * Daemon liveness, derived from the persisted per-tick snapshot. `null` (on the
 * envelope) before the daemon's first tick has written a snapshot — until then the
 * web server is up but the daemon has reported nothing.
 */
export const daemonHealthSchema = z
  .object({
    /** The target(s) this daemon works — `owner/repo`, or `N targets: a, b` when multi-repo. */
    targets: z.string(),
    /** Build-pool concurrency cap (`maxConcurrentAgents`) — the most agents that can run at once. */
    cap: z.number().int().nonnegative(),
    /** Agents in flight right now (across every repo). */
    inFlight: z.number().int().nonnegative(),
    /** ISO-8601 instant the daemon process started — the UI ticks uptime live off this. */
    startedAt: z.string(),
    /** ISO-8601 instant of the most recent reconcile tick. */
    lastTickAt: z.string(),
    /** ISO-8601 instant the next tick is due (equals "now" / the projection time when overdue). */
    nextTickAt: z.string(),
    /** The last tick lapsed by more than ~2 reconcile intervals — the daemon may be down or stalled. */
    stale: z.boolean(),
    /** The most recent reconcile error (cleared once a tick completes cleanly), or null. */
    lastError: z
      .object({ event: z.string(), at: z.string() })
      .strict()
      .nullable(),
  })
  .strict();
export type DaemonHealth = z.infer<typeof daemonHealthSchema>;

/**
 * One surfaced completeness anomaly (an **island**, CONTEXT.md) with its logged
 * reason. The daemon parks an unclassifiable/contradictory issue under a
 * `daemon-anomaly` label and logs the classification reason once at the edge; this
 * pairs the live label (the issue still needs a human) with that logged reason so
 * the operator can repair it without digging through logs.
 */
export const anomalyItemSchema = z
  .object({
    repo: repoSlug,
    issue: issueNumber,
    /** The completeness reason logged when the island was surfaced (e.g. `paused-label-missing-run`). */
    reason: z.string(),
    /** The issue title from the backlog, or null when unknown. */
    title: z.string().nullable(),
    /** ISO-8601 instant the anomaly was logged, or null when not recoverable. */
    since: z.string().nullable(),
  })
  .strict();
export type AnomalyItem = z.infer<typeof anomalyItemSchema>;

/**
 * One plan rate-limit window's live state (ADR-0023/0028): the SDK reports a 5-hour
 * rolling window and several weekly windows, each a utilization percentage + a reset
 * instant. `utilization`/`resetsAt` are null until the login has streamed a signal.
 */
export const usageWindowSchema = z
  .object({
    /** The SDK `rateLimitType` keying the window (`five_hour`, `seven_day`, …). */
    type: z.string(),
    /** Percentage of the window used, 0-100, or null if not yet known. */
    utilization: z.number().nullable(),
    /** ISO-8601 instant the window resets, or null if not yet known. */
    resetsAt: z.string().nullable(),
  })
  .strict();
export type UsageWindow = z.infer<typeof usageWindowSchema>;

/**
 * One OAuth login's usage state (ADR-0028 dual-subscription rotation). The daemon
 * may carry more than one login and routes new sessions to whichever has headroom;
 * `active` flags the one new sessions currently bind to, and `gated` says whether
 * the proactive gate would refuse NEW work on it right now (a window at/above the
 * threshold, or an active cooldown).
 */
export const usageLoginSchema = z
  .object({
    /** Stable login id (`default` for the box-default single login). */
    id: z.string(),
    /** Is this the login new sessions currently bind to? */
    active: z.boolean(),
    /** Would the proactive gate refuse NEW work on this login right now? */
    gated: z.boolean(),
    /** Per-window utilization, type-ordered. */
    windows: z.array(usageWindowSchema),
    /** ISO-8601 instant an active cooldown lifts, or null when none is active. */
    cooldownUntil: z.string().nullable(),
  })
  .strict();
export type UsageLogin = z.infer<typeof usageLoginSchema>;

/**
 * The daemon-wide usage picture (ADR-0028). `paused` is the whole-daemon hold: every
 * login is gated, so admission defers new work until a window resets — exactly the
 * ADR-0023 pause, now reached only when all budgets are spent.
 */
export const usageSummarySchema = z
  .object({
    /** The "stop at N%" plan-budget threshold (`admitBelowPercent`) the gate uses. */
    admitBelowPercent: z.number().int(),
    /** The login id new sessions currently bind to. */
    activeId: z.string(),
    /** Every login is gated → the daemon is holding back new work until a window resets. */
    paused: z.boolean(),
    /** Each configured login (including a never-used one), with its live state. */
    logins: z.array(usageLoginSchema),
  })
  .strict();
export type UsageSummary = z.infer<typeof usageSummarySchema>;

/**
 * The full `/api/health/usage` payload: daemon liveness (or null pre-first-tick),
 * the surfaced anomalies with their logged reasons, and the dual-login usage state.
 */
export const healthUsageResponseSchema = z
  .object({
    /** ISO-8601 instant this view was projected (the "now" the UI counts relative times from). */
    generatedAt: z.string(),
    /** Daemon liveness, or null before the daemon's first tick wrote a snapshot. */
    daemon: daemonHealthSchema.nullable(),
    /** Surfaced completeness anomalies with their logged reason, repo+issue ordered. */
    anomalies: z.array(anomalyItemSchema),
    /** Dual-login usage / plan-budget / cooldowns (ADR-0028). */
    usage: usageSummarySchema,
  })
  .strict();
export type HealthUsageResponse = z.infer<typeof healthUsageResponseSchema>;
