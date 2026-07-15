/**
 * Recording a container run's terminal state from its result frame (ADR-0038 / issue #184,
 * AC3 + the end-to-end walking-skeleton round-trip). Two layers:
 *
 *   1. the pure mapping — which {@link ResultOutcome} pins which store fact (and which are
 *      runner-direct and pin nothing);
 *   2. the full skeleton — a stub container's result travels stub → `LocalPipeTransport` →
 *      `ContainerExecution` → the daemon's store, and the run reads back in its terminal
 *      status off the real event-sourced projection.
 */
import { describe, expect, it } from "vitest";
import { ContainerExecution } from "./container-execution";
import type { ContainerDispatch } from "./assignment";
import { recordTerminalResult, type TerminalRunRecorder } from "./record-result";
import { runStubRunner } from "./stub-runner";
import { FakeDocker } from "../testing/fake-transport";
import { MEMORY_DB, openStore } from "../store/store";

const REPO = "acme/widgets";

/** A spy recorder capturing every `recordRunStuck` call (the only fact the mapping writes). */
function spyRecorder(): TerminalRunRecorder & { stuck: Array<{ runId: number; issueNumber: number; reason: string }> } {
  const stuck: Array<{ runId: number; issueNumber: number; reason: string }> = [];
  return { stuck, recordRunStuck: async (input) => void stuck.push(input) };
}

const run = { runId: 1, issueNumber: 184 };

describe("recordTerminalResult — the mapping (ADR-0038 / issue #184)", () => {
  it("pins agent-stuck from a `stuck` result, carrying the frame detail as the reason", async () => {
    const rec = spyRecorder();
    await recordTerminalResult(rec, run, { kind: "result", outcome: "stuck", detail: "bounded out" });
    expect(rec.stuck).toEqual([{ runId: 1, issueNumber: 184, reason: "bounded out" }]);
  });

  it("pins agent-stuck from a `failed` result too (a runner with no work product)", async () => {
    const rec = spyRecorder();
    await recordTerminalResult(rec, run, { kind: "result", outcome: "failed" });
    expect(rec.stuck).toHaveLength(1);
  });

  it("records nothing for runner-direct terminals (`pr-opened` / `escalated` land via GitHub)", async () => {
    const rec = spyRecorder();
    await recordTerminalResult(rec, run, { kind: "result", outcome: "pr-opened", detail: "#42" });
    await recordTerminalResult(rec, run, { kind: "result", outcome: "escalated", detail: "ask a human" });
    expect(rec.stuck).toEqual([]);
  });
});

describe("walking-skeleton round-trip — stub → pipe → ContainerExecution → store (issue #184)", () => {
  it("records the run's terminal state in the store from the result frame off the pipe", async () => {
    const store = openStore(MEMORY_DB);
    const scoped = store.forRepo(REPO);
    const seeded = scoped.upsertRun({ issueNumber: 184, mode: "tdd" });

    const dispatch: ContainerDispatch = {
      assignment: { issueNumber: 184, mode: "tdd", branch: "ralph/184", base: "main", prompt: "go" },
      token: { value: "tok" },
    };
    const docker = new FakeDocker((runner) => void runStubRunner(runner, dispatch.assignment));
    const result = await new ContainerExecution({ docker }).dispatch(dispatch);

    await recordTerminalResult(scoped, { runId: seeded.id, issueNumber: 184 }, result);

    expect(scoped.getRun(seeded.id)?.status).toBe("agent-stuck");
  });
});
