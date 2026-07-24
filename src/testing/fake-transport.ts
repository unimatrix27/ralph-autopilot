/**
 * Test doubles for the container transport seam (ADR-0038, issue #184). The epic's testing
 * decision is that `ContainerExecution` orchestration is exercised **behind a fake transport**
 * — never a real `docker run` or image — so these wire the in-memory pipe carrier and a
 * `DockerRunner` that "starts a container" by bridging two {@link LocalPipeTransport}s.
 */
import { PassThrough } from "node:stream";
import type { ContainerDispatch } from "../container/assignment";
import type { ContainerSweeper, DockerRunner, RunningContainer } from "../container/container-execution";
import { containerNameForBranch } from "../container/docker-runner";
import { LocalPipeTransport, type Transport } from "../container/transport";

/**
 * Two {@link LocalPipeTransport}s wired back-to-back over in-memory pipes — the `daemon` side
 * and the `runner` side of one container's stdio. `endRunner()` ends the runner→daemon stream,
 * simulating the container process dying (the daemon's `receive()` then reaches EOF).
 */
export function connectedTransports(): {
  daemon: Transport;
  runner: Transport;
  endRunner: () => void;
} {
  const runnerToDaemon = new PassThrough();
  const daemonToRunner = new PassThrough();
  return {
    daemon: new LocalPipeTransport({ inbound: runnerToDaemon, outbound: daemonToRunner }),
    runner: new LocalPipeTransport({ inbound: daemonToRunner, outbound: runnerToDaemon }),
    endRunner: () => runnerToDaemon.end(),
  };
}

/**
 * A {@link DockerRunner} that records every dispatch and "runs" the container by handing the
 * runner-side {@link Transport} to an optional `onStart` (e.g. the stub runner). `start`
 * captures the most recent {@link runnerSide} so a test can drive/observe it; `kill` flips
 * {@link killed} and ends the runner→daemon stream so the daemon's receive loop unblocks
 * (what a real `docker kill` does to the container's stdout).
 */
export class FakeDocker implements DockerRunner {
  /** Every dispatch `start` was asked to run, in order. */
  readonly dispatches: ContainerDispatch[] = [];
  /** Whether {@link RunningContainer.kill} was invoked (the abort backstop). */
  killed = false;
  /** The runner-side transport of the most recent {@link start} (tests drive/observe it). */
  runnerSide?: Transport;

  constructor(
    private readonly onStart?: (runner: Transport, dispatch: ContainerDispatch) => void,
    /** The container's post-exit failure detail (issue #220) — surfaced on a synthesized no-result terminal. */
    private readonly failureDetail?: () => string | undefined,
  ) {}

  async start(dispatch: ContainerDispatch): Promise<RunningContainer> {
    this.dispatches.push(dispatch);
    const { daemon, runner, endRunner } = connectedTransports();
    this.runnerSide = runner;
    this.onStart?.(runner, dispatch);
    return {
      transport: daemon,
      kill: async () => {
        this.killed = true;
        endRunner();
      },
      ...(this.failureDetail ? { failureDetail: this.failureDetail } : {}),
    };
  }
}

/**
 * A {@link ContainerSweeper} double for the reconciler's orphan-container sweep (issue #219). It
 * holds the branches of the containers it pretends are "running"; `sweepOrphans` kills (removes)
 * exactly those not backed by a live branch and records their container names in {@link killed},
 * mirroring the real {@link import("../container/docker-runner").DockerCliRunner} without a docker.
 */
export class FakeContainerSweeper implements ContainerSweeper {
  /** Container names this sweep killed, across all calls, in order. */
  readonly killed: string[] = [];

  constructor(private readonly liveBranchesSet: Set<string> = new Set()) {}

  async sweepOrphans(liveBranches: ReadonlySet<string>): Promise<string[]> {
    const orphans: string[] = [];
    for (const branch of this.liveBranchesSet) {
      if (!liveBranches.has(branch)) {
        orphans.push(containerNameForBranch(branch));
        this.liveBranchesSet.delete(branch);
      }
    }
    this.killed.push(...orphans);
    return orphans;
  }

  /** The branches of the containers this fake pretends are running (issue #29). */
  async runningBranches(): Promise<Set<string>> {
    return new Set(this.liveBranchesSet);
  }
}
