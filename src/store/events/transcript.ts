/**
 * The **agent transcript** vocabulary (ADR-0030): the verbose, message-level record
 * of what an agent actually did — its assistant turns, tool calls, tool results, and
 * the session result — captured from the Claude Agent SDK message stream.
 *
 * Transcripts are a **two-tier** companion to the domain timeline (ADR-0021/0024):
 *
 *  - The **domain timeline** (`<repo>#<issue>` issue stream) is the permanent story of
 *    a run's lifecycle — `RunStarted … Merged`. It is never pruned.
 *  - The **transcript** lives on a **dedicated per-run stream**
 *    `transcript:<repo>#<issue>:<runId>`, **appended raw**: no inline domain
 *    projection, no expected-version guard, and never on the issue/domain stream. It is
 *    verbose and **prunable** under a retention budget (see {@link planTranscriptRetention}),
 *    leaving a {@link TranscriptPruned} marker so the viewer can explain why an old run's
 *    conversation is gone while its timeline survives.
 *
 * This module is **pure**: stream-id helpers, the event vocabulary, the
 * `SDKMessage → transcript event` mapper (message-level granularity; token-level
 * streaming deferred), and the retention planner. The Emmett wiring that appends/reads/
 * prunes lives in {@link import("../event-log").EventLog}; the live capture sink that
 * redacts + serialises appends lives in {@link import("../../executor/transcript-sink")}.
 *
 * The additive-only evolution rule (ADR-0026) documented in {@link import("./event-types")}
 * applies here verbatim: never mutate or remove a field; add optional fields or mint a
 * new type.
 */

import type { Event } from "@event-driven-io/emmett";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// ── stream identity (`transcript:<repo>#<issue>:<runId>`) ─────────────────────

/**
 * The prefix that marks a per-run transcript stream. It keeps transcript streams
 * disjoint from issue streams (`<repo>#<issue>`) and the system stream (`$…`): a repo
 * slug never starts with `transcript:` or `$`, so the three families never collide.
 */
export const TRANSCRIPT_STREAM_PREFIX = "transcript:";

/** The stream id for one run's transcript: `transcript:<repo>#<issue>:<runId>` (ADR-0030). */
export function transcriptStreamId(repo: string, issueNumber: number, runId: string): string {
  return `${TRANSCRIPT_STREAM_PREFIX}${repo}#${issueNumber}:${runId}`;
}

/** A parsed transcript-stream reference. */
export interface TranscriptStreamRef {
  repo: string;
  issueNumber: number;
  runId: string;
}

/** Whether a stream id names a per-run transcript stream. */
export function isTranscriptStream(streamId: string): boolean {
  return streamId.startsWith(TRANSCRIPT_STREAM_PREFIX);
}

/**
 * Parse a `transcript:<repo>#<issue>:<runId>` stream id back into its parts, or `null`
 * for anything that is not a well-formed transcript stream. A repo slug contains neither
 * `#` nor `:`, so the issue number is the run between the **first** `#` and the **first**
 * `:` after it, and the runId is everything past that `:` (runIds are opaque strings).
 */
