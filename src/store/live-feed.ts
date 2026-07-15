/**
 * Canonical live-feed port over the event log's after-commit channel (ADR-0029).
 * Both the embedded SSE edge and the notification sink use this same store-backed
 * seam: durable catch-up by `global_position`, current head, and a wake-only live
 * subscription.
 */
import type { Store } from "./store";
import type { LiveSubscription, RecordedLogEvent } from "./log-broadcast";

export type LiveWakeHandler = () => void;

export interface LiveFeedPort {
  /** Subscribe to after-commit wake-ups. The handle's `close()` detaches. */
  subscribeWake(handler: LiveWakeHandler): LiveSubscription;
  /** Read up to `limit` committed events after a `global_position` cursor, oldest-first. */
  readAfter(globalPosition: number, limit: number): RecordedLogEvent[];
  /** The latest committed `global_position` — where a no-cursor "from now" consumer starts. */
  head(): number;
}

/** How many events one durable tail read pulls per wake-up. */
export const LIVE_TAIL_BATCH_SIZE = 500;

export type LiveTailErrorPhase =
  /** The initial subscribe-then-catch-up pass failed. */
  | "catch-up"
  /** A live wake-up failed while re-reading the durable tail or consuming events. */
  | "live";

interface LiveTailBaseOptions {
  /** The shared live-feed port (live wake-up + durable read-after). */
  feed: LiveFeedPort;
  /** Start after this global cursor. `feed.head()` gives "from now" semantics. */
  startAfter: number;
  /** Durable read page size; defaults to {@link LIVE_TAIL_BATCH_SIZE}. */
  batchSize?: number;
  /** Called after a read/consumer failure. The runner swallows the failure. */
  onError?: (error: unknown, phase: LiveTailErrorPhase) => void;
}

export type LiveTailOptions =
  | (LiveTailBaseOptions & {
      /** Consume one event at a time; the cursor advances after each successful event. */
      onEvent: (event: RecordedLogEvent) => void;
      onBatch?: never;
    })
  | (LiveTailBaseOptions & {
      /** Consume a durable page at a time; the cursor advances after the page succeeds. */
      onBatch: (events: RecordedLogEvent[]) => void;
      onEvent?: never;
    });

export interface LiveTail {
  /** The highest global position this tail has consumed. */
  cursor(): number;
  /** Detach the live wake-up subscription. Idempotent. */
  close(): void;
}

/** Build the shared live-feed port from the store's broadcaster + durable event log. */
export function createLiveFeedPort(store: Pick<Store, "liveLog" | "events">): LiveFeedPort {
  return {
    subscribeWake: (handler) => store.liveLog.subscribeWake(handler),
    readAfter: (globalPosition, limit) => store.events.readAfter(globalPosition, limit),
    head: () => store.events.head(),
  };
}

/**
 * Start a durable cursor tail over the live feed.
 *
 * The broadcaster is only the wake-up: every wake-up re-reads from the durable log
 * after the monotonic cursor, in bounded pages. That single subscribe-first /
 * read-after loop is the lossless handoff contract shared by SSE and notifications:
 * coalesced wake-ups cannot lose an event, and a faulty consumer is contained to this
 * edge by swallowing the failure and retrying from the same cursor on the next wake-up.
 */
export function startLiveTail(options: LiveTailOptions): LiveTail {
  const batchSize = Math.max(1, options.batchSize ?? LIVE_TAIL_BATCH_SIZE);
  let cursor = options.startAfter;
  let closed = false;

  const reportError = (error: unknown, phase: LiveTailErrorPhase): void => {
    try {
      options.onError?.(error, phase);
    } catch {
      /* the edge's diagnostic hook must not break the live broadcaster */
    }
  };

  const deliver = (events: RecordedLogEvent[]): void => {
    if (closed || events.length === 0) {
      return;
    }
    const fresh = events.filter((event) => event.globalPosition > cursor);
    if (fresh.length === 0) {
      return;
    }

    if (options.onEvent !== undefined) {
      for (const event of fresh) {
        options.onEvent(event);
        cursor = event.globalPosition;
      }
      return;
    }

    options.onBatch(fresh);
    cursor = fresh[fresh.length - 1]!.globalPosition;
  };

  const catchUp = (phase: LiveTailErrorPhase): void => {
    if (closed) {
      return;
    }
    try {
      for (;;) {
        const batch = options.feed.readAfter(cursor, batchSize);
        if (batch.length === 0) {
          return;
        }
        deliver(batch);
        if (batch.length < batchSize) {
          return;
        }
      }
    } catch (err) {
      reportError(err, phase);
    }
  };

  const subscription = options.feed.subscribeWake(() => catchUp("live"));

  // Subscribe first so commits racing with startup queue a wake-up, then read the
  // durable tail from the starting cursor. The cursor filter dedupes queued wake-ups.
  catchUp("catch-up");

  return {
    cursor: () => cursor,
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      subscription.close();
    },
  };
}
