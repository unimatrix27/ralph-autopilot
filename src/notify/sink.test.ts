import { describe, expect, it } from "vitest";
import type { RecordedLogEvent, LiveSubscription } from "../store/log-broadcast";
import type { LiveFeedPort, LiveWakeHandler } from "../store/live-feed";
import { createLogger, type Logger } from "../log/logger";
import { CompositeNotificationDispatcher, NotificationSink, type NotificationDispatchPort, type StallProbe } from "./sink";
import type { NotificationRequest } from "./types";

// ── fakes ─────────────────────────────────────────────────────────────────────

/** An in-memory feed backing both subscribe (wake-up) and readAfter (durable source). */
class FakeFeed implements LiveFeedPort {
  private events: RecordedLogEvent[] = [];
  private handler: LiveWakeHandler | null = null;
  private nextSub = 0;

  head(): number {
    return this.events.reduce((m, e) => Math.max(m, e.globalPosition), 0);
  }
  readAfter(globalPosition: number, limit: number): RecordedLogEvent[] {
    return this.events.filter((e) => e.globalPosition > globalPosition).slice(0, limit);
  }
  subscribeWake(handler: LiveWakeHandler): LiveSubscription {
    this.handler = handler;
    this.nextSub += 1;
    const id = this.nextSub;
    return { close: () => { if (id === this.nextSub) this.handler = null; } };
  }
  /** Test helper: append events to the durable log without waking the sink. */
  append(events: RecordedLogEvent[]): void {
    this.events.push(...events);
  }
  /** Test helper: commit events to the durable log AND wake the sink (broadcaster fan-out). */
  commit(events: RecordedLogEvent[]): void {
    this.append(events);
    this.wake();
  }
  /** Test helper: send one wake-only signal. */
  wake(): void {
    this.handler?.();
  }
}

/** A dispatcher that just captures what would be POSTed. */
function capturingDispatcher(): { dispatch: (r: NotificationRequest[]) => void; sent: NotificationRequest[] } {
  const sent: NotificationRequest[] = [];
  return { dispatch: (r) => sent.push(...r), sent };
}

function ev(streamId: string, type: string, data: Record<string, unknown>, gp: number): RecordedLogEvent {
  return { globalPosition: gp, streamId, type, data };
}

const ESC = (gp: number) => ev("owner/repo#1", "Escalated", { runId: "1", kind: "escalate", headline: "Q", commentId: 1 }, gp);
const STUCK = (gp: number) => ev("owner/repo#2", "RunStuck", { runId: "2", reason: "maxed" }, gp);
const ANOM = (gp: number) => ev("owner/repo#3", "AnomalyDetected", { reason: "island" }, gp);
const QUIET = (gp: number) => ev("owner/repo#9", "FixAttempted", { runId: "9", phase: 1 }, gp);

// ── event-driven dispatch ─────────────────────────────────────────────────────