export function parseTranscriptStreamId(streamId: string): TranscriptStreamRef | null {
  if (!isTranscriptStream(streamId)) {
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

// ── transcript event vocabulary ──────────────────────────────────────────────

/** The conversational role a captured message played. */
export type TranscriptRole = "assistant" | "user" | "result" | "system";

/**
 * One normalised content block of a captured message — message-level granularity
 * (token-level streaming deferred). The shapes mirror the SDK's Anthropic content
 * blocks, reduced to just the fields a viewer renders, so the transcript is
 * self-contained and not coupled to the SDK's internal types.
 */
export type TranscriptBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; toolUseId: string; content: unknown; isError: boolean }
  | { kind: "other"; raw: unknown };

/**
 * One captured SDK message, message-level. Carried on the per-run transcript stream.
 * `runId` is the correlation tag (ADR-0022) the stream is keyed by; `at` is when the
 * sink captured it; `sdkType` is the raw `SDKMessage.type`; `blocks` are the normalised,
 * **redacted** content (the sink redacts before persistence — ADR-0030).
 */
export type TranscriptMessage = Event<
  "TranscriptMessage",
  {
    runId: string;
    at: string;
    role: TranscriptRole;
    sdkType: string;
    subtype?: string;
    uuid?: string;
    blocks: TranscriptBlock[];
  }
>;

/**
 * The marker left when a run's verbose transcript is pruned under the retention budget
 * (ADR-0030). It replaces the deleted {@link TranscriptMessage}s on the stream so the
 * viewer can show "transcript pruned" — the conversation is gone, but the domain timeline
 * (the issue stream) survives.
 */
export type TranscriptPruned = Event<
  "TranscriptPruned",
  {
    runId: string;
    at: string;
    /** How many {@link TranscriptMessage}s were dropped. */
    prunedMessageCount: number;
    /** Why it was pruned: aged past the budget, or evicted oldest-first for the size cap. */
    reason: TranscriptPruneReason;
  }
>;

/** The discriminated union of every transcript-stream event. */
export type TranscriptEvent = TranscriptMessage | TranscriptPruned;

/** Every transcript-event `type` discriminant. */
export type TranscriptEventType = TranscriptEvent["type"];

/** The event-type string of a {@link TranscriptMessage} (the prunable verbose record). */
export const TRANSCRIPT_MESSAGE_TYPE: TranscriptMessage["type"] = "TranscriptMessage";
/** The event-type string of a {@link TranscriptPruned} marker. */
export const TRANSCRIPT_PRUNED_TYPE: TranscriptPruned["type"] = "TranscriptPruned";

// ── the pure SDKMessage → transcript event mapper ────────────────────────────

/** Context the mapper stamps onto each event (the stream's runId + capture time). */
export interface TranscriptMapContext {
  runId: string;
  at: string;
}

/**
 * Normalise an SDK message's `content` (a string or an array of Anthropic content
 * blocks) into {@link TranscriptBlock}s. Tolerant: an unknown block shape is preserved
 * verbatim as a `{ kind: "other" }` block rather than dropped, so capture never loses a
 * message it does not fully understand. **No redaction here** — the sink redacts the
 * whole event before persistence (ADR-0030), keeping this mapper pure and shape-only.
 */
function normaliseContent(content: unknown): TranscriptBlock[] {
  if (typeof content === "string") {
    return [{ kind: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return content == null ? [] : [{ kind: "other", raw: content }];
  }
  return content.map((block): TranscriptBlock => {
    if (!block || typeof block !== "object") {
      return { kind: "other", raw: block };
    }
    const b = block as Record<string, unknown>;
    switch (b.type) {
      case "text":
        return { kind: "text", text: typeof b.text === "string" ? b.text : String(b.text ?? "") };
      case "thinking":
        return { kind: "thinking", text: typeof b.thinking === "string" ? b.thinking : String(b.thinking ?? "") };
      case "tool_use":
        return {
          kind: "tool_use",
          id: typeof b.id === "string" ? b.id : "",
          name: typeof b.name === "string" ? b.name : "",
          input: b.input,
        };
      case "tool_result":
        return {
          kind: "tool_result",
          toolUseId: typeof b.tool_use_id === "string" ? b.tool_use_id : "",
          content: b.content,
          isError: b.is_error === true,
        };
      default:
        return { kind: "other", raw: block };
    }
  });
}

/**
 * Map one {@link SDKMessage} to a {@link TranscriptMessage} at **message-level**
 * granularity, or `null` when the message is not part of the conversational transcript
 * (token-level streaming partials, rate-limit telemetry, system bookkeeping — all
 * deferred). Pure: the same input always yields the same event, with **no** redaction
 * (the sink redacts before persistence).
 *
 * The representative conversational shapes are covered: assistant text + `tool_use`
 * blocks (`assistant`), `tool_result` blocks (`user`), and the session `result`.
 */
export function mapSdkMessageToTranscript(
  message: SDKMessage,
  ctx: TranscriptMapContext,
): TranscriptMessage["data"] | null {
  switch (message.type) {
    case "assistant":
    case "user":
      // Identical shape; the role literal equals the SDK type, so TS narrows
      // `message.type` to 'assistant' | 'user' — both valid TranscriptRoles.
      return {
        runId: ctx.runId,
        at: ctx.at,
        role: message.type,
        sdkType: message.type,
        ...(message.uuid ? { uuid: message.uuid } : {}),
        blocks: normaliseContent(message.message?.content),
      };
    case "result":
      return {
        runId: ctx.runId,
        at: ctx.at,
        role: "result",
        sdkType: message.type,
        subtype: message.subtype,
        ...(message.uuid ? { uuid: message.uuid } : {}),
        // A result carries a final text only on success; an error result has none.
        blocks: message.subtype === "success" ? [{ kind: "text", text: message.result }] : [],
      };
    default:
      // Streaming partials, rate-limit events, system/status bookkeeping, etc. are not
      // part of the message-level transcript (token-level is deferred — ADR-0030).
      return null;
  }
}

// ── retention (two-tier: timeline permanent, transcript prunable) ─────────────

/** Why a transcript stream was pruned. */
export type TranscriptPruneReason = "age" | "size";

/** The retention budget for verbose transcripts (ADR-0030). */
export interface TranscriptRetentionBudget {
  /** Prune a run's transcript once its newest message is older than this many days. */
  maxAgeDays: number;
  /**
   * Optional global size cap (bytes) across all (un-pruned) transcripts. When the total
   * exceeds it, the oldest streams are pruned first until back under the cap. Omit → no
   * size cap (age is the only budget).
   */
  maxTotalBytes?: number;
}

/** A summary of one un-pruned transcript stream, the input to {@link planTranscriptRetention}. */
export interface TranscriptStreamSummary {
  streamId: string;
  repo: string;
  issueNumber: number;
  runId: string;
  /** ISO timestamp of the stream's newest message, or `null` if unknown. */
  newestAt: string | null;
  /** Approximate stored size of the stream's messages, in bytes. */
  byteSize: number;
  /** How many verbose {@link TranscriptMessage}s the stream holds. */
  messageCount: number;
}

/** One stream selected for pruning, with the reason it was chosen. */
export interface TranscriptPrunePlan {
  streamId: string;
  reason: TranscriptPruneReason;
}

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

/** Sort key for "oldest-first": the stream's newest-message time (unknown → oldest). */
function ageKey(summary: TranscriptStreamSummary): number {
  if (!summary.newestAt) {
    return 0;
  }
  const t = Date.parse(summary.newestAt);
  return Number.isFinite(t) ? t : 0;
}

/**
 * **Pure** retention planner (ADR-0030): given the un-pruned transcript summaries, a
 * budget, and the current time, decide which streams to prune. Two rules compose:
 *
 *  1. **Age** — any stream whose newest message is older than `maxAgeDays` is pruned.
 *  2. **Size** — if a `maxTotalBytes` cap is set and the surviving streams still exceed
 *     it, prune the **oldest first** until back under the cap.
 *
 * Returns the streams to prune (de-duplicated; an age-pruned stream is never also counted
 * for size). A stream already reduced to its marker is not in `summaries` (it has no
 * verbose messages), so it is never re-pruned.
 */
export function planTranscriptRetention(
  summaries: readonly TranscriptStreamSummary[],
  budget: TranscriptRetentionBudget,
  now: Date,
): TranscriptPrunePlan[] {
  const cutoff = now.getTime() - budget.maxAgeDays * MILLIS_PER_DAY;
  const chosen = new Map<string, TranscriptPruneReason>();

  for (const summary of summaries) {
    if (ageKey(summary) < cutoff) {
      chosen.set(summary.streamId, "age");
    }
  }

  if (budget.maxTotalBytes != null) {
    const survivors = summaries.filter((s) => !chosen.has(s.streamId));
    let total = survivors.reduce((sum, s) => sum + s.byteSize, 0);
    if (total > budget.maxTotalBytes) {
      const oldestFirst = [...survivors].sort((a, b) => ageKey(a) - ageKey(b));
      for (const summary of oldestFirst) {
        if (total <= budget.maxTotalBytes) {
          break;
        }
        chosen.set(summary.streamId, "size");
        total -= summary.byteSize;
      }
    }
  }

  return [...chosen].map(([streamId, reason]) => ({ streamId, reason }));
}
