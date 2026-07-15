/**
 * The **transcript capture sink** (ADR-0030): the side-channel that owns the agent
 * transcript. It is applied inside the one execution chokepoint —
 * {@link import("./agent").runReapedWallClockedSession}, shared by
 * impl/resume/review/fix/moding — and for each completed `SDKMessage`:
 *
 *   1. maps it to a message-level transcript event (the pure
 *      {@link import("../store/events/transcript").mapSdkMessageToTranscript}),
 *   2. **redacts** its content with the existing `log/` secret-redaction *before*
 *      persistence, and
 *   3. appends it raw to the run's dedicated stream (`transcript:<repo>#<issue>:<runId>`).
 *
 * Capture is a **best-effort edge**, never on the run's critical path: `capture()` never
 * throws (a malformed message or a failed append is logged via `onError` and dropped),
 * and appends are **serialised** through one promise chain so concurrent messages cannot
 * race on the stream's append position. {@link TranscriptSink.flush} awaits the chain so
 * a caller can ensure every captured message is durable before the session is torn down.
 */

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { redact, type Logger } from "../log/logger";
import type { ScopedStore } from "../store/store";
import {
  mapSdkMessageToTranscript,
  type TranscriptEvent,
  type TranscriptMessage,
} from "../store/events/transcript";

/** A live capture sink bound to one run's transcript stream. */
export interface TranscriptSink {
  /** Capture one streamed SDK message. Never throws; non-conversational messages are skipped. */
  capture(message: SDKMessage): void;
  /** Await every enqueued append so the captured transcript is durable. Never throws. */
  flush(): Promise<void>;
}

export interface CreateTranscriptSinkParams {
  /** The run correlation tag this sink's stream is keyed by (ADR-0022). */
  runId: string;
  /** Persist a batch of transcript events to the run's stream (bound to repo/issue/runId). */
  append: (events: TranscriptEvent[]) => Promise<void>;
  /** Secret-redactor applied to each event before persistence. Defaults to the `log/` redactor. */
  redact?: (value: unknown) => unknown;
  /** Capture clock (for the event's `at` stamp). Defaults to wall-clock. */
  now?: () => Date;
  /** Reports a dropped message (map/append failure). Capture stays best-effort regardless. */
  onError?: (err: unknown) => void;
}

/**
 * Build a {@link TranscriptSink}. The `append` is pre-bound to the run's
 * (repo, issue, runId) by the caller, so the sink only needs the runId for the event
 * body and the redactor/clock. Appends are serialised; `capture` swallows all errors.
 */
export function createTranscriptSink(params: CreateTranscriptSinkParams): TranscriptSink {
  const redactFn = params.redact ?? redact;
  const nowFn = params.now ?? ((): Date => new Date());
  // Serialise appends: each link awaits the prior so two messages never collide on the
  // stream's append position, and each catches its own failure so one bad append never
  // wedges the chain or surfaces as an unhandled rejection.
  let chain: Promise<void> = Promise.resolve();

  return {
    capture(message: SDKMessage): void {
      let data: TranscriptMessage["data"] | null;
      try {
        data = mapSdkMessageToTranscript(message, { runId: params.runId, at: nowFn().toISOString() });
      } catch (err) {
        params.onError?.(err);
        return;
      }
      if (!data) {
        return; // non-conversational message (token-level / telemetry) — deferred
      }
      // Redact the whole event body before persistence (ADR-0030): the `log/` redactor
      // strips secret-keyed fields and secret-shaped values recursively through blocks.
      const event: TranscriptMessage = {
        type: "TranscriptMessage",
        data: redactFn(data) as TranscriptMessage["data"],
      };
      chain = chain.then(async () => {
        try {
          await params.append([event]);
        } catch (err) {
          params.onError?.(err);
        }
      });
    },
    async flush(): Promise<void> {
      await chain;
    },
  };
}

/**
 * Build a {@link TranscriptSink} bound to one run's `(issue, runId)` on the given store
 * (ADR-0030). This is the single place the store append and the best-effort `onError` log
 * key are wired, so the session call sites (impl/resume, review/fix, moding) stay one line
 * and cannot drift apart. Capture is best-effort: an append failure is logged at `debug`
 * under `transcript.capture-failed` and dropped, never raised into the run.
 */
export function createRunTranscriptSink(
  store: Pick<ScopedStore, "appendToTranscript">,
  issueNumber: number,
  runId: string,
  logger: Pick<Logger, "debug">,
): TranscriptSink {
  return createTranscriptSink({
    runId,
    append: (events) => store.appendToTranscript(issueNumber, runId, events),
    onError: (err) => logger.debug("transcript.capture-failed", { error: String(err) }),
  });
}