describe("NotificationSink — event-driven dispatch", () => {
  it("dispatches a notification when an escalation commits after start", () => {
    const feed = new FakeFeed();
    const cap = capturingDispatcher();
    const sink = new NotificationSink({ feed, dispatcher: cap, logger: silent() });
    sink.start();
    feed.commit([ESC(1)]);
    expect(cap.sent.map((s) => s.kind)).toEqual(["escalation"]);
    sink.stop();
  });

  it("dispatches for escalation, heal, stuck, and anomaly (the four attention families)", () => {
    const feed = new FakeFeed();
    const cap = capturingDispatcher();
    const sink = new NotificationSink({ feed, dispatcher: cap, logger: silent() });
    sink.start();
    feed.commit([
      ev("o/r#1", "Escalated", { runId: "1", kind: "escalate", headline: "h", commentId: 1 }, 1),
      ev("o/r#2", "Escalated", { runId: "2", kind: "heal-card", headline: "h", commentId: null }, 2),
      ev("o/r#3", "RunStuck", { runId: "3", reason: "r" }, 3),
      ev("o/r#4", "AnomalyDetected", { reason: "r" }, 4),
    ]);
    expect(cap.sent.map((s) => s.kind).sort()).toEqual(["anomaly", "escalation", "heal", "stuck"]);
    sink.stop();
  });

  it("ignores events that should not notify (FixAttempted etc.)", () => {
    const feed = new FakeFeed();
    const cap = capturingDispatcher();
    const sink = new NotificationSink({ feed, dispatcher: cap, logger: silent() });
    sink.start();
    feed.commit([QUIET(1)]);
    expect(cap.sent).toHaveLength(0);
    sink.stop();
  });

  it("does NOT replay history on start — only events committed after start notify", () => {
    const feed = new FakeFeed();
    feed.commit([ESC(1), STUCK(2)]); // pre-existing, before the sink subscribes
    const cap = capturingDispatcher();
    const sink = new NotificationSink({ feed, dispatcher: cap, logger: silent() });
    sink.start();
    expect(cap.sent).toHaveLength(0); // nothing replayed
    feed.commit([ANOM(3)]); // only this new one notifies
    expect(cap.sent.map((s) => s.kind)).toEqual(["anomaly"]);
    sink.stop();
  });

  it("is lossless across a coalesced wake-up — reads back from the durable log", () => {
    // The broadcaster supplies only a wake signal; the sink must recover all committed
    // attention events from the durable log, not depend on an in-memory batch.
    const feed = new FakeFeed();
    const cap = capturingDispatcher();
    const sink = new NotificationSink({ feed, dispatcher: cap, logger: silent() });
    sink.start();
    feed.append([ESC(1), STUCK(2), ANOM(3)]);
    feed.wake();
    expect(cap.sent.map((s) => s.kind).sort()).toEqual(["anomaly", "escalation", "stuck"]);
    sink.stop();
  });

  it("dedups a repeated attention event within a batch to one notification", () => {
    const feed = new FakeFeed();
    const cap = capturingDispatcher();
    const sink = new NotificationSink({ feed, dispatcher: cap, logger: silent() });
    sink.start();
    feed.commit([ESC(1), ESC(2)]); // same issue, same kind, twice
    expect(cap.sent).toHaveLength(1);
    sink.stop();
  });
});

describe("CompositeNotificationDispatcher", () => {
  it("fans the same batch to every dispatcher, isolating a faulty one", () => {
    const seen: string[] = [];
    const request = {
      kind: "escalation",
      severity: "high",
      title: "Escalation",
      message: "Need input",
      repo: "owner/repo",
      issueNumber: 1,
      at: "2026-06-23T00:00:00.000Z",
    } satisfies NotificationRequest;
    const ok: NotificationDispatchPort = { dispatch: (rs) => seen.push("ok:" + rs.length) };
    const broken: NotificationDispatchPort = { dispatch: () => { throw new Error("boom"); } };
    const other: NotificationDispatchPort = { dispatch: () => seen.push("other") };
    const composite = new CompositeNotificationDispatcher([ok, broken, other], silent());
    composite.dispatch([request]); // must not throw despite `broken`
    expect(seen).toEqual(["ok:1", "other"]);
  });
});

// ── stall probe ───────────────────────────────────────────────────────────────

