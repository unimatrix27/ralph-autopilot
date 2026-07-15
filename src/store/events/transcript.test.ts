import { describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  isTranscriptStream,
  mapSdkMessageToTranscript,
  parseTranscriptStreamId,
  planTranscriptRetention,
  transcriptStreamId,
  type TranscriptStreamSummary,
} from "./transcript";
import { parseIssueStreamId, isSystemStream } from "./streams";

/** Build an SDKMessage tersely; the real union is huge, so cast representative shapes. */
const sdk = (m: unknown): SDKMessage => m as SDKMessage;

const ctx = { runId: "42", at: "2026-06-21T10:00:00.000Z" };

describe("transcript stream identity", () => {
  it("round-trips a `transcript:<repo>#<issue>:<runId>` id", () => {
    const id = transcriptStreamId("acme/widgets", 110, "42");
    expect(id).toBe("transcript:acme/widgets#110:42");
    expect(isTranscriptStream(id)).toBe(true);
    expect(parseTranscriptStreamId(id)).toEqual({ repo: "acme/widgets", issueNumber: 110, runId: "42" });
  });

  it("parses a non-numeric runId (e.g. the moding session)", () => {
    const id = transcriptStreamId("acme/widgets", 7, "moding");
    expect(parseTranscriptStreamId(id)).toEqual({ repo: "acme/widgets", issueNumber: 7, runId: "moding" });
  });

  it("rejects non-transcript ids and is disjoint from issue/system streams", () => {
    expect(parseTranscriptStreamId("acme/widgets#110")).toBeNull(); // issue stream
    expect(parseTranscriptStreamId("$daemon-system")).toBeNull();
    expect(isTranscriptStream("acme/widgets#110")).toBe(false);
    // A transcript id is NOT a valid issue stream nor a system stream — the three
    // families never collide (the issue projection's defensive parse rejects it).
    const id = transcriptStreamId("acme/widgets", 110, "42");
    expect(parseIssueStreamId(id)).toBeNull();
    expect(isSystemStream(id)).toBe(false);
  });
});

describe("mapSdkMessageToTranscript — message-level mapper", () => {
  it("maps assistant text + tool_use into one message event", () => {
    const data = mapSdkMessageToTranscript(
      sdk({
        type: "assistant",
        uuid: "u1",
        message: {
          content: [
            { type: "text", text: "Reading the file." },
            { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/x.ts" } },
          ],
        },
      }),
      ctx,
    );
    expect(data).toEqual({
      runId: "42",
      at: ctx.at,
      role: "assistant",
      sdkType: "assistant",
      uuid: "u1",
      blocks: [
        { kind: "text", text: "Reading the file." },
        { kind: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/x.ts" } },
      ],
    });
  });

  it("maps a user tool_result into a message event", () => {
    const data = mapSdkMessageToTranscript(
      sdk({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file body", is_error: false }],
        },
      }),
      ctx,
    );
    expect(data?.role).toBe("user");
    expect(data?.blocks).toEqual([
      { kind: "tool_result", toolUseId: "tu_1", content: "file body", isError: false },
    ]);
  });

  it("maps a success result into a result event carrying the final text", () => {
    const data = mapSdkMessageToTranscript(
      sdk({ type: "result", subtype: "success", is_error: false, result: "Done." }),
      ctx,
    );
    expect(data).toMatchObject({ role: "result", sdkType: "result", subtype: "success" });
    expect(data?.blocks).toEqual([{ kind: "text", text: "Done." }]);
  });

  it("maps an error result with no result text to an empty block list", () => {
    const data = mapSdkMessageToTranscript(
      sdk({ type: "result", subtype: "error_max_turns", is_error: true }),
      ctx,
    );
    expect(data).toMatchObject({ role: "result", subtype: "error_max_turns" });
    expect(data?.blocks).toEqual([]);
  });

  it("returns null for non-conversational messages (token-level / telemetry deferred)", () => {
    expect(mapSdkMessageToTranscript(sdk({ type: "stream_event" }), ctx)).toBeNull();
    expect(mapSdkMessageToTranscript(sdk({ type: "rate_limit_event" }), ctx)).toBeNull();
    expect(mapSdkMessageToTranscript(sdk({ type: "system", subtype: "init" }), ctx)).toBeNull();
  });

  it("preserves an unknown content block verbatim rather than dropping it", () => {
    const data = mapSdkMessageToTranscript(
      sdk({ type: "assistant", message: { content: [{ type: "image", source: { data: "…" } }] } }),
      ctx,
    );
    expect(data?.blocks).toEqual([{ kind: "other", raw: { type: "image", source: { data: "…" } } }]);
  });
});

describe("planTranscriptRetention — pure two-tier planner", () => {
  const now = new Date("2026-06-21T00:00:00.000Z");
  const stream = (repo: string, issue: number, run: string): string => transcriptStreamId(repo, issue, run);
  const summary = (overrides: Partial<TranscriptStreamSummary> & { streamId: string }): TranscriptStreamSummary => ({
    repo: "acme/widgets",
    issueNumber: 1,
    runId: "1",
    newestAt: now.toISOString(),
    byteSize: 100,
    messageCount: 1,
    ...overrides,
  });

  it("prunes streams older than the age budget, leaving fresh ones", () => {
    const old = summary({ streamId: stream("acme/widgets", 1, "1"), newestAt: "2026-04-01T00:00:00.000Z" });
    const fresh = summary({ streamId: stream("acme/widgets", 2, "2"), newestAt: "2026-06-20T00:00:00.000Z" });
    const plans = planTranscriptRetention([old, fresh], { maxAgeDays: 30 }, now);
    expect(plans).toEqual([{ streamId: old.streamId, reason: "age" }]);
  });

  it("evicts the oldest streams first to honour a size cap", () => {
    const a = summary({ streamId: stream("acme/widgets", 1, "1"), newestAt: "2026-06-01T00:00:00.000Z", byteSize: 600 });
    const b = summary({ streamId: stream("acme/widgets", 2, "2"), newestAt: "2026-06-10T00:00:00.000Z", byteSize: 600 });
    const c = summary({ streamId: stream("acme/widgets", 3, "3"), newestAt: "2026-06-20T00:00:00.000Z", byteSize: 600 });
    // Cap 1500 with 1800 total: drop just the oldest (a) → 1200, under cap.
    const plans = planTranscriptRetention([a, b, c], { maxAgeDays: 365, maxTotalBytes: 1500 }, now);
    expect(plans).toEqual([{ streamId: a.streamId, reason: "size" }]);
  });

  it("does not double-count an age-pruned stream against the size cap", () => {
    const aged = summary({ streamId: stream("acme/widgets", 1, "1"), newestAt: "2026-01-01T00:00:00.000Z", byteSize: 5000 });
    const fresh = summary({ streamId: stream("acme/widgets", 2, "2"), newestAt: "2026-06-20T00:00:00.000Z", byteSize: 100 });
    const plans = planTranscriptRetention([aged, fresh], { maxAgeDays: 30, maxTotalBytes: 1000 }, now);
    // `aged` is pruned for age; the surviving `fresh` (100B) is under the cap → not pruned.
    expect(plans).toEqual([{ streamId: aged.streamId, reason: "age" }]);
  });

  it("prunes nothing when everything is within budget", () => {
    const s = summary({ streamId: stream("acme/widgets", 1, "1") });
    expect(planTranscriptRetention([s], { maxAgeDays: 30, maxTotalBytes: 1_000_000 }, now)).toEqual([]);
  });
});
