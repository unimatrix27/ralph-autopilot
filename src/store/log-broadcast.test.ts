import { describe, expect, it } from "vitest";
import { LogBroadcaster, type RecordedLogEvent } from "./log-broadcast";

/** A few synthetic committed events at consecutive global positions. */
function events(from: number, count: number): RecordedLogEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    globalPosition: from + i,
    streamId: "owner/repo#1",
    type: "FixAttempted",
    data: { i },
  }));
}

const tick = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

describe("LogBroadcaster", () => {
  it("delivers a wake after the publish call returns (never blocks the emitter)", async () => {
    const hub = new LogBroadcaster();
    let handlerRan = false;
    hub.subscribeWake(() => {
      handlerRan = true;
    });

    hub.publish(events(1, 2));
    // The handler must not have run synchronously inside publish — the append path
    // (which calls publish) can never be blocked or re-entered by a subscriber.
    expect(handlerRan).toBe(false);

    await tick();
    expect(handlerRan).toBe(true);
  });

  it("coalesces multiple publishes in one sync turn into a single wake", async () => {
    const hub = new LogBroadcaster();
    let wakes = 0;
    hub.subscribeWake(() => {
      wakes += 1;
    });

    hub.publish(events(1, 1));
    hub.publish(events(2, 2));
    hub.publish(events(4, 1));
    await tick();

    expect(wakes).toBe(1);
  });

  it("stops delivering after a subscription closes, and forgets the subscriber", async () => {
    const hub = new LogBroadcaster();
    let wakes = 0;
    const sub = hub.subscribeWake(() => {
      wakes += 1;
    });
    expect(hub.subscriberCount).toBe(1);

    sub.close();
    expect(hub.subscriberCount).toBe(0);
    hub.publish(events(1, 3));
    await tick();
    expect(wakes).toBe(0);
  });

  it("isolates a throwing subscriber: publish never throws and other subscribers still receive", async () => {
    const hub = new LogBroadcaster();
    let good = 0;
    hub.subscribeWake(() => {
      throw new Error("subscriber blew up");
    });
    hub.subscribeWake(() => {
      good += 1;
    });

    expect(() => hub.publish(events(1, 1))).not.toThrow();
    await tick();
    expect(good).toBe(1);
  });

  it("a publish with no subscribers is a no-op (the emitter path stays cheap when the UI is closed)", () => {
    const hub = new LogBroadcaster();
    expect(() => hub.publish(events(1, 5))).not.toThrow();
    expect(hub.subscriberCount).toBe(0);
  });
});
