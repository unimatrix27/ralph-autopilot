/**
 * The `/api/overview` wire shape (ADR-0031) — the operator's landing page: "does
 * anything need me?" answered in two seconds. It is a thin serialization of
 * `buildSnapshot` (the read edge adds no decision logic, ADR-0029): a
 * pure render-model transform (`snapshotToOverview`) folds the runtime snapshot
 * into these shapes, and both the daemon (serialize) and the UI (parse) share this
 * leaf so a drift is a compile error, not a silent mis-render.
 *
 * Every section is **aggregate across all repos** with a **repo filter**: the
 * response carries `repos` (the full set, never narrowed) so the UI's filter stays
 * populated, while each section is narrowed to `repo` when the request set one.
 */
import { z } from "zod";
import { issueNumber, repoSlug, routeSchema } from "./primitives";
import { powerActionCatalogSchema, powerActionSurfaceSchema } from "./power-actions";

/**
 * The four human-attention states the "Needs you" band groups (epic #106, DESIGN
 * §9). Ordered most → least urgent: `daemon-anomaly` (the completeness invariant
 * tripped — the daemon is confused about an issue) and `agent-stuck` (a terminal
 * self-stop) sit above `review-maxed` (automated review gave up) and
 * `awaiting-answer` (a normal escalation waiting on a decision).
 */
export const NEEDS_YOU_STATES = [
  "daemon-anomaly",
  "agent-stuck",
  "review-maxed",
  "awaiting-answer",
] as const;

export const needsYouStateSchema = z.enum(NEEDS_YOU_STATES);
export type NeedsYouState = z.infer<typeof needsYouStateSchema>;

/**
 * One item in the "Needs you" band: repo + issue + how long it has waited +
 * a one-line summary, so the operator can triage by urgency without drilling in.
 * `waitingSince` is an absolute instant (or `null` when no run carries one, e.g. a
 * completeness island with no run row) so the UI renders a live-ticking relative
 * time without the value going stale between polls.
 */
export const needsYouItemSchema = z
  .object({
    state: needsYouStateSchema,
    repo: repoSlug,
    issue: issueNumber,
    /** ISO-8601 instant the item entered its attention state, or null if unknown. */
    waitingSince: z.string().nullable(),
    /** One-line headline (escalation/heal-card question, else the issue title). */
    summary: z.string(),
    /** The surface this item sits in; resolves its affordance in the response catalog. */
    powerActionSurface: powerActionSurfaceSchema,
  })
  .strict();
export type NeedsYouItem = z.infer<typeof needsYouItemSchema>;

/** One running agent in the fleet summary: phase + elapsed-in-phase, for an at-a-glance read. */
export const fleetAgentSchema = z
  .object({
    repo: repoSlug,
    issue: issueNumber,
    /**
     * The GitHub issue title, captured at dispatch (issue #13), so the fleet row heads with
     * *which* issue the agent is on. `null` for a run predating the column — the UI falls back
     * to the `repo #issue` reference.
     */
    title: z.string().nullable(),
    /** Display phase: `impl`, `review-1`, `fix-1`, … */
    phase: z.string(),
    /** Live fix-attempt count for the current review phase (0 in impl). */
    fixAttempt: z.number().int().nonnegative(),
    /** ISO-8601 instant the *current phase's* fresh SDK session started (the elapsed clock). */
    phaseStartedAt: z.string(),
    /**
     * The route the **live** phase's container was dispatched on (ADR-0037 P3.1, issue #164):
     * its `{ provider, model, account }` (account id only). `null` when no route was recorded —
     * a box-default / routing-agnostic dispatch, or a run predating the recording.
     */
    route: routeSchema.nullable(),
  })
  .strict();
export type FleetAgent = z.infer<typeof fleetAgentSchema>;

/**
 * The pipeline funnel (epic #106): how many items sit at each stage of the flow,
 * eligible → in-flight → awaiting-ci → awaiting-merge → merged. The first four are
 * current holding counts; `merged` is recent throughput (merges in the
 * recent-activity window), so the funnel reads as flow and surfaces bottlenecks.
 */
export const pipelineFunnelSchema = z
  .object({
    eligible: z.number().int().nonnegative(),
    inFlight: z.number().int().nonnegative(),
    awaitingCi: z.number().int().nonnegative(),
    awaitingMerge: z.number().int().nonnegative(),
    merged: z.number().int().nonnegative(),
  })
  .strict();
export type PipelineFunnel = z.infer<typeof pipelineFunnelSchema>;

/** One entry in the recent-activity feed: a merge / escalation / outcome, newest-first. */
export const activityItemSchema = z
  .object({
    /** The repo, or null for a daemon-global log entry written before a run was scoped. */
    repo: repoSlug.nullable(),
    /** The issue, or null for a daemon-global entry. */
    issue: issueNumber.nullable(),
    /** The outcome event name (e.g. `merged`, `escalated`, `pr-opened`). */
    event: z.string(),
    /** ISO-8601 instant the event was logged. */
    ts: z.string(),
    /** A human one-line rendering of the event + its data. */
    summary: z.string(),
  })
  .strict();
export type ActivityItem = z.infer<typeof activityItemSchema>;

/**
 * The full Overview payload. `repo` echoes the active filter (`null` = aggregate
 * across all repos); `repos` is the full, *unnarrowed* set so the filter dropdown
 * stays populated even while a filter is applied; every section is already narrowed
 * to `repo` when one was requested.
 */
export const overviewResponseSchema = z
  .object({
    /** ISO-8601 instant this view was projected (the snapshot time). */
    generatedAt: z.string(),
    /** The active repo filter, or null when aggregate across all repos. */
    repo: repoSlug.nullable(),
    /** Every known target repo, for the filter — never narrowed by `repo`. */
    repos: z.array(repoSlug),
    /**
     * The daemon's reconcile interval in seconds — the honest "the daemon acts next tick (~Ns)"
     * figure used by power actions on the Needs-you band.
     */
    reconcileIntervalSeconds: z.number().int().positive(),
    /** The attention band, pre-sorted most-urgent-first (triage order). */
    needsYou: z.array(needsYouItemSchema),
    /** Running agents with phase + elapsed. */
    fleet: z.array(fleetAgentSchema),
    /** The pipeline funnel counts. */
    funnel: pipelineFunnelSchema,
    /** Recent merges / escalations / outcomes, newest-first. */
    activity: z.array(activityItemSchema),
    /**
     * The deduplicated power-action affordance catalog (issue #114): every (repo, surface)
     * pair the "Needs you" items reference, emitted once. An item resolves its controls via
     * `powerActions[item.repo]?.[item.powerActionSurface]` — the static descriptor is never
     * repeated per item.
     */
    powerActions: powerActionCatalogSchema,
  })
  .strict();
export type OverviewResponse = z.infer<typeof overviewResponseSchema>;
