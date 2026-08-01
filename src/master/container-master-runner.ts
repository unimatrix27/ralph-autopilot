/**
 * `ContainerMasterAgentRunner` — the daemon-side adapter that makes a fresh container run one
 * master adjudication (ADR-0041 over ADR-0038). It is the master's sibling of the impl and
 * review/fix container adapters, and it is deliberately shaped like them: build the assignment,
 * dispatch, relay telemetry into the run's transcript, map the terminal frame.
 *
 * That sameness is the point. "Transcript capture, route recording, usage-limit defer/rotation,
 * wall clock, container cleanup, and secret redaction apply to master sessions like every other
 * agent" is not a feature this module implements — it is a property it inherits by refusing to
 * build a second execution path. The master is a stronger model with a bigger context packet and
 * more capability inside the container; it is not a different kind of run.
 *
 * The one thing it does add is the **pre-dispatch compatibility gate**: a master assignment into
 * a runner image that does not declare `master-escalation` fails loud and precisely, rather than
 * dispatching into a runner that does not know what `kind: "master"` means and reporting a
 * generic no-result.
 */

import type { Assignment, ContainerDispatch, ContainerRoute, RunToken } from "../container/assignment";
import { assertRunnerSupports, type RunnerCapabilityProbe } from "../container/capabilities";
import { ContainerExecution, type DockerRunner } from "../container/container-execution";
import type { ResultFrame } from "../container/protocol";
import { createTelemetrySink, type TranscriptRunRecorder } from "../container/record-telemetry";
import { foldRateLimitTelemetry, type RecordRateLimitSignal } from "../container/record-rate-limit";
import { isUsageLimitError } from "../core/usage";
import type { TargetConfig } from "../config/schema";
import type { MasterAgentRunner, MasterSessionInput, MasterSessionOutcome } from "./engine";
import { parseMasterSessionResult } from "./outcome";

export interface ContainerMasterRunnerDeps {
  /** The `docker run` port — faked in tests, shells `docker` in production. */
  docker: DockerRunner;
  /** The run/transcript store the daemon (sole writer) folds container telemetry into. */
  store: TranscriptRunRecorder;
  /** The resolved target config — supplies the repo the image is keyed by. */
  config: TargetConfig;
  /** The branch the eventual PR targets. */
  baseBranch: string;
  /** Folds a container-reported per-account rate-limit signal back into the daemon's meter. */
  recordRateLimit?: RecordRateLimitSignal;
  /** Reads the runner image's declared capabilities for the pre-dispatch gate. */
  capabilities?: RunnerCapabilityProbe;
  /** Mints the per-run token pushed into the container at dispatch. */
  makeToken?: (assignment: Assignment) => RunToken;
  /** The daemon's graceful-drain signal: a drain refuses fresh master dispatch. */
  drainSignal?: AbortSignal;
}

export class ContainerMasterAgentRunner implements MasterAgentRunner {
  constructor(private readonly deps: ContainerMasterRunnerDeps) {}

  async run(input: MasterSessionInput): Promise<MasterSessionOutcome> {
    // Fail loud, pre-dispatch, on a stale runner: `kind: "master"` is not additively tolerable.
    await assertRunnerSupports(this.deps.capabilities, this.deps.config.targetRepo, ["master-escalation"]);

    const assignment: Assignment = {
      kind: "master",
      issueNumber: input.issue.number,
      mode: "tdd",
      branch: input.branch,
      base: this.deps.baseBranch,
      prompt: input.prompt,
      escalationMode: "master",
    };
    const dispatch: ContainerDispatch = {
      assignment,
      token: (this.deps.makeToken ?? defaultToken)(assignment),
      ...(input.route ? { route: input.route as ContainerRoute } : {}),
    };

    const sink = createTelemetrySink(this.deps.store, {
      issueNumber: input.issue.number,
      runId: String(input.runId),
    });
    let sawRateLimit = false;
    const execution = new ContainerExecution({
      docker: this.deps.docker,
      onTelemetry: (frame, dispatched) => {
        if (foldRateLimitTelemetry(frame, dispatched, this.deps.recordRateLimit)) {
          sawRateLimit = true;
        } else {
          sink.record(frame);
        }
      },
    });

    const result = await execution.dispatch(dispatch, {
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      ...(this.deps.drainSignal ? { drainSignal: this.deps.drainSignal } : {}),
    });
    await sink.flush();
    return this.mapResult(result, sawRateLimit, input);
  }

  /**
   * Map the terminal frame. `master` carries the relayed result, re-validated daemon-side (never
   * trusted off the wire); a usage-limited `failed` is a **defer** so the pending intervention
   * stays re-adoptable on a rotated account; anything else is a session failure the engine defers
   * without spending the attempt's outcome.
   */
  private mapResult(result: ResultFrame, sawRateLimit: boolean, input: MasterSessionInput): MasterSessionOutcome {
    if (result.outcome === "master") {
      if (!result.master) {
        return { kind: "failed", detail: "master terminal arrived with no relayed outcome" };
      }
      try {
        return { kind: "outcome", result: parseMasterSessionResult(result.master.result) };
      } catch (err) {
        // A malformed outcome is a failure, never a guessed resolution: guessing here would
        // execute a resolution the master did not choose.
        return { kind: "failed", detail: `master relayed an invalid outcome: ${String(err)}` };
      }
    }
    if (sawRateLimit || isUsageLimitError(result.detail ?? "")) {
      input.logger.warn("master.container-usage-limited", { issue: input.issue.number, detail: result.detail });
      return { kind: "limited", ...(result.detail ? { detail: result.detail } : {}) };
    }
    return { kind: "failed", detail: result.detail ?? `master container reported ${result.outcome}` };
  }
}

function defaultToken(assignment: Assignment): RunToken {
  return { value: `ralph-master-${assignment.issueNumber}-${assignment.branch}` };
}
