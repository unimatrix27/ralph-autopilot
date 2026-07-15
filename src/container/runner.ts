/**
 * The real in-container runner (ADR-0038 / issue #185, epic #182 slice 3). It is the thin
 * component shipped in `ralph/agent-base` that hosts one agent run *inside* the container,
 * superseding the walking-skeleton {@link import("./stub-runner").runStubRunner}. Per run it:
 *
 *   - fresh-clones the assignment's branch into an isolated workspace (the freshness
 *     guarantee — a clean filesystem every run, ADR-0038);
 *   - hosts a real impl SDK session against that workspace via the {@link SessionHost} port
 *     (the existing in-process impl path, now running in-container) — the agent commits,
 *     pushes, and opens the PR **itself**, prompt-driven, exactly as it does in-process;
 *   - streams transcript + lifecycle **telemetry** over the best-effort {@link Transport};
 *   - reports a terminal {@link ResultFrame} (`pr-opened` on a clean session, else `failed`).
 *
 * The boundary split (ADR-0038): the run's *work product* — clone/push/PR — is **runner-direct**
 * (it lands on GitHub through the session's own git/gh calls, independent of the pipe), so a
 * dead pipe degrades the run to "less live", never "lost work". The pipe carries only
 * best-effort telemetry + the terminal hint; correctness never depends on it (ADR-0016).
 *
 * `escalate`/`stuck` from inside the container land here too (#187): the agent's `escalate`
 * publishes the `ralph-question` + WIP push **runner-direct** to GitHub before the session even
 * returns, then reports an `escalated` terminal; `stuck` reports a self-stop. Resume-not-restart
 * (#188) and the daemon-side `docker run` orchestration + credential mounts are their own slices.
 */
import type { Assignment, ContainerDispatch } from "./assignment";
import type { Frame, ResultFrame } from "./protocol";
import type { Transport } from "./transport";
import type { TranscriptSink } from "../executor/transcript-sink";
import type { ClassifiedSessionResult } from "../executor/agent";
import type { StuckReport } from "../executor/stuck-tool";
import type { EscalationQuestion } from "../review/escalation";
import type { FixOutcome } from "../review/agents";
import type { Worklist } from "../review/worklist";
import type { RateLimitSignal } from "../core/usage";

/** The isolated working tree a run executes in — a fresh clone, never reused (ADR-0038 L3). */
export interface RunnerWorkspace {
  /** Absolute path to the freshly-cloned working tree the session runs in. */
  path: string;
}

/** Fresh-clones the assignment's branch into an isolated {@link RunnerWorkspace} for the run. */
export interface WorkspaceCloner {
  /** Clone the assignment's branch (off its base) into a clean workspace; return its path. */
  clone(assignment: Assignment): Promise<RunnerWorkspace>;
}

/** Everything one impl session needs from the runner. */
export interface SessionHostInput {
  /** The run's marching orders (issue, mode, branch, base, prompt). */
  assignment: Assignment;
  /** The freshly-cloned working tree the session runs in. */
  workspacePath: string;
  /** The transcript capture sink — the runner relays each captured message as telemetry. */
  transcriptSink: TranscriptSink;
  /**
   * The `escalate` tool's side effect (#187): the session host wires it into the in-container
   * SDK session, and the runner publishes the escalation **runner-direct** (push WIP + post the
   * `ralph-question` comment to GitHub) when the agent calls it. Absent → the session has no
   * `escalate` tool (e.g. no escalation publisher was injected).
   */
  onEscalate?: (question: EscalationQuestion) => Promise<void>;
  /**
   * The `stuck` tool's side effect (#187): the session host wires it in, and the runner records
   * the self-stop report so it can report a `stuck` terminal. The daemon labels the issue
   * `agent-stuck` (no PR), exactly as for an in-process self-stop.
   */
  onStuck?: (report: StuckReport) => void;
  /**
   * Relay a rate-limit signal the session observed (the 429 / usage-window header) back to the
   * daemon's per-account meter over the best-effort pipe (ADR-0037/0038, issue #228). The session
   * host wires it into the SDK session's `onRateLimit`; the runner ships only the signal (the daemon
   * sources provider + account from the dispatch route when it folds). Absent → signals are dropped
   * (a session host / test that does not wire it).
   */
  onRateLimit?: (signal: RateLimitSignal) => void;
}

