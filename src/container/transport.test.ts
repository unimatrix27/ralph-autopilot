/**
 * The {@link Transport} seam and its first concrete impl, {@link LocalPipeTransport}
 * (ADR-0038 / issue #184, epic #182 slice 2). A transport is the byte-level carrier under
 * the pure {@link import("./protocol").Frame} codec: it moves encoded frames between the
 * daemon and the in-container runner. `LocalPipeTransport` is the functionally-complete
 * first carrier (newline-delimited frames over a Readable/Writable pair — the container's
 * stdio); a future `DialBackSocketTransport` slots in behind the same interface unchanged.
 *
 * These tests pin the *carrier contract* (frames sent on one end arrive, in order, on the
 * other) — not the wire format, which is the codec's job and is tested in `protocol.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { connectedTransports } from "../testing/fake-transport";
import type { Frame } from "./protocol";
import type { Transport } from "./transport";

/** Wire two `LocalPipeTransport`s back-to-back over in-memory pipes — A's out is B's in. */
function connectedPair(): { a: Transport; b: Transport } {
  const { daemon, runner } = connectedTransports();
  return { a: daemon, b: runner };
}

/** Pull the next n frames off a transport's receive stream. */
async function take(transport: Transport, n: number): Promise<Frame[]> {
  const out: Frame[] = [];
  for await (const frame of transport.receive()) {
    out.push(frame);
    if (out.length === n) break;
  }
  return out;
}

describe("LocalPipeTransport (ADR-0038 / issue #184)", () => {
  it("delivers a frame sent on one end to the receiver on the other", async () => {
    const { a, b } = connectedPair();
    const received = take(b, 1);
    await a.send({ kind: "telemetry", body: { type: "lifecycle", name: "started" } });
    expect(await received).toEqual([{ kind: "telemetry", body: { type: "lifecycle", name: "started" } }]);
  });

  it("preserves frame order across a telemetry→result stream", async () => {
    const { a, b } = connectedPair();
    const received = take(b, 3);
    await a.send({ kind: "telemetry", body: { type: "lifecycle", name: "started" } });
    await a.send({ kind: "telemetry", body: { type: "transcript", message: "working" } });
    await a.send({ kind: "result", outcome: "pr-opened", detail: "#7" });
    expect(await received).toEqual([
      { kind: "telemetry", body: { type: "lifecycle", name: "started" } },
      { kind: "telemetry", body: { type: "transcript", message: "working" } },
      { kind: "result", outcome: "pr-opened", detail: "#7" },
    ]);
  });

  it("carries control frames in the daemon→runner direction too (bidirectional)", async () => {
    const { a, b } = connectedPair();
    const atRunner = take(a, 1);
    await b.send({ kind: "control", signal: "abort" });
    expect(await atRunner).toEqual([{ kind: "control", signal: "abort" }]);
  });

  it("completes the receive iterator when the peer closes (EOF, not a hang)", async () => {
    const { a, b } = connectedPair();
    await a.send({ kind: "result", outcome: "failed" });
    await a.close();
    // Drain to completion: the loop must END after the buffered frame, not block forever.
    const all: Frame[] = [];
    for await (const frame of b.receive()) all.push(frame);
    expect(all).toEqual([{ kind: "result", outcome: "failed" }]);
  });
});
