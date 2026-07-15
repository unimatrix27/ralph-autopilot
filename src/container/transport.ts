/**
 * The {@link Transport} seam (ADR-0038, issue #184, epic #182 slice 2): the byte-level
 * carrier beneath the pure {@link Frame} codec. The daemon-as-orchestrator and the
 * in-container runner speak {@link Frame}s; a `Transport` is *how those frames travel*.
 * Keeping the carrier behind an interface is what lets the protocol stay transport-agnostic
 * — {@link LocalPipeTransport} (the container's stdio) ships first; a future
 * `DialBackSocketTransport` (the CI-runner dial-back pattern, for worker fleets) drops in
 * unchanged.
 *
 * The transport is **best-effort**: correctness never depends on a frame arriving (GitHub
 * stays the source of truth, ADR-0016), so the interface deliberately offers no delivery
 * guarantee, ack, or retry — just "send this frame" and "iterate frames as they arrive".
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { decodeFrame, encodeFrame, type Frame } from "./protocol";

export interface Transport {
  /** Hand one frame to the carrier (best-effort; resolves once written). */
  send(frame: Frame): Promise<void>;
  /**
   * The inbound frames as they arrive, in order. A single consumer iterates this; the
   * iterator completes when the underlying carrier closes (the peer hung up / EOF).
   */
  receive(): AsyncIterable<Frame>;
  /** Release the carrier (close the outbound side). Idempotent. */
  close(): Promise<void>;
}

/** The two stream ends a {@link LocalPipeTransport} bridges — typically a container's stdio. */
export interface LocalPipeEnds {
  /** Frames *from* the peer arrive here (the runner's stdout / the daemon's read side). */
  inbound: Readable;
  /** Frames *to* the peer are written here (the runner's stdin / the daemon's write side). */
  outbound: Writable;
}

/**
 * A {@link Transport} over a Readable/Writable pair, framing each {@link Frame} as one
 * newline-delimited JSON line (the codec guarantees a frame encodes newline-free, so a line
 * IS a frame). This is the functionally-complete local carrier: the daemon holds the
 * container's stdout (inbound) + stdin (outbound), the runner holds the mirror image.
 */
export class LocalPipeTransport implements Transport {
  private closed = false;

  constructor(private readonly ends: LocalPipeEnds) {}

  async send(frame: Frame): Promise<void> {
    if (this.closed) return;
    const line = encodeFrame(frame) + "\n";
    await new Promise<void>((resolve, reject) => {
      this.ends.outbound.write(line, (err) => (err ? reject(err) : resolve()));
    });
  }

  async *receive(): AsyncIterable<Frame> {
    // readline yields exactly one inbound line per frame; decode each back to a Frame. A
    // malformed/foreign line throws out of the codec (loud), per the best-effort-but-explicit
    // contract — a corrupt pipe is surfaced, not silently mis-read.
    const lines = createInterface({ input: this.ends.inbound, crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.length === 0) continue;
      yield decodeFrame(line);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => this.ends.outbound.end(resolve));
  }
}
