/**
 * Pure builders for the run history + run-detail read models (issue #111). They serialise
 * store reads — run rows, the permanent issue-stream timeline, and the prunable transcript —
 * into the browser-safe wire shapes ({@link RunsResponse} / {@link RunDetailResponse}), adding
 * **no decision logic** (ADR-0029: the read edge is a thin serialization of existing state).
 * Kept pure (the store reads happen in {@link import("./control-plane").createWebPorts}) so the
 * mapping is unit-testable without a database.
 *
 * A run is keyed by its issue: there is exactly one `runs` row per (repo, issue), so its
 * numeric `runs.id` *is* the transcript stream's `runId` correlation tag (ADR-0022/0030) —
 * derived here and echoed for live-tail correlation.
 */
import type { Run } from "../store/types";
import type { RecordedStreamEvent, RecordedTranscriptEvent } from "../store/event-log";
import { coerceRoute } from "../store/events/projection";
import { toWireRoute } from "./overview";
import type {
  Route,
  RunDetailResponse,
  RunSummary,
  RunsResponse,
  TimelineEntry,
  TranscriptEntry,
  TranscriptMessageData,
  TranscriptPrunedData,
} from "./contract";

/** A run's transcript correlation tag (the numeric run id as a string). */
export function runIdOf(run: Run): string {
  return String(run.id);
}

/**
 * The `runId` tag an issue-stream event carries — every run-lifecycle fact echoes its
 * span's `runId` (ADR-0022) — or `null` for an issue-level event that belongs to no single
 * run (`AnomalyDetected`/`AnomalyCleared`, which carry no `runId`). Used to scope the
 * permanent timeline to the viewed run's span.
 */
function eventRunId(data: unknown): string | null {
  if (data !== null && typeof data === "object" && typeof (data as { runId?: unknown }).runId === "string") {
    return (data as { runId: string }).runId;
  }
  return null;
}

