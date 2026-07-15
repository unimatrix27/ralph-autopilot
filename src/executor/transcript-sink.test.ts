import { describe, expect, it } from "vitest";
import type { QueryFn } from "./agent";
import { runReapedWallClockedSession } from "./agent";
import { runStructuredSession } from "./structured-session";
import { createTranscriptSink } from "./transcript-sink";
import type { SessionReaper } from "./process-reaper";
import { parseConfig, resolveTargets } from "../config/load";
import type { TargetConfig } from "../config/schema";
import { openStore, MEMORY_DB } from "../store/store";
import type { TranscriptEvent } from "../store/events/transcript";

function config(): TargetConfig {
  return resolveTargets(
    parseConfig({ targets: [{ repo: "acme/widgets", commands: { build: "b", test: "t" } }] }),
  )[0]!;
}

/** A reaper whose spawn must never be called (we inject the query, so the CLI never spawns). */
function spyReaper(): SessionReaper {
  return {
    spawn: (() => {
      throw new Error("spawn should not be called with an injected query");
    }) as unknown as SessionReaper["spawn"],
    reap: () => {},
  };
}

/** A query that yields a fixed list of SDK messages, like a real session's stream. */
function scriptedQuery(messages: unknown[]): QueryFn {
  return (() =>
    (async function* () {
      for (const m of messages) {
        yield m;
      }
    })()) as unknown as QueryFn;
}

/** Drive the one chokepoint with a sink bound to a real store, returning what landed. */
async function captureThrough(messages: unknown[], runId = "1") {
  const store = openStore(MEMORY_DB);
  const sink = createTranscriptSink({
    runId,
    append: (events: TranscriptEvent[]) => store.events.appendToTranscript("acme/widgets", 110, runId, events),
  });
  await runReapedWallClockedSession({
    config: config(),
    available: {},
    worktreePath: "/tmp/wt",
    reaperFactory: spyReaper,
    queryFn: scriptedQuery(messages),
    prompt: "do it",
    transcriptSink: sink,
  });
  const transcript = store.events.readTranscript("acme/widgets", 110, runId);
  store.close();
  return transcript;
}

describe("transcript capture through the session chokepoint (ADR-0030)", () => {
  it("captures assistant / tool_use / tool_result / result uniformly, skipping non-conversational frames", async () => {
    const transcript = await captureThrough([
      { type: "system", subtype: "init" }, // skipped (bookkeeping)
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Reading." },
            { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/x.ts" } },
          ],
        },
      },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok", is_error: false }] } },
      { type: "result", subtype: "success", is_error: false, result: "Done." },
    ]);

    // The init frame is skipped; the three conversational frames are captured in order.
    expect(transcript.map((e) => e.type)).toEqual([
      "TranscriptMessage",
      "TranscriptMessage",
      "TranscriptMessage",
    ]);
    expect(transcript.map((e) => (e.data as { role: string }).role)).toEqual(["assistant", "user", "result"]);
    // The runId stamped on the event matches the stream it was captured on.
    expect((transcript[0]!.data as { runId: string }).runId).toBe("1");
  });

  it("redacts secrets in message content BEFORE persistence", async () => {
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const transcript = await captureThrough([
      { type: "assistant", message: { content: [{ type: "text", text: `the token is ${secret}` }] } },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tu", content: `export GH=${secret}`, is_error: false }] },
      },
    ]);

    const serialized = JSON.stringify(transcript);
    expect(serialized).not.toContain(secret); // the raw secret never reached the store
    expect(serialized).toContain("[REDACTED]"); // it was redacted in place
  });

  it("is a no-op when no sink is wired (capture absent → nothing persisted)", async () => {
    const store = openStore(MEMORY_DB);
    await runReapedWallClockedSession({
      config: config(),
      available: {},
      worktreePath: "/tmp/wt",
      reaperFactory: spyReaper,
      queryFn: scriptedQuery([{ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }]),
      prompt: "do it",
    });
    expect(store.events.readTranscript("acme/widgets", 110, "1")).toEqual([]);
    store.close();
  });

  it("also captures via the structured-session path (review/fix/moding share one chokepoint)", async () => {
    // review/fix/moding sessions run through runStructuredSession → the same chokepoint,
    // so forwarding the sink there captures their conversation uniformly with impl/resume.
    const store = openStore(MEMORY_DB);
    const sink = createTranscriptSink({
      runId: "9",
      append: (events: TranscriptEvent[]) => store.events.appendToTranscript("acme/widgets", 110, "9", events),
    });
    const result = await runStructuredSession(
      {
        config: config(),
        available: {},
        prompt: "review it",
        worktreePath: "/tmp/wt",
        reaperFactory: spyReaper,
        queryFn: scriptedQuery([
          { type: "assistant", message: { content: [{ type: "text", text: "reviewing" }] } },
          { type: "result", subtype: "success", is_error: false, result: '{"ok":true}' },
        ]),
        transcriptSink: sink,
      },
      (text) => JSON.parse(text) as { ok: boolean },
    );
    expect(result).toEqual({ ok: true });
    const transcript = store.events.readTranscript("acme/widgets", 110, "9");
    expect(transcript.map((e) => (e.data as { role: string }).role)).toEqual(["assistant", "result"]);
    store.close();
  });

  it("keeps capture best-effort: an append failure never breaks the session", async () => {
    const errors: unknown[] = [];
    const sink = createTranscriptSink({
      runId: "1",
      append: () => Promise.reject(new Error("disk full")),
      onError: (err) => errors.push(err),
    });
    await expect(
      runReapedWallClockedSession({
        config: config(),
        available: {},
        worktreePath: "/tmp/wt",
        reaperFactory: spyReaper,
        queryFn: scriptedQuery([{ type: "result", subtype: "success", is_error: false, result: "Done." }]),
        prompt: "do it",
        transcriptSink: sink,
      }),
    ).resolves.toMatchObject({ subtype: "success", isError: false });
    expect(errors).toHaveLength(1);
  });
});
