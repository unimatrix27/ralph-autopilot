import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../log/logger";
import { MEMORY_DB, openStore, type Store } from "../store/store";
import { seedRun } from "../testing/seed-run";
import { Executor } from "../executor/executor";
import { ControlledAgentRunner, PrOpeningAgentRunner } from "../testing/fake-agent";
import { FakeGitHub } from "../testing/fake-github";
import { FakeWorktreeManager } from "../testing/fake-worktree";
import {
  LABEL_AGENT_STUCK,
  LABEL_AWAITING_ANSWER,
  LABEL_AWAITING_MERGE,
  LABEL_DAEMON_ANOMALY,
  LABEL_READY,
  LABEL_REVIEW_MAXED,
} from "../core/labels";
import { Reconciler, type ReconcileBudget } from "./reconciler";
import { UsageMeter } from "./usage-meter";
import { parseConfig } from "../config/load";
import type { Account } from "../config/schema";
import type { RouteWorld } from "../providers/resolve";
import type { TranscriptMessage } from "../store/events/transcript";

const silent = createLogger({ write: () => {} });

function transcriptMessage(at: string, text: string): TranscriptMessage {
  return {
    type: "TranscriptMessage",
    data: { runId: "1", at, role: "assistant", sdkType: "assistant", blocks: [{ kind: "text", text }] },
  };
}

/**
 * A single-repo view of the shared global budget (ADR-0020): free slots are
 * `cap − active`, where `active` is read live from the reconciler under test.
 */
function budgetFor(getActive: () => number, cap: number): ReconcileBudget {
  return {
    available: () => Math.max(0, cap - getActive()),
    hasCapacity: () => getActive() < cap,
  };
}

function wire(opts: {
  github: FakeGitHub;
  store: Store;
  runner: PrOpeningAgentRunner | ControlledAgentRunner;
  cap?: number;
  priorityLabels?: string[];
  maxClaimFailures?: number;
}) {
  const worktrees = new FakeWorktreeManager();
  const executor = new Executor({
    store: opts.store,
    github: opts.github,
    worktrees,
    agentRunner: opts.runner,
    logger: silent,
  });
  const cap = opts.cap ?? 5;
  let reconciler: Reconciler;
  reconciler = new Reconciler({
    store: opts.store,
    github: opts.github,
    executor,
    worktrees,
    logger: silent,
    budget: budgetFor(() => reconciler.activeCount(), cap),
    cap,
    priorityLabels: opts.priorityLabels ?? [],
    maxClaimFailures: opts.maxClaimFailures,
    targetRepo: "owner/repo",
    reconcileIntervalSeconds: 30,
  });
  return { reconciler, worktrees };
}

