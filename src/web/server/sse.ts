/**
 * The `/api/live` Server-Sent-Events handler (ADR-0029/0031, issue #109): it streams
 * every committed log event to a browser as `text/event-stream` frames, replacing
 * polling. SSE (not WebSocket) is deliberate — push-only, auto-reconnecting, no upgrade
 * handshake (ADR-0031).
 *
 * The flow, per connection:
 *   1. **Resolve a cursor** — the `Last-Event-ID` header (sent automatically by the
 *      browser's `EventSource` on reconnect) or `?cursor=<n>`; absent → "from now"
 *      (`port.head()`), so a fresh page does not replay all of history.
 *   2. Start the shared durable tail runner, which subscribes to live wake-ups first and
 *      then reads from the cursor over the durable log. Every frame carries
 *      `id: <global_position>`, and the runner's monotonic cursor dedupes the
 *      catch-up→live handoff.
 *   3. **Stay live.** Live broadcasts are wake-ups only: the runner re-syncs from the
 *      durable log by cursor on every wake-up, so coalesced wake signals cannot lose an
 *      event and never block the emitter (ADR-0029).
 *
 * Isolation (ADR-0029): nothing here is awaited by the reconcile tick. The heartbeat
 * timer is `unref`'d, the subscription + timer are torn down on socket close, and a
 * write to a dead socket can never wedge the daemon.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "../../log/logger";
import type { RecordedLogEvent } from "../../store/log-broadcast";
import { LIVE_TAIL_BATCH_SIZE, startLiveTail, type LiveTail } from "../../store/live-feed";
import type { LiveFeedPort } from "./ports";

/** Comment-ping cadence — keeps proxies from idling the connection and detects dead sockets. */
const HEARTBEAT_MS = 15_000;
/** Reconnect backoff the browser's `EventSource` honours after a drop (the `retry:` field). */
const RECONNECT_MS = 3_000;
/**
 * Resolve the catch-up cursor for a connection: `Last-Event-ID` (reconnect) wins, then
 * `?cursor=<n>`; absent → the current head (stream only new events). A malformed value
 * falls back to head rather than replaying everything.
 */
function resolveCursor(req: IncomingMessage, port: LiveFeedPort): number {
  const lastEventId = req.headers["last-event-id"];
  const fromHeader = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;
  if (fromHeader !== undefined && /^\d+$/.test(fromHeader)) {
    return Number(fromHeader);
  }
  try {
    const raw = new URL(req.url ?? "/", "http://localhost").searchParams.get("cursor");
    if (raw !== null && /^\d+$/.test(raw)) {
      return Number(raw);
    }
  } catch {
    /* fall through to head */
  }
  return port.head();
}

/**
 * Serve one SSE connection over `/api/live`. Returns immediately; the response stays
 * open and is streamed until the client disconnects.
 */
export function handleLiveSse(
  req: IncomingMessage,
  res: ServerResponse,
  port: LiveFeedPort,
  logger: Logger,
): void {
  const startAfter = resolveCursor(req, port);
  let closed = false;
  let tail: LiveTail | null = null;

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Defeat proxy/response buffering so frames flush as they are written.
    "x-accel-buffering": "no",
  });
  res.write(`retry: ${RECONNECT_MS}\n`);
  res.write(`: connected\n\n`);

  const send = (event: RecordedLogEvent): void => {
    if (closed) {
      return;
    }
    const payload = JSON.stringify({
      globalPosition: event.globalPosition,
      streamId: event.streamId,
      type: event.type,
      data: event.data,
    });
    res.write(`id: ${event.globalPosition}\ndata: ${payload}\n\n`);
  };

  tail = startLiveTail({
    feed: port,
    startAfter,
    batchSize: LIVE_TAIL_BATCH_SIZE,
    onEvent: send,
    onError: (err, phase) => {
      if (phase === "catch-up") {
        logger.debug("web.live-catchup-failed", { error: String(err) });
        return;
      }
      logger.debug("web.live-write-failed", { error: String(err) });
      cleanup();
    },
  });

  const heartbeat = setInterval(() => {
    if (!closed) {
      res.write(`: ping\n\n`);
    }
  }, HEARTBEAT_MS);
  // Never let the heartbeat hold the event loop open past a drain (ADR-0029).
  heartbeat.unref?.();

  function cleanup(): void {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(heartbeat);
    tail?.close();
    tail = null;
    res.end();
  }

  req.on("close", cleanup);
  req.on("error", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
}
