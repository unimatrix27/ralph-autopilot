/**
 * The **live (SSE) wire shape** (ADR-0029/0031, issue #109) — the browser-safe contract
 * for the `/api/live` event stream. Each SSE frame carries one committed log event as a
 * {@link LiveEvent}: its `global_position` (the cursor the client resumes from on
 * reconnect via `Last-Event-ID`), the stream it landed on, and its type + data.
 *
 * The feed is a generic tail over the **whole** event log; the client interprets each
 * frame by its `streamId`:
 *   - a **transcript** stream (`transcript:<repo>#<issue>:<runId>`) carries the verbose
 *     agent messages → the live tool/assistant line on a Fleet-wall card, and
 *   - everything else (the issue `<repo>#<issue>` and system streams) is a **domain**
 *     change → the client refreshes the affected aggregate (fleet / attention badges).
 *
 * Like the rest of the contract leaf this module is **browser-safe**: zod + its own pure
 * helpers, **zero node imports** (the stream-id parser and the transcript-line renderer
 * are re-stated here rather than imported from the node-side `store/events/transcript`,
 * which pulls in the SDK types). The blocks it renders mirror that module's
 * `TranscriptBlock` shapes; the additive-only evolution rule (ADR-0026) applies.
 */
import { z } from "zod";

/** One committed log event, as delivered on the `/api/live` SSE stream. */
export const liveEventSchema = z
  .object({
    /** Monotonic position across the whole log — the SSE cursor (`id:` / `Last-Event-ID`). */
    globalPosition: z.number().int().nonnegative(),
    /** The stream the event committed to (`<repo>#<issue>`, `transcript:…`, or the system stream). */
    streamId: z.string(),
    /** The event `type` discriminant. */
    type: z.string(),
    /** The event payload (opaque to the contract — interpreted per stream family). */
    data: z.unknown(),
  })
  .strict();
export type LiveEvent = z.infer<typeof liveEventSchema>;

// ── transcript stream identity (browser mirror of store/events/transcript) ────

/** The prefix that marks a per-run transcript stream. */
export const TRANSCRIPT_STREAM_PREFIX = "transcript:";

/** A parsed transcript-stream reference. */
export interface TranscriptStreamRef {
  repo: string;
  issueNumber: number;
  runId: string;
}

/** Whether a stream id names a per-run transcript stream. */
export function isTranscriptStreamId(streamId: string): boolean {
  return streamId.startsWith(TRANSCRIPT_STREAM_PREFIX);
}

/**
 * Parse `transcript:<repo>#<issue>:<runId>` into its parts, or `null` for anything that
 * is not a well-formed transcript stream. A repo slug contains neither `#` nor `:`, so
 * the issue number is between the first `#` and the first `:` after it, and the runId is
 * everything past that `:`.
 */
export function parseTranscriptStreamRef(streamId: string): TranscriptStreamRef | null {
  if (!isTranscriptStreamId(streamId)) {
    return null;
  }
  const rest = streamId.slice(TRANSCRIPT_STREAM_PREFIX.length);
  const hash = rest.indexOf("#");
  if (hash <= 0) {
    return null;
  }
  const repo = rest.slice(0, hash);
  const afterHash = rest.slice(hash + 1);
  const colon = afterHash.indexOf(":");
  if (colon <= 0) {
    return null;
  }
  const issuePart = afterHash.slice(0, colon);
  if (!/^\d+$/.test(issuePart)) {
    return null;
  }
  const runId = afterHash.slice(colon + 1);
  if (!runId) {
    return null;
  }
  return { repo, issueNumber: Number(issuePart), runId };
}

// ── live-event classification ─────────────────────────────────────────────────

/** A live event recognised as a per-run transcript line. */
export interface TranscriptLiveEvent {
  kind: "transcript";
  ref: TranscriptStreamRef;
  event: LiveEvent;
}

/** A live event that is a domain change (issue / system stream) — refresh the aggregate. */
export interface DomainLiveEvent {
  kind: "domain";
  event: LiveEvent;
}

export type ClassifiedLiveEvent = TranscriptLiveEvent | DomainLiveEvent;

/**
 * Classify a {@link LiveEvent} by its stream family so the UI can route it: a parseable
 * transcript stream → a Fleet-wall line; everything else (issue + system streams, or a
 * malformed transcript id) → a domain refresh.
 */
export function classifyLiveEvent(event: LiveEvent): ClassifiedLiveEvent {
  const ref = parseTranscriptStreamRef(event.streamId);
  return ref ? { kind: "transcript", ref, event } : { kind: "domain", event };
}

// ── live transcript line rendering ─────────────────────────────────────────────

/** The kind of content a rendered live line came from (drives its badge/icon). */
export type LiveLineKind = "tool_use" | "tool_result" | "text" | "thinking";

/** A one-line rendering of the latest meaningful block of a transcript message. */
export interface LiveLine {
  kind: LiveLineKind;
  /** A short, single-line, human rendering (already trimmed to a sane length). */
  text: string;
}

/** Max characters of free text shown on a live line before it is elided. */
const MAX_LINE = 140;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_LINE ? `${flat.slice(0, MAX_LINE - 1)}…` : flat;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Render the latest meaningful line of a transcript message's `data` (the SSE frame's
 * payload for a `TranscriptMessage`), or `null` when it carries nothing renderable.
 * Tolerant of an unknown/partial shape — the live feed must never throw on a message it
 * does not fully understand. Prefers the **last** actionable block (a tool call or tool
 * result is the most informative "what is the agent doing now"), then assistant text,
 * then thinking.
 */
export function transcriptLatestLine(data: unknown): LiveLine | null {
  if (!isRecord(data) || !Array.isArray(data.blocks)) {
    return null;
  }
  const blocks = data.blocks.filter(isRecord);
  // Last tool_use → "the agent is calling X"; the strongest signal of current activity.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.kind === "tool_use") {
      const name = typeof b.name === "string" && b.name ? b.name : "tool";
      const arg = summariseToolInput(b.input);
      return { kind: "tool_use", text: arg ? `${name}: ${arg}` : name };
    }
  }
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.kind === "tool_result") {
      const ok = b.isError === true ? "error" : "ok";
      return { kind: "tool_result", text: `tool result (${ok})` };
    }
  }
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.kind === "text" && typeof b.text === "string" && b.text.trim()) {
      return { kind: "text", text: oneLine(b.text) };
    }
  }
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.kind === "thinking" && typeof b.text === "string" && b.text.trim()) {
      return { kind: "thinking", text: oneLine(b.text) };
    }
  }
  return null;
}

/** A short, single-line rendering of a tool call's input (the most identifying field). */
function summariseToolInput(input: unknown): string | null {
  if (typeof input === "string") {
    return oneLine(input);
  }
  if (!isRecord(input)) {
    return null;
  }
  // Common, identifying fields across the box's tools, in rough order of usefulness.
  for (const key of ["command", "file_path", "path", "pattern", "query", "url", "description"]) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) {
      return oneLine(v);
    }
  }
  return null;
}
