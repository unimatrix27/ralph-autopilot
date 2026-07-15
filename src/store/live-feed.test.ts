import { describe, expect, it } from "vitest";
import type { LiveSubscription, RecordedLogEvent } from "./log-broadcast";
import type { LiveFeedPort, LiveWakeHandler } from "./live-feed";
import { startLiveTail } from "./live-feed";

class FakeFeed implements LiveFeedPort {
  events: RecordedLogEvent[] = [];
  handler: LiveWakeHandler | null = null;
  onSubscribe: (() => void) | null = null;

  head(): number {
    return this.events.reduce((max, event) => Math.max(max, event.globalPosition), 0);
  }

  readAfter(globalPosition: number, limit: number): RecordedLogEvent[] {
    return this.events.filter((event) => event.globalPosition > globalPosition).slice(0, limit);
  }

  subscribeWake(handler: LiveWakeHandler): LiveSubscription {
    this.handler = handler;
    this.onSubscribe?.();
    return {
      close: () => {
        this.handler = null;
      },
    };
  }

  append(events: RecordedLogEvent[]): void {
    this.events.push(...events);
  }

  wake(): void {
    this.handler?.();
  }
}

function ev(globalPosition: number): RecordedLogEvent {
  return { globalPosition, streamId: "owner/repo#1", type: "FixAttempted", data: { phase: globalPosition } };
}

describe("startLiveTail", () => {
  it("subscribes before initial catch-up so startup-racing commits are read", () => {
    const feed = new FakeFeed();
    const seen: number[] = [];
    const startAfter = feed.head();
    feed.onSubscribe = () => feed.append([ev(1)]);

    const tail = startLiveTail({
      feed,
      startAfter,
      onEvent: (event) => seen.push(event.globalPosition),
    });

    expect(seen).toEqual([1]);
    expect(tail.cursor()).toBe(1);
    tail.close();
  });

  it("treats live signals as wake-ups and re-reads the durable tail in bounded pages", () => {
    const feed = new FakeFeed();
    const batches: number[][] = [];
    const tail = startLiveTail({
      feed,
      startAfter: feed.head(),
      batchSize: 2,
      onBatch: (events) => batches.push(events.map((event) => event.globalPosition)),
    });

    feed.append([ev(1), ev(2), ev(3)]);
    feed.wake();

    expect(batches).toEqual([[1, 2], [3]]);
    expect(tail.cursor()).toBe(3);
    tail.close();
  });

  it("swallows a consumer failure and retries from the same cursor on the next wake-up", () => {
    const feed = new FakeFeed();
    const errors: string[] = [];
    const seen: number[][] = [];
    let fail = true;
    const tail = startLiveTail({
      feed,
      startAfter: feed.head(),
      onBatch: (events) => {
        seen.push(events.map((event) => event.globalPosition));
        if (fail) {
          fail = false;
          throw new Error("consumer failed");
        }
      },
      onError: (_error, phase) => errors.push(phase),
    });

    feed.append([ev(1)]);
    feed.wake();
    expect(tail.cursor()).toBe(0);

    feed.wake();
    expect(seen).toEqual([[1], [1]]);
    expect(errors).toEqual(["live"]);
    expect(tail.cursor()).toBe(1);
    tail.close();
  });

  it("close detaches the live wake-up subscription", () => {
    const feed = new FakeFeed();
    const seen: number[] = [];
    const tail = startLiveTail({
      feed,
      startAfter: feed.head(),
      onEvent: (event) => seen.push(event.globalPosition),
    });

    tail.close();
    feed.append([ev(1)]);
    feed.wake();

    expect(seen).toEqual([]);
  });
});
