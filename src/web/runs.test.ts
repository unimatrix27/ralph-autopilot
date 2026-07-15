import { describe, expect, it } from "vitest";
import { toRunSummary, toRunsResponse, toRunDetailResponse } from "./runs";
import { runDetailResponseSchema, runsResponseSchema } from "./contract";
import type { Run } from "../store/types";
import type { RecordedStreamEvent, RecordedTranscriptEvent } from "../store/event-log";

const NOW = () => new Date("2026-06-22T01:00:00.000Z");

function run(over: Partial<Run> = {}): Run {
  return {
    id: 5,
    repo: "owner/repo",
    issueNumber: 111,
    mode: "tdd",
    status: "merged",
    branch: "ralph/111-x",
    worktreePath: "/tmp/wt",
    prNumber: 42,
    createdAt: "2026-06-22T00:00:00.000Z",
    updatedAt: "2026-06-22T00:30:00.000Z",
    ...over,
  };
}

function ev(globalPosition: number, type: string, data: unknown): RecordedStreamEvent {
  return { globalPosition, streamPosition: globalPosition, type, data };
}

describe("toRunsResponse", () => {
  it("maps run rows to summaries, newest activity first, echoing the repo filter", () => {
    const out = toRunsResponse(
      [
        run({ id: 1, issueNumber: 1, updatedAt: "2026-06-22T00:00:00.000Z" }),
        run({ id: 2, issueNumber: 2, updatedAt: "2026-06-22T05:00:00.000Z" }),
      ],
      { now: NOW, repos: ["owner/repo", "owner/other"], repo: "owner/repo" },
    );
    expect(runsResponseSchema.safeParse(out).success).toBe(true);
    expect(out.repo).toBe("owner/repo");
    expect(out.repos).toEqual(["owner/repo", "owner/other"]);
    expect(out.runs.map((r) => r.issue)).toEqual([2, 1]); // newest updatedAt first
    expect(out.runs[0]!.runId).toBe("2");
  });

  it("echoes a null repo for the aggregate view", () => {
    const out = toRunsResponse([], { now: NOW, repos: ["owner/repo"] });
    expect(out.repo).toBeNull();
    expect(out.runs).toEqual([]);
  });
});

describe("toRunSummary", () => {
  it("derives the runId from the numeric run id", () => {
    expect(toRunSummary(run({ id: 17 })).runId).toBe("17");
  });
});

