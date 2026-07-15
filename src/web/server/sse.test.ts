import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../log/logger";
import { MEMORY_DB, openStore, type Store } from "../../store/store";
import type { WebSettings } from "../../config/schema";
import type { LiveEvent } from "../contract";
import { liveEventSchema } from "../contract";
import type { WebControlPlanePorts } from "./ports";
import { WebServer } from "./server";

const silentLogger = createLogger({ level: "error", write: () => {} });

function settings(staticDir: string): WebSettings {
  return { enabled: true, host: "127.0.0.1", port: 0, staticDir, allowedOrigins: [] };
}

/** A live port backed by a real store: the durable catch-up + the in-process broadcast. */
function livePort(store: Store): WebControlPlanePorts["live"] {
  return {
    subscribeWake: (handler) => store.liveLog.subscribeWake(handler),
    readAfter: (gp, limit) => store.events.readAfter(gp, limit),
    head: () => store.events.head(),
  };
}

function ports(store: Store): WebControlPlanePorts {
  return {
    health: () => ({ status: "ok", name: "ralph-autopilot", version: "9.9.9", startedAt: "2026-06-21T00:00:00.000Z", uptimeSeconds: 1 }),
    overview: (query) => ({
      generatedAt: "2026-06-21T00:00:00.000Z",
      repo: query.repo ?? null,
      repos: [],
      reconcileIntervalSeconds: 30,
      needsYou: [],
      fleet: [],
      funnel: { eligible: 0, inFlight: 0, awaitingCi: 0, awaitingMerge: 0, merged: 0 },
      activity: [],
    }),
    live: livePort(store),
  };
}

/**
 * Open an SSE connection and yield parsed {@link LiveEvent} data frames as they arrive.
 * Resolves once `want` frames are collected (or rejects on timeout), then aborts the
 * connection. `onReady` fires after the first chunk (the `: connected` preamble + any
 * catch-up) so a test can trigger live appends at the right moment.
 */
async function collectSse(
  url: string,
  opts: { want: number; headers?: Record<string, string>; onFrame?: (count: number) => void; timeoutMs?: number },
): Promise<LiveEvent[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 4000);
  const frames: LiveEvent[] = [];
  try {
    const res = await fetch(url, { headers: { accept: "text/event-stream", ...opts.headers }, signal: controller.signal });
    if (!res.ok || !res.body) {
      throw new Error(`SSE connect failed: ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (frames.length < opts.want) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
        if (dataLine) {
          frames.push(liveEventSchema.parse(JSON.parse(dataLine.slice("data: ".length))));
          opts.onFrame?.(frames.length);
        }
      }
    }
    return frames;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

describe("GET /api/live (SSE)", () => {
  let store: Store;
  let dir: string;
  let server: WebServer;
  let base: string;

  beforeEach(async () => {
    store = openStore(MEMORY_DB);
    dir = mkdtempSync(join(tmpdir(), "ralph-sse-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><div id=root></div>");
    server = new WebServer({ config: settings(dir), logger: silentLogger, ports: ports(store) });
    await server.start();
    base = `http://127.0.0.1:${server.boundPort()}`;
  });

  afterEach(async () => {
    await server.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("catches up from a global_position cursor, then streams live events after it", async () => {
    const scoped = store.forRepo("owner/repo");
    // Two events committed before the client connects — the catch-up backlog.
    await scoped.recordRunStarted({ runId: 1, issueNumber: 7, mode: "tdd" });
    await scoped.recordFixAttempt({ runId: 1, issueNumber: 7, phase: 1 });

    // Connect from the beginning (cursor=0); after catch-up lands, commit a live event.
    const collected = collectSse(`${base}/api/live?cursor=0`, {
      want: 3,
      onFrame: (count) => {
        if (count === 2) {
          // The two catch-up frames arrived; now a live append must reach the same stream.
          void scoped.recordReviewPassed({ runId: 1, issueNumber: 7 });
        }
      },
    });

    const frames = await collected;
    expect(frames.map((f) => f.type)).toEqual(["RunStarted", "FixAttempted", "ReviewPassed"]);
    // Strictly increasing global positions — the SSE cursor.
    expect(frames[0]!.globalPosition).toBeLessThan(frames[1]!.globalPosition);
    expect(frames[1]!.globalPosition).toBeLessThan(frames[2]!.globalPosition);
    // The transcript-vs-domain stream id is carried through verbatim.
    expect(frames[0]!.streamId).toBe("owner/repo#7");
  });

  it("resumes from Last-Event-ID on reconnect — exactly the events after that position", async () => {
    const scoped = store.forRepo("owner/repo");
    await scoped.recordRunStarted({ runId: 1, issueNumber: 7, mode: "tdd" }); // pos 1
    await scoped.recordFixAttempt({ runId: 1, issueNumber: 7, phase: 1 }); // pos 2
    await scoped.recordReviewPassed({ runId: 1, issueNumber: 7 }); // pos 3

    const head = store.events.head();
    const firstPos = store.events.readAfter(0, 10)[0]!.globalPosition;

    // A browser EventSource reconnecting sends Last-Event-ID = the last id it saw.
    const frames = await collectSse(`${base}/api/live`, {
      want: head - firstPos, // events strictly after the first
      headers: { "last-event-id": String(firstPos) },
    });
    expect(frames.map((f) => f.type)).toEqual(["FixAttempted", "ReviewPassed"]);
    expect(frames.every((f) => f.globalPosition > firstPos)).toBe(true);
  });

  it("with no cursor, streams only events committed after connect (from now), not history", async () => {
    const scoped = store.forRepo("owner/repo");
    await scoped.recordRunStarted({ runId: 1, issueNumber: 7, mode: "tdd" }); // history — must NOT replay

    const collected = collectSse(`${base}/api/live`, {
      want: 1,
      onFrame: () => {},
    });
    // Give the connection a beat to establish + run catch-up (which should yield nothing),
    // then commit one live event.
    await new Promise((r) => setTimeout(r, 150));
    await scoped.recordFixAttempt({ runId: 1, issueNumber: 7, phase: 1 });

    const frames = await collected;
    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe("FixAttempted"); // the historical RunStarted was not replayed
  });

  it("streams transcript messages as live frames (the Fleet-wall tool/assistant feed)", async () => {
    const scoped = store.forRepo("owner/repo");
    const collected = collectSse(`${base}/api/live`, { want: 1 });
    await new Promise((r) => setTimeout(r, 150));
    await scoped.appendToTranscript(7, "run-xyz", [
      { type: "TranscriptMessage", data: { runId: "run-xyz", at: "2026-06-21T00:00:00.000Z", role: "assistant", sdkType: "assistant", blocks: [{ kind: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] } },
    ]);

    const frames = await collected;
    expect(frames).toHaveLength(1);
    expect(frames[0]!.streamId).toBe("transcript:owner/repo#7:run-xyz");
    expect(frames[0]!.type).toBe("TranscriptMessage");
  });

  it("405s a non-GET to the live route", async () => {
    const res = await fetch(`${base}/api/live`, { method: "POST", headers: { origin: base } });
    expect(res.status).toBe(405);
  });

  it("tears the subscription down when the client disconnects (no leak)", async () => {
    await collectSse(`${base}/api/live`, { want: 1, timeoutMs: 1500 }).catch(() => {
      /* aborts after timeout with no frames — that's fine, we just need the disconnect */
    });
    // After the client is gone the server must have dropped its subscriber. Poll briefly
    // since the socket-close teardown runs on the next event-loop turn.
    for (let i = 0; i < 20 && store.liveLog.subscriberCount > 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(store.liveLog.subscriberCount).toBe(0);
  });
});
