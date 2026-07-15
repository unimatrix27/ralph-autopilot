/**
 * The **notification sink** (epic #106, issue #117): the out-of-app alerting edge that
 * pages the operator when the daemon needs them and the UI is not open.
 *
 * It is the after-commit event stream's second subscriber (the first is the live SSE
 * feed, ADR-0029), so it inherits that channel's isolation contract for free: the wake-up
 * fires from a microtask off the append path, never inline with the reconcile tick, and a
 * slow / failing dispatch never back-pressures the daemon. The sink composes three pure /
 * injectable pieces —
 *   - the pure {@link import("./decide").decideNotifications} (event → notification + dedup),
 *   - the best-effort {@link import("./dispatch").NotificationDispatcher} (fire-and-forget POSTs),
 *   - a periodic **stall probe** that pages when no reconcile tick has landed for a while,
 *     unless the daemon is intentionally in a no-tick window such as graceful drain.
 *
 * Losslessness for the event path rides the canonical durable tail runner shared with
 * the SSE feed: the broadcast is only the *wake-up*; the sink re-reads exactly the
 * events past its monotonic cursor from the durable log, so coalesced wake-ups can
 * never silently swallow an escalation. The sink starts from the log's `head()`, so a
 * restart never replays pre-existing escalations and re-pages the operator about
 * history.
 *
 * `start()`/`stop()` are idempotent and never throw; `stop()` detaches the subscription
 * and the stall timer (which is `unref`'d so it never holds the process open past a drain).
 */
import type { Logger } from "../log/logger";
import type { RecordedLogEvent } from "../store/log-broadcast";
import { LIVE_TAIL_BATCH_SIZE, startLiveTail, type LiveFeedPort, type LiveTail } from "../store/live-feed";
import { decideNotifications } from "./decide";
import type { NotificationRequest } from "./types";

/**
 * The stall probe: returns the latest reconcile-tick ISO instant, or `null` before the
 * first tick / on a fresh start. The daemon wires it to the persisted snapshot's daemon
 * health (`lastTickAt`); the sink treats `null` as "stalled since start".
 */
export type StallProbe = () => string | null;

/** The minimal dispatcher surface the sink calls (so a fake can stand in under test). */
export interface NotificationDispatchPort {
  dispatch(requests: NotificationRequest[]): void;
}

/** Fan the same `dispatch(requests)` to a list of dispatchers, isolating each (ADR-0029). */
export class CompositeNotificationDispatcher implements NotificationDispatchPort {
  constructor(
    private readonly dispatchers: ReadonlyArray<NotificationDispatchPort>,
    private readonly logger: Logger,
  ) {}

