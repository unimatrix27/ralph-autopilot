import { describe, expect, it } from "vitest";
import type { RuntimeSnapshot, QueueItem } from "../projection/snapshot";
import { overviewResponseSchema } from "./contract";
import { activitySummary, snapshotToOverview } from "./overview";

const NOW = new Date("2026-06-21T12:00:00.000Z");

/** An empty runtime snapshot; tests fill in only the sections they exercise. */
function emptySnapshot(): RuntimeSnapshot {
  return {
    runningAgents: [],
    backlog: { eligible: [], blocked: [], paused: [], manualHolds: [], modingCandidates: [], noProvider: [] },
    awaitingAnswer: [],
    reviewMaxed: [],
    agentStuck: [],
    awaitingCi: [],
    awaitingMerge: [],
    recentOutcomes: [],
    daemon: null,
  };
}

/** A queue row with sensible defaults. */
function queue(repo: string, issue: number, over: Partial<QueueItem> = {}): QueueItem {
  return { repo, issueNumber: issue, headline: "", since: NOW.toISOString(), ...over };
}

describe("snapshotToOverview", () => {
  it("produces a contract-valid payload (parse → serialize round-trips)", () => {
    const out = snapshotToOverview(emptySnapshot(), { now: () => NOW, repos: ["owner/a"] });
    expect(overviewResponseSchema.safeParse(out).success).toBe(true);
    // Re-parsing the JSON-serialized form is identity — both sides cross the wire with it.
    expect(overviewResponseSchema.parse(JSON.parse(JSON.stringify(out)))).toEqual(out);
    expect(out.generatedAt).toBe(NOW.toISOString());
    expect(out.repo).toBeNull(); // aggregate by default
  });

  it("builds the Needs-you band from all four states, each with repo/issue/wait/summary", () => {
    const snap = emptySnapshot();
    snap.awaitingAnswer = [queue("owner/a", 20, { headline: "Pick a DB driver", since: "2026-06-21T11:00:00.000Z" })];
    snap.reviewMaxed = [queue("owner/b", 21, { headline: "3 P0s remain", since: "2026-06-21T10:00:00.000Z" })];
    snap.agentStuck = [queue("owner/a", 25, { since: "2026-06-21T09:00:00.000Z" })]; // no headline
    // daemon-anomaly only exists as a GitHub label (no run) — the backlog is its source.
    snap.backlog.paused = [
      { repo: "owner/c", issueNumber: 30, title: "island issue", state: "daemon-anomaly" },
      { repo: "owner/a", issueNumber: 25, title: "stuck issue", state: "agent-stuck" }, // enriches the agent-stuck run
    ];

    const out = snapshotToOverview(snap, {
      now: () => NOW,
      priorityLabelsFor: (repo) => (repo === "owner/a" ? ["priority:p0"] : []),
    });
    const { needsYou } = out;

    // Triage order: daemon-anomaly → agent-stuck → review-maxed → awaiting-answer.
    expect(needsYou.map((n) => [n.state, n.repo, n.issue])).toEqual([
      ["daemon-anomaly", "owner/c", 30],
      ["agent-stuck", "owner/a", 25],
      ["review-maxed", "owner/b", 21],
      ["awaiting-answer", "owner/a", 20],
    ]);
    // Each carries a one-line summary: question headline where present, else the issue title.
    const byIssue = Object.fromEntries(needsYou.map((n) => [n.issue, n]));
    expect(byIssue[20]!.summary).toBe("Pick a DB driver");
    expect(byIssue[21]!.summary).toBe("3 P0s remain");
    expect(byIssue[25]!.summary).toBe("stuck issue"); // agent-stuck: no headline → backlog title
    expect(byIssue[30]!.summary).toBe("island issue");
    // Wait-time: the run-sourced ones carry an absolute instant; the run-less anomaly is null.
    expect(byIssue[20]!.waitingSince).toBe("2026-06-21T11:00:00.000Z");
    expect(byIssue[30]!.waitingSince).toBeNull();
    // Every needs-you item sits in the "attention" surface; its affordance lives once in the
    // per-repo catalog (owner/a carries the configured priority, the others none).
    expect(byIssue[20]!.powerActionSurface).toBe("attention");
    expect(out.powerActions["owner/a"]?.attention).toEqual({
      actions: ["readmit", "close"],
      priorityLabels: ["priority:p0"],
    });
    expect(out.powerActions["owner/b"]?.attention).toEqual({ actions: ["readmit", "close"], priorityLabels: [] });
  });

  it("orders within a state by longest wait first, nulls last", () => {
    const snap = emptySnapshot();
    snap.awaitingAnswer = [
      queue("owner/a", 1, { headline: "newer", since: "2026-06-21T11:00:00.000Z" }),
      queue("owner/a", 2, { headline: "older", since: "2026-06-21T08:00:00.000Z" }),
    ];
    const { needsYou } = snapshotToOverview(snap, { now: () => NOW });
    expect(needsYou.map((n) => n.issue)).toEqual([2, 1]); // oldest wait (issue 2) first
  });

  it("falls back to a per-state default summary when neither headline nor title exists", () => {
    const snap = emptySnapshot();
    snap.agentStuck = [queue("owner/a", 9)]; // no headline, and no backlog title
    const { needsYou } = snapshotToOverview(snap, { now: () => NOW });
    expect(needsYou[0]!.summary).toBe("Agent self-stopped — needs you");
  });

  it("dedups a run that is both in a queue and in the label backlog (one item, run-sourced)", () => {
    const snap = emptySnapshot();
    snap.awaitingAnswer = [queue("owner/a", 7, { headline: "from the run", since: "2026-06-21T11:00:00.000Z" })];
    snap.backlog.paused = [{ repo: "owner/a", issueNumber: 7, title: "from the label", state: "awaiting-answer" }];
    const { needsYou } = snapshotToOverview(snap, { now: () => NOW });
    expect(needsYou).toHaveLength(1);
    expect(needsYou[0]!.summary).toBe("from the run"); // run headline wins
    expect(needsYou[0]!.waitingSince).toBe("2026-06-21T11:00:00.000Z");
  });

  it("summarises the fleet with phase + elapsed, sorted longest-running first", () => {
    const snap = emptySnapshot();
    // phaseStartedAt anchors the elapsed clock the UI computes live; earliest start =
    // longest-running, so the fleet sorts ascending by it (issue 12 started first).
    snap.runningAgents = [
      { repo: "owner/a", issueNumber: 11, phase: "impl", fixAttempt: 0, phaseStartedAt: "2026-06-21T11:59:55.000Z" },
      { repo: "owner/b", issueNumber: 12, phase: "fix-1", fixAttempt: 2, phaseStartedAt: "2026-06-21T11:59:00.000Z" },
    ];
    const { fleet, funnel } = snapshotToOverview(snap, { now: () => NOW });
    expect(fleet.map((f) => [f.issue, f.phase, f.fixAttempt])).toEqual([
      [12, "fix-1", 2], // longest-running first (earliest phaseStartedAt)
      [11, "impl", 0],
    ]);
    expect(funnel.inFlight).toBe(2);
  });

  it("carries each running agent's live route onto the fleet (model → null on the wire, ADR-0037 #164)", () => {
    const snap = emptySnapshot();
    snap.runningAgents = [
      {
        repo: "owner/a",
        issueNumber: 11,
        phase: "impl",
        fixAttempt: 0,
        phaseStartedAt: NOW.toISOString(),
        route: { provider: "claude", model: "opus", account: "c1" },
      },
      // A default-model route omits `model` node-side; it serialises to an explicit null.
      {
        repo: "owner/b",
        issueNumber: 12,
        phase: "review-1",
        fixAttempt: 0,
        phaseStartedAt: "2026-06-21T11:59:00.000Z",
        route: { provider: "zai", account: "z3" },
      },
      // No route recorded → null on the wire (box-default / unrecorded dispatch).
      { repo: "owner/c", issueNumber: 13, phase: "impl", fixAttempt: 0, phaseStartedAt: "2026-06-21T11:58:00.000Z", route: null },
    ];
    const byIssue = new Map(snapshotToOverview(snap, { now: () => NOW }).fleet.map((f) => [f.issue, f.route]));
    expect(byIssue.get(11)).toEqual({ provider: "claude", model: "opus", account: "c1" });
    expect(byIssue.get(12)).toEqual({ provider: "zai", model: null, account: "z3" });
    expect(byIssue.get(13)).toBeNull();
  });

  it("drops a malformed running agent (no run row) from the fleet", () => {
    const snap = emptySnapshot();
    snap.runningAgents = [
      { repo: "", issueNumber: 0, phase: "impl", fixAttempt: 0, phaseStartedAt: NOW.toISOString() },
    ];
    expect(snapshotToOverview(snap, { now: () => NOW }).fleet).toEqual([]);
  });

  it("computes the pipeline funnel from holding counts + recent merge throughput", () => {
    const snap = emptySnapshot();
    snap.backlog.eligible = [
      { repo: "owner/a", issueNumber: 1, title: "x", priority: null, priorityColor: null },
      { repo: "owner/b", issueNumber: 2, title: "y", priority: null, priorityColor: null },
    ];
    snap.runningAgents = [{ repo: "owner/a", issueNumber: 11, phase: "impl", fixAttempt: 0, phaseStartedAt: NOW.toISOString() }];
    snap.awaitingCi = [queue("owner/a", 3)];
    snap.awaitingMerge = [queue("owner/b", 4), queue("owner/a", 5)];
    snap.recentOutcomes = [
      { runId: 6, repo: "owner/a", issueNumber: 6, level: "info", event: "merged", data: { prNumber: 7 }, ts: NOW.toISOString() },
      { runId: 8, repo: "owner/b", issueNumber: 8, level: "info", event: "merged", data: null, ts: NOW.toISOString() },
      { runId: 9, repo: "owner/a", issueNumber: 9, level: "info", event: "pr-opened", data: null, ts: NOW.toISOString() },
    ];
    expect(snapshotToOverview(snap, { now: () => NOW }).funnel).toEqual({
      eligible: 2,
      inFlight: 1,
      awaitingCi: 1,
      awaitingMerge: 2,
      merged: 2,
    });
  });

  it("renders the recent-activity feed newest-first with one-line summaries", () => {
    const snap = emptySnapshot();
    snap.recentOutcomes = [
      { runId: 1, repo: "owner/a", issueNumber: 5, level: "info", event: "merged", data: { prNumber: 7 }, ts: "2026-06-21T11:00:00.000Z" },
      { runId: null, repo: null, issueNumber: null, level: "warn", event: "daemon-anomaly", data: { reason: "island" }, ts: "2026-06-21T10:00:00.000Z" },
    ];
    const { activity } = snapshotToOverview(snap, { now: () => NOW });
    expect(activity.map((a) => [a.event, a.summary, a.issue, a.repo])).toEqual([
      ["merged", "Merged PR #7", 5, "owner/a"],
      ["daemon-anomaly", "Anomaly: island", null, null],
    ]);
  });

  describe("repo filter narrows every section but not the repo list", () => {
    function multiRepoSnapshot(): RuntimeSnapshot {
      const snap = emptySnapshot();
      snap.runningAgents = [
        { repo: "owner/a", issueNumber: 11, phase: "impl", fixAttempt: 0, phaseStartedAt: NOW.toISOString() },
        { repo: "owner/b", issueNumber: 12, phase: "impl", fixAttempt: 0, phaseStartedAt: NOW.toISOString() },
      ];
      snap.awaitingAnswer = [queue("owner/a", 20, { headline: "a" }), queue("owner/b", 21, { headline: "b" })];
      snap.backlog.eligible = [
        { repo: "owner/a", issueNumber: 1, title: "x", priority: null, priorityColor: null },
        { repo: "owner/b", issueNumber: 2, title: "y", priority: null, priorityColor: null },
      ];
      snap.recentOutcomes = [
        { runId: 3, repo: "owner/a", issueNumber: 3, level: "info", event: "merged", data: null, ts: NOW.toISOString() },
        { runId: 4, repo: "owner/b", issueNumber: 4, level: "info", event: "merged", data: null, ts: NOW.toISOString() },
      ];
      return snap;
    }

    it("aggregates across all repos when no filter is set", () => {
      const out = snapshotToOverview(multiRepoSnapshot(), { now: () => NOW });
      expect(out.repo).toBeNull();
      expect(out.needsYou).toHaveLength(2);
      expect(out.fleet).toHaveLength(2);
      expect(out.activity).toHaveLength(2);
      expect(out.funnel).toMatchObject({ eligible: 2, inFlight: 2, merged: 2 });
      expect(out.repos).toEqual(["owner/a", "owner/b"]);
    });

    it("narrows every section to the selected repo, keeping the full repo list", () => {
      const out = snapshotToOverview(multiRepoSnapshot(), { now: () => NOW, repo: "owner/a" });
      expect(out.repo).toBe("owner/a");
      expect(out.needsYou.map((n) => n.repo)).toEqual(["owner/a"]);
      expect(out.fleet.map((f) => f.repo)).toEqual(["owner/a"]);
      expect(out.activity.map((a) => a.repo)).toEqual(["owner/a"]);
      expect(out.funnel).toMatchObject({ eligible: 1, inFlight: 1, merged: 1 });
      // The filter dropdown stays populated with every repo, not just the selected one.
      expect(out.repos).toEqual(["owner/a", "owner/b"]);
    });

    it("includes configured-but-idle repos in the filter list", () => {
      const out = snapshotToOverview(multiRepoSnapshot(), { now: () => NOW, repos: ["owner/a", "owner/b", "owner/idle"] });
      expect(out.repos).toEqual(["owner/a", "owner/b", "owner/idle"]);
    });
  });
});

describe("activitySummary", () => {
  it("renders each known outcome event, falling back to the raw event name", () => {
    expect(activitySummary("pr-opened", { prNumber: 7 })).toBe("PR #7 opened");
    expect(activitySummary("merged", null)).toBe("Merged");
    expect(activitySummary("escalated", null)).toBe("Escalated for a decision");
    expect(activitySummary("daemon-anomaly", { reason: "x" })).toBe("Anomaly: x");
    expect(activitySummary("orphan-worktree-pruned", null)).toBe("Orphan worktree pruned");
    expect(activitySummary("some-future-event", null)).toBe("some-future-event");
  });
});