/**
 * Hosts one impl SDK session to completion in the given workspace and returns its classified
 * terminal result. The production impl wires this to the one session-drive primitive
 * ({@link import("../executor/agent").runReapedWallClockedSession}) running *inside* the
 * container; the agent commits/pushes/opens the PR itself. Faked in the unit suite.
 */
export interface SessionHost {
  run(input: SessionHostInput): Promise<ClassifiedSessionResult>;
}

/** What the runner-direct escalation publisher needs to land an escalation on GitHub (#187). */
export interface RunnerEscalationInput {
  /** The run's marching orders — supplies the issue + branch to checkpoint. */
  assignment: Assignment;
  /** The agent's (validated, bar-clearing) escalation question. */
  question: EscalationQuestion;
  /** The cloned workspace the WIP branch is pushed from. */
  workspacePath: string;
}

/**
 * Publishes an escalation **runner-direct** (ADR-0038 boundary split / issue #187): pushes the
 * run's WIP branch and posts the structured `ralph-question` comment **straight to GitHub**, so a
 * blocked agent's question survives even if the pipe is down. Returns the posted comment's id
 * (+ the draft PR, when one is opened) for the runner to relay so the daemon swaps the label
 * without re-posting. The production impl shells `git` + `gh` inside the container; faked in the
 * unit suite (no real GitHub).
 */
export interface RunnerEscalation {
  publish(input: RunnerEscalationInput): Promise<{ commentId: number; prNumber?: number }>;
}

/** What a review or fix session is handed inside the container (ADR-0038 / issue #189). */
export interface ReviewFixSessionInput {
  /** The run's marching orders — the pre-built review/fix prompt, branch, base, mode. */
  assignment: Assignment;
  /** The freshly-cloned working tree (the PR's head branch) the session runs against. */
  workspacePath: string;
  /** The transcript capture sink — the runner relays each captured message as telemetry. */
  transcriptSink: TranscriptSink;
  /**
   * Relay a rate-limit signal the review/fix session observed back to the daemon's per-account meter
   * over the best-effort pipe (ADR-0037/0038, issue #228). Wired into the structured backend's
   * `onRateLimit`; the runner ships only the signal (the daemon sources provider + account from the
   * dispatch route when it folds). Absent → signals are dropped (a session host / test that does not
   * wire it).
   */
  onRateLimit?: (signal: RateLimitSignal) => void;
}

/**
 * Hosts one **review** pass inside the container (#189): runs the pushed review prompt through the
 * shared structured-output contract and returns the consolidated, deduped, severity-ranked
 * {@link Worklist} — byte-identical to the in-process review agent's return value. Throws
 * `AgentOutputParseError` / `WallClockExceededError` on the same terminals the in-process path
 * does; the runner maps either to a `failed` terminal (best-effort pipe → the daemon-side loop
 * maxes the phase out). Faked in `runner.test.ts`; the production impl drives a real SDK session.
 */
export interface ReviewSessionHost {
  review(input: ReviewFixSessionInput): Promise<Worklist>;
}

/**
 * Hosts one **fix** attempt inside the container (#189): runs the pushed fix prompt through the
 * shared structured contract; the agent applies the gating items, keeps build+test green, and
 * **pushes runner-direct** (prompt-driven, exactly as in-process), then returns a {@link FixOutcome}
 * — `fixed` (it pushed) or `escalate` (a risky structural change it refused to apply blind).
 */
export interface FixSessionHost {
  fix(input: ReviewFixSessionInput): Promise<FixOutcome>;
}