  dispatch(requests: NotificationRequest[]): void {
    for (const d of this.dispatchers) {
      try {
        d.dispatch(requests);
      } catch (err) {
        // Each dispatcher is itself fire-and-forget; this guards a faulty implementation.
        this.logger.warn("notify.dispatcher-threw", { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}

export interface NotificationSinkDeps {
  /** The live-feed port (subscribe wake-up + durable readAfter + head). */
  feed: LiveFeedPort;
  /** The best-effort dispatcher (event-driven requests + stall requests both route here). */
  dispatcher: NotificationDispatchPort;
  /** Structured logger for sink diagnostics (never fatal). */
  logger: Logger;
  /**
   * The stall probe. Optional; when omitted, no stall detection runs (the sink still does
   * event-driven dispatch). Wired by the daemon from the persisted snapshot.
   */
  stallProbe?: StallProbe;
  /** Page when no tick has landed for this many ms. `0` (default) disables the stall probe. */
  stallThresholdMs?: number;
  /** Pause only stall notifications while an old tick is expected (for example, graceful drain). */
  suppressStallProbe?: () => boolean;
  /** How often the stall probe runs. Defaults to one minute. */
  pollIntervalMs?: number;
  /** Injected clock for a deterministic stall evaluation; defaults to the system clock. */
  now?: () => Date;
}

/** Default stall-probe cadence (the probe is cheap, so a minute is responsive enough). */
const DEFAULT_POLL_INTERVAL_MS = 60_000;

export class NotificationSink {
  private readonly feed: LiveFeedPort;
  private readonly dispatcher: NotificationDispatchPort;
  private readonly logger: Logger;
  private readonly stallProbe: StallProbe | null;
  private readonly stallThresholdMs: number;
  private readonly suppressStallProbe: () => boolean;
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;
  private readonly startedAtIso: string;

  private tail: LiveTail | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** The stall-episode key already paged (the stalled `lastTickAt`, or "<start>" for never-ticked); null when healthy. */
  private notifiedStallKey: string | null = null;
  private running = false;

  constructor(deps: NotificationSinkDeps) {
    this.feed = deps.feed;
    this.dispatcher = deps.dispatcher;
    this.logger = deps.logger;
    this.stallProbe = deps.stallProbe ?? null;
    this.stallThresholdMs = deps.stallThresholdMs ?? 0;
    this.suppressStallProbe = deps.suppressStallProbe ?? ((): boolean => false);
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = deps.now ?? ((): Date => new Date());
    this.startedAtIso = this.now().toISOString();
  }

  /**
   * Subscribe to the after-commit stream and arm the stall probe. Idempotent. From `head()`
   * onward — a restart does not replay history. Never throws.
   */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    // Start from the log's head so a restart pages only on events committed AFTER start,
    // never on pre-existing escalations still sitting in the log.
    const startAfter = this.feed.head();
    this.tail = startLiveTail({
      feed: this.feed,
      startAfter,
      batchSize: LIVE_TAIL_BATCH_SIZE,
      onBatch: (events) => this.notify(events),
      onError: (err) => {
        this.logger.warn("notify.pump-failed", { error: err instanceof Error ? err.message : String(err) });
      },
    });
    if (this.stallProbe && this.stallThresholdMs > 0) {
      // The timer callback swallows any throw (e.g. a faulty probe) so a stall-probe
      // fault can never surface as an uncaught timer exception — the sink is best-effort.
      this.timer = setInterval(
        () => {
          try {
            this.pollOnce();
          } catch (err) {
            this.logger.warn("notify.poll-failed", { error: err instanceof Error ? err.message : String(err) });
          }
        },
        this.pollIntervalMs,
      );
      // Never let the stall probe hold the event loop open past a drain (ADR-0029 isolation).
      this.timer.unref?.();
    }
    this.logger.info("notify.sink-started", {
      fromHead: this.tail.cursor(),
      stallProbe: this.stallProbe !== null && this.stallThresholdMs > 0,
      stallThresholdMs: this.stallThresholdMs,
    });
  }

  /** Detach the subscription + stall timer. Idempotent. Never throws. */
  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.tail?.close();
    this.tail = null;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one stall-probe evaluation (also what the timer calls). Exposed so a test (or a
   * deterministic driver) can advance it without waiting on the timer. Idempotent + safe
   * to call before `start()` / after `stop()` (it just re-evaluates the probe).
   */
  pollOnce(): void {
    if (!this.stallProbe || this.stallThresholdMs <= 0) {
      return;
    }
    if (this.suppressStallProbe()) {
      return;
    }
    const now = this.now();
    const lastTick = this.stallProbe();
    const baselineIso = lastTick ?? this.startedAtIso;
    const baselineMs = Date.parse(baselineIso);
    const elapsedMs = now.getTime() - baselineMs;
    if (!(elapsedMs > this.stallThresholdMs)) {
      // Healthy (or not yet past threshold) — reset so the next stall episode re-pages.
      this.notifiedStallKey = null;
      return;
    }
    // Stalled. Page once per episode (keyed by the stalled tick instant / start fallback).
    if (this.notifiedStallKey === baselineIso) {
      return;
    }
    this.notifiedStallKey = baselineIso;
    const last = lastTick ?? "never";
    this.safeDispatch([
      {
        kind: "stall",
        severity: "max",
        title: "Ralph daemon stalled",
        message: `No reconcile tick for ${formatElapsed(elapsedMs)} (last tick: ${last}).`,
        repo: null,
        issueNumber: null,
        at: now.toISOString(),
      },
    ]);
  }

  /** Decide and dispatch notifications for one durable tail page. */
  private notify(events: RecordedLogEvent[]): void {
    if (!this.running) {
      return;
    }
    const requests = decideNotifications(events, this.now);
    if (requests.length > 0) {
      this.safeDispatch(requests);
    }
  }

  /** Dispatch, swallowing any throw from a misbehaving dispatcher (the sink never throws). */
  private safeDispatch(requests: NotificationRequest[]): void {
    try {
      this.dispatcher.dispatch(requests);
    } catch (err) {
      this.logger.warn("notify.dispatch-threw", { count: requests.length, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** A compact human duration for the stall message (e.g. `6m`, `2h 3m`, `90s`). */
function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m`;
  }
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}