describe("Reconciler", () => {
  let store: Store;
  let github: FakeGitHub;

  beforeEach(() => {
    store = openStore(MEMORY_DB).forRepo("owner/repo");
    github = new FakeGitHub();
  });
  afterEach(() => store.close());

  it("takes a seeded ready-for-agent+afk+mode:tdd issue to a PR that closes it", async () => {
    github.seed({ number: 2, title: "Core loop" });
    const runner = new PrOpeningAgentRunner(github);
    const { reconciler } = wire({ github, store, runner });

    await reconciler.tick();
    await reconciler.awaitInFlight();

    const pr = await github.findPullRequestForBranch("ralph/2-core-loop");
    expect(pr).not.toBeNull();
    expect(pr!.body).toContain("Closes #2");
    expect(store.getRunByIssue(2)?.prNumber).toBe(pr!.number);
  });

  it("admits NOTHING while the usage meter is gated, but keeps the issue eligible", async () => {
    // Layer 2: when a plan window is exhausted (here, an active cooldown), the tick
    // starts no new agents — so the backlog is never converted to agent-stuck — yet
    // the issue stays `ready-for-agent` for the moment the cooldown clears.
    github.seed({ number: 2, title: "Core loop" });
    const worktrees = new FakeWorktreeManager();
    const executor = new Executor({ store, github, worktrees, agentRunner: new PrOpeningAgentRunner(github), logger: silent });
    const now = 1_750_000_000_000;
    const meter = new UsageMeter({ now: () => now });
    meter.trip(now + 60_000); // cooldown active for another minute
    let reconciler: Reconciler;
    reconciler = new Reconciler({
      store,
      github,
      executor,
      worktrees,
      logger: silent,
      budget: budgetFor(() => reconciler.activeCount(), 5),
      cap: 5,
      priorityLabels: [],
      targetRepo: "owner/repo",
      reconcileIntervalSeconds: 30,
      usageMeter: meter,
      usageLimit: { enabled: true, admitBelowPercent: 85 },
    });

    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(store.getRunByIssue(2)).toBeUndefined();
    expect(await github.listOpenPullRequests()).toHaveLength(0);
    expect(github.issues.get(2)!.labels).toContain(LABEL_READY);
  });

  it("admits normally once the usage cooldown has passed", async () => {
    github.seed({ number: 2, title: "Core loop" });
    const worktrees = new FakeWorktreeManager();
    const executor = new Executor({ store, github, worktrees, agentRunner: new PrOpeningAgentRunner(github), logger: silent });
    const now = 1_750_000_000_000;
    const meter = new UsageMeter({ now: () => now });
    meter.trip(now - 1); // already expired → gate open
    let reconciler: Reconciler;
    reconciler = new Reconciler({
      store,
      github,
      executor,
      worktrees,
      logger: silent,
      budget: budgetFor(() => reconciler.activeCount(), 5),
      cap: 5,
      priorityLabels: [],
      targetRepo: "owner/repo",
      reconcileIntervalSeconds: 30,
      usageMeter: meter,
      usageLimit: { enabled: true, admitBelowPercent: 85 },
    });

    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(await github.findPullRequestForBranch("ralph/2-core-loop")).not.toBeNull();
  });

  it("admits NOTHING while a non-Claude provider cooldown is active", async () => {
    // z.ai is deliberately off the Claude OAuth meter, but a transient provider cap
    // must still pause fresh sessions so the backlog is not terminalized every tick.
    github.seed({ number: 2, title: "Core loop" });
    const worktrees = new FakeWorktreeManager();
    const executor = new Executor({ store, github, worktrees, agentRunner: new PrOpeningAgentRunner(github), logger: silent });
    const now = 1_750_000_000_000;
    const providerMeter = new UsageMeter({ tokens: [{ id: "zai" }], now: () => now });
    providerMeter.record({ status: "rejected" }, "zai");
    let reconciler: Reconciler;
    reconciler = new Reconciler({
      store,
      github,
      executor,
      worktrees,
      logger: silent,
      budget: budgetFor(() => reconciler.activeCount(), 5),
      cap: 5,
      priorityLabels: [],
      targetRepo: "owner/repo",
      reconcileIntervalSeconds: 30,
      providerUsageMeter: providerMeter,
      usageLimit: { enabled: true, admitBelowPercent: 85 },
    });

    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(store.getRunByIssue(2)).toBeUndefined();
    expect(await github.listOpenPullRequests()).toHaveLength(0);
    expect(github.issues.get(2)!.labels).toContain(LABEL_READY);
  });

  it("defers an eligible issue as a no-provider wait — no run, no human-attention label (ADR-0037 P2.3)", async () => {
    // Route resolution for the impl launch yields no route (every allowed pool gated),
    // so admission excludes the issue with `no-provider`: a wait, not a stuck. Nothing
    // is started, the issue keeps `ready-for-agent`, and NO human-attention label is
    // applied (no escalation) — the completeness pass classifies it `eligible`, so it
    // is never surfaced as a `daemon-anomaly`.
    github.seed({ number: 2, title: "Core loop" });
    const worktrees = new FakeWorktreeManager();
    const executor = new Executor({ store, github, worktrees, agentRunner: new PrOpeningAgentRunner(github), logger: silent });
    const cfg = parseConfig({ targets: [{ repo: "owner/repo", commands: { build: "x", test: "y" } }] });
    const gatedRouteWorld: RouteWorld = { acquireAccount: () => null };
    let reconciler: Reconciler;
    reconciler = new Reconciler({
      store,
      github,
      executor,
      worktrees,
      logger: silent,
      budget: budgetFor(() => reconciler.activeCount(), 5),
      cap: 5,
      priorityLabels: [],
      targetRepo: "owner/repo",
      reconcileIntervalSeconds: 30,
      routing: () => ({ agent: cfg.agent, providers: cfg.providers }),
      routeWorld: gatedRouteWorld,
    });

    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(store.getRunByIssue(2)).toBeUndefined();
    expect(await github.listOpenPullRequests()).toHaveLength(0);
    const labels = github.issues.get(2)!.labels;
    expect(labels).toContain(LABEL_READY);
    for (const attention of [LABEL_AGENT_STUCK, LABEL_AWAITING_ANSWER, LABEL_REVIEW_MAXED, LABEL_DAEMON_ANOMALY]) {
      expect(labels).not.toContain(attention);
    }
  });

  it("admits the deferred issue automatically once a pool regains headroom (ADR-0037 P2.3)", async () => {
    github.seed({ number: 2, title: "Core loop" });
    const worktrees = new FakeWorktreeManager();
    const executor = new Executor({ store, github, worktrees, agentRunner: new PrOpeningAgentRunner(github), logger: silent });
    const cfg = parseConfig({ targets: [{ repo: "owner/repo", commands: { build: "x", test: "y" } }] });
    const claudeAccount: Account = { id: "c1", provider: "claude", configDir: "" };
    let hasHeadroom = false;
    // The headroom port recovers between ticks: gated first, then a claude account appears.
    const recoveringRouteWorld: RouteWorld = { acquireAccount: () => (hasHeadroom ? claudeAccount : null) };
    let reconciler: Reconciler;
    reconciler = new Reconciler({
      store,
      github,
      executor,
      worktrees,
      logger: silent,
      budget: budgetFor(() => reconciler.activeCount(), 5),
      cap: 5,
      priorityLabels: [],
      targetRepo: "owner/repo",
      reconcileIntervalSeconds: 30,
      routing: () => ({ agent: cfg.agent, providers: cfg.providers }),
      routeWorld: recoveringRouteWorld,
    });

    // Tick 1: no headroom → nothing launches, the issue waits.
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(store.getRunByIssue(2)).toBeUndefined();

    // A pool regains headroom; the very next tick admits the issue with no re-labelling.
    hasHeadroom = true;
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(await github.findPullRequestForBranch("ralph/2-core-loop")).not.toBeNull();
  });

  it("re-admits an issue with a terminal run row when ready-for-agent is re-added (AC2)", async () => {
    github.seed({ number: 8, title: "redo" });
    // A prior run finished terminally; re-labelling must start a fresh run.
    await seedRun(store, { issueNumber: 8, mode: "tdd", status: "merged", branch: "ralph/8-redo" });
    const runner = new PrOpeningAgentRunner(github);
    const { reconciler } = wire({ github, store, runner });

    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(runner.runs.map((r) => r.issue.number)).toEqual([8]);
    expect(store.getRunByIssue(8)!.status).toBe("running");
  });

  it("does not re-admit an issue whose run is still active", async () => {
    github.seed({ number: 8, title: "active" });
    store.upsertRun({ issueNumber: 8, mode: "tdd", branch: "ralph/8-active" });
    const runner = new PrOpeningAgentRunner(github);
    const { reconciler } = wire({ github, store, runner });

    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(runner.runs).toHaveLength(0);
  });

  it("frees the slot and re-admittably terminalizes a mid-run executor failure (#34, AC3/AC4)", async () => {
    github.seed({ number: 34, title: "wedged" });
    const branch = "ralph/34-wedged";
    // Mimic #9: the agent opens a PR, then the result-parse throws mid-run.
    const openThenThrow = {
      async run(ctx: { issue: { number: number }; branch: string }) {
        github.openPullRequest(ctx.branch, `Closes #${ctx.issue.number}`);
        throw new SyntaxError("Unexpected token '\\'");
      },
    };
    const { reconciler } = wire({ github, store, runner: openThenThrow as never });

    await reconciler.tick();
    await reconciler.awaitInFlight();

    // The slot freed (the failure is swallowed by occupySlot, not left in flight).
    expect(reconciler.activeCount()).toBe(0);
    // No `running` orphan, no dangling PR, and the issue is human-visible.
    expect(store.getRunByIssue(34)!.status).toBe("agent-stuck");
    expect(github.issues.get(34)!.labels).toContain("agent-stuck");
    expect((await github.findPullRequestForBranch(branch))!.state).toBe("CLOSED");
    expect(await github.listOpenPullRequests()).toHaveLength(0);

    // Re-admittable: a human swaps `agent-stuck` for `ready-for-agent` (as for any
    // stuck run) and the next tick starts a fresh run — never silently wedged.
    await github.removeLabel(34, "agent-stuck");
    await github.addLabel(34, "ready-for-agent");
    const runner = new PrOpeningAgentRunner(github);
    const { reconciler: r2 } = wire({ github, store, runner });
    await r2.tick();
    await r2.awaitInFlight();
    expect(runner.runs.map((r) => r.issue.number)).toEqual([34]);
  });

  it("admits a blocked issue once its dependency is satisfied", async () => {
    github.seed({ number: 5, title: "was blocked", body: "## Blocked by\n- #99\n" });
    github.setDependencySatisfied(99, true);
    const runner = new PrOpeningAgentRunner(github);
    const { reconciler } = wire({ github, store, runner });

    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(runner.runs.map((r) => r.issue.number)).toEqual([5]);
  });

  it("never picks the same issue up twice across ticks", async () => {
    github.seed({ number: 7, title: "once" });
    const runner = new PrOpeningAgentRunner(github);
    const { reconciler } = wire({ github, store, runner });

    await reconciler.tick();
    await reconciler.awaitInFlight();
    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(runner.runs.filter((r) => r.issue.number === 7)).toHaveLength(1);
    expect(github.removedLabels.filter((r) => r.issue === 7 && r.label === "ready-for-agent")).toHaveLength(1);
  });

  it("runs up to the cap concurrently, refills slots, and orders FIFO", async () => {
    for (let n = 1; n <= 5; n++) {
      github.seed({ number: n, title: `issue ${n}`, createdAt: `2026-01-0${n}T00:00:00Z` });
    }
    const runner = new ControlledAgentRunner();
    const { reconciler } = wire({ github, store, runner, cap: 2 });

    await reconciler.tick();
    expect(reconciler.activeCount()).toBe(2);
    expect(runner.peak).toBe(2);
    expect(runner.started).toEqual([1, 2]);

    runner.complete(1);
    await reconciler.activePromiseFor(1);
    runner.complete(2);
    await reconciler.activePromiseFor(2);
    expect(reconciler.activeCount()).toBe(0);

    await reconciler.tick();
    expect(reconciler.activeCount()).toBe(2);
    expect(runner.started).toEqual([1, 2, 3, 4]);

    runner.complete(3);
    await reconciler.activePromiseFor(3);
    runner.complete(4);
    await reconciler.activePromiseFor(4);

    await reconciler.tick();
    expect(reconciler.activeCount()).toBe(1);
    expect(runner.started).toEqual([1, 2, 3, 4, 5]);

    runner.complete(5);
    await reconciler.awaitInFlight();

    expect(runner.peak).toBe(2); // cap never exceeded
    expect(reconciler.activeCount()).toBe(0);
  });

  it("does not exceed the cap even when many issues are eligible at once", async () => {
    for (let n = 1; n <= 10; n++) {
      github.seed({ number: n, title: `issue ${n}`, createdAt: `2026-01-${String(n).padStart(2, "0")}T00:00:00Z` });
    }
    const runner = new ControlledAgentRunner();
    const { reconciler } = wire({ github, store, runner, cap: 3 });

    await reconciler.tick();
    expect(reconciler.activeCount()).toBe(3);
    expect(runner.peak).toBe(3);
  });

  it("surfaces a persistently-failing claim as daemon-anomaly and stops the silent retry (#28, AC3)", async () => {
    github.seed({ number: 4, title: "wedged" });
    let claimCalls = 0;
    // A real executor so the relocated `surfaceClaimAnomaly` runs for real; only
    // `claim` is stubbed to throw (an unrecoverable git/gh fault) — it must not
    // loop every tick forever, burning slots while the issue never progresses.
    const worktrees = new FakeWorktreeManager();
    const executor = new Executor({
      store,
      github,
      worktrees,
      agentRunner: new PrOpeningAgentRunner(github),
      logger: silent,
    });
    executor.claim = async () => {
      claimCalls += 1;
      throw new Error("git boom");
    };
    const reconciler = new Reconciler({
      store,
      github,
      executor,
      worktrees,
      logger: silent,
      budget: budgetFor(() => reconciler.activeCount(), 5),
      cap: 5,
      priorityLabels: [],
      maxClaimFailures: 2,
      targetRepo: "owner/repo",
      reconcileIntervalSeconds: 30,
    });

    // Below the threshold: keep trying, no human-attention state yet.
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(claimCalls).toBe(1);
    expect(github.issues.get(4)!.labels).not.toContain(LABEL_DAEMON_ANOMALY);

    // Hitting the threshold surfaces it: human-attention label on, ready-for-agent
    // off, a terminal run row, and a logged anomaly for live views.
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(claimCalls).toBe(2);
    expect(github.issues.get(4)!.labels).toContain(LABEL_DAEMON_ANOMALY);
    expect(github.issues.get(4)!.labels).not.toContain(LABEL_READY);
    expect(store.getRunByIssue(4)!.status).toBe("agent-stuck");
    const anomaly = store
      .tailLog(store.getRunByIssue(4)!.id)
      .find((e) => e.event === "daemon-anomaly");
    expect(anomaly?.data).toMatchObject({ reason: "claim-failed-after-2-attempts", failures: 2 });

    // The gate now excludes it — the retry is bounded, not unbounded.
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(claimCalls).toBe(2);
  });

  it("resets the claim-failure count after a claim succeeds (#28, AC3)", async () => {
    github.seed({ number: 4, title: "flaky claim" });
    let claimCalls = 0;
    const claimed = {
      runId: 1,
      agentId: 1,
      branch: "ralph/4-flaky-claim",
      worktreePath: "/fake-wt/4-flaky-claim",
    };
    const flaky = {
      // Fail once, then succeed: the single failure must not accumulate toward
      // the threshold across the later success.
      claim: async () => {
        claimCalls += 1;
        if (claimCalls === 1) {
          throw new Error("transient git lock");
        }
        store.upsertRun({ issueNumber: 4, mode: "tdd", branch: claimed.branch });
        await github.removeLabel(4, LABEL_READY);
        return claimed;
      },
      execute: async () => ({ runId: 1, branch: claimed.branch, worktreePath: claimed.worktreePath, prNumber: null }),
    } as unknown as Executor;
    const reconciler = new Reconciler({
      store,
      github,
      executor: flaky,
      worktrees: new FakeWorktreeManager(),
      logger: silent,
      budget: budgetFor(() => reconciler.activeCount(), 5),
      cap: 5,
      priorityLabels: [],
      maxClaimFailures: 2,
      targetRepo: "owner/repo",
      reconcileIntervalSeconds: 30,
    });

    await reconciler.tick(); // claim #1 fails (count → 1)
    await reconciler.awaitInFlight();
    await reconciler.tick(); // claim #2 succeeds (count reset)
    await reconciler.awaitInFlight();

    expect(claimCalls).toBe(2);
    expect(github.issues.get(4)!.labels).not.toContain(LABEL_DAEMON_ANOMALY);
    expect(store.getRunByIssue(4)!.status).toBe("running");
  });

  it("prunes orphaned ralph/* branches with no live run on startup (#28, AC2)", async () => {
    // A paused run keeps its branch; a terminal run's branch and an unknown
    // ralph/* branch are orphans the startup sweep prunes.
    await seedRun(store, { issueNumber: 4, mode: "tdd", status: "awaiting-answer", branch: "ralph/4-live" });
    await seedRun(store, { issueNumber: 99, mode: "tdd", status: "merged", branch: "ralph/99-old" });
    const runner = new PrOpeningAgentRunner(github);
    const { reconciler, worktrees } = wire({ github, store, runner });
    worktrees.existingBranches = ["ralph/4-live", "ralph/99-old", "ralph/123-ghost"];

    await reconciler.rehydrate();
    await reconciler.awaitInFlight();

    expect(worktrees.prunedBranches.sort()).toEqual(["ralph/123-ghost", "ralph/99-old"]);
    expect(worktrees.pruneCalls).toHaveLength(1);
    expect([...worktrees.pruneCalls[0]!]).toContain("ralph/4-live");
  });

  describe("backlog snapshot (issue #20)", () => {
    it("persists eligible (pick-order), blocked refs, and paused/stuck each tick", async () => {
      github.seed({ number: 3, title: "newer", createdAt: "2026-01-03T00:00:00Z" });
      github.seed({ number: 1, title: "older", createdAt: "2026-01-01T00:00:00Z" });
      github.seed({ number: 5, title: "blocked", body: "## Blocked by\n- #99\n" }); // #99 unsatisfied
      github.seed({
        number: 7,
        title: "paused",
        labels: ["ready-for-agent", "afk", "mode:tdd", "awaiting-answer"],
      });
      const runner = new ControlledAgentRunner();
      const { reconciler } = wire({ github, store, runner, cap: 5 });

      await reconciler.tick();

      const snap = store.getBacklogSnapshot()!;
      expect(snap).not.toBeNull();
      expect(snap.targetRepo).toBe("owner/repo");
      expect(snap.cap).toBe(5);
      expect(snap.reconcileIntervalSeconds).toBe(30);
      // Eligible in scheduler pick-order (older first); blocked & paused excluded.
      expect(snap.eligible.map((e) => e.issueNumber)).toEqual([1, 3]);
      expect(snap.blocked.map((b) => b.issueNumber)).toEqual([5]);
      expect(snap.blocked[0]!.blockers).toEqual([{ ref: 99, satisfied: false }]);
      expect(snap.paused).toEqual([{ issueNumber: 7, title: "paused", state: "awaiting-answer" }]);
    });

    it("refreshes the snapshot even when the cap is full", async () => {
      github.seed({ number: 1, title: "one", createdAt: "2026-01-01T00:00:00Z" });
      github.seed({ number: 2, title: "two", createdAt: "2026-01-02T00:00:00Z" });
      const runner = new ControlledAgentRunner();
      const { reconciler } = wire({ github, store, runner, cap: 1 });

      await reconciler.tick(); // launches #1
      expect(reconciler.activeCount()).toBe(1);

      await reconciler.tick(); // cap full, but the snapshot must still refresh
      const snap = store.getBacklogSnapshot()!;
      expect(snap.eligible.map((e) => e.issueNumber)).toEqual([2]); // #1 held, #2 waiting
    });
  });
});

