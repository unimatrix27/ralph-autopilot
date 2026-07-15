/**
 * The walking-skeleton in-container runner (ADR-0038 / issue #184). This stub stands in for
 * the real thin runner (epic #182 slice 3): it does **no SDK work yet** — it proves the
 * in-container half of the plumbing by reading its dispatched {@link Assignment}, emitting a
 * lifecycle telemetry frame followed by a terminal result frame over its {@link Transport},
 * and exiting. The real runner replaces the body; the frame contract it speaks here is what
 * `ContainerExecution` orchestrates against.
 */
import { describe, expect, it } from "vitest";
import { connectedTransports } from "../testing/fake-transport";
import type { Assignment } from "./assignment";
import type { Frame } from "./protocol";
import type { Transport } from "./transport";
import { runStubRunner } from "./stub-runner";

const assignment: Assignment = {
  issueNumber: 184,
  mode: "tdd",
  branch: "ralph/184-walking-skeleton",
  base: "main",
  prompt: "implement the walking skeleton",
};

async function collect(transport: Transport, n: number): Promise<Frame[]> {
  const out: Frame[] = [];
  for await (const frame of transport.receive()) {
    out.push(frame);
    if (out.length === n) break;
  }
  return out;
}

describe("stub runner (ADR-0038 / issue #184)", () => {
  it("emits a lifecycle telemetry frame then a terminal result frame, in order", async () => {
    const { runner, daemon } = connectedTransports();
    const seen = collect(daemon, 2);
    await runStubRunner(runner, assignment);
    const frames = await seen;
    expect(frames[0]).toEqual({ kind: "telemetry", body: { type: "lifecycle", name: "started" } });
    expect(frames[1]!.kind).toBe("result");
  });

  it("ties its terminal result back to the dispatched assignment (the round-trip proof)", async () => {
    const { runner, daemon } = connectedTransports();
    const seen = collect(daemon, 2);
    await runStubRunner(runner, assignment);
    const result = (await seen)[1];
    expect(result).toEqual(
      expect.objectContaining({ kind: "result", detail: expect.stringContaining("184") }),
    );
  });
});
