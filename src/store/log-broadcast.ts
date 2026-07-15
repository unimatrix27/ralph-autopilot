/**
 * The **in-process live broadcast channel** behind the embedded web control plane's
 * SSE feed (ADR-0029, epic #106 / issue #109). The event log's after-commit emitter
 * ({@link import("./event-log").EventLog} `onCommit`) calls {@link LogBroadcaster.publish}
 * the moment events commit; subscribers receive coalesced wake-only signals for
 * durable tails.
 *
 * Two properties are load-bearing for the **isolation contract** (ADR-0029 — "slow
 * clients never back-pressure the daemon"):
 *
 *  - **Non-blocking publish.** `publish` is synchronous, O(subscribers), never
 *    throws, and never invokes a subscriber's handler inline — delivery is deferred
 *    to a microtask. The reconcile tick (which drives the appends that call
 *    `publish`) therefore never awaits, re-enters, or is wedged by the web layer.
 *  - **Wake-only, durable tail.** Multiple publishes before a subscriber drains
 *    coalesce to one wake-up without buffering event data. Consumers always re-read
 *    from the durable log by their `global_position` cursor
 *    ({@link import("./event-log").EventLog.readAfter}), so a slow consumer can only
 *    lag its own cursor; it cannot grow an in-memory buffer or block the emitter.
 *
 * This module is pure in-process plumbing: it holds no DB handle and no SDK reference,
 * so it is exhaustively unit-testable with synthetic events.
 */

/**
 * One committed log event as it crosses the live channel: its global ordering position
 * (the SSE cursor), the stream it landed on, and its type + data. `globalPosition` is
 * monotonic across the whole log, so a consumer filters by it to dedupe the
 * catch-up/live handoff.
 */
export interface RecordedLogEvent {
  /** Monotonic position across the whole event log — the SSE catch-up cursor. */
  globalPosition: number;
  /** The stream the event committed to (`<repo>#<issue>`, `transcript:…`, or the system stream). */
  streamId: string;
  /** The event `type` discriminant. */
  type: string;
  /** The event payload (already redacted at the append boundary for transcripts). */
  data: unknown;
}

/** Handle returned by {@link LogBroadcaster.subscribeWake}; `close()` detaches the subscriber. */
export interface LiveSubscription {
  close(): void;
}

interface WakeSubscriber {
  handler: () => void;
  scheduled: boolean;
  closed: boolean;
}

export class LogBroadcaster {
  private readonly wakeSubscribers = new Set<WakeSubscriber>();

  /** How many live subscribers are attached. */
  get subscriberCount(): number {
    return this.wakeSubscribers.size;
  }

  /**
   * Fan committed events out to every subscriber. Synchronous and non-throwing — it
   * only schedules wake microtasks, so the append path / reconcile tick that calls it
   * is never blocked or re-entered (ADR-0029).
   */
  publish(events: RecordedLogEvent[]): void {
    if (events.length === 0 || this.wakeSubscribers.size === 0) {
      return;
    }
    for (const sub of this.wakeSubscribers) {
      this.enqueueWake(sub);
    }
  }

  /**
   * Attach a wake-only subscriber. This is for durable tails that always call
   * `readAfter(cursor)` on wake-up.
   */
  subscribeWake(handler: () => void): LiveSubscription {
    const sub: WakeSubscriber = {
      handler,
      scheduled: false,
      closed: false,
    };
    this.wakeSubscribers.add(sub);
    return {
      close: () => {
        sub.closed = true;
        this.wakeSubscribers.delete(sub);
      },
    };
  }

  private enqueueWake(sub: WakeSubscriber): void {
    if (!sub.scheduled) {
      sub.scheduled = true;
      queueMicrotask(() => this.flushWake(sub));
    }
  }

  private flushWake(sub: WakeSubscriber): void {
    sub.scheduled = false;
    if (sub.closed) {
      return;
    }
    try {
      sub.handler();
    } catch {
      // A faulty wake subscriber must never break the emitter or its peers (ADR-0029).
    }
  }
}
