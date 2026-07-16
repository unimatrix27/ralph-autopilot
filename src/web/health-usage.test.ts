import { describe, expect, it } from "vitest";
import type { RuntimeSnapshot, DaemonHealthView } from "../projection/snapshot";
import { healthUsageResponseSchema } from "./contract";
import { buildHealthUsage, type AnomalyLogRow, type UsageMeterSnapshot } from "./health-usage";

const NOW = new Date("2026-06-21T12:00:00.000Z");
const NOW_MS = NOW.getTime();

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

/** A daemon-health view carrying absolute instants (as the persisted snapshot emits). */
function daemon(over: Partial<DaemonHealthView> = {}): DaemonHealthView {
  return {
    targetRepo: "owner/repo",
    cap: 5,
    startedAt: new Date(NOW_MS - 4 * 60 * 60 * 1000).toISOString(), // up 4h
    lastTickAt: new Date(NOW_MS - 10_000).toISOString(),
    nextTickAt: new Date(NOW_MS + 20_000).toISOString(),
    stale: false,
    lastError: null,
    ...over,
  };
}

/** The default single-login meter snapshot (no streamed state yet). */
function meter(over: Partial<UsageMeterSnapshot> = {}): UsageMeterSnapshot {
  return { activeId: "default", ids: ["default"], states: {}, disabledIds: [], ...over };
}

