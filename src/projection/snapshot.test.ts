import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEMORY_DB, openStore, type ScopedStore, type Store } from "../store/store";
import { seedRun } from "../testing/seed-run";
import { buildSnapshot } from "./snapshot";

/** Fixed clock for deterministic timestamps in the store. */
const FIXED = "2026-06-19T12:00:00.000Z";

/** The single target the per-repo seed writes go through; buildSnapshot reads globally. */
const REPO = "owner/repo";

describe("buildSnapshot", () => {
  let store: Store;
  // Seed runs/questions/snapshots through a repo-scoped view; buildSnapshot still
  // reads the raw store globally, so single-repo seeding reproduces the old setup.
  let repoStore: ScopedStore;

  beforeEach(() => {
    store = openStore(MEMORY_DB, { now: () => FIXED });
    repoStore = store.forRepo(REPO);
  });
  afterEach(() => store.close());

  it("lists running agents with issue, phase and fix-attempt", async () => {
    const run = repoStore.upsertRun({ issueNumber: 12, mode: "tdd", branch: "ralph/12-foo" });
    repoStore.addAgent({ runId: run.id, worktreePath: "/wt/12", branch: "ralph/12-foo" });

    // The impl phase carries no stored phase and no fix attempts.
    const implSnap = buildSnapshot(store, {
      now: () => new Date("2026-06-19T12:00:30.000Z"),
    });
    expect(implSnap.runningAgents).toHaveLength(1);
    const implView = implSnap.runningAgents[0]!;
    expect(implView.repo).toBe(REPO); // aggregate-first: every item carries its repo (#108)
    expect(implView.issueNumber).toBe(12);
    expect(implView.phase).toBe("impl");
    expect(implView.fixAttempt).toBe(0);
    expect(implView.phaseStartedAt).toBe("2026-06-19T12:00:00.000Z"); // run start (no phase clock in impl)
    expect(implView.route).toBeNull(); // no route recorded yet

    // A review phase with fix attempts reports the live counter.
    const agent = store.listActiveAgents()[0]!;
    repoStore.setAgentPhase(agent.id, "fix-1");
    await repoStore.recordFixAttempt({ runId: run.id, issueNumber: 12, phase: 1 });
    await repoStore.recordFixAttempt({ runId: run.id, issueNumber: 12, phase: 1 });

    const reviewSnap = buildSnapshot(store, { now: () => new Date(FIXED) });
    const reviewView = reviewSnap.runningAgents[0]!;
    expect(reviewView.phase).toBe("fix-1");
    expect(reviewView.fixAttempt).toBe(2);
  });

  it("carries the live phase's recorded route on the running agent (ADR-0037 P3.1, #164)", async () => {
    const run = repoStore.upsertRun({ issueNumber: 14, mode: "tdd", branch: "ralph/14" });
    repoStore.addAgent({ runId: run.id, worktreePath: "/wt/14", branch: "ralph/14" });
    await repoStore.recordRouteResolved({
      runId: run.id,
      issueNumber: 14,
      phase: "impl",
      route: { provider: "claude", model: "opus", account: "c1" },
    });

    const view = buildSnapshot(store).runningAgents[0]!;
    expect(view.route).toEqual({ provider: "claude", model: "opus", account: "c1" });

    // A re-dispatch (e.g. a resumed phase onto a different account) overwrites the live route.
    await repoStore.recordRouteResolved({
      runId: run.id,
      issueNumber: 14,
      phase: "review-1",
      route: { provider: "zai", account: "z3" },
    });
    expect(buildSnapshot(store).runningAgents[0]!.route).toEqual({ provider: "zai", account: "z3" });
  });

  it("carries the run's issue title onto the running agent, null for a title-less (pre-migration) run (#13)", () => {
    const titled = repoStore.upsertRun({ issueNumber: 30, mode: "tdd", branch: "ralph/30", issueTitle: "One agent per line" });
    repoStore.addAgent({ runId: titled.id, worktreePath: "/wt/30", branch: "ralph/30" });
    // A run predating the issue_title column reads back null; the projection stays total.
    const legacy = repoStore.upsertRun({ issueNumber: 31, mode: "tdd", branch: "ralph/31" });
    repoStore.addAgent({ runId: legacy.id, worktreePath: "/wt/31", branch: "ralph/31" });

    const byIssue = new Map(buildSnapshot(store).runningAgents.map((a) => [a.issueNumber, a.title]));
    expect(byIssue.get(30)).toBe("One agent per line");
    expect(byIssue.get(31)).toBeNull();
  });

  it("excludes ended agents from the running list", () => {
    const run = repoStore.upsertRun({ issueNumber: 3, mode: "tdd", branch: "ralph/3-x" });
    const agent = repoStore.addAgent({ runId: run.id, worktreePath: "/wt/3", branch: "ralph/3-x" });
    repoStore.endAgent(agent.id);
    expect(buildSnapshot(store).runningAgents).toHaveLength(0);
  });

  it("surfaces the awaiting-answer and review-maxed queues with headlines", async () => {
    const a = repoStore.upsertRun({ issueNumber: 20, mode: "tdd", branch: "ralph/20" });
    await repoStore.addQuestion({ issueNumber: 20, runId: a.id, kind: "escalate", headline: "Pick a DB driver" });
    const m = repoStore.upsertRun({ issueNumber: 21, mode: "tdd", branch: "ralph/21", prNumber: 99 });
    await repoStore.addQuestion({ issueNumber: 21, runId: m.id, kind: "heal-card", headline: "3 P0s remain" });
    // The status projection (issue #81) folds the heal-card's `Escalated` into
    // `awaiting-answer`; the `ReviewMaxed` fact pins `review-maxed` on top, exactly as the
    // review loop appends it after the heal-card.
    await repoStore.recordReviewMaxed({ runId: m.id, issueNumber: 21, phase: 1 });

    // A merged run belongs in neither queue.
    await seedRun(repoStore, { issueNumber: 22, mode: "tdd", status: "merged" });

    // A run parked on the off-slot pre-review CI gate (ADR-0022 stage 1).
    await seedRun(repoStore, { issueNumber: 24, mode: "tdd", status: "awaiting-ci", branch: "ralph/24", prNumber: 88 });

    // A run queued for the single-concurrency merge flow.
    await seedRun(repoStore, { issueNumber: 23, mode: "tdd", status: "awaiting-merge", branch: "ralph/23", prNumber: 77 });

    // A terminal agent-stuck run is its own queue (a human-attention state, #108).
    await seedRun(repoStore, { issueNumber: 25, mode: "tdd", status: "agent-stuck", branch: "ralph/25" });

    const snap = buildSnapshot(store);
    expect(snap.awaitingAnswer.map((q) => q.issueNumber)).toEqual([20]);
    expect(snap.awaitingAnswer[0]!.headline).toBe("Pick a DB driver");
    expect(snap.awaitingAnswer[0]!.repo).toBe(REPO); // queue items carry their repo (#108)
    expect(snap.agentStuck.map((q) => q.issueNumber)).toEqual([25]);
    expect(snap.agentStuck[0]!.repo).toBe(REPO);
    expect(snap.reviewMaxed.map((q) => q.issueNumber)).toEqual([21]);
    expect(snap.reviewMaxed[0]!.headline).toBe("3 P0s remain");
    // The CI-wait queue is its own list, distinct from the merge queue (AC5).
    expect(snap.awaitingCi.map((q) => q.issueNumber)).toEqual([24]);
    // The merge queue is its own panel; the merged run #22 is in none of them.
    expect(snap.awaitingMerge.map((q) => q.issueNumber)).toEqual([23]);
  });

  it("reports recent outcome events newest-first, filtering chatter", () => {
    const run = repoStore.upsertRun({ issueNumber: 5, mode: "tdd" });
    repoStore.appendLog({ runId: run.id, issueNumber: 5, level: "info", event: "pickup" });
    repoStore.appendLog({ runId: run.id, issueNumber: 5, level: "info", event: "pr-opened", data: { prNumber: 7 } });
    repoStore.appendLog({ runId: run.id, issueNumber: 5, level: "info", event: "review-worklist", data: { gating: 1 } });
    repoStore.appendLog({ runId: run.id, issueNumber: 5, level: "info", event: "merged" });

    const outcomes = buildSnapshot(store).recentOutcomes;
    expect(outcomes.map((o) => o.event)).toEqual(["merged", "pr-opened"]);
    expect(outcomes.map((o) => o.event)).not.toContain("review-worklist");
    expect(outcomes.map((o) => o.event)).not.toContain("pickup");
    expect(outcomes[0]!.repo).toBe(REPO); // outcomes carry their repo (#108)
  });

  it("honours the outcome limit", () => {
    const run = repoStore.upsertRun({ issueNumber: 8, mode: "tdd" });
    for (let i = 0; i < 5; i++) {
      repoStore.appendLog({ runId: run.id, issueNumber: 8, level: "info", event: "pr-opened" });
    }
    expect(buildSnapshot(store, { outcomeLimit: 3 }).recentOutcomes).toHaveLength(3);
  });

  it("exposes an empty backlog and no daemon health before the first tick", () => {
    const snap = buildSnapshot(store);
    expect(snap.backlog).toEqual({ eligible: [], blocked: [], paused: [], manualHolds: [], modingCandidates: [], noProvider: [] });
    expect(snap.daemon).toBeNull();
  });

  it("reads the persisted backlog snapshot (eligible / blocked / paused / moding)", () => {
    repoStore.saveBacklogSnapshot({
      generatedAt: FIXED,
      targetRepo: REPO,
      cap: 5,
      reconcileIntervalSeconds: 30,
      daemonStartedAt: FIXED,
      lastError: null,
      eligible: [{ issueNumber: 7, title: "next up", priority: "priority:p0", priorityColor: "red" }],
      blocked: [{ issueNumber: 8, title: "blocked", blockers: [{ ref: 99, satisfied: false }] }],
      paused: [{ issueNumber: 9, title: "paused", state: "review-maxed" }],
      manualHolds: [{ issueNumber: 11, title: "held" }],
      modingCandidates: [{ issueNumber: 10, title: "needs a mode" }],
    });

    const snap = buildSnapshot(store);
    expect(snap.backlog.eligible.map((e) => e.issueNumber)).toEqual([7]);
    expect(snap.backlog.eligible[0]!.priority).toBe("priority:p0");
    // The precomputed row colour round-trips through SQLite (TUI paints it directly).
    expect(snap.backlog.eligible[0]!.priorityColor).toBe("red");
    expect(snap.backlog.blocked[0]!.blockers).toEqual([{ ref: 99, satisfied: false }]);
    expect(snap.backlog.paused[0]!.state).toBe("review-maxed");
    expect(snap.backlog.manualHolds.map((h) => h.issueNumber)).toEqual([11]);
    expect(snap.backlog.modingCandidates.map((m) => m.issueNumber)).toEqual([10]);
    // The aggregate reader tags each flattened backlog item with its repo (#108).
    expect(snap.backlog.eligible[0]!.repo).toBe(REPO);
    expect(snap.backlog.blocked[0]!.repo).toBe(REPO);
    expect(snap.backlog.paused[0]!.repo).toBe(REPO);
    expect(snap.backlog.manualHolds[0]!.repo).toBe(REPO);
    expect(snap.backlog.modingCandidates[0]!.repo).toBe(REPO);
  });

  it("defaults newer backlog sections to empty for a snapshot row persisted before the fields existed", () => {
    // Simulate an older daemon build: persist a snapshot payload with no
    // `modingCandidates` key, then confirm the reader stays total (`?? []`).
    repoStore.saveBacklogSnapshot({
      generatedAt: FIXED,
      targetRepo: REPO,
      cap: 5,
      reconcileIntervalSeconds: 30,
      daemonStartedAt: FIXED,
      lastError: null,
      eligible: [],
      blocked: [],
      paused: [],
      modingCandidates: [{ issueNumber: 1, title: "dropped before reserialize" }],
    });
    // Strip the field out of the stored JSON to mimic a pre-upgrade row.
    store.db.prepare("UPDATE daemon_snapshot SET payload = ? WHERE repo = ?").run(
      JSON.stringify({
        generatedAt: FIXED,
        targetRepo: REPO,
        cap: 5,
        reconcileIntervalSeconds: 30,
        daemonStartedAt: FIXED,
        lastError: null,
        eligible: [],
        blocked: [],
        paused: [],
      }),
      REPO,
    );

    expect(buildSnapshot(store).backlog.modingCandidates).toEqual([]);
    expect(buildSnapshot(store).backlog.manualHolds).toEqual([]);
    // The no-provider wait (ADR-0037 P3.2) is additive too — a pre-upgrade row lacks it.
    expect(buildSnapshot(store).backlog.noProvider).toEqual([]);
  });

  it("aggregates backlog across repos, tagging each item with its source repo (#108)", () => {
    const repoA = store.forRepo("owner/a");
    const repoB = store.forRepo("owner/b");
    const base = {
      cap: 5,
      reconcileIntervalSeconds: 30,
      daemonStartedAt: FIXED,
      lastError: null,
      blocked: [],
      paused: [],
      manualHolds: [],
      modingCandidates: [],
    };
    repoA.saveBacklogSnapshot({
      ...base,
      generatedAt: FIXED,
      targetRepo: "owner/a",
      eligible: [{ issueNumber: 1, title: "a-one", priority: null, priorityColor: null }],
    });
    repoB.saveBacklogSnapshot({
      ...base,
      generatedAt: FIXED,
      targetRepo: "owner/b",
      eligible: [{ issueNumber: 2, title: "b-two", priority: null, priorityColor: null }],
    });

    const eligible = buildSnapshot(store).backlog.eligible;
    expect(eligible.map((e) => [e.repo, e.issueNumber])).toEqual([
      ["owner/a", 1],
      ["owner/b", 2],
    ]);
  });

  it("reports the LIVE cap in the header, not a stale idle-repo snapshot's cap (#34)", () => {
    const repoA = store.forRepo("owner/a");
    const repoB = store.forRepo("owner/b");
    const base = {
      generatedAt: FIXED,
      reconcileIntervalSeconds: 30,
      daemonStartedAt: FIXED,
      lastError: null,
      eligible: [],
      blocked: [],
      paused: [],
      manualHolds: [],
      modingCandidates: [],
    };
    // An idle repo persisted its snapshot before the operator lowered the cap (OOM stopgap 10→3);
    // the active repo re-ticked at the new cap. `Math.max` would read the stale 10.
    repoA.saveBacklogSnapshot({ ...base, targetRepo: "owner/a", cap: 10 });
    repoB.saveBacklogSnapshot({ ...base, targetRepo: "owner/b", cap: 3 });

    // With the live cap threaded in, the header reports it — never the stale max.
    expect(buildSnapshot(store, { cap: 3 }).daemon!.cap).toBe(3);
    // Without it (tests that don't assert the header), the old persisted-max behaviour holds.
    expect(buildSnapshot(store).daemon!.cap).toBe(10);
  });

  it("derives daemon health: absolute tick instants, start anchor, and freshness", () => {
    repoStore.saveBacklogSnapshot({
      generatedAt: FIXED, // last tick at 12:00:00
      targetRepo: REPO,
      cap: 4,
      reconcileIntervalSeconds: 30,
      daemonStartedAt: "2026-06-19T11:00:00.000Z", // up 1h
      lastError: null,
      eligible: [],
      blocked: [],
      paused: [],
      manualHolds: [],
      modingCandidates: [],
    });

    const fresh = buildSnapshot(store, { now: () => new Date("2026-06-19T12:00:10.000Z") }).daemon!;
    expect(fresh.targetRepo).toBe("owner/repo");
    expect(fresh.cap).toBe(4);
    expect(fresh.startedAt).toBe("2026-06-19T11:00:00.000Z");
    expect(fresh.lastTickAt).toBe("2026-06-19T12:00:00.000Z");
    expect(fresh.nextTickAt).toBe("2026-06-19T12:00:30.000Z"); // last tick + 30s interval
    expect(fresh.stale).toBe(false);

    // Two intervals with no tick → the daemon looks stalled; the overdue next-tick
    // clamps to `now` rather than reading as a past instant.
    const stalled = buildSnapshot(store, { now: () => new Date("2026-06-19T12:02:00.000Z") }).daemon!;
    expect(stalled.stale).toBe(true);
    expect(stalled.nextTickAt).toBe("2026-06-19T12:02:00.000Z"); // overdue → clamped to now
  });

  it("phaseStartedAt tracks the phase session start, not the run start", () => {
    // A clock that yields fixed instants per write so the phase change lands
    // later than the run pickup and the agent start. Order of `now()` reads:
    // upsertRun, addAgent, setAgentPhase.
    const instants = [
      "2026-06-19T11:59:00.000Z", // run upsert (irrelevant to the timers)
      "2026-06-19T12:00:00.000Z", // agent start
      "2026-06-19T12:00:20.000Z", // phase → fix-1
    ];
    let i = 0;
    const clockStore = openStore(MEMORY_DB, { now: () => instants[Math.min(i++, instants.length - 1)]! });
    const clockRepoStore = clockStore.forRepo(REPO);
    const run = clockRepoStore.upsertRun({ issueNumber: 4, mode: "tdd", branch: "ralph/4" });
    const agent = clockRepoStore.addAgent({ runId: run.id, worktreePath: "/wt/4", branch: "ralph/4" }); // t=12:00:00
    clockRepoStore.setAgentPhase(agent.id, "fix-1"); // t=12:00:20

    const view = buildSnapshot(clockStore, { now: () => new Date("2026-06-19T12:00:50.000Z") }).runningAgents[0]!;
    // The phase clock anchors to the fix-1 session start (12:00:20), not the run pickup (11:59:00).
    expect(view.phaseStartedAt).toBe("2026-06-19T12:00:20.000Z");
    clockStore.close();
  });
});
