/**
 * The daemon↔runner pipe protocol — a pure, versioned frame codec (ADR-0038, issue #184,
 * epic #182 slice 2). The daemon-as-orchestrator and the in-container runner exchange three
 * frame families over a {@link import("./transport").Transport}:
 *
 *   - runner→daemon `telemetry` — a lifecycle event or a transcript message (best-effort
 *     liveness; the operator sees the run without the daemon polling);
 *   - runner→daemon `result` — the terminal disposition (`pr-opened` / `escalated` /
 *     `stuck` / `failed`);
 *   - daemon→runner `control` — an `abort` / `drain` signal.
 *
 * The pipe is **best-effort and never load-bearing**: a dropped frame degrades a run to
 * "less live", never to "lost work" (GitHub stays the source of truth, ADR-0016). What the
 * codec *does* owe is that runner/daemon **version skew is explicit** — a frame from an
 * incompatible protocol fails loud here rather than mis-decoding into a plausible-but-wrong
 * frame downstream. To honour that, {@link decodeFrame} validates the frame body against a
 * zod schema (ADR-0010, unknown keys rejected): a versioned-but-garbage frame is a loud
 * {@link ProtocolDecodeError}, never a silently-accepted junk {@link Frame}.
 */
import { z } from "zod";
import { rateLimitSignalSchema } from "../core/usage";
import { escalationQuestionSchema } from "../review/escalation";
import { worklistSchema } from "../review/worklist";

/**
 * The wire protocol version. Bumped whenever the {@link Frame} shape changes incompatibly;
 * {@link decodeFrame} rejects any other version with a {@link ProtocolVersionError} so a
 * runner and daemon built from different releases fail loud instead of silently
 * mis-decoding.
 */
export const PROTOCOL_VERSION = 1;

/**
 * The {@link frameSchema} below is the single source of truth for the wire shape (the repo's
 * canonical zod-contract idiom, cf. `web/contract/*`): every exported `Frame` type is derived
 * from it via {@link z.infer}, so the runtime guard and the static types cannot drift. Per-field
 * docs live on the schema. `.strict()` everywhere ⇒ unknown keys are rejected (ADR-0010).
 */
const lifecycleTelemetrySchema = z
  .object({
    type: z.literal("lifecycle"),
    /** The milestone name (`started`, `cloning`, `session-end`, …). */
    name: z.string(),
  })
  .strict();

const transcriptTelemetrySchema = z
  .object({
    type: z.literal("transcript"),
    /** The captured SDK message payload; the codec carries it verbatim, opaque. */
    message: z.unknown(),
  })
  .strict();

/**
 * A runner→daemon **per-account rate-limit** relay (ADR-0037 account meter / ADR-0038, issue
 * #228). In container-only execution the 429 / usage-window signal is born *inside* the container
 * — the SDK session there is the first to see it — so the runner ships it back as telemetry and the
 * daemon folds it into the right per-account meter so `resolveRoute`'s headroom view stays current.
 * The wire carries **only the `signal`**: both the meter selector (provider — the claude OAuth meter
 * vs the z.ai cooldown meter, never cross-fed, ADR-0034) and the meter key (the account *id*) are
 * the daemon's own dispatch facts, so the fold sources both daemon-side from the dispatch route. The
 * runner never learns the account (the credential arrives mounted, ADR-0037), and the in-container
 * provider is exactly `dispatch.route.provider` (the daemon injects it, no in-container re-resolution),
 * so neither belongs on the wire — exactly as a transcript frame is keyed by the dispatch runId.
 * Best-effort: a dropped frame just leaves the meter staler (ADR-0038), never a lost run.
 */
const rateLimitTelemetrySchema = z
  .object({
    type: z.literal("rate-limit"),
    /** The observed rate-limit / usage-window signal, folded into the account's meter state. */
    signal: rateLimitSignalSchema,
  })
  .strict();

const telemetryFrameSchema = z
  .object({
    kind: z.literal("telemetry"),
    /** A lifecycle marker, a transcript relay, or a per-account rate-limit signal (#228). */
    body: z.discriminatedUnion("type", [
      lifecycleTelemetrySchema,
      transcriptTelemetrySchema,
      rateLimitTelemetrySchema,
    ]),
  })
  .strict();