describe("NotificationSink — stalled-daemon probe", () => {
  const HOUR = 3600_000;
  const THRESHOLD = 5 * 60_000; // 5 min

  function makeClock(start: number) {
    let t = start;
    return { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  }

  it("fires a stall notification once when no tick lands past the threshold", () => {
    const feed = new FakeFeed();
    const cap = capturingDispatcher();
    const clock = makeClock(1_000_000);
    let lastTick: string | null = new Date(1_000_000).toISOString(); // just ticked
    const probe: StallProbe = () => lastTick;
    const sink = new NotificationSink({
      feed, dispatcher: cap, logger: silent(),
      stallProbe: probe, stallThresholdMs: THRESHOLD, pollIntervalMs: 60_000, now: clock.now,
    });
    sink.start();
    clock.advance(THRESHOLD + 1);
    sink.pollOnce(); // past threshold → notify
    expect(cap.sent.filter((s) => s.kind === "stall")).toHaveLength(1);
    cap.sent.length = 0;
    sink.pollOnce(); // still stalled, same episode → NOT re-notified
    expect(cap.sent).toHaveLength(0);
    sink.stop();
  });

  it("does not fire before the threshold", () => {
    const feed = new FakeFeed();
    const cap = capturingDispatcher();
    const clock = makeClock(1_000_000);
    const sink = new NotificationSink({
      feed, dispatcher: cap, logger: silent(),
      stallProbe: () => new Date(1_000_000).toISOString(),
      stallThresholdMs: THRESHOLD, pollIntervalMs: 60_000, now: clock.now,
    });
    sink.start();
    clock.advance(THRESHOLD - 1);
    sink.pollOnce();
    expect(cap.sent).toHaveLength(0);
    sink.stop();
  });

  it("pauses stall notifications while the daemon is intentionally draining", () => {
    const feed = new FakeFeed();
    const cap = capturingDispatcher();
    const clock = makeClock(1_000_000);
    let draining = true;
    const sink = new NotificationSink({
      feed, dispatcher: cap, logger: silent(),
      stallProbe: () => new Date(1_000_000).toISOString(),
      stallThresholdMs: THRESHOLD, pollIntervalMs: 60_000, now: clock.now,
      suppressStallProbe: () => draining,
    });
    sink.start();
    clock.advance(THRESHOLD + 1);
    sink.pollOnce();
    expect(cap.sent).toHaveLength(0);

    draining = false;
    sink.pollOnce();
    expect(cap.sent.filter((s) => s.kind === "stall")).toHaveLength(1);
    sink.stop();
  });

  it("recovers then re-notifies on a fresh stall episode (dedup is per-episode)", () => {
    const feed = new FakeFeed();
    const cap = capturingDispatcher();
    const clock = makeClock(1_000_000);
    let lastTick: string | null = new Date(1_000_000).toISOString();
    const sink = new NotificationSink({
      feed, dispatcher: cap, logger: silent(),
      stallProbe: () => lastTick, stallThresholdMs: THRESHOLD, pollIntervalMs: 60_000, now: clock.now,
    });
    sink.start();
    clock.advance(THRESHOLD + 1);
    sink.pollOnce();
    expect(cap.sent.filter((s) => s.kind === "stall")).toHaveLength(1);
    // Daemon recovers: a fresh tick advances lastTick to "now".
    lastTick = clock.now().toISOString();
    cap.sent.length = 0;
    sink.pollOnce(); // no longer stalled → reset
    expect(cap.sent).toHaveLength(0);
    // Stalls again much later.
    clock.advance(THRESHOLD + 1);
    sink.pollOnce();
    expect(cap.sent.filter((s) => s.kind === "stall")).toHaveLength(1); // new episode → notify again
    sink.stop();
  });

  it("treats a never-ticked daemon (null probe) as stalled past the threshold from start", () => {
    const feed = new FakeFeed();
    const cap = capturingDispatcher();
    const startMs = 1_000_000;
    const clock = makeClock(startMs);
    const sink = new NotificationSink({
      feed, dispatcher: cap, logger: silent(),
      stallProbe: () => null, stallThresholdMs: THRESHOLD, pollIntervalMs: 60_000, now: clock.now,
    });
    sink.start();
    clock.advance(THRESHOLD + 1);
    sink.pollOnce();
    expect(cap.sent.filter((s) => s.kind === "stall")).toHaveLength(1);
    sink.stop();
  });

  it("disables the stall probe when stallThresholdMs is 0", () => {
    const feed = new FakeFeed();
    const cap = capturingDispatcher();
    const clock = makeClock(1_000_000);
    const sink = new NotificationSink({
      feed, dispatcher: cap, logger: silent(),
      stallProbe: () => new Date(1_000_000).toISOString(),
      stallThresholdMs: 0, pollIntervalMs: 60_000, now: clock.now,
    });
    sink.start();
    clock.advance(THRESHOLD + 1 + HOUR);
    sink.pollOnce();
    expect(cap.sent).toHaveLength(0);
    sink.stop();
  });
});

// ── lifecycle ─────────────────────────────────────────────────────────────────

describe("NotificationSink — lifecycle", () => {
  it("start/stop is idempotent and stop detaches the subscription", () => {
    const feed = new FakeFeed();
    const cap = capturingDispatcher();
    const sink = new NotificationSink({ feed, dispatcher: cap, logger: silent() });
    sink.start();
    sink.start(); // idempotent
    feed.commit([ESC(1)]);
    expect(cap.sent).toHaveLength(1);
    sink.stop();
    feed.commit([STUCK(2)]); // detached → no dispatch
    expect(cap.sent).toHaveLength(1);
    sink.stop(); // idempotent
  });

  it("never throws from the wake-up handler (a faulty subscriber cannot wedge the sink)", () => {
    const feed = new FakeFeed();
    const cap = capturingDispatcher();
    const sink = new NotificationSink({
      feed,
      dispatcher: { dispatch: () => { throw new Error("dispatcher broke"); } },
      logger: silent(),
    });
    sink.start();
    expect(() => feed.commit([ESC(1)])).not.toThrow();
    sink.stop();
  });
});

/** A silent logger (the sink only logs diagnostics; nothing should surface here). */
function silent(): Logger {
  return createLogger({ level: "error", write: () => {} });
}
