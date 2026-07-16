/**
 * The `/api/backlog` wire shape (issue #113, ADR-0031) — the operator's "what is
 * queued, blocked, parked, or misconfigured?" view. Like {@link overviewResponseSchema}
 * it is a thin serialization of `buildSnapshot` (the read edge adds no decision logic,
 * ADR-0029): the pure {@link snapshotToBacklog} transform folds the runtime snapshot
 * into these four sections, and both the daemon (serialize) and the UI (parse) share
 * this leaf so a drift is a compile error, not a silent mis-render.
 *
 * The four sections mirror the daemon's own classification (DESIGN §9, `BacklogView`):
 *   - **eligible** — issues that passed the gate, in the **daemon's actual pick-order**
 *     (the array order is the admission order — never re-sort it);
 *   - **blocked** — issues held on an unsatisfied `## Blocked by`, each carrying its
 *     dependency refs with per-ref satisfaction (the dependency mini-graph);
 *   - **paused** — issues carrying a human-attention label, each tagged with its
 *     {@link BacklogPausedState} so the UI can group by attention state;
 *   - **manualHolds** — ready issues held by `hitl`, the visible surface for
 *     the Tier-1 pause/unpause pair;
 *   - **modingCandidates** — `ready-for-agent` + `afk` issues missing a `mode:*` label
 *     (the auto-mode pass's candidates).
 *
 * Every section is **aggregate across all repos** with a **repo filter**: `repos`
 * (the full set, never narrowed) keeps the UI's filter populated, while each section
 * is narrowed to `repo` when the request set one.
 */
import { z } from "zod";
import { powerActionCatalogSchema, powerActionSurfaceSchema } from "./power-actions";

/** A target-repo slug (`owner/name`); the per-item attribution the repo filter narrows on. */
const repoSlug = z.string();

/** A 1-based GitHub issue number. */
const issueNumber = z.number().int().positive();

/**
 * The four human-attention states the Paused section groups by (DESIGN §9). Ordered
 * most → least urgent, matching the Overview's `NEEDS_YOU_STATES`: `daemon-anomaly`
 * (a completeness island) and `agent-stuck` (a terminal self-stop) above
 * `review-maxed` (automated review gave up) and `awaiting-answer` (a normal
 * escalation). The UI walks this order so the most urgent group renders first.
 */
export const BACKLOG_PAUSED_STATES = [
  "daemon-anomaly",
  "agent-stuck",
  "review-maxed",
  "awaiting-answer",
] as const;

export const backlogPausedStateSchema = z.enum(BACKLOG_PAUSED_STATES);
export type BacklogPausedStateWire = z.infer<typeof backlogPausedStateSchema>;

/** The eligible-row priority colour, bucketed from the issue's rank in `priorityLabels`. */
export const backlogPriorityColorSchema = z.enum(["red", "yellow", "blue"]);
export type BacklogPriorityColorWire = z.infer<typeof backlogPriorityColorSchema>;

/**
 * One eligible issue, positioned by the array index in the daemon's pick-order. Carries
 * the highest-priority label (the scheduling tie-break) as a display tag plus its
 * bucketed row colour, both `null` when the issue has no priority label, and its
 * server-derived power-action affordances.
 */
export const backlogEligibleItemSchema = z
  .object({
    repo: repoSlug,
    issue: issueNumber,
    title: z.string(),
    /** The highest-priority label present (the scheduling tie-break), or null. */
    priority: z.string().nullable(),
    /** Row colour bucketed from the priority label's rank, or null when none. */
    priorityColor: backlogPriorityColorSchema.nullable(),
    /** The surface this row sits in; resolves its affordance in the response catalog. */
    powerActionSurface: powerActionSurfaceSchema,
  })
  .strict();
export type BacklogEligibleItem = z.infer<typeof backlogEligibleItemSchema>;

/** One `## Blocked by` dependency edge: the referenced issue + whether it is satisfied (closed-and-merged). */
export const backlogBlockerSchema = z
  .object({
    /**
     * The referenced (depended-on) issue number, or the verbatim `owner/repo#n` of
     * a cross-repo ref the gate cannot evaluate (always unsatisfied — issue #8).
     */
    ref: z.union([issueNumber, z.string()]),
    /** True once the dep is closed-and-merged (the gate's satisfaction test). */
    satisfied: z.boolean(),
  })
  .strict();
export type BacklogBlocker = z.infer<typeof backlogBlockerSchema>;

/**
 * One blocked issue with its dependency mini-graph: every `## Blocked by` ref and
 * whether it is satisfied, so the UI can render which deps are met vs outstanding.
 */
export const backlogBlockedItemSchema = z
  .object({
    repo: repoSlug,
    issue: issueNumber,
    title: z.string(),
    /** The dependency edges; the issue is blocked while any is unsatisfied. */
    blockers: z.array(backlogBlockerSchema),
    /** The surface this row sits in; resolves its affordance in the response catalog. */
    powerActionSurface: powerActionSurfaceSchema,
  })
  .strict();