/** A controllable review loop: review always hands off; integration is gated. */
function gatedReviewLoop(store: Store) {
  const started: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const reviewLoop = {
    async runReview() {
      return { kind: "awaiting-merge" as const };
    },
    async runIntegration(ctx: { runId: number; issue: { number: number } }) {
      started.push(ctx.issue.number);
      await gate;
      await markMerged(store, ctx.runId);
      return { kind: "merged" as const };
    },
  };
  return { reviewLoop, started, release: () => release() };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A fake review loop's merged terminal: append the `Merged` fact (the real loop's effect). */
async function markMerged(store: Store, runId: number): Promise<void> {
  const r = store.getRun(runId)!;
  await store.recordMerged({ runId, issueNumber: r.issueNumber, prNumber: r.prNumber ?? 0 });
}

describe("Reconciler — integration worker (single concurrency)", () => {
  let store: Store;
  let github: FakeGitHub;

  beforeEach(() => {
    store = openStore(MEMORY_DB).forRepo("owner/repo");
    github = new FakeGitHub();
  });
  afterEach(() => store.close());

  /** Seed an issue + open PR + an awaiting-merge run row (the merge-queue state). */
  async function seedAwaitingMerge(n: number, title: string): Promise<void> {
    const branch = `ralph/${n}-${title}`;
    github.seed({ number: n, title });
    const pr = github.openPullRequest(branch, `Closes #${n}`);
    await seedRun(store, {
      issueNumber: n,
      mode: "tdd",
      status: "awaiting-merge",
      branch,
      worktreePath: `/wt/${n}`,
      prNumber: pr.number,
    });
  }

  function wireIntegration(reviewLoop: unknown, cap = 5) {
    const worktrees = new FakeWorktreeManager();
    const executor = new Executor({
      store,
      github,
      worktrees,
      agentRunner: new PrOpeningAgentRunner(github),
      logger: silent,
      reviewLoop: reviewLoop as never,
    });
    const reconciler = new Reconciler({
      store,
      github,
      executor,
      worktrees,
      logger: silent,
      budget: budgetFor(() => reconciler.activeCount(), cap),
      cap,
      priorityLabels: [],
      targetRepo: "owner/repo",
      reconcileIntervalSeconds: 30,
    });
    return { reconciler, worktrees };
  }

  it("integrates only one run at a time, oldest first (single lease)", async () => {
    await seedAwaitingMerge(1, "first");
    await seedAwaitingMerge(2, "second");
    await seedAwaitingMerge(3, "third");
    const { reviewLoop, started, release } = gatedReviewLoop(store);
    const { reconciler } = wireIntegration(reviewLoop);

    // Three ticks, but the lease is single: only the oldest run integrates.
    await reconciler.tick();
    await flush();
    await reconciler.tick();
    await flush();
    await reconciler.tick();
    await flush();

    expect(started).toEqual([1]);
    expect(reconciler.activeCount()).toBe(1);

    // Releasing it frees the lease; the next tick takes the next-oldest.
    release();
    await reconciler.awaitInFlight();
    expect(store.getRunByIssue(1)!.status).toBe("merged");
  });

  it("services the merge worker even when the build pool is full", async () => {
    // cap=1 build slot, occupied by a blocked build run for a ready issue.
    github.seed({ number: 9, title: "build hog", labels: [LABEL_READY, "afk", "mode:tdd"] });
    const blockedRunner = new ControlledAgentRunner();
    const worktrees = new FakeWorktreeManager();
    const executor = new Executor({
      store,
      github,
      worktrees,
      agentRunner: blockedRunner,
      logger: silent,
      reviewLoop: { async runReview() { return { kind: "awaiting-merge" as const }; }, async runIntegration(ctx: { runId: number }) { await markMerged(store, ctx.runId); return { kind: "merged" as const }; } } as never,
    });
    const reconciler = new Reconciler({ store, github, executor, worktrees, logger: silent, budget: budgetFor(() => reconciler.activeCount(), 1), cap: 1, priorityLabels: [], targetRepo: "owner/repo", reconcileIntervalSeconds: 30 });

    // Tick 1 fills the single build slot with the blocked run.
    await reconciler.tick();
    await flush();
    expect(reconciler.activeCount()).toBe(1);

    // Now the build pool is full. A run reaches the merge queue; the next tick
    // hits the "no build slots" early-return — but the merge worker runs first.
    await seedAwaitingMerge(5, "queued");
    await reconciler.tick();
    await flush();
    await flush();

    expect(store.getRunByIssue(5)!.status).toBe("merged");
    blockedRunner.complete(9);
    await reconciler.awaitInFlight();
  });

  it("does not lease a run still occupying its build slot (no teardown/re-attach race)", async () => {
    // A build run is marked `awaiting-merge` before its slot frees: the status
    // flips, then `addLabel` and the worktree teardown still run under the slot.
    // Gate the teardown so the run sits `awaiting-merge` AND in flight at once.
    github.seed({ number: 7, title: "handoff" });
    let releaseTeardown!: () => void;
    const teardownGate = new Promise<void>((r) => {
      releaseTeardown = r;
    });
    const worktrees = new (class extends FakeWorktreeManager {
      async remove(path: string): Promise<void> {
        await teardownGate;
        await super.remove(path);
      }
    })();

    const integrated: number[] = [];
    const executor = new Executor({
      store,
      github,
      worktrees,
      agentRunner: new PrOpeningAgentRunner(github),
      logger: silent,
      reviewLoop: {
        async runReview() {
          return { kind: "awaiting-merge" as const };
        },
        async runIntegration(ctx: { runId: number; issue: { number: number } }) {
          integrated.push(ctx.issue.number);
          await markMerged(store, ctx.runId);
          return { kind: "merged" as const };
        },
      } as never,
    });
    // cap=2 so tick 2 has a free build slot — this isolates the merge-worker
    // guard from the "no build slots" early-return.
    const reconciler = new Reconciler({ store, github, executor, worktrees, logger: silent, budget: budgetFor(() => reconciler.activeCount(), 2), cap: 2, priorityLabels: [], targetRepo: "owner/repo", reconcileIntervalSeconds: 30 });

    // Tick 1: build the issue. runReview hands off → status awaiting-merge, but the
    // build slot stays held because the worktree teardown is gated.
    await reconciler.tick();
    await flush();
    await flush();
    expect(store.getRunByIssue(7)!.status).toBe("awaiting-merge");
    expect(reconciler.activeCount()).toBe(1); // still occupying the build slot

    // Tick 2: the merge worker must NOT lease it while it is still in flight —
    // doing so would re-attach its worktree while teardown removes the same path.
    await reconciler.tick();
    await flush();
    expect(integrated).toEqual([]);

    // Teardown completes → the build slot frees → the next tick safely integrates.
    releaseTeardown();
    await reconciler.activePromiseFor(7);
    await reconciler.tick();
    await flush();
    await reconciler.awaitInFlight();
    expect(integrated).toEqual([7]);
    expect(store.getRunByIssue(7)!.status).toBe("merged");
  });

  // The graceful drain (servicing the merge queue to empty) is now owned by the
  // Orchestrator across all repos — see orchestrator.test.ts.
});

