/**
 * `ContainerExecution` — the daemon-as-orchestrator side of the container model (ADR-0038 /
 * issue #184, epic #182 slice 5). The walking skeleton: `docker run` the base image with the
 * dispatch (assignment + per-run token) pushed in, stream telemetry back, and collect a
 * terminal result frame over a {@link Transport}. **No real docker, no real container** runs
 * here (ADR-0038: no images in the unit suite) — the `DockerRunner` port is faked, and the
 * pipe is the in-memory `connectedTransports` carrier, exactly as the epic's testing decision
 * prescribes (orchestration behind a fake transport).
 *
 * These tests assert *what the orchestrator does* — forwards the dispatch, relays telemetry,
 * surfaces the terminal result, and aborts cleanly — never private call shapes.
 */
import { describe, expect, it } from "vitest";
import type { Assignment, ContainerDispatch } from "./assignment";
import { ContainerExecution } from "./container-execution";
import type { TelemetryFrame } from "./protocol";
import { FakeDocker } from "../testing/fake-transport";
import { runStubRunner } from "./stub-runner";

const assignment: Assignment = {
  issueNumber: 184,
  mode: "tdd",
  branch: "ralph/184-walking-skeleton",
  base: "main",
  prompt: "implement the walking skeleton",
};
const dispatch: ContainerDispatch = { assignment, token: { value: "run-token-abc" } };

describe("ContainerExecution (ADR-0038 / issue #184)", () => {
  it("docker-runs the image with the assignment + per-run token pushed in", async () => {
    const docker = new FakeDocker((runner) => void runStubRunner(runner, assignment));
    await new ContainerExecution({ docker }).dispatch(dispatch);
    expect(docker.dispatches).toEqual([dispatch]);
  });

  it("collects the runner's terminal result frame over the pipe", async () => {
    const docker = new FakeDocker((runner) => void runStubRunner(runner, assignment, { outcome: "pr-opened" }));
    const result = await new ContainerExecution({ docker }).dispatch(dispatch);
    expect(result.outcome).toBe("pr-opened");
  });

  it("relays each telemetry frame to the telemetry sink before the terminal result", async () => {
    const seen: TelemetryFrame[] = [];
    const docker = new FakeDocker((runner) => void runStubRunner(runner, assignment));
    await new ContainerExecution({ docker, onTelemetry: (f) => seen.push(f) }).dispatch(dispatch);
    expect(seen).toEqual([{ kind: "telemetry", body: { type: "lifecycle", name: "started" } }]);
  });

  it("on abort, sends a control:abort frame to the runner and docker-kills the container", async () => {
    // A runner that never reports a result — only an abort can end this run.
    const docker = new FakeDocker(/* no runner: silent container */);
    const controller = new AbortController();
    const exec = new ContainerExecution({ docker });
    const done = exec.dispatch(dispatch, { abortSignal: controller.signal });
    // Watch the runner side for the control frame the daemon pushes in.
    const controlSeen = (async () => {
      for await (const frame of docker.runnerSide!.receive()) return frame;
      return undefined;
    })();
    controller.abort();
    const result = await done;
    expect(await controlSeen).toEqual({ kind: "control", signal: "abort" });
    expect(docker.killed).toBe(true);
    expect(result.outcome).toBe("failed");
  });

  it("refuses to start a new container when the drain signal is already aborted (issue #219)", async () => {
    // A drain stops dispatching new container runs: the gate trips before `docker run`, so no
    // container starts. It throws (rather than returning a result) so the executor's drain-aware
    // catch leaves the run resumable instead of terminalizing it.
    const docker = new FakeDocker((runner) => void runStubRunner(runner, assignment, { outcome: "pr-opened" }));
    const draining = new AbortController();
    draining.abort();
    await expect(
      new ContainerExecution({ docker }).dispatch(dispatch, { drainSignal: draining.signal }),
    ).rejects.toThrow(/draining/);
    expect(docker.dispatches).toEqual([]); // no container was ever started.
  });

  it("dispatches normally when a drain signal is present but not yet aborted (issue #219)", async () => {
    // In-flight work is unaffected: a not-yet-draining signal lets a fresh dispatch proceed.
    const docker = new FakeDocker((runner) => void runStubRunner(runner, assignment, { outcome: "pr-opened" }));
    const draining = new AbortController();
    const result = await new ContainerExecution({ docker }).dispatch(dispatch, { drainSignal: draining.signal });
    expect(result.outcome).toBe("pr-opened");
    expect(docker.dispatches).toEqual([dispatch]);
  });

  it("surfaces a failed result flagged noResult when the runner exits without a result frame (issue #220)", async () => {
    // Runner connects, emits one telemetry frame, then the container dies (no result).
    const docker = new FakeDocker(async (runner) => {
      await runner.send({ kind: "telemetry", body: { type: "lifecycle", name: "started" } });
      await runner.close();
    });
    const result = await new ContainerExecution({ docker }).dispatch(dispatch);
    expect(result.outcome).toBe("failed");
    // `noResult` marks this as a daemon-synthesized infra terminal (vs a runner-reported `failed`),
    // so the review loop retries it rather than maxing out on a (lying) parse-failure heal-card.
    expect(result.noResult).toBe(true);
  });

  it("carries the container's real failure detail (docker exit/stderr) on the synthesized terminal (issue #220)", async () => {
    const detail = "docker exited (code=125 signal=null); stderr tail: no such image";
    const docker = new FakeDocker(
      async (runner) => {
        await runner.close(); // no result frame
      },
      () => detail,
    );
    const result = await new ContainerExecution({ docker }).dispatch(dispatch);
    expect(result.outcome).toBe("failed");
    expect(result.noResult).toBe(true);
    expect(result.detail).toBe(detail);
  });

  it("does NOT flag noResult on a runner-reported failed frame (a genuine in-container failure)", async () => {
    const docker = new FakeDocker((runner) => void runStubRunner(runner, assignment, { outcome: "failed" }));
    const result = await new ContainerExecution({ docker }).dispatch(dispatch);
    expect(result.outcome).toBe("failed");
    expect(result.noResult).toBeUndefined();
  });
});