const resultOutcomeSchema = z.enum([
  "pr-opened",
  "escalated",
  "stuck",
  "failed",
  // The review-loop's review + fix runs in a container (ADR-0038 / issue #189). A `reviewed`
  // run relays the consolidated worklist back (the verdict contract); a `fixed` run pushed its
  // fix runner-direct; a `fix-escalate` run refused a risky structural change and relays the
  // question so the daemon posts the heal-card — exactly as the in-process review loop does.
  "reviewed",
  "fixed",
  "fix-escalate",
]);

/**
 * The escalation payload on an `escalated` result (ADR-0038 / issue #187). The runner posts
 * the `ralph-question` comment + pushes WIP **directly** to GitHub (runner-direct, so the
 * escalation survives a dead pipe); these fields then relay the *already-posted* comment's id
 * + headline (and the draft-PR number) so the daemon can swap `ready-for-agent → awaiting-answer`
 * without re-posting. Best-effort: absent → the daemon reconciles the label from GitHub instead.
 */
const escalationResultSchema = z
  .object({
    /** The escalation's headline — what the daemon indexes the open question under. */
    headline: z.string(),
    /** The id of the `ralph-question` comment the runner already posted to GitHub. */
    commentId: z.number(),
    /** The draft PR the WIP was checkpointed onto, when one was opened. */
    prNumber: z.number().optional(),
    /**
     * The full (validated, bar-clearing) escalation question, relayed so the daemon can record
     * the run's resume context at escalation indexing time (#9) — without it every answered
     * container escalation wedges as `paused-run-unresumable`. Optional so a question-less frame
     * from an older runner build still decodes; the daemon then falls back to a headline-derived
     * payload (the full question stays readable in the posted comment either way).
     */
    question: escalationQuestionSchema.optional(),
  })
  .strict();

/**
 * The self-stop report on a `stuck` result (ADR-0038 / issue #187): the agent called the
 * in-container `stuck` tool. Relays its `category` + `reason` so the daemon labels the issue
 * `agent-stuck` exactly as it does for an in-process self-stop. `wall-clock` is admitted because
 * a daemon-imposed wall-clock kill maps onto the same terminal report (it is never a tool input).
 */
const stuckResultSchema = z
  .object({
    category: z.enum(["fix-iterations", "no-green-build", "futility", "wall-clock"]),
    reason: z.string(),
  })
  .strict();

const resultFrameSchema = z
  .object({
    kind: z.literal("result"),
    outcome: resultOutcomeSchema,
    /** Human-readable context for the outcome (the PR ref, the stuck reason, …). */
    detail: z.string().optional(),
    /** Present on an `escalated` result — the runner-direct escalation's relayed payload. */
    escalation: escalationResultSchema.optional(),
    /** Present on a `stuck` result — the agent's self-stop report. */
    stuck: stuckResultSchema.optional(),
    /**
     * Present on a `reviewed` result (#189) — the consolidated, deduped, severity-ranked
     * worklist the in-container review pass produced. The daemon-side review loop reads it as
     * the phase verdict, identical to the in-process review agent's return value. Best-effort:
     * a dropped pipe yields `failed` here → the loop maxes the phase out (review-maxed +
     * heal-card), surfacing it to a human rather than losing it silently (ADR-0016).
     */
    worklist: worklistSchema.optional(),
    /**
     * Present on a `fix-escalate` result (#189) — the structured `ralph-question` the fix agent
     * emitted when a finding implied a risky structural change. The daemon-side review loop lifts
     * it to the phase escalation exactly as it does for an in-process fix escalate.
     */
    fixEscalation: escalationQuestionSchema.optional(),
  })
  .strict();

const controlSignalSchema = z.enum(["abort", "drain"]);

const controlFrameSchema = z
  .object({ kind: z.literal("control"), signal: controlSignalSchema })
  .strict();