describe("toRunDetailResponse", () => {
  it("builds a contract-valid header, scoping the issue stream to this run's span as the timeline", () => {
    const out = toRunDetailResponse({
      run: run(),
      timeline: [
        ev(1, "RunStarted", { runId: "5", mode: "tdd" }),
        ev(2, "AnomalyDetected", { reason: "island" }), // no runId — still kept
        ev(3, "Merged", { runId: "5", prNumber: 42 }),
      ],
      transcript: [],
      now: NOW,
    });
    expect(runDetailResponseSchema.safeParse(out).success).toBe(true);
    expect(out.run.runId).toBe("5");
    expect(out.run.status).toBe("merged");
    expect(out.run.prNumber).toBe(42);
    expect(out.run.spanStartGlobalPosition).toBe(1);
    expect(out.timeline.map((t) => t.type)).toEqual(["RunStarted", "AnomalyDetected", "Merged"]);
  });

  it("surfaces the per-phase route on each RouteResolved timeline entry (ADR-0037 P3.1, #164)", () => {
    const out = toRunDetailResponse({
      run: run(),
      timeline: [
        ev(1, "RunStarted", { runId: "5", mode: "tdd" }),
        ev(2, "RouteResolved", { runId: "5", phase: "impl", route: { provider: "claude", model: "opus", account: "c1" } }),
        ev(3, "ReviewPhaseEntered", { runId: "5", phase: 1 }),
        // A default-model route omits `model` in the recorded fact → null on the wire.
        ev(4, "RouteResolved", { runId: "5", phase: "review-1", route: { provider: "zai", account: "z3" } }),
      ],
      transcript: [],
      now: NOW,
    });

    expect(runDetailResponseSchema.safeParse(out).success).toBe(true);
    const routed = out.timeline.filter((t) => t.type === "RouteResolved");
    // Each past phase's route rides on its own entry — one route per container (no mid-phase rotation).
    expect(routed.map((t) => t.route)).toEqual([
      { provider: "claude", model: "opus", account: "c1" },
      { provider: "zai", model: null, account: "z3" },
    ]);
    // Non-route entries never carry the typed field.
    expect(out.timeline.find((t) => t.type === "ReviewPhaseEntered")?.route).toBeUndefined();
  });

  it("leaves a route-less RouteResolved entry's typed route undefined (box-default dispatch)", () => {
    const out = toRunDetailResponse({
      run: run(),
      timeline: [
        ev(1, "RunStarted", { runId: "5", mode: "tdd" }),
        ev(2, "RouteResolved", { runId: "5", phase: "impl" }),
      ],
      transcript: [],
      now: NOW,
    });
    expect(runDetailResponseSchema.safeParse(out).success).toBe(true);
    expect(out.timeline.find((t) => t.type === "RouteResolved")?.route).toBeUndefined();
  });

  it("settles terminal duration against the issue projection timestamp, not the stale run row", () => {
    const out = toRunDetailResponse({
      run: run({ status: "merged", updatedAt: "2026-06-22T00:00:00.000Z" }),
      timeline: [
        ev(1, "RunStarted", { runId: "5", mode: "tdd" }),
        ev(2, "Merged", { runId: "5", prNumber: 42 }),
        ev(3, "RunEnded", { runId: "5", outcome: "merged" }),
      ],
      transcript: [],
      projection: { updatedAt: "2026-06-22T00:45:00.000Z" },
      now: NOW,
    });

    expect(out.run.updatedAt).toBe("2026-06-22T00:45:00.000Z");
  });

  it("drops a prior/abandoned run-span's events so they cannot pollute this run's timeline or fix counts", () => {
    const out = toRunDetailResponse({
      run: run({ id: 8 }), // the current run is runId 8 (a re-pickup after a rolled-back claim)
      timeline: [
        // A prior span (runId 7), abandoned by the re-pickup — must NOT leak.
        ev(1, "RunStarted", { runId: "7", mode: "tdd" }),
        ev(2, "ReviewPhaseEntered", { runId: "7", phase: 1 }),
        ev(3, "FixAttempted", { runId: "7", phase: 1 }),
        ev(4, "RunEnded", { runId: "7", outcome: "abandoned" }),
        // An issue-level anomaly (no runId) — kept regardless of span.
        ev(5, "AnomalyDetected", { reason: "island" }),
        // This run's span (runId 8).
        ev(6, "RunStarted", { runId: "8", mode: "tdd" }),
        ev(7, "ReviewPhaseEntered", { runId: "8", phase: 1 }),
        ev(8, "FixAttempted", { runId: "8", phase: 1 }),
      ],
      transcript: [],
      now: NOW,
    });
    expect(out.run.runId).toBe("8");
    expect(out.timeline.map((t) => t.type)).toEqual([
      "AnomalyDetected",
      "RunStarted",
      "ReviewPhaseEntered",
      "FixAttempted",
    ]);
    // The prior span's fix attempt is excluded — only this run's counts.
    expect(out.run.fixAttempts).toEqual({ "1": 1 });
  });

  it("isolates a re-admitted run that REUSED the same runId — a prior span's timeline + transcript are dropped", () => {
    // Re-admission updates the existing (repo, issue) row in place (upsertRun ON CONFLICT), so
    // the new attempt keeps runs.id 5 and appends/streams under the SAME runId as the prior
    // attempt. The runId tag alone cannot separate the spans; the latest RunStarted boundary can.
    const transcript: RecordedTranscriptEvent[] = [
      {
        type: "TranscriptMessage",
        streamPosition: 0,
        globalPosition: 10, // prior span — shared transcript stream, same runId — must be dropped
        data: { runId: "5", at: "2026-06-22T00:01:00.000Z", role: "assistant", sdkType: "assistant", blocks: [{ kind: "text", text: "old attempt" }] },
      },
      {
        type: "TranscriptMessage",
        streamPosition: 1,
        globalPosition: 30, // this span — kept
        data: { runId: "5", at: "2026-06-22T00:11:00.000Z", role: "assistant", sdkType: "assistant", blocks: [{ kind: "text", text: "new attempt" }] },
      },
    ];
    const out = toRunDetailResponse({
      run: run({ id: 5 }),
      timeline: [
        // The prior span (runId 5), bounced to stuck — must NOT leak into this run.
        ev(1, "RunStarted", { runId: "5", mode: "tdd" }),
        ev(2, "FixAttempted", { runId: "5", phase: 1 }),
        ev(3, "RunStuck", { runId: "5", reason: "bounded out" }),
        // An issue-level anomaly between spans (no runId) — kept regardless of span.
        ev(4, "AnomalyDetected", { reason: "island" }),
        // This span re-uses runId 5 (re-admission preserved runs.id) and starts at gp 20.
        ev(20, "RunStarted", { runId: "5", mode: "tdd" }),
        ev(21, "FixAttempted", { runId: "5", phase: 1 }),
      ],
      transcript,
      now: NOW,
    });
    // Only this span's timeline survives (plus the runId-less anomaly).
    expect(out.timeline.map((t) => t.type)).toEqual(["AnomalyDetected", "RunStarted", "FixAttempted"]);
    // The prior span's fix attempt does not inflate this run's counts.
    expect(out.run.fixAttempts).toEqual({ "1": 1 });
    // Only this span's transcript renders — the prior attempt's message is gone.
    expect(out.transcript).toHaveLength(1);
    expect((out.transcript[0]!.data as { blocks: { text: string }[] }).blocks[0]!.text).toBe("new attempt");
  });

  it("folds per-phase fix attempts, resetting on ReviewPhaseEntered", () => {
    const out = toRunDetailResponse({
      run: run(),
      timeline: [
        ev(1, "ReviewPhaseEntered", { runId: "5", phase: 1 }),
        ev(2, "FixAttempted", { runId: "5", phase: 1 }),
        ev(3, "FixAttempted", { runId: "5", phase: 1 }),
        ev(4, "ReviewPhaseEntered", { runId: "5", phase: 1 }), // re-entered → reset
        ev(5, "FixAttempted", { runId: "5", phase: 1 }),
        ev(6, "FixAttempted", { runId: "5", phase: 2 }),
      ],
      transcript: [],
      now: NOW,
    });
    expect(out.run.fixAttempts).toEqual({ "1": 1, "2": 1 });
  });

  it("maps transcript messages + surfaces a pruned marker", () => {
    const transcript: RecordedTranscriptEvent[] = [
      {
        type: "TranscriptMessage",
        streamPosition: 0,
        globalPosition: 10,
        data: { runId: "5", at: "2026-06-22T00:01:00.000Z", role: "assistant", sdkType: "assistant", blocks: [{ kind: "text", text: "hi" }] },
      },
      {
        type: "TranscriptPruned",
        streamPosition: 1,
        globalPosition: 11,
        data: { runId: "5", at: "2026-06-22T00:02:00.000Z", prunedMessageCount: 3, reason: "age" },
      },
    ];
    const out = toRunDetailResponse({ run: run(), timeline: [], transcript, now: NOW });
    expect(runDetailResponseSchema.safeParse(out).success).toBe(true);
    expect(out.transcript).toHaveLength(2);
    expect(out.pruned).toEqual({ runId: "5", at: "2026-06-22T00:02:00.000Z", prunedMessageCount: 3, reason: "age" });
  });

  it("leaves pruned null when the verbose transcript is intact", () => {
    const out = toRunDetailResponse({ run: run(), timeline: [], transcript: [], now: NOW });
    expect(out.pruned).toBeNull();
  });
});
