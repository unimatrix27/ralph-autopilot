import { describe, expect, it } from "vitest";
import type { RunLogEntry } from "../store/types";
import { analyticsResponseSchema } from "./contract";
import { analyticsWindowStart, computeAnalytics, type RunStart } from "./analytics";

const NOW = new Date("2026-06-21T12:00:00.000Z");

let nextId = 1;
/** A run-log entry with sensible defaults; tests override only what they exercise. */
function log(over: Partial<RunLogEntry> & Pick<RunLogEntry, "event" | "ts">): RunLogEntry {
  return {
    id: nextId++,
    repo: "owner/a",
    runId: null,
    issueNumber: null,
    level: "info",
    data: null,
    ...over,
  };
}

function compute(
  events: RunLogEntry[],
  opts: { windowDays?: number; repo?: string; repos?: string[]; runStarts?: RunStart[] } = {},
) {
  return computeAnalytics({
    events,
    runStarts: opts.runStarts ?? [],
    now: NOW,
    windowDays: opts.windowDays ?? 30,
    repo: opts.repo,
    repos: opts.repos,
  });
}

describe("computeAnalytics", () => {
  it("produces a contract-valid payload (parse → serialize round-trips)", () => {
    const out = compute([], { repos: ["owner/a"], windowDays: 7 });
    expect(analyticsResponseSchema.safeParse(out).success).toBe(true);
    expect(analyticsResponseSchema.parse(JSON.parse(JSON.stringify(out)))).toEqual(out);
    expect(out.generatedAt).toBe(NOW.toISOString());
    expect(out.repo).toBeNull(); // aggregate by default
    expect(out.windowDays).toBe(7);
  });

  it("builds a contiguous daily spine of exactly `windowDays` days, ending today, zeros filled", () => {
    const out = compute([], { windowDays: 7 });
    expect(out.daily).toHaveLength(7);
    expect(out.daily.map((d) => d.date)).toEqual([
      "2026-06-15",
      "2026-06-16",
      "2026-06-17",
      "2026-06-18",
      "2026-06-19",
      "2026-06-20",
      "2026-06-21",
    ]);
    expect(out.since).toBe("2026-06-15T00:00:00.000Z");
    expect(out.since).toBe(analyticsWindowStart(NOW, 7));
    // No data → every day is zero and the time-to-merge line breaks (null).
    expect(out.daily.every((d) => d.merges === 0 && d.anomalies === 0 && d.meanTimeToMergeMs === null)).toBe(true);
  });

  it("counts throughput (merges/day) and means time-to-merge from each run's start", () => {
    const runStarts: RunStart[] = [
      { runId: 1, startedAt: "2026-06-20T09:00:00.000Z" },
      { runId: 2, startedAt: "2026-06-21T08:00:00.000Z" },
    ];
    const out = compute(
      [
        log({ event: "merged", runId: 1, ts: "2026-06-20T11:00:00.000Z", data: { prNumber: 1 } }), // 2h
        log({ event: "merged", runId: 2, ts: "2026-06-21T10:00:00.000Z", data: { prNumber: 2 } }), // 2h
        // A merge whose run start is unknown still counts as throughput, but not in TTM.
        log({ event: "merged", runId: 3, ts: "2026-06-21T11:00:00.000Z", data: { prNumber: 3 } }),
      ],
      { windowDays: 2, runStarts },
    );

    const byDate = Object.fromEntries(out.daily.map((d) => [d.date, d]));
    expect(byDate["2026-06-20"]).toMatchObject({ merges: 1, meanTimeToMergeMs: 7_200_000 });
    expect(byDate["2026-06-21"]).toMatchObject({ merges: 2, meanTimeToMergeMs: 7_200_000 });
    expect(out.summary.totalMerges).toBe(3);
    // Overall mean is over the two merges with a known start (the third is excluded).
    expect(out.summary.meanTimeToMergeMs).toBe(7_200_000);
  });

  it("ignores a merge whose start is after the merge (clock skew) for time-to-merge", () => {
    const out = compute([log({ event: "merged", runId: 1, ts: "2026-06-21T10:00:00.000Z" })], {
      windowDays: 2,
      runStarts: [{ runId: 1, startedAt: "2026-06-21T11:00:00.000Z" }],
    });
    expect(out.summary.totalMerges).toBe(1);
    expect(out.summary.meanTimeToMergeMs).toBeNull(); // no valid delta
  });

  it("renders an anomaly trend over time (the completeness-health signal)", () => {
    const out = compute(
      [
        log({ event: "daemon-anomaly", ts: "2026-06-20T01:00:00.000Z", data: { reason: "island" } }),
        log({ event: "daemon-anomaly", ts: "2026-06-20T05:00:00.000Z", data: { reason: "island" } }),
        log({ event: "daemon-anomaly", ts: "2026-06-21T05:00:00.000Z", data: { reason: "island" } }),
      ],
      { windowDays: 2 },
    );
    const byDate = Object.fromEntries(out.daily.map((d) => [d.date, d.anomalies]));
    expect(byDate["2026-06-20"]).toBe(2);
    expect(byDate["2026-06-21"]).toBe(1);
    expect(out.summary.totalAnomalies).toBe(3);
  });

  it("builds the fix-attempt, escalation, and review-maxed distributions (gaps zero-filled)", () => {
    const out = compute(
      [
        // review-maxed: issue 10 maxes out twice (attempts 3 then 1), issue 20 once (attempts 3).
        log({ event: "review-maxed", issueNumber: 10, ts: "2026-06-20T01:00:00.000Z", data: { phase: 1, attempts: 3 } }),
        log({ event: "review-maxed", issueNumber: 10, ts: "2026-06-21T01:00:00.000Z", data: { phase: 2, attempts: 1 } }),
        log({ event: "review-maxed", issueNumber: 20, ts: "2026-06-21T02:00:00.000Z", data: { phase: 1, attempts: 3 } }),
        // escalations: issue 10 twice, issue 20 once.
        log({ event: "escalated", issueNumber: 10, ts: "2026-06-20T03:00:00.000Z", data: { headline: "x" } }),
        log({ event: "escalated", issueNumber: 10, ts: "2026-06-21T03:00:00.000Z", data: { headline: "y" } }),
        log({ event: "escalated", issueNumber: 20, ts: "2026-06-21T04:00:00.000Z", data: { headline: "z" } }),
      ],
      { windowDays: 2 },
    );

    // fix-attempts: by attempts value across review-maxed events → {1:1, 2:0, 3:2}.
    expect(out.distributions.fixAttempts).toEqual([
      { bucket: 1, count: 1 },
      { bucket: 2, count: 0 },
      { bucket: 3, count: 2 },
    ]);
    // escalations: per-issue count → issue 10 = 2, issue 20 = 1 → values [2,1] → {1:1, 2:1}.
    expect(out.distributions.escalations).toEqual([
      { bucket: 1, count: 1 },
      { bucket: 2, count: 1 },
    ]);
    // review-maxed: per-issue count → issue 10 = 2, issue 20 = 1 → {1:1, 2:1}.
    expect(out.distributions.reviewMaxed).toEqual([
      { bucket: 1, count: 1 },
      { bucket: 2, count: 1 },
    ]);
    expect(out.summary).toMatchObject({ totalEscalations: 3, totalReviewMaxed: 3 });
  });

  it("aggregates across repos by default and narrows every metric under a repo filter", () => {
    const events = [
      log({ event: "merged", repo: "owner/a", runId: 1, ts: "2026-06-21T09:00:00.000Z" }),
      log({ event: "merged", repo: "owner/b", runId: 2, ts: "2026-06-21T10:00:00.000Z" }),
      log({ event: "escalated", repo: "owner/b", issueNumber: 5, ts: "2026-06-21T10:30:00.000Z" }),
    ];
    const repos = ["owner/a", "owner/b", "owner/idle"];

    const all = compute(events, { windowDays: 2, repos });
    expect(all.summary.totalMerges).toBe(2);
    expect(all.summary.totalEscalations).toBe(1);
    // The filter list includes the configured-but-idle repo.
    expect(all.repos).toEqual(["owner/a", "owner/b", "owner/idle"]);

    const onlyA = compute(events, { windowDays: 2, repos, repo: "owner/a" });
    expect(onlyA.repo).toBe("owner/a");
    expect(onlyA.summary.totalMerges).toBe(1); // only owner/a's merge
    expect(onlyA.summary.totalEscalations).toBe(0); // owner/b's escalation excluded
    expect(onlyA.repos).toEqual(["owner/a", "owner/b", "owner/idle"]); // full list preserved
  });

  it("drops events outside the window's days (a generous store query may overscan)", () => {
    const out = compute(
      [
        log({ event: "merged", runId: 1, ts: "2026-06-10T10:00:00.000Z" }), // before the 2-day window
        log({ event: "merged", runId: 2, ts: "2026-06-21T10:00:00.000Z" }), // inside
      ],
      { windowDays: 2 },
    );
    expect(out.summary.totalMerges).toBe(1);
  });
});