describe("buildHealthUsage", () => {
  it("produces a contract-valid payload (parse → serialize round-trips)", () => {
    const out = buildHealthUsage(emptySnapshot(), [], meter(), { now: () => NOW, admitBelowPercent: 85 });
    expect(healthUsageResponseSchema.safeParse(out).success).toBe(true);
    expect(healthUsageResponseSchema.parse(JSON.parse(JSON.stringify(out)))).toEqual(out);
    expect(out.generatedAt).toBe(NOW.toISOString());
  });

  it("returns a null daemon section before the first tick wrote a snapshot", () => {
    const out = buildHealthUsage(emptySnapshot(), [], meter(), { now: () => NOW, admitBelowPercent: 85 });
    expect(out.daemon).toBeNull();
  });

  it("passes the snapshot's absolute daemon instants through, with cap + in-flight", () => {
    const snap = emptySnapshot();
    const startedAt = new Date(NOW_MS - 3_600_000).toISOString();
    const lastTickAt = new Date(NOW_MS - 15_000).toISOString();
    const nextTickAt = new Date(NOW_MS + 15_000).toISOString();
    snap.daemon = daemon({ cap: 3, startedAt, lastTickAt, nextTickAt });
    // Two running agents → in-flight 2 (the count is the raw running-agent length).
    snap.runningAgents = [
      { repo: "owner/repo", issueNumber: 7, phase: "impl", fixAttempt: 0, phaseStartedAt: NOW.toISOString() },
      { repo: "owner/repo", issueNumber: 8, phase: "review-1", fixAttempt: 0, phaseStartedAt: NOW.toISOString() },
    ];

    const { daemon: d } = buildHealthUsage(snap, [], meter(), { now: () => NOW, admitBelowPercent: 85 });
    expect(d).not.toBeNull();
    expect(d!.targets).toBe("owner/repo");
    expect(d!.cap).toBe(3);
    expect(d!.inFlight).toBe(2);
    expect(d!.startedAt).toBe(startedAt);
    expect(d!.lastTickAt).toBe(lastTickAt);
    expect(d!.nextTickAt).toBe(nextTickAt);
    expect(d!.stale).toBe(false);
    expect(d!.lastError).toBeNull();
  });

  it("carries the stale flag and the last reconcile error through", () => {
    const snap = emptySnapshot();
    snap.daemon = daemon({ stale: true, lastError: { event: "reconcile.tick-failed", at: "2026-06-21T11:50:00.000Z" } });
    const { daemon: d } = buildHealthUsage(snap, [], meter(), { now: () => NOW, admitBelowPercent: 85 });
    expect(d!.stale).toBe(true);
    expect(d!.lastError).toEqual({ event: "reconcile.tick-failed", at: "2026-06-21T11:50:00.000Z" });
  });

  it("lists each live anomaly (backlog island) joined to its latest logged reason + instant", () => {
    const snap = emptySnapshot();
    // Two repos parked under daemon-anomaly; a non-anomaly paused row must be ignored.
    snap.backlog.paused = [
      { repo: "owner/b", issueNumber: 30, title: "island b", state: "daemon-anomaly" },
      { repo: "owner/a", issueNumber: 12, title: "island a", state: "daemon-anomaly" },
      { repo: "owner/a", issueNumber: 99, title: "just stuck", state: "agent-stuck" },
    ];
    // Anomaly log is newest-first; the latest row per (repo, issue) wins.
    const log: AnomalyLogRow[] = [
      { repo: "owner/a", issueNumber: 12, data: { reason: "paused-label-missing-run" }, ts: "2026-06-21T10:30:00.000Z" },
      { repo: "owner/a", issueNumber: 12, data: { reason: "stale-earlier-reason" }, ts: "2026-06-21T09:00:00.000Z" },
      // owner/b#30 has no logged reason in the window → a fallback reason, null since.
      { repo: "owner/a", issueNumber: 99, data: { reason: "not-an-anomaly-event-for-this-issue" }, ts: "2026-06-21T08:00:00.000Z" },
    ];

    const { anomalies } = buildHealthUsage(snap, log, meter(), { now: () => NOW, admitBelowPercent: 85 });

    // Ordered by repo then issue; only the two daemon-anomaly islands appear.
    expect(anomalies.map((a) => [a.repo, a.issue])).toEqual([
      ["owner/a", 12],
      ["owner/b", 30],
    ]);
    const a12 = anomalies.find((a) => a.issue === 12)!;
    expect(a12.reason).toBe("paused-label-missing-run"); // latest logged reason, not the stale one
    expect(a12.title).toBe("island a");
    expect(a12.since).toBe("2026-06-21T10:30:00.000Z");
    const b30 = anomalies.find((a) => a.issue === 30)!;
    expect(b30.reason).not.toBe(""); // a fallback, never blank
    expect(b30.since).toBeNull();
  });

  it("summarises a single default login with no streamed state as un-gated, not paused", () => {
    const { usage } = buildHealthUsage(emptySnapshot(), [], meter(), { now: () => NOW, admitBelowPercent: 85 });
    expect(usage.admitBelowPercent).toBe(85);
    expect(usage.activeId).toBe("default");
    expect(usage.paused).toBe(false);
    expect(usage.logins).toHaveLength(1);
    const login = usage.logins[0]!;
    expect(login).toMatchObject({ id: "default", active: true, gated: false, windows: [], cooldownUntil: null });
  });

  it("flags the over-threshold window as gated and surfaces per-window utilization + reset", () => {
    const fiveHourReset = NOW_MS + 90 * 60 * 1000;
    const usageSnap = meter({
      activeId: "primary",
      ids: ["primary", "secondary"],
      states: {
        primary: { windows: { five_hour: { utilization: 90, resetsAtMs: fiveHourReset } }, cooldownUntilMs: null },
        // secondary is well under threshold → has headroom.
        secondary: { windows: { seven_day: { utilization: 20, resetsAtMs: null } }, cooldownUntilMs: null },
      },
    });

    const { usage } = buildHealthUsage(emptySnapshot(), [], usageSnap, { now: () => NOW, admitBelowPercent: 85 });
    const primary = usage.logins.find((l) => l.id === "primary")!;
    const secondary = usage.logins.find((l) => l.id === "secondary")!;
    expect(primary.active).toBe(true);
    expect(primary.gated).toBe(true); // 90% ≥ 85% threshold
    expect(primary.windows).toEqual([{ type: "five_hour", utilization: 90, resetsAt: new Date(fiveHourReset).toISOString() }]);
    expect(secondary.gated).toBe(false);
    // One login still has headroom → the daemon is NOT paused.
    expect(usage.paused).toBe(false);
  });

  it("marks an active cooldown and reports the daemon paused only when EVERY login is gated", () => {
    const cooldownUntil = NOW_MS + 5 * 60 * 1000;
    const past = NOW_MS - 60_000;
    const usageSnap = meter({
      activeId: "a",
      ids: ["a", "b"],
      states: {
        a: { windows: {}, cooldownUntilMs: cooldownUntil }, // active cooldown → gated
        b: { windows: { five_hour: { utilization: 99, resetsAtMs: null } }, cooldownUntilMs: past }, // over threshold → gated
      },
    });

    const { usage } = buildHealthUsage(emptySnapshot(), [], usageSnap, { now: () => NOW, admitBelowPercent: 85 });
    const a = usage.logins.find((l) => l.id === "a")!;
    const b = usage.logins.find((l) => l.id === "b")!;
    expect(a.gated).toBe(true);
    expect(a.cooldownUntil).toBe(new Date(cooldownUntil).toISOString());
    expect(b.gated).toBe(true);
    expect(b.cooldownUntil).toBeNull(); // a past cooldown is not surfaced
    expect(usage.paused).toBe(true); // both gated → whole-daemon hold
  });
});

