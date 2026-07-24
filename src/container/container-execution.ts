/**
 * `ContainerExecution` — the daemon's orchestrator for the container model (ADR-0038, issue
 * #184, epic #182 slice 5). The daemon shrinks to an orchestrator: instead of running the
 * SDK in-process it `docker run`s the target image with the {@link ContainerDispatch}
 * (assignment + per-run token) pushed in, streams telemetry back over a best-effort
 * {@link Transport}, and collects the runner's terminal {@link ResultFrame}.
 *
 * This is the walking skeleton: it owns the `docker run` → pipe → result round-trip and the
 * `docker kill` abort backstop, against a {@link DockerRunner} port so **no real container or
 * image runs in the unit suite**. The pipe is **never load-bearing** — if the runner exits
 * without a result, that surfaces as a `failed` result here, while the run's real work
 * product (PR/escalate) lands on GitHub independent of the pipe (ADR-0016).
 */
import type { ContainerDispatch } from "./assignment";
import type { ResultFrame, TelemetryFrame } from "./protocol";
import type { Transport } from "./transport";

/**
 * A {@link ResultFrame} plus a daemon-internal `noResult` flag: `true` ONLY for the terminal the
 * daemon *synthesizes* when a `docker run` ends with no result frame (a dropped pipe / killed
 * container / docker that never started) — a daemon-side **infra fault**, distinct from a
 * runner-reported `failed` frame (a genuine in-container agent failure, already retried inside the
 * container). The review loop retries the infra fault and otherwise keeps `failed`-frame semantics
 * (issue #220). Daemon-internal only — `noResult` never crosses the wire (it is not on
 * {@link resultFrameSchema}).
 */
export type DispatchResult = ResultFrame & { noResult?: boolean };

/** A live container the daemon is orchestrating: its daemon-side pipe and a kill backstop. */
export interface RunningContainer {
  /** The daemon-side {@link Transport} bridged to the container's stdio. */
  transport: Transport;
  /** `docker kill` the container — the abort/wall-clock backstop (reaps the process tree). */
  kill(): Promise<void>;
  /**
   * The real reason a `docker run` ended without a result frame — the docker exit code/signal and
   * a tail of the container's stderr — for the daemon-synthesized `failed` terminal (issue #220).
   * Meaningful only after the child has exited; `undefined` before that or when the runner is faked
   * without one. Lets the synthesized no-frame terminal carry the actual infra fault rather than a
   * generic "exited without a result frame", so the review loop's heal-card is honest.
   */
  failureDetail?(): string | undefined;
}

/**
 * The `docker run` port. `start` launches the target image with the dispatch pushed in and
 * returns the live {@link RunningContainer}. Faked in tests; the real impl shells `docker`.
 */
export interface DockerRunner {
  start(dispatch: ContainerDispatch): Promise<RunningContainer>;
}

/**
 * The orphan-sweep port (ADR-0038's "kill containers with no live run" pass). The reconciler's
 * periodic orphan sweep — which already GCs `ralph/*` worktrees/branches and wedged run rows —
 * hands it the set of branches with a live (non-terminal, in-flight) run; the implementation
 * enumerates the running container fleet and kills any container that does not back one of them.
 * Sourcing the live fleet from Docker (not in-memory daemon state) is deliberate: a daemon crash
 * that loses a run row mid-flight would otherwise leave a container running with nothing to reap
 * it. Faked in tests (no real containers in the unit suite, ADR-0038); the real impl is
 * {@link import("./docker-runner").DockerCliRunner}.
 */
export interface ContainerSweeper {
  /** Stop every running ralph-managed container whose branch is not in `liveBranches`; returns the killed names. */
  sweepOrphans(liveBranches: ReadonlySet<string>): Promise<string[]>;
  /**
   * The branches of every ralph-managed container currently running for this repo — enumerated from
   * Docker itself, so it reflects reality across a daemon restart (issue #29). The startup orphan
   * reconcile consults it before discarding a `running` row with no PR: a daemon crash/OOM can leave
   * the run's container still executing (it opens its own PR), and discarding it would false-stick a
   * live run and kill a healthy container. A run whose container is alive is left running, not stuck.
   */
  runningBranches(): Promise<Set<string>>;
}

