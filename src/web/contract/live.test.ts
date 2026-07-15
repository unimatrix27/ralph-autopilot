import { describe, expect, it } from "vitest";
import {
  liveEventSchema,
  parseTranscriptStreamRef,
  isTranscriptStreamId,
  classifyLiveEvent,
  transcriptLatestLine,
  type LiveEvent,
} from "./live";

describe("live contract leaf", () => {
  it("round-trips a valid live event and rejects unknown keys (strict)", () => {
    const value: LiveEvent = { globalPosition: 5, streamId: "owner/repo#7", type: "FixAttempted", data: { phase: 1 } };
    expect(liveEventSchema.parse(value)).toEqual(value);
    expect(liveEventSchema.safeParse({ ...value, extra: 1 }).success).toBe(false);
  });

  it("parses a transcript stream ref and rejects non-transcript / issue streams", () => {
    expect(parseTranscriptStreamRef("transcript:owner/repo#7:run-abc")).toEqual({
      repo: "owner/repo",
      issueNumber: 7,
      runId: "run-abc",
    });
    expect(isTranscriptStreamId("transcript:owner/repo#7:run-abc")).toBe(true);
    expect(isTranscriptStreamId("owner/repo#7")).toBe(false);
    expect(parseTranscriptStreamRef("owner/repo#7")).toBeNull();
    expect(parseTranscriptStreamRef("transcript:malformed")).toBeNull();
  });

  it("classifies a transcript message vs a domain event", () => {
    const transcript = classifyLiveEvent({
      globalPosition: 1,
      streamId: "transcript:owner/repo#7:run-abc",
      type: "TranscriptMessage",
      data: {},
    });
    expect(transcript.kind).toBe("transcript");
    expect(transcript.kind === "transcript" && transcript.ref.issueNumber).toBe(7);

    const domain = classifyLiveEvent({
      globalPosition: 2,
      streamId: "owner/repo#7",
      type: "FixAttempted",
      data: {},
    });
    expect(domain.kind).toBe("domain");

    // The system stream is neither a per-issue card nor a transcript line — still "domain".
    const system = classifyLiveEvent({ globalPosition: 3, streamId: "$daemon", type: "DaemonStarted", data: {} });
    expect(system.kind).toBe("domain");
  });

  it("renders the latest tool call as the live line, preferring the last actionable block", () => {
    const line = transcriptLatestLine({
      role: "assistant",
      blocks: [
        { kind: "text", text: "Let me run the tests." },
        { kind: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } },
      ],
    });
    expect(line).not.toBeNull();
    expect(line!.kind).toBe("tool_use");
    expect(line!.text).toContain("Bash");
  });

  it("renders an assistant text line when there is no tool call", () => {
    const line = transcriptLatestLine({ role: "assistant", blocks: [{ kind: "text", text: "Working on it." }] });
    expect(line!.kind).toBe("text");
    expect(line!.text).toContain("Working on it");
  });

  it("renders a tool result line for a user(tool_result) message", () => {
    const line = transcriptLatestLine({
      role: "user",
      blocks: [{ kind: "tool_result", toolUseId: "t1", content: "ok", isError: false }],
    });
    expect(line!.kind).toBe("tool_result");
  });

  it("returns null for an empty / unparseable transcript message (tolerant)", () => {
    expect(transcriptLatestLine({ role: "assistant", blocks: [] })).toBeNull();
    expect(transcriptLatestLine(null)).toBeNull();
    expect(transcriptLatestLine({ nope: true })).toBeNull();
  });
});