/** Construction deps for one {@link runContainerRunner} invocation. */
export interface ContainerRunnerDeps {
  /** Fresh-clones the run's workspace. */
  cloner: WorkspaceCloner;
  /** Hosts the impl session. */
  session: SessionHost;
  /** The runner-side {@link Transport} bridged to the daemon over the container's stdio. */
  transport: Transport;
  /**
   * Lands an escalation runner-direct when the agent calls `escalate` (#187). Absent → the
   * session is hosted without an `escalate` tool (the agent cannot escalate from this run).
   */
  escalation?: RunnerEscalation;
  /** Hosts a review pass for a `kind: "review"` assignment (#189). Required for such a run. */
  reviewSession?: ReviewSessionHost;
  /** Hosts a fix attempt for a `kind: "fix"` assignment (#189). Required for such a run. */
  fixSession?: FixSessionHost;
}

/**
 * The one best-effort serialised sender over the pipe — the canonical concurrency primitive the
 * runner's telemetry relays share. Sends are serialised through a single promise chain so two
 * enqueued frames never race on the carrier, and each swallows its own error so the best-effort
 * pipe never disturbs the session; {@link SerialTransportSender.flush} awaits the chain so every
 * enqueued frame is on the wire before the terminal result frame. Owning the primitive once means a
 * later change to it (a dropped `.catch`, a flush tweak) cannot silently affect only one relay.
 */
interface SerialTransportSender {
  /** Enqueue one frame on the serialised best-effort chain (never throws). */
  send(frame: Frame): void;
  /** Await every enqueued send so the frames are on the wire before the terminal frame. */
  flush(): Promise<void>;
}

function createSerialTransportSender(transport: Transport): SerialTransportSender {
  let chain: Promise<void> = Promise.resolve();
  return {
    send(frame) {
      chain = chain.then(() => transport.send(frame).catch(() => {}));
    },
    async flush(): Promise<void> {
      await chain.catch(() => {});
    },
  };
}

/**
 * A {@link TranscriptSink} that relays each captured SDK message over the pipe as a `transcript`
 * telemetry frame (best-effort) — the in-container counterpart of the store-backed sink (ADR-0030):
 * inside the container there is no SQLite to append to, so the runner ships the message to the
 * daemon (the sole store writer) instead. It is a thin frame-shaper over the shared
 * {@link SerialTransportSender} it is handed, so captures are serialised + error-swallowed and
 * {@link TranscriptSink.flush} drains that chain before the terminal result frame.
 */
function createTransportTranscriptSink(sender: SerialTransportSender): TranscriptSink {
  return {
    capture(message) {
      sender.send({ kind: "telemetry", body: { type: "transcript", message } });
    },
    flush() {
      return sender.flush();
    },
  };
}

/**
 * Run one container assignment to its terminal result. Announces `started`, fresh-clones the
 * workspace, hosts the impl session against it, and reports its terminal over the pipe:
 *
 *   - `escalated` — the agent called `escalate`; the runner published the `ralph-question` +
 *     pushed WIP **directly to GitHub** (runner-direct, #187) and relays the posted comment id;
 *   - `stuck` — the agent called `stuck`; the runner relays the self-stop report;
 *   - else `pr-opened` (clean session) / `failed` (errored session).
 *
 * Escalate/stuck take precedence over the session's own classified result: a self-stop is a
 * terminal regardless of how the SDK loop happened to end. Every side effect that matters lands
 * on GitHub independent of the pipe, so the terminal frame is a best-effort hint (ADR-0016).
 */