/** Construction deps for {@link ContainerExecution}. */
export interface ContainerExecutionDeps {
  /** The `docker run` port. */
  docker: DockerRunner;
  /**
   * Best-effort telemetry sink: each runner→daemon telemetry frame is relayed here as it
   * arrives (the daemon maps it into the run/transcript store — daemon stays the sole
   * writer, ADR-0030). Absent → telemetry is dropped (still best-effort).
   */
  onTelemetry?: (frame: TelemetryFrame, dispatch: ContainerDispatch) => void;
}

/** Options for a single {@link ContainerExecution.dispatch}. */
export interface DispatchOptions {
  /** Aborting this signal pushes a `control:abort` to the runner and `docker kill`s it. */
  abortSignal?: AbortSignal;
  /**
   * The daemon's graceful-drain signal (issue #35). When already aborted at dispatch time the run
   * is refused **before any container starts** — a drain stops dispatching new container runs while
   * in-flight ones finish. Only the *fresh-run* (impl/resume) seam passes it; a run already in
   * flight keeps its review/fix containers so it can complete. The refusal throws (it never starts,
   * so there is no work product): the executor's drain-aware catch leaves the run resumable rather
   * than terminalizing it, and the next post-drain tick re-drives it (resume-not-restart).
   */
  drainSignal?: AbortSignal;
}

export class ContainerExecution {
  constructor(private readonly deps: ContainerExecutionDeps) {}

  /**
   * Run one assignment to its terminal result: `docker run` the image, relay telemetry, and
   * return the runner's {@link ResultFrame}. On abort, push a `control:abort` frame and
   * `docker kill` the container; a runner that exits without a result yields a synthesized
   * `failed` (the pipe is best-effort, never load-bearing).
   */
  async dispatch(dispatch: ContainerDispatch, options: DispatchOptions = {}): Promise<DispatchResult> {
    // Drain gate (issue #35 / ADR-0038): a graceful drain stops dispatching new container runs.
    // Refuse before `docker run` so no fresh container is started; throwing (rather than starting
    // and racing the abort) lands in the executor's drain-aware catch, which leaves the run
    // resumable. In-flight runs are unaffected — they never re-enter this gate.
    if (options.drainSignal?.aborted) {
      throw new Error("daemon draining: refusing to dispatch a new container run");
    }
    const container = await this.deps.docker.start(dispatch);
    let aborted = false;

    const abort = async (): Promise<void> => {
      aborted = true;
      // Best-effort: ask the runner to wind down, then kill as the backstop. `docker kill`
      // ends the container's stdout, which unblocks the receive loop below at EOF.
      await container.transport.send({ kind: "control", signal: "abort" }).catch(() => {});
      await container.kill().catch(() => {});
    };

    const signal = options.abortSignal;
    if (signal?.aborted) {
      await abort();
    } else {
      signal?.addEventListener("abort", () => void abort(), { once: true });
    }

    for await (const frame of container.transport.receive()) {
      if (frame.kind === "telemetry") {
        this.deps.onTelemetry?.(frame, dispatch);
      } else if (frame.kind === "result") {
        await container.transport.close().catch(() => {});
        return frame;
      }
      // A daemon-side `control` frame would be the runner echoing our own signal back — ignore.
    }

    // The stream ended with no result: the runner exited (or was killed) without reporting.
    // The pipe is best-effort, so this degrades to a synthesized `failed` terminal here while any
    // real work product still lands on GitHub. `noResult: true` marks it as a daemon-side infra
    // fault (vs a runner-reported `failed` frame) so the review loop retries it (issue #220), and
    // `failureDetail()` carries the real docker exit code/stderr tail for the honest heal-card.
    return {
      kind: "result",
      outcome: "failed",
      noResult: true,
      detail: aborted
        ? "aborted by daemon"
        : (container.failureDetail?.() ?? "runner exited without a result frame"),
    };
  }
}
