/**
 * The **run detail + transcript** wire shape (ADR-0030/0031, issue #111) — the browser-safe
 * contract for `/api/run` and `/api/runs`. Both the daemon (serialize) and the UI (parse)
 * share this leaf, so a drift is a compile error, not a silent mis-render.
 *
 * A run's window is **two-tier** (ADR-0030):
 *   - the **timeline** is the permanent issue-stream domain story (`RunStarted … Merged`),
 *     carried here as raw recorded events ordered by their global position; and
 *   - the **transcript** is the verbose, prunable record captured from the SDK message
 *     stream — `TranscriptMessage`s, or, once aged out, a single `TranscriptPruned` marker.
 *
 * The two streams share one monotonic `globalPosition` sequence (Emmett stamps it across
 * every stream), so the viewer interleaves transcript messages and domain events into one
 * chronological order and a timeline click jumps to the matching transcript point.
 *
 * Browser-safe like the rest of the leaf (zod only, zero node imports): the transcript-block
 * shapes mirror the node-side `store/events/transcript` `TranscriptBlock`s rather than
 * importing them (that module pulls in the SDK types). The additive-only evolution rule
 * (ADR-0026) applies — never mutate/remove a field; add optional fields or mint a new type.
 */
import { z } from "zod";
import { issueNumber, repoSlug, routeSchema } from "./primitives";

const nonNegInt = z.number().int().nonnegative();
const prNumber = z.number().int().positive();

/**
 * A run's lifecycle status — the wire mirror of the node-side `RunStatus` (store/types).
 * Mirrored, not imported, to keep the leaf browser-safe; the daemon serializes the folded
 * `effectiveStatus` into one of these and the UI maps it to a status badge.
 */
export const RUN_STATUSES = [
  "running",
  "awaiting-answer",
  "agent-stuck",
  "review-maxed",
  "awaiting-ci",
  "awaiting-merge",
  "merged",
  "closed",
] as const;
export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatusWire = z.infer<typeof runStatusSchema>;

/**
 * Statuses whose transcript is fully historical: the run has terminalized, so no agent
 * will ever append to it again. The run-detail viewer opens no live tail (and shows no
 * pause / jump-to-latest controls) for these — every other status is treated as *live*.
 *
 * Crucially `awaiting-merge` is live, not terminal: the integration agent runs while the
 * run deliberately stays `awaiting-merge` until it terminalizes (`integrate` in
 * src/executor/executor.ts), and the Live wall links every active agent — integration
 * included — to this page. A Fleet card therefore must still land on the streaming
 * transcript, not a frozen one (issue #111 review).
 */
export const TERMINAL_RUN_STATUSES = ["agent-stuck", "review-maxed", "merged", "closed"] as const;
const TERMINAL_RUN_STATUS_SET: ReadonlySet<RunStatusWire> = new Set(TERMINAL_RUN_STATUSES);

/** Whether a run may still stream transcript (non-terminal) — gates the run-detail live tail. */
export function isLiveRunStatus(status: RunStatusWire): boolean {
  return !TERMINAL_RUN_STATUS_SET.has(status);
}

/** A run's implementation mode — the wire mirror of the node-side `Mode` (store/types). */
export const runModeSchema = z.enum(["tdd", "infra", "ui"]);
export type RunModeWire = z.infer<typeof runModeSchema>;

/** Why a transcript was pruned — the wire mirror of `TranscriptPruneReason`. */
export const transcriptPruneReasonSchema = z.enum(["age", "size"]);
export type TranscriptPruneReasonWire = z.infer<typeof transcriptPruneReasonSchema>;

// ── transcript blocks (mirror of store/events/transcript TranscriptBlock) ──────

const textBlockSchema = z.object({ kind: z.literal("text"), text: z.string() });
const thinkingBlockSchema = z.object({ kind: z.literal("thinking"), text: z.string() });
const toolUseBlockSchema = z.object({
  kind: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
const toolResultBlockSchema = z.object({
  kind: z.literal("tool_result"),
  toolUseId: z.string(),
  content: z.unknown(),
  isError: z.boolean(),
});
const otherBlockSchema = z.object({ kind: z.literal("other"), raw: z.unknown() });

/** One normalised content block of a captured message. */
export const transcriptBlockSchema = z.discriminatedUnion("kind", [
  textBlockSchema,
  thinkingBlockSchema,
  toolUseBlockSchema,
  toolResultBlockSchema,
  otherBlockSchema,
]);
export type TranscriptBlockWire = z.infer<typeof transcriptBlockSchema>;

/** The payload of a captured `TranscriptMessage` event. */
export const transcriptMessageDataSchema = z.object({
  runId: z.string(),
  at: z.string(),
  role: z.enum(["assistant", "user", "result", "system"]),
  sdkType: z.string(),
  subtype: z.string().optional(),
  uuid: z.string().optional(),
  blocks: z.array(transcriptBlockSchema),
});
export type TranscriptMessageData = z.infer<typeof transcriptMessageDataSchema>;

/** The payload of a `TranscriptPruned` marker (the verbose log aged/evicted out). */
export const transcriptPrunedDataSchema = z.object({
  runId: z.string(),
  at: z.string(),
  prunedMessageCount: nonNegInt,
  reason: transcriptPruneReasonSchema,
});
export type TranscriptPrunedData = z.infer<typeof transcriptPrunedDataSchema>;

/** One event read back from a per-run transcript stream, with its ordering metadata. */
export const transcriptEntrySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("TranscriptMessage"),
    globalPosition: nonNegInt,
    streamPosition: nonNegInt,
    data: transcriptMessageDataSchema,
  }),
  z.object({
    type: z.literal("TranscriptPruned"),
    globalPosition: nonNegInt,
    streamPosition: nonNegInt,
    data: transcriptPrunedDataSchema,
  }),
]);
export type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;

