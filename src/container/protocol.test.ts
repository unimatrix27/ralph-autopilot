/**
 * The daemon↔runner pipe protocol — a pure, versioned frame codec (ADR-0038 / issue #184,
 * epic #182 slice 2). The pipe is best-effort and never load-bearing for correctness
 * (GitHub stays the source of truth), so the codec's whole job is: round-trip the three
 * frame families exactly, and make runner/daemon version skew *explicit and loud* rather
 * than a silently mis-decoded frame. These are pure encode/decode units in the spirit of
 * `admission.test.ts` / `completeness.test.ts` — no transport, no IO.
 */
import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  ProtocolDecodeError,
  ProtocolVersionError,
  decodeFrame,
  encodeFrame,
  type Frame,
} from "./protocol";

describe("pipe protocol codec (ADR-0038 / issue #184)", () => {
  it("round-trips a runner→daemon result frame through encode→decode", () => {
    const frame = { kind: "result", outcome: "pr-opened", detail: "opened #42" } as const;
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  it("round-trips a rate-limit telemetry frame through encode→decode (ADR-0037/0038 / issue #228)", () => {
    // The in-container session observes the 429/usage-window signal first and relays it; the daemon
    // folds the signal into the dispatched account's meter so resolveRoute's headroom view stays
    // current. NEITHER the account id NOR the provider is on the wire — the daemon sources both from
    // the dispatch route, so the frame carries only the signal.
    const frame = {
      kind: "telemetry",
      body: {
        type: "rate-limit",
        signal: { status: "rejected", utilization: 100, resetsAt: 1718924400, rateLimitType: "five_hour" },
      },
    } as const;
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    // A signal carrying only a status + reset (no window utilization) round-trips just the same.
    const minimal = {
      kind: "telemetry",
      body: { type: "rate-limit", signal: { status: "rejected", resetsAt: 1718924400 } },
    } as const;
    expect(decodeFrame(encodeFrame(minimal))).toEqual(minimal);
  });

  it("round-trips every frame family (telemetry lifecycle/transcript/rate-limit, all result outcomes, control)", () => {
    const frames: Frame[] = [
      { kind: "telemetry", body: { type: "lifecycle", name: "started" } },
      { kind: "telemetry", body: { type: "transcript", message: { role: "assistant", text: "hi" } } },
      { kind: "telemetry", body: { type: "rate-limit", signal: { status: "rejected" } } },
      { kind: "result", outcome: "pr-opened", detail: "opened #42" },
      { kind: "result", outcome: "escalated", detail: "needs a human" },
      { kind: "result", outcome: "stuck", detail: "bounded out" },
      { kind: "result", outcome: "failed" },
      { kind: "control", signal: "abort" },
      { kind: "control", signal: "drain" },
    ];
    for (const frame of frames) {
      expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    }
  });

  it("round-trips an escalated result frame carrying the runner-direct escalation payload (#187)", () => {
    // The in-container runner posts the ralph-question comment + pushes WIP directly, then
    // relays the headline + comment id (+ the draft PR) so the daemon can swap the label.
    const frame = {
      kind: "result",
      outcome: "escalated",
      detail: "operator question posted",
      escalation: { headline: "Which retention window?", commentId: 987654, prNumber: 42 },
    } as const;
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  it("round-trips an escalated result frame carrying the full escalation question (#9)", () => {
    // The runner relays the validated question alongside the comment id so the daemon can
    // persist the run's resume context at indexing time — without it every answered container
    // escalation wedges as paused-run-unresumable (#9). Optional on the wire: an older runner's
    // question-less frame still decodes (best-effort pipe, ADR-0038).
    const frame = {
      kind: "result",
      outcome: "escalated",
      detail: "operator question posted",
      escalation: {
        headline: "Which retention window?",
        commentId: 987654,
        prNumber: 42,
        question: {
          headline: "Which retention window?",
          feature: "the run-archival job",
          whereWeStand: "the prune job is built but the window is a product choice",
          decision: "how long to keep a finished run",
          stakes: "too short loses audit history; too long grows disk unbounded",
          recommendation: "keep 90 days",
        },
      },
    } as const;
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  it("round-trips a stuck result frame carrying the self-stop report (#187)", () => {
    const frame = {
      kind: "result",
      outcome: "stuck",
      detail: "bounded out",
      stuck: { category: "no-green-build", reason: "tests will not go green after 6 edits" },
    } as const;
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  it("round-trips a reviewed result frame carrying the consolidated worklist (#189)", () => {
    // A container review run produces the worklist inside the container and relays it back so the
    // daemon-side review loop reads the SAME worklist/verdict contract as the in-process path.
    const frame = {
      kind: "result",
      outcome: "reviewed",
      detail: "review produced 2 findings",
      worklist: {
        items: [
          { severity: "P0", title: "null deref on empty list", detail: "guard it", source: "review" },
          { severity: "nit", title: "rename foo" },
        ],
      },
    } as const;
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  it("round-trips a fixed result frame (the fix pushed runner-direct) (#189)", () => {
    const frame = { kind: "result", outcome: "fixed", detail: "resolved 2 gating items" } as const;
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  it("round-trips a fix-escalate result frame carrying the escalation question (#189)", () => {
    // A fix that hits a risky structural change escalates instead of applying it blind; the
    // question rides back so the daemon-side review loop posts the heal-card, exactly as in-process.
    const frame = {
      kind: "result",
      outcome: "fix-escalate",
      detail: "risky structural change",
      fixEscalation: {
        headline: "Split the store module?",
        feature: "the persistence layer",
        whereWeStand: "the schema is fine but the module is doing two jobs",
        decision: "split now vs later",
        stakes: "splitting later is a wider refactor across call sites",
        recommendation: "split now",
      },
    } as const;
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  it("fails loud with ProtocolVersionError on version skew — never a silent mis-decode", () => {
    // A frame stamped with a different protocol version (a runner from another release).
    const foreign = JSON.stringify({ v: PROTOCOL_VERSION + 1, frame: { kind: "control", signal: "abort" } });
    expect(() => decodeFrame(foreign)).toThrow(ProtocolVersionError);
    try {
      decodeFrame(foreign);
    } catch (err) {
      expect(err).toBeInstanceOf(ProtocolVersionError);
      expect((err as ProtocolVersionError).received).toBe(PROTOCOL_VERSION + 1);
      expect((err as ProtocolVersionError).expected).toBe(PROTOCOL_VERSION);
    }
  });

  it("rejects a malformed (non-JSON / unenveloped) line with ProtocolDecodeError", () => {
    expect(() => decodeFrame("not json")).toThrow(ProtocolDecodeError);
    expect(() => decodeFrame(JSON.stringify({ kind: "control", signal: "abort" }))).toThrow(
      ProtocolDecodeError,
    );
  });

  it("rejects a versioned-but-garbage frame body — never mis-decodes into a junk Frame", () => {
    // Well-formed envelope, current version, but a frame body the codec cannot validate. This
    // must fail loud rather than slip through as a plausible-but-wrong Frame downstream.
    const cases = [
      { v: PROTOCOL_VERSION, frame: { kind: "nope" } }, // unknown discriminant
      { v: PROTOCOL_VERSION, frame: { kind: "result", outcome: "not-an-outcome" } }, // bad enum
      { v: PROTOCOL_VERSION, frame: { kind: "control", signal: "halt" } }, // bad enum
      { v: PROTOCOL_VERSION, frame: { kind: "result", outcome: "failed", extra: 1 } }, // unknown key
      { v: PROTOCOL_VERSION, frame: { kind: "telemetry", body: { type: "lifecycle" } } }, // missing name
      // rate-limit body (#228): the wire carries only the signal (provider is daemon-sourced), so an
      // unknown key on the body, a missing signal, and a signal with an unknown key all fail loud
      // rather than mis-decoding into a plausible-but-wrong meter fold.
      { v: PROTOCOL_VERSION, frame: { kind: "telemetry", body: { type: "rate-limit", signal: {}, provider: "claude" } } },
      { v: PROTOCOL_VERSION, frame: { kind: "telemetry", body: { type: "rate-limit" } } },
      { v: PROTOCOL_VERSION, frame: { kind: "telemetry", body: { type: "rate-limit", signal: { nope: 1 } } } },
    ];
    for (const c of cases) {
      expect(() => decodeFrame(JSON.stringify(c))).toThrow(ProtocolDecodeError);
    }
  });

  it("encodes to a single newline-free line so frames can be newline-delimited on the wire", () => {
    const line = encodeFrame({ kind: "telemetry", body: { type: "lifecycle", name: "session-end" } });
    expect(line).not.toContain("\n");
  });
});