/**
 * The runtime guard behind {@link decodeFrame}: the discriminated frame union. A versioned
 * frame whose body fails this fails loud rather than decoding into a plausible-but-wrong
 * {@link Frame}.
 */
const frameSchema = z.discriminatedUnion("kind", [
  telemetryFrameSchema,
  resultFrameSchema,
  controlFrameSchema,
]);

/** A runner→daemon lifecycle marker — the run reached a named milestone. */
export type LifecycleTelemetry = z.infer<typeof lifecycleTelemetrySchema>;
/** A runner→daemon transcript relay — one captured SDK message, opaque to the codec. */
export type TranscriptTelemetry = z.infer<typeof transcriptTelemetrySchema>;
/** A runner→daemon per-account rate-limit relay — the in-container signal the daemon meter folds (#228). */
export type RateLimitTelemetry = z.infer<typeof rateLimitTelemetrySchema>;
/** Best-effort runner→daemon liveness: a lifecycle marker or a transcript relay. */
export type TelemetryFrame = z.infer<typeof telemetryFrameSchema>;
/** A run's terminal disposition, as the runner reports it over the pipe. */
export type ResultOutcome = z.infer<typeof resultOutcomeSchema>;
/** The relayed payload of a runner-direct escalation (#187): headline + posted comment id. */
export type EscalationResult = z.infer<typeof escalationResultSchema>;
/** The relayed self-stop report of an in-container `stuck` (#187): category + reason. */
export type StuckResult = z.infer<typeof stuckResultSchema>;
/** The terminal runner→daemon frame: the run ended with this {@link ResultOutcome}. */
export type ResultFrame = z.infer<typeof resultFrameSchema>;
/** A daemon→runner control signal. */
export type ControlSignal = z.infer<typeof controlSignalSchema>;
/** The daemon→runner frame: stop or wind down the run. */
export type ControlFrame = z.infer<typeof controlFrameSchema>;
/** Every frame that crosses the pipe, discriminated on {@link Frame.kind}. */
export type Frame = z.infer<typeof frameSchema>;

/**
 * The on-the-wire envelope guard: the protocol version plus a still-unvalidated frame body.
 * The body is checked against {@link frameSchema} *after* the version gate, so cross-release
 * skew surfaces as a {@link ProtocolVersionError} (not a decode error over a shape this
 * build was never meant to read).
 */
const envelopeSchema = z.object({ v: z.number(), frame: z.unknown() }).strict();

/** Raised when a decoded frame carries a protocol version this build cannot read. */
export class ProtocolVersionError extends Error {
  override readonly name = "ProtocolVersionError";
  constructor(
    readonly received: number,
    readonly expected: number = PROTOCOL_VERSION,
  ) {
    super(`pipe protocol version mismatch: received ${received}, expected ${expected}`);
  }
}

/** Raised when a line is not a well-formed, version-stamped frame envelope. */
export class ProtocolDecodeError extends Error {
  override readonly name = "ProtocolDecodeError";
}

/** Encode one {@link Frame} into a single newline-free wire string (version-stamped). */
export function encodeFrame(frame: Frame): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, frame });
}

/**
 * Decode one wire string back into a {@link Frame}. Throws {@link ProtocolVersionError} on
 * version skew (loud, not a silent mis-decode), and {@link ProtocolDecodeError} on a
 * malformed envelope *or* a versioned-but-malformed frame body — the codec never returns a
 * frame whose shape it could not validate.
 */
export function decodeFrame(line: string): Frame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new ProtocolDecodeError(`pipe frame is not valid JSON: ${line}`);
  }
  const envelope = envelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    throw new ProtocolDecodeError("pipe frame is missing its version/frame envelope");
  }
  // Version gate first: a frame from another release may carry a shape this build cannot
  // read, so skew must surface as a version error, not a decode error over its body.
  if (envelope.data.v !== PROTOCOL_VERSION) {
    throw new ProtocolVersionError(envelope.data.v);
  }
  const frame = frameSchema.safeParse(envelope.data.frame);
  if (!frame.success) {
    throw new ProtocolDecodeError(`pipe frame body is malformed: ${frame.error.message}`);
  }
  return frame.data;
}