/** Map a run row to its index summary. */
export function toRunSummary(run: Run): RunSummary {
  return {
    repo: run.repo,
    issue: run.issueNumber,
    runId: runIdOf(run),
    status: run.status,
    mode: run.mode,
    branch: run.branch,
    prNumber: run.prNumber,
    // The issue title captured at dispatch (issue #13); null for a pre-migration run.
    title: run.issueTitle,
    startedAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

export interface RunDetailProjection {
  /**
   * The issue projection's append timestamp. The legacy run row is not touched by
   * terminal lifecycle facts, so terminal run duration must settle against this clock.
   */
  updatedAt: string;
}

/** Build the `/api/runs` index: every run newest-first (by last activity), repo filter echoed. */
export function toRunsResponse(
  runs: readonly Run[],
  opts: { now: () => Date; repos: string[]; repo?: string },
): RunsResponse {
  const summaries = runs
    .map(toRunSummary)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return {
    generatedAt: opts.now().toISOString(),
    repo: opts.repo ?? null,
    repos: opts.repos,
    runs: summaries,
  };
}

/**
 * Per-phase fix-attempt counts, folded from the timeline exactly as the domain projection
 * does (ADR-0025): the count for a phase is the number of `FixAttempted` since the latest
 * `ReviewPhaseEntered` for that phase (re-entering a phase resets it).
 */
function foldFixAttempts(timeline: readonly RecordedStreamEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const ev of timeline) {
    const data = ev.data;
    const phase = data && typeof data === "object" && typeof (data as { phase?: unknown }).phase === "number"
      ? String((data as { phase: number }).phase)
      : null;
    if (phase === null) {
      continue;
    }
    if (ev.type === "ReviewPhaseEntered") {
      counts[phase] = 0;
    } else if (ev.type === "FixAttempted") {
      counts[phase] = (counts[phase] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * The typed route a `RouteResolved` timeline entry carries (ADR-0037 P3.1, issue #164), surfaced
 * as a first-class field so the run-detail timeline shows the route **per past phase** without the
 * UI reaching into the opaque `data`. Returns `undefined` for any other event type, or when the
 * recorded route fails the shape check (a route-less/box-default dispatch, or corrupt data) — the
 * raw fact stays in `data` either way, so this is purely additive. The validation reuses the
 * fleet path's shared {@link coerceRoute} (one tolerant `unknown → PhaseRoute` reader) and the
 * single node→wire mapping {@link toWireRoute}, so both read paths validate identically and the
 * `model` normalisation lives in one place.
 */
function timelineRoute(ev: RecordedStreamEvent): Route | undefined {
  if (ev.type !== "RouteResolved") {
    return undefined;
  }
  const raw = ev.data && typeof ev.data === "object" ? (ev.data as { route?: unknown }).route : undefined;
  return toWireRoute(coerceRoute(raw)) ?? undefined;
}

/** Map a recorded transcript event to its wire entry, or null for an unrecognised type. */
function toTranscriptEntry(ev: RecordedTranscriptEvent): TranscriptEntry | null {
  if (ev.type === "TranscriptMessage") {
    return {
      type: "TranscriptMessage",
      globalPosition: ev.globalPosition,
      streamPosition: ev.streamPosition,
      data: ev.data as TranscriptMessageData,
    };
  }
  if (ev.type === "TranscriptPruned") {
    return {
      type: "TranscriptPruned",
      globalPosition: ev.globalPosition,
      streamPosition: ev.streamPosition,
      data: ev.data as TranscriptPrunedData,
    };
  }
  return null;
}

/**
 * Build the `/api/run` detail: the run header, the permanent domain timeline (this run's
 * span of the issue stream), and the verbose transcript (or a lone pruned marker once aged
 * out, surfaced as `pruned`).
 *
 * The issue stream `<repo>#<issue>` is permanent and can carry **several run spans** — a
 * re-pickup after a transient drop appends a fresh `RunStarted`. Crucially the `runId` tag
 * alone does **not** separate those spans: `runs.id` (hence `runId`) is REUSED when the same
 * (repo, issue) is re-admitted, because `upsertRun` updates the existing row in place
 * (`ON CONFLICT(repo, issue_number) DO UPDATE`), so a fresh attempt after a terminal/healed
 * one appends its `RunStarted` and writes its transcript under the **same** `runId` as the
 * prior attempt. The discriminator that *does* separate them is the **span boundary**: the
 * current run begins at the latest `RunStarted`, every event of this run (timeline +
 * transcript) has a global position at or after it, and every prior span's event precedes it
 * (global position is monotonic across all streams). The timeline (and the fix-attempt fold
 * over it) is therefore scoped to the viewed run by `runId` **and** that boundary — and the
 * transcript, read from the shared `transcript:<repo>#<issue>:<runId>` stream, is bounded by
 * the same span so a prior attempt's conversation never renders as this run's. A
 * prior/abandoned span thus never pollutes this run's header, timeline, transcript, or
 * fix-attempt counts. Issue-level events that belong to no single run
 * (`AnomalyDetected`/`AnomalyCleared`, which carry no `runId`) are kept regardless of span.
 */
export function toRunDetailResponse(input: {
  run: Run;
  timeline: readonly RecordedStreamEvent[];
  transcript: readonly RecordedTranscriptEvent[];
  projection?: RunDetailProjection | null;
  now: () => Date;
}): RunDetailResponse {
  const { run, timeline, transcript } = input;
  const runId = runIdOf(run);
  // The current run's span starts at the latest `RunStarted` on the issue stream. `0` (no
  // `RunStarted` seen — the synchronous claim window, or a transcript-only read) disables the
  // bound, keeping every event, which is the safe default for a single-span run.
  const spanStart = timeline.reduce(
    (max, ev) => (ev.type === "RunStarted" && ev.globalPosition > max ? ev.globalPosition : max),
    0,
  );
  const ownTimeline = timeline.filter((ev) => {
    const evRunId = eventRunId(ev.data);
    // Issue-level events (anomalies) belong to the whole issue, not a single run span.
    if (evRunId === null) {
      return true;
    }
    // A run-scoped event is this run's only if it tags this `runId` AND falls in this span —
    // the span bound is what isolates a prior attempt that reused the same `runId`.
    return evRunId === runId && ev.globalPosition >= spanStart;
  });
  const timelineEntries: TimelineEntry[] = ownTimeline.map((ev) => {
    const route = timelineRoute(ev);
    return {
      globalPosition: ev.globalPosition,
      streamPosition: ev.streamPosition,
      type: ev.type,
      data: ev.data,
      // Surface the per-phase route as a typed field for a RouteResolved entry (ADR-0037 P3.1).
      ...(route ? { route } : {}),
    };
  });
  const transcriptEntries: TranscriptEntry[] = [];
  let pruned: TranscriptPrunedData | null = null;
  for (const ev of transcript) {
    // The transcript stream is shared across spans that reuse the `runId`; drop a prior
    // attempt's messages (and its pruned marker) so only this span's conversation renders.
    if (ev.globalPosition < spanStart) {
      continue;
    }
    const entry = toTranscriptEntry(ev);
    if (!entry) {
      continue;
    }
    transcriptEntries.push(entry);
    if (entry.type === "TranscriptPruned") {
      pruned = entry.data;
    }
  }
  return {
    generatedAt: input.now().toISOString(),
    run: {
      repo: run.repo,
      issue: run.issueNumber,
      runId: runIdOf(run),
      status: run.status,
      mode: run.mode,
      branch: run.branch,
      prNumber: run.prNumber,
      // The issue title captured at dispatch (issue #13); null for a pre-migration run.
      title: run.issueTitle,
      startedAt: run.createdAt,
      updatedAt: input.projection?.updatedAt ?? run.updatedAt,
      spanStartGlobalPosition: spanStart,
      fixAttempts: foldFixAttempts(ownTimeline),
    },
    timeline: timelineEntries,
    transcript: transcriptEntries,
    pruned,
  };
}
