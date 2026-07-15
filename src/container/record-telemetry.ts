/**
 * Mapping a runner's best-effort {@link TelemetryFrame}s onto the daemon's per-run transcript
 * store (ADR-0038 / issue #185, AC4). The container runner streams telemetry over the pipe; the
 * daemon — the **sole writer** of run/transcript state (ADR-0030) — folds each frame into the
 * run's dedicated transcript stream here, so the live web control plane shows a containerized
 * run exactly as it shows an in-process one.
 *
 *   - A `transcript` frame carries one raw SDK message; it is mapped + redacted into a
 *     {@link TranscriptMessage} via the very same pure mapper the in-process sink uses
 *     ({@link mapSdkMessageToTranscript}), so both execution models persist identical shapes. A
 *     non-conversational message (the mapper returns `null`) records nothing.
 *   - A `lifecycle` frame (today `started`; more milestones as the runner grows) lands as a
 *     visible `system` transcript note, so run progress is legible without a new event type.
 *
 * The pipe is **best-effort and never load-bearing** (ADR-0016): a map failure is swallowed
 * (nothing is recorded) rather than raised into the daemon's receive loop.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { redact as defaultRedact } from "../log/logger";
import {
  mapSdkMessageToTranscript,
  type TranscriptEvent,
  type TranscriptMessage,
} from "../store/events/transcript";
import type { TelemetryFrame } from "./protocol";

/** The narrow store port this needs — structurally satisfied by `ScopedStore`. */
export interface TranscriptRunRecorder {
  appendToTranscript(issueNumber: number, runId: string, events: TranscriptEvent[]): Promise<void>;
}

/** Identifies the run whose transcript a telemetry frame belongs to (ADR-0022 runId tag). */
export interface TelemetryRunRef {
  issueNumber: number;
  runId: string;
}

/** Optional injected clock + redactor (default: wall-clock + the `log/` secret redactor). */
export interface RecordTelemetryOptions {
  now?: () => Date;
  redact?: (value: unknown) => unknown;
}

/**
 * Fold one telemetry frame into the run's transcript stream. Best-effort: a `transcript` frame
 * whose message is non-conversational (or unmappable) records nothing; a `lifecycle` frame
 * becomes a system note. Total over {@link TelemetryFrame.body}.
 */
export async function recordTelemetry(
  recorder: TranscriptRunRecorder,
  run: TelemetryRunRef,
  frame: TelemetryFrame,
  options: RecordTelemetryOptions = {},
): Promise<void> {
  const at = (options.now ?? ((): Date => new Date()))().toISOString();
  const redact = options.redact ?? defaultRedact;

  const event =
    frame.body.type === "lifecycle"
      ? lifecycleNote(run.runId, at, frame.body.name)
      : frame.body.type === "transcript"
        ? transcriptMessage(run.runId, at, frame.body.message, redact)
        : // A `rate-limit` body (#228) folds into the daemon's per-account usage meter, not the
          // transcript store — the container adapters demux it before this sink ever sees it, but
          // stay total here so a stray one is a harmless no-op rather than a type hole.
          null;

  if (!event) {
    return; // non-conversational / unmappable message — nothing to persist (best-effort).
  }
  await recorder.appendToTranscript(run.issueNumber, run.runId, [event]);
}

/** A serialised telemetry sink bound to one run: feed frames in, await durability. */
export interface TelemetrySink {
  /** Fold one frame into the run's transcript (best-effort; never throws into the caller). */
  record(frame: TelemetryFrame): void;
  /** Await every enqueued append so the captured telemetry is durable. */
  flush(): Promise<void>;
}

/**
 * Bind a {@link TelemetrySink} to one run on the given recorder — the wiring
 * `ContainerExecution.onTelemetry` is plugged into. Appends are **serialised** through one
 * promise chain (exactly as the in-process transcript sink), because frames arrive faster than
 * an append completes and two concurrent appends to a run's not-yet-created transcript stream
 * would otherwise race on stream creation. Each link swallows its own error so the best-effort
 * pipe never wedges the chain or surfaces an unhandled rejection.
 */
export function createTelemetrySink(
  recorder: TranscriptRunRecorder,
  run: TelemetryRunRef,
  options: RecordTelemetryOptions = {},
): TelemetrySink {
  let chain: Promise<void> = Promise.resolve();
  return {
    record(frame: TelemetryFrame): void {
      chain = chain.then(() => recordTelemetry(recorder, run, frame, options)).catch(() => {});
    },
    async flush(): Promise<void> {
      await chain;
    },
  };
}

/** Map a relayed SDK message into a redacted {@link TranscriptMessage}, or `null` to skip it. */
function transcriptMessage(
  runId: string,
  at: string,
  message: unknown,
  redact: (value: unknown) => unknown,
): TranscriptMessage | null {
  let data: TranscriptMessage["data"] | null;
  try {
    data = mapSdkMessageToTranscript(message as SDKMessage, { runId, at });
  } catch {
    return null; // a malformed relayed message is dropped, never raised (best-effort pipe).
  }
  if (!data) {
    return null;
  }
  return { type: "TranscriptMessage", data: redact(data) as TranscriptMessage["data"] };
}

/** Represent a runner lifecycle milestone as a visible `system` transcript note. */
function lifecycleNote(runId: string, at: string, name: string): TranscriptMessage {
  return {
    type: "TranscriptMessage",
    data: { runId, at, role: "system", sdkType: "lifecycle", blocks: [{ kind: "text", text: name }] },
  };
}