export async function runContainerRunner(
  deps: ContainerRunnerDeps,
  dispatch: ContainerDispatch,
): Promise<void> {
  const { assignment } = dispatch;
  await sendBestEffort(deps.transport, { kind: "telemetry", body: { type: "lifecycle", name: "started" } });

  const workspace = await deps.cloner.clone(assignment);
  // One serialised best-effort sender, shared by both telemetry relays — the canonical concurrency
  // primitive (above). Both the transcript-capture shaper and the rate-limit relay enqueue onto this
  // single chain; the daemon demuxes by frame type, so the two kinds need no cross-stream ordering, and
  // one chain still drains every enqueued frame before the terminal result frame.
  const sender = createSerialTransportSender(deps.transport);
  const transcriptSink = createTransportTranscriptSink(sender);
  // Relay each rate-limit signal the session observes back to the daemon's per-account meter (ADR-0037/
  // 0038, issue #228) through that same sender. The frame carries only the signal: neither the account
  // *id* nor the provider is on the wire — the runner learns neither (the credential arrived mounted,
  // ADR-0037, and the in-container provider is exactly `dispatch.route.provider`), so the daemon sources
  // both from the dispatch route when it folds. A route-less run's signal is therefore dropped daemon-side
  // (the fold no-ops), not by withholding the relay here, so the route-less drop lives in one place
  // (best-effort).
  const onRateLimit = (signal: RateLimitSignal): void =>
    sender.send({ kind: "telemetry", body: { type: "rate-limit", signal } });

  // The run's kind selects which session the runner hosts and which terminal it reports (#189):
  // a review pass relays its worklist, a fix attempt relays `fixed`/`fix-escalate`, and the
  // default impl/resume path opens a PR (#185/#187/#188). The clone, sinks, and best-effort
  // terminal frame are shared.
  const result =
    assignment.kind === "review"
      ? await runReviewPass(deps, assignment, workspace.path, transcriptSink, onRateLimit)
      : assignment.kind === "fix"
        ? await runFixAttempt(deps, assignment, workspace.path, transcriptSink, onRateLimit)
        : await runImplSession(deps, assignment, workspace.path, transcriptSink, onRateLimit);

  // Drain the shared chain — every captured transcript message + relayed rate-limit signal — onto the
  // wire before the terminal frame, so the daemon sees the run's transcript and folds its meter ahead of
  // the result (best-effort; never throws).
  await sender.flush();

  await sendBestEffort(deps.transport, result);
}

/**
 * Host the impl/resume session and pick its terminal (#185/#187/#188): the agent commits,
 * pushes, and opens the PR itself; `escalate` lands runner-direct before the session returns,
 * `stuck` records the self-stop report.
 */
async function runImplSession(
  deps: ContainerRunnerDeps,
  assignment: Assignment,
  workspacePath: string,
  transcriptSink: TranscriptSink,
  onRateLimit: ((signal: RateLimitSignal) => void) | undefined,
): Promise<ResultFrame> {
  // The two terminal exits the in-container agent can take, captured runner-side. `escalate`
  // runs its GitHub side effect (runner-direct) before the session even returns; `stuck` only
  // records the report — the daemon owns the `agent-stuck` label, exactly as in-process.
  let escalation: { question: EscalationQuestion; commentId: number; prNumber?: number } | null = null;
  let stuck: StuckReport | null = null;

  // Hoist the optional publisher to a narrowed `const` so the `onEscalate` closure captures it
  // directly (no non-null assertion — the closure can't see the `deps.escalation` narrowing).
  const publisher = deps.escalation;
  const result = await deps.session.run({
    assignment,
    workspacePath,
    transcriptSink,
    onRateLimit,
    onEscalate: publisher
      ? async (question) => {
          // Push WIP + post the ralph-question straight to GitHub. This is the load-bearing
          // work (it lands the escalation); the terminal frame below is just the daemon's hint.
          const published = await publisher.publish({ assignment, question, workspacePath });
          escalation = { question, ...published };
        }
      : undefined,
    onStuck: (report) => {
      stuck = report;
    },
  });
  return terminalResult(assignment, result, escalation, stuck);
}

/**
 * Host a review pass (#189) and relay its worklist as a `reviewed` terminal. A thrown
 * `AgentOutputParseError`/`WallClockExceededError` (the same terminals the in-process review
 * hits) degrades to `failed` — the daemon-side loop then maxes the phase out gracefully
 * (review-maxed + heal-card) rather than the run being lost (best-effort pipe, ADR-0016).
 */