export type BacklogBlockedItem = z.infer<typeof backlogBlockedItemSchema>;

/** One paused/stuck issue, tagged with its human-attention state for grouping. */
export const backlogPausedItemSchema = z
  .object({
    repo: repoSlug,
    issue: issueNumber,
    title: z.string(),
    state: backlogPausedStateSchema,
    /** The surface this row sits in; resolves its affordance in the response catalog. */
    powerActionSurface: powerActionSurfaceSchema,
  })
  .strict();
export type BacklogPausedItem = z.infer<typeof backlogPausedItemSchema>;

/** One operator-held ready issue (`hitl`), surfaced so it can be unpaused. */
export const backlogManualHoldItemSchema = z
  .object({
    repo: repoSlug,
    issue: issueNumber,
    title: z.string(),
    /** The surface this row sits in; resolves its affordance in the response catalog. */
    powerActionSurface: powerActionSurfaceSchema,
  })
  .strict();
export type BacklogManualHoldItem = z.infer<typeof backlogManualHoldItemSchema>;

/** One moding-pass candidate: ready + afk but missing a `mode:*` label. */
export const backlogModingCandidateItemSchema = z
  .object({
    repo: repoSlug,
    issue: issueNumber,
    title: z.string(),
    /** The surface this row sits in; resolves its affordance in the response catalog. */
    powerActionSurface: powerActionSurfaceSchema,
  })
  .strict();
export type BacklogModingCandidateItem = z.infer<typeof backlogModingCandidateItemSchema>;

/**
 * One issue waiting on the ADR-0037 **no-provider** condition (issue #165): it passed the gate and
 * is in pick-order, but no allowed provider has an account with headroom this tick, so it is parked
 * (a wait, not a stuck — it keeps `ready-for-agent`, takes no human-attention label). Rendered
 * distinctly from an eligible "queued for a slot" row. `resetsAt` is the approximate instant a
 * provider pool is expected to regain headroom (the "resets ~HH:MM" ETA), or null when unknown —
 * the UI shows the wait either way and only appends the ETA when present.
 */
export const backlogNoProviderItemSchema = z
  .object({
    repo: repoSlug,
    issue: issueNumber,
    title: z.string(),
    /** ISO-8601 instant a provider pool is expected to regain headroom, or null when unknown. */
    resetsAt: z.string().nullable(),
    /** The surface this row sits in; resolves its affordance in the response catalog. */
    powerActionSurface: powerActionSurfaceSchema,
  })
  .strict();
export type BacklogNoProviderItem = z.infer<typeof backlogNoProviderItemSchema>;

/**
 * The full Backlog payload. `repo` echoes the active filter (`null` = aggregate across
 * all repos); `repos` is the full, *unnarrowed* set so the filter dropdown stays
 * populated; every section is already narrowed to `repo` when one was requested.
 * `eligible` is in the daemon's pick-order (array order is significant).
 */
export const backlogResponseSchema = z
  .object({
    /** ISO-8601 instant this view was projected (the snapshot time). */
    generatedAt: z.string(),
    /** The active repo filter, or null when aggregate across all repos. */
    repo: repoSlug.nullable(),
    /** Every known target repo, for the filter — never narrowed by `repo`. */
    repos: z.array(repoSlug),
    /**
     * The daemon's reconcile interval in seconds — the honest "the daemon acts next tick (~Ns)"
     * figure the Tier-1 power actions state (issue #114, ADR-0032: no faked immediacy). Positive integer.
     */
    reconcileIntervalSeconds: z.number().int().positive(),
    /** Eligible issues in the daemon's pick-order (array order is the admission order). */
    eligible: z.array(backlogEligibleItemSchema),
    /** Blocked issues with their dependency mini-graph. */
    blocked: z.array(backlogBlockedItemSchema),
    /** Paused/stuck issues, each tagged with its attention state for grouping. */
    paused: z.array(backlogPausedItemSchema),
    /** Operator-held ready issues (`hitl`) that can be returned with `unpause`. */
    manualHolds: z.array(backlogManualHoldItemSchema),
    /** Ready+afk issues missing a `mode:*` label (the moding pass's candidates). */
    modingCandidates: z.array(backlogModingCandidateItemSchema),
    /** Eligible issues parked on the ADR-0037 no-provider wait (rendered distinctly from `eligible`). */
    noProvider: z.array(backlogNoProviderItemSchema),
    /**
     * The deduplicated power-action affordance catalog (issue #114): every (repo, surface)
     * pair the rows reference, emitted once. A row resolves its controls via
     * `powerActions[row.repo]?.[row.powerActionSurface]` — the static descriptor is never
     * repeated per row.
     */
    powerActions: powerActionCatalogSchema,
  })
  .strict();
export type BacklogResponse = z.infer<typeof backlogResponseSchema>;
