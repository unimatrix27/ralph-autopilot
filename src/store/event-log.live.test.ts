import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEMORY_DB, openStore, type Store } from "./store";
import type { RecordedLogEvent } from "./log-broadcast";
import { createLiveFeedPort, startLiveTail, type LiveTail } from "./live-feed";

const tick = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

function collectLive(store: Store, seen: RecordedLogEvent[], startAfter = 0): LiveTail {
  return startLiveTail({
    feed: createLiveFeedPort(store),
    startAfter,
    onBatch: (events) => seen.push(...events),
  });
}

describe("event log live emitter (after-commit)", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(MEMORY_DB);
  });
  afterEach(() => store.close());

  it("wakes a durable live tail after the append commits, with monotonic global positions", async () => {
    const seen: RecordedLogEvent[] = [];
    const tail = collectLive(store, seen);

    const scoped = store.forRepo("owner/repo");
    await scoped.recordRunStarted({ runId: 1, issueNumber: 7, mode: "tdd" });
    await scoped.recordFixAttempt({ runId: 1, issueNumber: 7, phase: 1 });
    await tick();

    // Both appends reached the subscriber, in commit order.
    expect(seen.map((e) => e.type)).toEqual(["RunStarted", "FixAttempted"]);
    expect(seen.every((e) => e.streamId === "owner/repo#7")).toBe(true);
    // Global positions are strictly increasing — the SSE cursor.
    expect(seen[1]!.globalPosition).toBeGreaterThan(seen[0]!.globalPosition);
    tail.close();
  });

  it("emits transcript events on their per-run stream too (the live tool/assistant feed)", async () => {
    const seen: RecordedLogEvent[] = [];
    const tail = collectLive(store, seen);

    const scoped = store.forRepo("owner/repo");
    await scoped.appendToTranscript(7, "run-abc", [
      { type: "TranscriptMessage", data: { runId: "run-abc", at: "2026-06-21T00:00:00.000Z", role: "assistant", sdkType: "assistant", blocks: [{ kind: "text", text: "hello" }] } },
    ]);
    await tick();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.streamId).toBe("transcript:owner/repo#7:run-abc");
    expect(seen[0]!.type).toBe("TranscriptMessage");
    tail.close();
  });

  it("the global positions the live tail reads match readAfter from the durable log", async () => {
    const seen: RecordedLogEvent[] = [];
    const tail = collectLive(store, seen);

    const scoped = store.forRepo("owner/repo");
    await scoped.recordRunStarted({ runId: 1, issueNumber: 7, mode: "tdd" });
    await scoped.recordFixAttempt({ runId: 1, issueNumber: 7, phase: 1 });
    await scoped.recordReviewPassed({ runId: 1, issueNumber: 7 });
    await tick();

    const fromLog = store.events.readAfter(0, 100);
    expect(fromLog.map((e) => e.globalPosition)).toEqual(seen.map((e) => e.globalPosition));
    expect(fromLog.map((e) => e.type)).toEqual(["RunStarted", "FixAttempted", "ReviewPassed"]);
    tail.close();
  });

  it("readAfter(cursor) returns exactly the events after a global_position cursor, in order (catch-up)", async () => {
    const scoped = store.forRepo("owner/repo");
    await scoped.recordRunStarted({ runId: 1, issueNumber: 7, mode: "tdd" }); // pos 1
    await scoped.recordFixAttempt({ runId: 1, issueNumber: 7, phase: 1 }); // pos 2
    await scoped.recordReviewPassed({ runId: 1, issueNumber: 7 }); // pos 3

    const all = store.events.readAfter(0, 100);
    const cursor = all[0]!.globalPosition; // after the first event
    const after = store.events.readAfter(cursor, 100);
    expect(after.map((e) => e.type)).toEqual(["FixAttempted", "ReviewPassed"]);
    expect(after.every((e) => e.globalPosition > cursor)).toBe(true);

    // head() is the latest committed position — a fresh "from now" connect starts here.
    expect(store.events.head()).toBe(all[all.length - 1]!.globalPosition);
  });

  it("readAfter respects the limit (batched catch-up)", async () => {
    const scoped = store.forRepo("owner/repo");
    for (let i = 0; i < 5; i++) {
      await scoped.recordFixAttempt({ runId: 1, issueNumber: 7, phase: 1 });
    }
    const firstTwo = store.events.readAfter(0, 2);
    expect(firstTwo).toHaveLength(2);
    const next = store.events.readAfter(firstTwo[1]!.globalPosition, 2);
    expect(next).toHaveLength(2);
    expect(next[0]!.globalPosition).toBeGreaterThan(firstTwo[1]!.globalPosition);
  });

  it("derives consecutive global positions within one multi-event batch (matches readAfter)", async () => {
    const seen: RecordedLogEvent[] = [];
    const tail = collectLive(store, seen);

    // One append carrying two events — the within-batch arithmetic (first = last - n + 1)
    // must line each event up with the position the durable log assigned it.
    await store.forRepo("owner/repo").appendIssueEvents(7, [
      { type: "FixAttempted", data: { runId: "1", phase: 1 } },
      { type: "FixAttempted", data: { runId: "1", phase: 1 } },
    ]);
    await tick();

    expect(seen).toHaveLength(2);
    expect(seen[1]!.globalPosition).toBe(seen[0]!.globalPosition + 1);
    const fromLog = store.events.readAfter(0, 100);
    expect(fromLog.map((e) => e.globalPosition)).toEqual(seen.map((e) => e.globalPosition));
    tail.close();
  });

  it("readAfter / head are well-defined before any append (empty log)", () => {
    expect(store.events.readAfter(0, 10)).toEqual([]);
    expect(store.events.head()).toBe(0);
  });
});