async function runReviewPass(
  deps: ContainerRunnerDeps,
  assignment: Assignment,
  workspacePath: string,
  transcriptSink: TranscriptSink,
  onRateLimit: ((signal: RateLimitSignal) => void) | undefined,
): Promise<ResultFrame> {
  if (!deps.reviewSession) {
    return { kind: "result", outcome: "failed", detail: "review run dispatched without a review session host" };
  }
  try {
    const worklist = await deps.reviewSession.review({ assignment, workspacePath, transcriptSink, onRateLimit });
    return {
      kind: "result",
      outcome: "reviewed",
      detail: `review produced ${worklist.items.length} finding(s) (issue #${assignment.issueNumber})`,
      worklist,
    };
  } catch (err) {
    return { kind: "result", outcome: "failed", detail: failureDetail("review", assignment, err) };
  }
}

/**
 * Host a fix attempt (#189): the agent applies the gating items and **pushes runner-direct**, then
 * the runner relays `fixed` (it pushed) or `fix-escalate` (it refused a risky structural change,
 * carrying the question). A thrown terminal degrades to `failed`, exactly as a review pass.
 */
async function runFixAttempt(
  deps: ContainerRunnerDeps,
  assignment: Assignment,
  workspacePath: string,
  transcriptSink: TranscriptSink,
  onRateLimit: ((signal: RateLimitSignal) => void) | undefined,
): Promise<ResultFrame> {
  if (!deps.fixSession) {
    return { kind: "result", outcome: "failed", detail: "fix run dispatched without a fix session host" };
  }
  try {
    const outcome = await deps.fixSession.fix({ assignment, workspacePath, transcriptSink, onRateLimit });
    if (outcome.kind === "escalate") {
      return {
        kind: "result",
        outcome: "fix-escalate",
        detail: `fix escalated to the operator (issue #${assignment.issueNumber})`,
        fixEscalation: outcome.question,
      };
    }
    return { kind: "result", outcome: "fixed", detail: `fix pushed (issue #${assignment.issueNumber})` };
  } catch (err) {
    return { kind: "result", outcome: "failed", detail: failureDetail("fix", assignment, err) };
  }
}

/** A human-readable `failed` detail for a review/fix session that threw (parse/wall-clock terminal). */
function failureDetail(role: "review" | "fix", assignment: Assignment, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  return `${role} session failed (issue #${assignment.issueNumber}): ${reason}`;
}

/**
 * Pick the terminal {@link ResultFrame} for a finished run. Self-stop exits win over the
 * session's classified result: `escalated` (with its relayed comment payload) first, then
 * `stuck` (with its report), else `pr-opened`/`failed` keyed on the session's `isError`.
 */
function terminalResult(
  assignment: Assignment,
  result: ClassifiedSessionResult,
  escalation: { question: EscalationQuestion; commentId: number; prNumber?: number } | null,
  stuck: StuckReport | null,
): ResultFrame {
  if (escalation) {
    return {
      kind: "result",
      outcome: "escalated",
      detail: `escalated to the operator (issue #${assignment.issueNumber})`,
      escalation: {
        headline: escalation.question.headline,
        commentId: escalation.commentId,
        ...(escalation.prNumber !== undefined ? { prNumber: escalation.prNumber } : {}),
      },
    };
  }
  if (stuck) {
    return {
      kind: "result",
      outcome: "stuck",
      detail: stuck.reason,
      stuck: { category: stuck.category, reason: stuck.reason },
    };
  }
  const outcome = result.isError ? "failed" : "pr-opened";
  return { kind: "result", outcome, detail: `impl session ${outcome} (issue #${assignment.issueNumber})` };
}

/**
 * Send one frame over the best-effort pipe, swallowing any carrier error (a dead/broken pipe).
 * Telemetry and the terminal hint are **never load-bearing** (ADR-0016): a failed send must
 * never abort the run, whose real work product lands on GitHub independent of the pipe.
 */
async function sendBestEffort(transport: Transport, frame: Frame): Promise<void> {
  await transport.send(frame).catch(() => {});
}