/**
 * The off-slot pre-review CI gate (ADR-0022 stage 1): a run parked `awaiting-ci`
 * yields its build slot, and a reconciler poller — a sibling of the merge worker —
 * reads its checks each tick and re-admits it into review when they settle, green to
 * review, red to the CI-fix loop, a pending wait past the CI timeout to the Phase 0
 * maxout. The *wait* never consumes a build slot; only the advancement into review
 * does, gated on the build budget.
 */
describe("Reconciler — CI poller (off-slot pre-review CI gate, ADR-0022 stage 1)", () => {
  let store: Store;
  let github: FakeGitHub;

  /** The fixed store clock — every parked run's `updated_at` (the park time). */
  const PARKED_AT = "2026-01-01T00:00:00Z";

  beforeEach(() => {
    store = openStore(MEMORY_DB, { now: () => PARKED_AT }).forRepo("owner/repo");
    github = new FakeGitHub();
  });
  afterEach(() => store.close());

  /** Seed an issue + open PR + a parked `awaiting-ci` run + the durable label. */
  async function seedAwaitingCi(n: number, title: string): Promise<{ branch: string; prNumber: number }> {
    const branch = `ralph/${n}-${title}`;
    github.seed({ number: n, title, labels: ["afk", "mode:tdd", "awaiting-ci"] });
    const pr = github.openPullRequest(branch, `Closes #${n}`);
    await seedRun(store, {
      issueNumber: n,
      mode: "tdd",
      status: "awaiting-ci",
      branch,
      worktreePath: `/wt/${n}`,
      prNumber: pr.number,
    });
    return { branch, prNumber: pr.number };
  }

  /**
   * A review loop that records every `resumeAfterCi` call and its seeded verdict.
   * Green/none → `awaiting-merge` (the executor sets the status + label); red/timeout
   * → the loop terminalizes to `review-maxed` internally, so the stub does too.
   */
  function recordingReviewLoop() {
    const advanced: Array<{ issue: number; state: string }> = [];
    const reviewLoop = {
      async runReview() {
        return { kind: "awaiting-merge" as const };
      },
      async resumeAfterCi(ctx: { runId: number; issue: { number: number } }, checks: { state: string }) {
        advanced.push({ issue: ctx.issue.number, state: checks.state });
        if (checks.state === "green" || checks.state === "none") {
          return { kind: "awaiting-merge" as const };
        }
        await store.recordReviewMaxed({ runId: ctx.runId, issueNumber: ctx.issue.number, phase: 0 });
        return { kind: "review-maxed" as const, phase: 0 as const };
      },
      async runIntegration(ctx: { runId: number }) {
        await markMerged(store, ctx.runId);
        return { kind: "merged" as const };
      },
    };
    return { reviewLoop, advanced };
  }

  function wireCi(
    reviewLoop: unknown,
    opts: { cap?: number; now?: () => Date; ciTimeoutMinutes?: number } = {},
  ) {
    const cap = opts.cap ?? 5;
    const worktrees = new FakeWorktreeManager();
    const executor = new Executor({
      store,
      github,
      worktrees,
      agentRunner: new PrOpeningAgentRunner(github),
      logger: silent,
      reviewLoop: reviewLoop as never,
    });
    // The build budget counts the build pool only (the merge lease is free per-repo
    // concurrency, ADR-0017) — production-faithful, so the merge worker never blocks
    // the CI poller's advancement.
    const reconciler = new Reconciler({
      store,
      github,
      executor,
      worktrees,
      logger: silent,
      budget: budgetFor(() => reconciler.inFlightCount(), cap),
      cap,
      priorityLabels: [],
      targetRepo: "owner/repo",
      reconcileIntervalSeconds: 30,
      ciTimeoutMinutes: opts.ciTimeoutMinutes ?? 30,
      now: opts.now,
    });
    return { reconciler, worktrees };
  }

  it("advances a green parked run into review (awaiting-merge), clearing the parked CI marker", async () => {
    const { prNumber } = await seedAwaitingCi(1, "green");
    github.setReadChecks(prNumber, { state: "green", failures: [] });
    const { reviewLoop, advanced } = recordingReviewLoop();
    const { reconciler } = wireCi(reviewLoop);

    await reconciler.tick();
    await reconciler.awaitInFlight();

    // The poller read CI once and re-admitted the run into review with the verdict.
    expect(github.readCheckPolls).toEqual([prNumber]);
    expect(advanced).toEqual([{ issue: 1, state: "green" }]);
    // Status hands off to awaiting-merge (the `ReviewPassed` fact). The off-slot CI
    // marker is cleared inline as the run leaves the parked queue; the `awaiting-merge`
    // label is now a level-triggered reconciler effect of that status (issue #82,
    // ADR-0027) — applied by the per-tick diff, exercised by the #82 reconciler tests.
    expect(store.getRunByIssue(1)!.status).toBe("awaiting-merge");
    expect(github.issues.get(1)!.labels).not.toContain("awaiting-ci");
  });

  it("leaves a still-pending parked run parked (read once, no advance)", async () => {
    const { prNumber } = await seedAwaitingCi(2, "pending");
    github.setReadChecks(prNumber, { state: "pending", failures: ["build"] });
    const { reviewLoop, advanced } = recordingReviewLoop();
    // 5 minutes parked, well under the 30-minute CI-timeout budget.
    const { reconciler } = wireCi(reviewLoop, { now: () => new Date("2026-01-01T00:05:00Z") });

    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(github.readCheckPolls).toEqual([prNumber]); // one lean read
    expect(advanced).toEqual([]); // still pending → no advance
    expect(store.getRunByIssue(2)!.status).toBe("awaiting-ci");
    expect(github.issues.get(2)!.labels).toContain("awaiting-ci"); // stays parked
  });

  it("times out a parked run whose CI stays pending past the CI-timeout budget (Phase 0 maxout)", async () => {
    const { prNumber } = await seedAwaitingCi(3, "slow");
    github.setReadChecks(prNumber, { state: "pending", failures: ["slow-check"] });
    const { reviewLoop, advanced } = recordingReviewLoop();
    // 60 minutes parked, past the 30-minute budget → timeout.
    const { reconciler } = wireCi(reviewLoop, {
      now: () => new Date("2026-01-01T01:00:00Z"),
      ciTimeoutMinutes: 30,
    });

    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(advanced).toEqual([{ issue: 3, state: "timeout" }]);
    expect(store.getRunByIssue(3)!.status).toBe("review-maxed");
  });

  it("advances a red parked run into the existing CI-fix path", async () => {
    const { prNumber } = await seedAwaitingCi(4, "red");
    github.setReadChecks(prNumber, { state: "red", failures: ["build"] });
    const { reviewLoop, advanced } = recordingReviewLoop();
    const { reconciler } = wireCi(reviewLoop);

    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(advanced).toEqual([{ issue: 4, state: "red" }]);
    expect(store.getRunByIssue(4)!.status).toBe("review-maxed");
  });

  it("never reads CI or advances a parked run while the build budget is full (off-budget wait)", async () => {
    const { prNumber } = await seedAwaitingCi(5, "queued");
    github.setReadChecks(prNumber, { state: "green", failures: [] });
    const { reviewLoop, advanced } = recordingReviewLoop();
    const worktrees = new FakeWorktreeManager();
    const executor = new Executor({
      store,
      github,
      worktrees,
      agentRunner: new PrOpeningAgentRunner(github),
      logger: silent,
      reviewLoop: reviewLoop as never,
    });
    // A build pool with no free slots this tick.
    const fullBudget: ReconcileBudget = { available: () => 0, hasCapacity: () => false };
    const reconciler = new Reconciler({
      store,
      github,
      executor,
      worktrees,
      logger: silent,
      budget: fullBudget,
      cap: 1,
      priorityLabels: [],
      targetRepo: "owner/repo",
      reconcileIntervalSeconds: 30,
    });

    await reconciler.tick();
    await reconciler.awaitInFlight();

    // The wait costs nothing while parked: a full pool means no read and no advance.
    expect(github.readCheckPolls).not.toContain(prNumber);
    expect(advanced).toEqual([]);
    expect(store.getRunByIssue(5)!.status).toBe("awaiting-ci");
  });

  it("advances the oldest parked run first, up to the build budget (cap=1)", async () => {
    const a = await seedAwaitingCi(1, "first");
    const b = await seedAwaitingCi(2, "second");
    github.setReadChecks(a.prNumber, { state: "green", failures: [] });
    github.setReadChecks(b.prNumber, { state: "green", failures: [] });
    const { reviewLoop, advanced } = recordingReviewLoop();
    const { reconciler } = wireCi(reviewLoop, { cap: 1 });

    // Tick 1: one free build slot → only the oldest park advances.
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(advanced).toEqual([{ issue: 1, state: "green" }]);
    expect(store.getRunByIssue(1)!.status).toBe("awaiting-merge");
    expect(store.getRunByIssue(2)!.status).toBe("awaiting-ci");

    // Tick 2: the freed slot lets the second advance (the merge lease is off-budget,
    // so servicing run 1's merge does not block the CI poller).
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(advanced).toEqual([
      { issue: 1, state: "green" },
      { issue: 2, state: "green" },
    ]);
    expect(store.getRunByIssue(2)!.status).toBe("awaiting-merge");
  });

  it("discards a parked run whose issue closed under it, never re-admitting it to review", async () => {
    await seedAwaitingCi(6, "closed");
    github.issues.get(6)!.state = "CLOSED"; // concluded out-of-band while parked
    const { reviewLoop, advanced } = recordingReviewLoop();
    const { reconciler } = wireCi(reviewLoop);

    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(advanced).toEqual([]); // not re-admitted into review
    // Terminalized as done. The out-of-band-closed orphan projects the effect-neutral
    // `closed` (issue #81), read truthfully — it never merged — not the legacy `merged`.
    expect(store.getRunByIssue(6)!.status).toBe("closed");
  });

  // ---- daemon-set state labels as reconciler effects (#82, ADR-0027) -------
  //
  // The four daemon-set state labels are level-triggered *effects*: each tick the
  // reconciler diffs the projection's desired set (from the run status) against the
  // actual GitHub labels and applies the difference idempotently. No transition-point
  // `addLabel` — the per-tick diff is the single writer.
  describe("daemon-set state labels are reconciler effects (#82)", () => {
    const cases: Array<["awaiting-answer" | "review-maxed" | "awaiting-merge", string]> = [
      ["awaiting-answer", LABEL_AWAITING_ANSWER],
      ["review-maxed", LABEL_REVIEW_MAXED],
      ["awaiting-merge", LABEL_AWAITING_MERGE],
    ];
    for (const [status, label] of cases) {
      it(`applies ${label} from a ${status} status projection (no inline addLabel)`, async () => {
        // A paused/queued run with its status set but NO state label on GitHub yet —
        // the transition point no longer labels imperatively.
        github.seed({ number: 4, title: "x", labels: ["afk", "mode:tdd"] });
        await seedRun(store, { issueNumber: 4, mode: "tdd", status, branch: "ralph/4-x" });
        const { reconciler } = wire({ github, store, runner: new PrOpeningAgentRunner(github) });

        await reconciler.tick();
        await reconciler.awaitInFlight();

        expect(github.issues.get(4)!.labels).toContain(label);
        // No false island: the projection's desired set is what completeness compares
        // against, so the in-flight effect latency does not trip a daemon-anomaly.
        expect(github.issues.get(4)!.labels).not.toContain(LABEL_DAEMON_ANOMALY);
      });
    }

    it("removes a state label that no longer matches the projection, and applies the new one", async () => {
      // A run that moved to agent-stuck while a stale awaiting-answer label lingers.
      github.seed({ number: 4, title: "x", labels: ["afk", "mode:tdd", LABEL_AWAITING_ANSWER, LABEL_AGENT_STUCK] });
      await seedRun(store, { issueNumber: 4, mode: "tdd", status: "agent-stuck", branch: "ralph/4-x" });
      const { reconciler } = wire({ github, store, runner: new PrOpeningAgentRunner(github) });

      await reconciler.tick();
      await reconciler.awaitInFlight();

      expect(github.issues.get(4)!.labels).toContain(LABEL_AGENT_STUCK);
      expect(github.issues.get(4)!.labels).not.toContain(LABEL_AWAITING_ANSWER);
    });

    it("re-applies a hand-removed state label on the next tick (idempotent self-heal)", async () => {
      github.seed({ number: 4, title: "x", labels: ["afk", "mode:tdd"] });
      await seedRun(store, { issueNumber: 4, mode: "tdd", status: "awaiting-answer", branch: "ralph/4-x" });
      const { reconciler } = wire({ github, store, runner: new PrOpeningAgentRunner(github) });

      await reconciler.tick();
      await reconciler.awaitInFlight();
      expect(github.issues.get(4)!.labels).toContain(LABEL_AWAITING_ANSWER);

      // An operator/GitHub drops it off-projection — the next tick reconciles it back.
      await github.removeLabel(4, LABEL_AWAITING_ANSWER);
      await reconciler.tick();
      await reconciler.awaitInFlight();
      expect(github.issues.get(4)!.labels).toContain(LABEL_AWAITING_ANSWER);
    });

    it("yields the pause label to a ready-for-agent re-arm (ralph-answer swap-back)", async () => {
      // The operator answered: awaiting-answer was swapped for ready-for-agent. The run
      // status is still awaiting-answer until the resume lands, but the diff must NOT
      // re-add the pause label the swap-back cleared (intake is authoritative).
      github.seed({ number: 4, title: "x", labels: ["afk", "mode:tdd", LABEL_READY] });
      await seedRun(store, { issueNumber: 4, mode: "tdd", status: "awaiting-answer", branch: "ralph/4-x" });
      const { reconciler } = wire({ github, store, runner: new PrOpeningAgentRunner(github) });

      await reconciler.tick();
      await reconciler.awaitInFlight();

      expect(github.issues.get(4)!.labels).not.toContain(LABEL_AWAITING_ANSWER);
    });

    it("does not give agent-stuck to a daemon-anomaly claim-park (#28 sole surface preserved)", async () => {
      // surfaceClaimAnomaly parks an unclaimable issue on `daemon-anomaly` + a terminal
      // `agent-stuck` run row with NO agent-stuck label. The state-label diff must yield
      // to daemon-anomaly: introducing agent-stuck would clear the sole human surface.
      github.seed({ number: 4, title: "x", labels: ["afk", "mode:tdd", LABEL_DAEMON_ANOMALY] });
      await seedRun(store, { issueNumber: 4, mode: "tdd", status: "agent-stuck", branch: "ralph/4-x" });
      const { reconciler } = wire({ github, store, runner: new PrOpeningAgentRunner(github) });

      await reconciler.tick();
      await reconciler.awaitInFlight();

      expect(github.issues.get(4)!.labels).toContain(LABEL_DAEMON_ANOMALY);
      expect(github.issues.get(4)!.labels).not.toContain(LABEL_AGENT_STUCK);
    });
  });

  describe("transcript retention (ADR-0030)", () => {
    function wireWithRetention(now: () => Date, everyTicks: number): Reconciler {
      const worktrees = new FakeWorktreeManager();
      const executor = new Executor({ store, github, worktrees, agentRunner: new PrOpeningAgentRunner(github), logger: silent });
      let reconciler: Reconciler;
      reconciler = new Reconciler({
        store,
        github,
        executor,
        worktrees,
        logger: silent,
        budget: budgetFor(() => reconciler.activeCount(), 5),
        cap: 5,
        priorityLabels: [],
        targetRepo: "owner/repo",
        reconcileIntervalSeconds: 30,
        transcriptRetention: { budget: { maxAgeDays: 30 }, everyTicks },
        now,
      });
      return reconciler;
    }

    it("prunes an aged transcript on the scheduled tick, leaving a marker", async () => {
      await store.appendToTranscript(110, "1", [transcriptMessage("2026-04-01T00:00:00.000Z", "ancient")]);
      const reconciler = wireWithRetention(() => new Date("2026-06-21T00:00:00.000Z"), 1);

      await reconciler.tick();

      const transcript = store.readTranscript(110, "1");
      expect(transcript).toHaveLength(1);
      expect(transcript[0]!.type).toBe("TranscriptPruned");
    });

    it("only prunes on the cadence tick, not every tick", async () => {
      await store.appendToTranscript(110, "1", [transcriptMessage("2026-04-01T00:00:00.000Z", "ancient")]);
      // everyTicks=2: the first tick (count 1) is a no-op; the second (count 2) prunes.
      const reconciler = wireWithRetention(() => new Date("2026-06-21T00:00:00.000Z"), 2);

      await reconciler.tick();
      expect(store.readTranscript(110, "1")[0]!.type).toBe("TranscriptMessage");

      await reconciler.tick();
      expect(store.readTranscript(110, "1")[0]!.type).toBe("TranscriptPruned");
    });
  });

  // Issue #8: a `## Blocked by` dependency the gate cannot evaluate is a gate breach,
  // not a no-op — cross-repo refs and zero-parse sections are warned every tick, and
  // a cross-repo ref fails CLOSED (the issue is never launched past it).
  describe("blocked-by section anomalies are surfaced, never silent", () => {
    function wireCapturing() {
      const lines: { event: string; [k: string]: unknown }[] = [];
      const logger = createLogger({ write: (line) => lines.push(JSON.parse(line)) });
      const worktrees = new FakeWorktreeManager();
      const executor = new Executor({ store, github, worktrees, agentRunner: new PrOpeningAgentRunner(github), logger });
      let reconciler: Reconciler;
      reconciler = new Reconciler({
        store,
        github,
        executor,
        worktrees,
        logger,
        budget: budgetFor(() => reconciler.activeCount(), 5),
        cap: 5,
        priorityLabels: [],
        targetRepo: "owner/repo",
        reconcileIntervalSeconds: 30,
      });
      return { reconciler, lines };
    }

    it("warns on a cross-repo ref and does not launch the issue (fail closed)", async () => {
      github.seed({
        number: 3,
        title: "Cross-repo dep",
        body: "## Blocked by\n- [dep](https://github.com/other/thing/issues/5)\n",
      });
      const { reconciler, lines } = wireCapturing();

      await reconciler.tick();
      await reconciler.awaitInFlight();

      const warns = lines.filter((l) => l.event === "blocked-by.cross-repo-ref");
      expect(warns).toEqual([
        expect.objectContaining({ level: "warn", repo: "owner/repo", issue: 3, refs: ["other/thing#5"] }),
      ]);
      // Fail closed: the dependency cannot be evaluated, so the issue is never launched.
      expect(store.getRunByIssue(3)).toBeUndefined();
      expect(github.issues.get(3)!.labels).toContain(LABEL_READY);
    });

    it("warns when a Blocked by section has non-empty items but zero parsed refs", async () => {
      github.seed({
        number: 4,
        title: "Unparseable deps",
        body: "## Blocked by\n- [spec](https://example.com/spec)\n- the auth refactor\n",
      });
      const { reconciler, lines } = wireCapturing();

      await reconciler.tick();
      await reconciler.awaitInFlight();

      const warns = lines.filter((l) => l.event === "blocked-by.no-refs-parsed");
      expect(warns).toEqual([
        expect.objectContaining({
          level: "warn",
          repo: "owner/repo",
          issue: 4,
          items: ["[spec](https://example.com/spec)", "the auth refactor"],
        }),
      ]);
    });

    it("emits no blocked-by warning for a clean same-repo URL section", async () => {
      github.seed({
        number: 5,
        title: "URL-form dep",
        body: "## Blocked by\n- [prereq](https://github.com/owner/repo/issues/2)\n",
      });
      github.setDependencySatisfied(2);
      const { reconciler, lines } = wireCapturing();

      await reconciler.tick();
      await reconciler.awaitInFlight();

      expect(lines.filter((l) => String(l.event).startsWith("blocked-by."))).toEqual([]);
      // And the URL-form ref gates identically to #n: satisfied → launched.
      expect(store.getRunByIssue(5)).toBeDefined();
    });
  });
});