describe("buildHealthUsage — operator-disabled logins (issue #10)", () => {
  it("one disabled(+gated) login plus one enabled-with-headroom login → marked disabled, NOT paused", () => {
    const usageSnap = meter({
      activeId: "b",
      ids: ["a", "b"],
      states: {
        // a is parked AND gated — its gating must not count toward the whole-daemon hold.
        a: { windows: { five_hour: { utilization: 99, resetsAtMs: null } }, cooldownUntilMs: null },
        b: { windows: { five_hour: { utilization: 10, resetsAtMs: null } }, cooldownUntilMs: null },
      },
      disabledIds: ["a"],
    });
    const { usage } = buildHealthUsage(emptySnapshot(), [], usageSnap, { now: () => NOW, admitBelowPercent: 85 });
    const a = usage.logins.find((l) => l.id === "a")!;
    const b = usage.logins.find((l) => l.id === "b")!;
    expect(a.disabled).toBe(true);
    expect(b.disabled).toBe(false);
    expect(usage.paused).toBe(false); // disabled is operator intent, not a gate state
  });

  it("a disabled login's HEADROOM does not count either: the only enabled login gated → paused", () => {
    const usageSnap = meter({
      activeId: "b",
      ids: ["a", "b"],
      states: {
        // a is parked with plenty of headroom; b (the only enabled login) is gated.
        b: { windows: { five_hour: { utilization: 99, resetsAtMs: null } }, cooldownUntilMs: null },
      },
      disabledIds: ["a"],
    });
    const { usage } = buildHealthUsage(emptySnapshot(), [], usageSnap, { now: () => NOW, admitBelowPercent: 85 });
    expect(usage.paused).toBe(true);
  });

  it("every login disabled → not paused (nothing usage-gated; the state is operator intent)", () => {
    const usageSnap = meter({ activeId: "a", ids: ["a"], states: {}, disabledIds: ["a"] });
    const { usage } = buildHealthUsage(emptySnapshot(), [], usageSnap, { now: () => NOW, admitBelowPercent: 85 });
    expect(usage.logins[0]!.disabled).toBe(true);
    expect(usage.paused).toBe(false);
  });

  it("the disabled flag round-trips through the wire schema", () => {
    const out = buildHealthUsage(emptySnapshot(), [], meter({ disabledIds: ["default"] }), {
      now: () => NOW,
      admitBelowPercent: 85,
    });
    expect(healthUsageResponseSchema.safeParse(out).success).toBe(true);
    expect(healthUsageResponseSchema.parse(JSON.parse(JSON.stringify(out))).usage.logins[0]!.disabled).toBe(true);
  });
});