// ── domain timeline (raw issue-stream events) ──────────────────────────────────

/**
 * One domain event on the run's timeline (an issue-stream event), with ordering metadata.
 * `type` is the past-tense fact (`RunStarted`, `FixAttempted`, `Merged`, …) and `data` is
 * its opaque payload — the viewer interprets each by type, so it stays tolerant of an
 * unknown/future fact (ADR-0026). The permanent tier: it survives a transcript prune.
 */
export const timelineEntrySchema = z.object({
  globalPosition: nonNegInt,
  streamPosition: nonNegInt,
  type: z.string(),
  data: z.unknown(),
  /**
   * The route this phase dispatched on, populated for a `RouteResolved` entry (ADR-0037 P3.1,
   * issue #164) so the timeline shows the route **per past phase** as a typed field, not just
   * inside the opaque `data`. Absent for every other event type. One route per container (no
   * mid-phase rotation): a resume re-dispatch is its own later `RouteResolved` entry.
   */
  route: routeSchema.optional(),
});
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

// ── run header ─────────────────────────────────────────────────────────────────

/**
 * The run header: status, PR, branch, mode, timing, and per-phase fix attempts — the gist
 * the operator reads before diving into the conversation (epic #106 story 19). `runId` is
 * the correlation tag the transcript stream is keyed by, echoed for live-tail filtering.
 * `fixAttempts` maps a phase (`"0"`/`"1"`/`"2"`) to its current attempt count.
 */
export const runHeaderSchema = z
  .object({
    repo: repoSlug,
    issue: issueNumber,
    runId: z.string(),
    status: runStatusSchema,
    mode: runModeSchema,
    branch: z.string().nullable(),
    prNumber: prNumber.nullable(),
    /** ISO-8601 instant the run row was created (the duration anchor). */
    startedAt: z.string(),
    /** ISO-8601 instant the run row last changed (the duration's far end). */
    updatedAt: z.string(),
    /**
     * The current run span's `RunStarted` global position. Re-admitted issues may reuse
     * the same runId, so live transcript consumers must use this boundary as well.
     */
    spanStartGlobalPosition: nonNegInt,
    /** Per-phase fix-attempt counts, keyed by phase number as a string. */
    fixAttempts: z.record(z.string(), nonNegInt),
  })
  .strict();
export type RunHeader = z.infer<typeof runHeaderSchema>;

/** The full `/api/run` payload: header + permanent timeline + (prunable) transcript. */
export const runDetailResponseSchema = z
  .object({
    /** ISO-8601 instant this view was projected. */
    generatedAt: z.string(),
    run: runHeaderSchema,
    /** The permanent domain timeline (issue-stream events for this run), oldest-first. */
    timeline: z.array(timelineEntrySchema),
    /** The verbose captured transcript, oldest-first; a lone `TranscriptPruned` once aged. */
    transcript: z.array(transcriptEntrySchema),
    /** The pruned marker if the verbose log aged out (the timeline still renders), else null. */
    pruned: transcriptPrunedDataSchema.nullable(),
  })
  .strict();
export type RunDetailResponse = z.infer<typeof runDetailResponseSchema>;

// ── runs index ───────────────────────────────────────────────────────────────

/** One row in the run history index: enough to triage and open a run. */
export const runSummarySchema = z
  .object({
    repo: repoSlug,
    issue: issueNumber,
    runId: z.string(),
    status: runStatusSchema,
    mode: runModeSchema,
    branch: z.string().nullable(),
    prNumber: prNumber.nullable(),
    startedAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type RunSummary = z.infer<typeof runSummarySchema>;

/** The `/api/runs` payload: every run newest-first, with the repo filter echoed. */
export const runsResponseSchema = z
  .object({
    generatedAt: z.string(),
    /** The active repo filter, or null when aggregate across all repos. */
    repo: repoSlug.nullable(),
    /** Every known target repo, for the filter — never narrowed by `repo`. */
    repos: z.array(repoSlug),
    /** Runs newest-first (by last activity). */
    runs: z.array(runSummarySchema),
  })
  .strict();
export type RunsResponse = z.infer<typeof runsResponseSchema>;
