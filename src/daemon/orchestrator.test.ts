/**
 * The multi-repo orchestrator (ADR-0020): the one process loop over a per-repo
 * reconciler each tick, sharing the global build budget, the graceful drain
 * (issue #35), and the single self-update checker (issue #30, ADR-0018). Covers
 * the drain mechanics and self-update reaction that moved here from the reconciler,
 * plus the new multi-repo guarantees (shared budget, cross-repo issue independence,
 * and a drain that waits for every repo).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../log/logger";
import { MEMORY_DB, openStore, type Store, type ScopedStore } from "../store/store";
import { Executor } from "../executor/executor";
import { RunAbortRegistry } from "../executor/run-abort-registry";
import type { AgentRunner } from "../executor/agent";
import { AbortAwareAgentRunner, ControlledAgentRunner } from "../testing/fake-agent";
import { FakeGitHub } from "../testing/fake-github";
import { FakeWorktreeManager } from "../testing/fake-worktree";
import { seedRun } from "../testing/seed-run";
import { Reconciler, type ReconcileBudget } from "./reconciler";
import { Orchestrator } from "./orchestrator";
import type { SelfUpdateDeps } from "./orchestrator";
import type { UpdateChecker, UpdateStatus } from "./self-update";
import { buildLaunchMarker } from "../github/marker";
import { LABEL_AWAITING_ANSWER } from "../hitl/labels";
import { formatRalphQuestion, type EscalationQuestion } from "../review/escalation";
import { branchName } from "../core/slug";

const silent = createLogger({ write: () => {} });

const question: EscalationQuestion = {
  headline: "Need a decision",
  feature: "Startup rehydrate",
  whereWeStand: "The daemon recovered an existing paused run after a cold store restart.",
  decision: "Resume the recovered run or close it?",
  options: ["Resume", "Close"],
  stakes: "Recovered pauses must not be misclassified as new operator pages.",
  recommendation: "Resume.",
};

interface RepoSpec {
  repo: string;
  github: FakeGitHub;
  runner: AgentRunner;
  /** Optional integration review loop (for the merge-queue drain test). */
  reviewLoop?: unknown;
}

/**
 * Build an Orchestrator over one reconciler per spec, all sharing ONE global build
 * budget (`cap − Σ all repos' in-flight build runs`) and ONE shared runId →
 * AbortController registry (issue #118): executors own register/release, while
 * DaemonControl.killRun sees only its abort-only port. Returns the orchestrator,
 * the shared store, the per-repo scoped stores, and the registry.
 */
function wireOrchestrator(specs: RepoSpec[], cap: number, selfUpdate?: SelfUpdateDeps) {
  const store = openStore(MEMORY_DB);
  const reconcilers: Reconciler[] = [];
  const globalBuild = (): number => reconcilers.reduce((n, r) => n + r.inFlightCount(), 0);
  const budget: ReconcileBudget = {
    available: () => Math.max(0, cap - globalBuild()),
    hasCapacity: () => globalBuild() < cap,
  };
  const abortRegistry = new RunAbortRegistry();
  const scopes = new Map<string, ScopedStore>();
  for (const spec of specs) {
    const worktrees = new FakeWorktreeManager();
    const scoped = store.forRepo(spec.repo);
    scopes.set(spec.repo, scoped);
    const executor = new Executor({
      store: scoped,
      github: spec.github,
      worktrees,
      agentRunner: spec.runner,
      logger: silent,
      reviewLoop: spec.reviewLoop as never,
      abortRegistry,
    });
    reconcilers.push(
      new Reconciler({
        store: scoped,
        github: spec.github,
        executor,
        worktrees,
        logger: silent,
        budget,
        cap,
        priorityLabels: [],
        targetRepo: spec.repo,
        reconcileIntervalSeconds: 30,
      }),
    );
  }
  const orchestrator = new Orchestrator({ reconcilers, store, logger: silent, selfUpdate, runAbort: abortRegistry });
  return { orchestrator, store, scopes, abortRegistry };
}

/** Poll `predicate` until true or the budget runs out. */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe("Orchestrator graceful drain (#35)", () => {
  let github: FakeGitHub;

  beforeEach(() => {
    github = new FakeGitHub();
  });

  it("drains in-flight agents to completion and picks up nothing new (AC1)", async () => {
    github.seed({ number: 1, title: "one", createdAt: "2026-01-01T00:00:00Z" });
    github.seed({ number: 2, title: "two", createdAt: "2026-01-02T00:00:00Z" });
    const runner = new ControlledAgentRunner();
    const { orchestrator, store } = wireOrchestrator([{ repo: "owner/repo", github, runner }], 2);

    await orchestrator.tick();
    // A fresh eligible issue appears mid-drain; the drain never ticks, so it is not picked up.
    github.seed({ number: 3, title: "three", createdAt: "2026-01-03T00:00:00Z" });

    const drainP = orchestrator.drainToCompletion({ timeoutMs: 60_000 });
    runner.complete(1);
    runner.complete(2);
    const result = await drainP;

    expect(result.outcome).toBe("completed");
    expect(result.stillInFlight).toEqual([]);
    expect(runner.started).toEqual([1, 2]); // #3 never started
    store.close();
  });

  it("force-exits a stalled drain at the timeout, surfacing repo#issue still in flight (AC2)", async () => {
    github.seed({ number: 1, title: "hang", createdAt: "2026-01-01T00:00:00Z" });
    github.seed({ number: 2, title: "hang2", createdAt: "2026-01-02T00:00:00Z" });
    const runner = new ControlledAgentRunner();
    const { orchestrator, store } = wireOrchestrator([{ repo: "owner/repo", github, runner }], 2);

    await orchestrator.tick();
    const result = await orchestrator.drainToCompletion({ timeoutMs: 30 });

    expect(result.outcome).toBe("timeout");
    expect([...result.stillInFlight].sort()).toEqual(["owner/repo#1", "owner/repo#2"]);

    runner.complete(1);
    runner.complete(2);
    store.close();
  });

  it("a force signal during drain stops immediately and surfaces still-in-flight runs (AC3)", async () => {
    github.seed({ number: 1, title: "slow" });
    const runner = new ControlledAgentRunner();
    const { orchestrator, store } = wireOrchestrator([{ repo: "owner/repo", github, runner }], 1);

    await orchestrator.tick();
    const force = new AbortController();
    const drainP = orchestrator.drainToCompletion({ timeoutMs: 60_000, force: force.signal });
    force.abort();
    const result = await drainP;

    expect(result.outcome).toBe("forced");
    expect(result.stillInFlight).toEqual(["owner/repo#1"]);

    runner.complete(1);
    store.close();
  });

  it("runForever: a drain signal stops new pickups, drains in-flight, returns completed (e2e)", async () => {
    github.seed({ number: 1, title: "one" });
    const runner = new ControlledAgentRunner();
    const { orchestrator, store } = wireOrchestrator([{ repo: "owner/repo", github, runner }], 2);
    const drain = new AbortController();
    const force = new AbortController();

    const loopP = orchestrator.runForever({
      intervalMs: 5,
      drainSignal: drain.signal,
      forceSignal: force.signal,
      drainTimeoutMs: 60_000,
    });

    await waitFor(() => runner.started.length === 1);
    github.seed({ number: 2, title: "two" }); // appears as the drain begins
    drain.abort();
    runner.complete(1);

    const result = await loopP;
    expect(result.outcome).toBe("completed");
    expect(result.stillInFlight).toEqual([]);
    expect(runner.started).toEqual([1]); // #2 never picked up after the drain began
    store.close();
  });

  it("startup appends rehydrate facts before the run loop can tick", async () => {
    const branch = branchName(4, "cold paused");
    github.seed({ number: 4, title: "cold paused", labels: [LABEL_AWAITING_ANSWER, "afk", "mode:tdd"] });
    github.openPullRequest(
      branch,
      `Closes #4\n\n${buildLaunchMarker({ issueNumber: 4, branch })}`,
    );
    void github.postComment(4, formatRalphQuestion(question));
    const runner = new ControlledAgentRunner();
    const { orchestrator, store } = wireOrchestrator([{ repo: "owner/repo", github, runner }], 2);
    const drain = new AbortController();
    const force = new AbortController();

    await orchestrator.startup();
    const headAfterStartup = store.events.head();
    const typesAfterStartup = store.events.readAfter(0, 100).map((e) => e.type);
    drain.abort();

    const result = await orchestrator.runForever({
      intervalMs: 5,
      drainSignal: drain.signal,
      forceSignal: force.signal,
      drainTimeoutMs: 60_000,
    });

    expect(result.outcome).toBe("completed");
    expect(headAfterStartup).toBeGreaterThan(0);
    expect(typesAfterStartup).toContain("Escalated");
    expect(runner.started).toEqual([]);
    store.close();
  });

  it("runForever: a force signal abandons the loop without waiting on in-flight runs", async () => {
    github.seed({ number: 1, title: "one" });
    const runner = new ControlledAgentRunner();
    const { orchestrator, store } = wireOrchestrator([{ repo: "owner/repo", github, runner }], 1);
    const drain = new AbortController();
    const force = new AbortController();

    const loopP = orchestrator.runForever({
      intervalMs: 5,
      drainSignal: drain.signal,
      forceSignal: force.signal,
      drainTimeoutMs: 60_000,
    });

    await waitFor(() => runner.started.length === 1);
    force.abort();

    const result = await loopP;
    expect(result.outcome).toBe("forced");
    expect(result.stillInFlight).toEqual(["owner/repo#1"]);

    runner.complete(1);
    store.close();
  });

  it("drain keeps servicing each repo's merge queue until it is empty", async () => {
    const reviewLoop = {
      async runReview() {
        return { kind: "awaiting-merge" as const };
      },
      async runIntegration(ctx: { runId: number }) {
        const s = scopes.get("owner/repo")!;
        const r = s.getRun(ctx.runId)!;
        await s.recordMerged({ runId: r.id, issueNumber: r.issueNumber, prNumber: r.prNumber ?? 0 });
        return { kind: "merged" as const };
      },
    };
    const runner = new ControlledAgentRunner();
    const { orchestrator, store, scopes } = wireOrchestrator(
      [{ repo: "owner/repo", github, runner, reviewLoop }],
      2,
    );
    const scoped = scopes.get("owner/repo")!;
    for (const [n, slug] of [
      [1, "a"],
      [2, "b"],
    ] as const) {
      const branch = `ralph/${n}-${slug}`;
      github.seed({ number: n, title: slug, labels: ["afk"] });
      const pr = github.openPullRequest(branch, `Closes #${n}`);
      await seedRun(scoped, { issueNumber: n, mode: "tdd", status: "awaiting-merge", branch, prNumber: pr.number });
    }

    const outcome = await orchestrator.drainToCompletion({ timeoutMs: 5000 });

    expect(outcome.outcome).toBe("completed");
    expect(scoped.getRunByIssue(1)!.status).toBe("merged");
    expect(scoped.getRunByIssue(2)!.status).toBe("merged");
    expect(scoped.listRunsByStatus("awaiting-merge")).toHaveLength(0);
    store.close();
  });
});

/** A scripted {@link UpdateChecker}: returns (or throws) a fixed outcome per call. */
class FakeUpdateChecker implements UpdateChecker {
  calls = 0;
  constructor(private readonly outcomes: Array<UpdateStatus | Error>) {}
  async check(): Promise<UpdateStatus> {
    const idx = Math.min(this.calls, this.outcomes.length - 1);
    this.calls += 1;
    const outcome = this.outcomes[idx];
    if (outcome === undefined) throw new Error("no scripted outcome");
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

function status(behind: boolean): UpdateStatus {
  return {
    behind,
    behindBy: behind ? 1 : 0,
    localHead: "localsha",
    remoteHead: behind ? "remotesha" : "localsha",
    branch: "main",
  };
}

describe("Orchestrator self-update wiring (#30)", () => {
  let github: FakeGitHub;
  beforeEach(() => {
    github = new FakeGitHub();
  });

  it("never checks or requests a restart when self-update is off (the default)", async () => {
    const runner = new ControlledAgentRunner();
    const { orchestrator, store } = wireOrchestrator([{ repo: "owner/repo", github, runner }], 5);
    for (let i = 0; i < 5; i++) await orchestrator.tick();
    expect(orchestrator.restartForUpdateRequested()).toBe(false);
    store.close();
  });

  it("checks only every checkEveryTicks ticks, then requests a restart once behind", async () => {
    const checker = new FakeUpdateChecker([status(true)]);
    const runner = new ControlledAgentRunner();
    const { orchestrator, store } = wireOrchestrator([{ repo: "owner/repo", github, runner }], 5, {
      checker,
      checkEveryTicks: 3,
      drainTimeoutSeconds: 1,
    });

    await orchestrator.tick();
    await orchestrator.tick();
    expect(checker.calls).toBe(0); // below the cadence — no fetch yet
    expect(orchestrator.restartForUpdateRequested()).toBe(false);

    await orchestrator.tick(); // 3rd tick → the check fires
    expect(checker.calls).toBe(1);
    expect(orchestrator.restartForUpdateRequested()).toBe(true);
    store.close();
  });

  it("does not request a restart when the repo is up to date", async () => {
    const checker = new FakeUpdateChecker([status(false)]);
    const runner = new ControlledAgentRunner();
    const { orchestrator, store } = wireOrchestrator([{ repo: "owner/repo", github, runner }], 5, {
      checker,
      checkEveryTicks: 1,
      drainTimeoutSeconds: 1,
    });
    await orchestrator.tick();
    expect(checker.calls).toBe(1);
    expect(orchestrator.restartForUpdateRequested()).toBe(false);
    store.close();
  });

  it("fails safe on a check error — logs and skips, never restarts on a flaky fetch", async () => {
    const checker = new FakeUpdateChecker([new Error("git fetch: network unreachable")]);
    const runner = new ControlledAgentRunner();
    const { orchestrator, store } = wireOrchestrator([{ repo: "owner/repo", github, runner }], 5, {
      checker,
      checkEveryTicks: 1,
      drainTimeoutSeconds: 1,
    });
    await orchestrator.tick();
    expect(checker.calls).toBe(1);
    expect(orchestrator.restartForUpdateRequested()).toBe(false);
    store.close();
  });

  it("runForever drains to completion and returns restartForUpdate when behind", async () => {
    const checker = new FakeUpdateChecker([status(true)]);
    const runner = new ControlledAgentRunner();
    const { orchestrator, store } = wireOrchestrator([{ repo: "owner/repo", github, runner }], 5, {
      checker,
      checkEveryTicks: 1,
      drainTimeoutSeconds: 1,
    });
    const never = new AbortController().signal;

    const outcome = await orchestrator.runForever({
      intervalMs: 0,
      drainSignal: never,
      forceSignal: never,
      drainTimeoutMs: 60_000,
    });

    expect(outcome.restartForUpdate).toBe(true);
    expect(outcome.outcome).toBe("completed");
    expect(outcome.stillInFlight).toEqual([]);
    store.close();
  });
});

describe("Orchestrator multi-repo (ADR-0020)", () => {
  it("shares ONE global build budget across repos (never oversubscribes the cap)", async () => {
    const githubA = new FakeGitHub();
    const githubB = new FakeGitHub();
    for (let n = 1; n <= 3; n++) {
      githubA.seed({ number: n, title: `a${n}`, createdAt: `2026-01-0${n}T00:00:00Z` });
      githubB.seed({ number: n, title: `b${n}`, createdAt: `2026-01-0${n}T00:00:00Z` });
    }
    const runnerA = new ControlledAgentRunner();
    const runnerB = new ControlledAgentRunner();
    const { orchestrator, store } = wireOrchestrator(
      [
        { repo: "a/x", github: githubA, runner: runnerA },
        { repo: "b/y", github: githubB, runner: runnerB },
      ],
      3, // global cap of 3, shared across both repos
    );

    await orchestrator.tick();
    // Exactly 3 build agents total — the first repo (driven first) fills the cap,
    // the second sees no remaining budget. Never 6.
    expect(runnerA.started.length + runnerB.started.length).toBe(3);
    expect(runnerA.started).toEqual([1, 2, 3]);
    expect(runnerB.started).toEqual([]);

    // A slot freed in repo A is reusable by repo B on the next tick.
    runnerA.complete(1);
    runnerA.complete(2);
    runnerA.complete(3);
    await orchestrator.tick();
    expect(runnerB.started).toEqual([1, 2, 3]);
    store.close();
  });

  it("keeps the same issue number in two repos independent (no cross-repo block)", async () => {
    const githubA = new FakeGitHub();
    const githubB = new FakeGitHub();
    githubA.seed({ number: 5, title: "a5" });
    githubB.seed({ number: 5, title: "b5" });
    const runnerA = new ControlledAgentRunner();
    const runnerB = new ControlledAgentRunner();
    const { orchestrator, store, scopes } = wireOrchestrator(
      [
        { repo: "a/x", github: githubA, runner: runnerA },
        { repo: "b/y", github: githubB, runner: runnerB },
      ],
      5,
    );

    await orchestrator.tick();
    // Both #5s are picked up — one repo's #5 does not exclude the other's.
    expect(runnerA.started).toEqual([5]);
    expect(runnerB.started).toEqual([5]);
    expect(scopes.get("a/x")!.getRunByIssue(5)!.status).toBe("running");
    expect(scopes.get("b/y")!.getRunByIssue(5)!.status).toBe("running");
    runnerA.complete(5);
    runnerB.complete(5);
    store.close();
  });

  it("drains every repo: completes only once both repos are idle", async () => {
    const githubA = new FakeGitHub();
    const githubB = new FakeGitHub();
    githubA.seed({ number: 1, title: "a1" });
    githubB.seed({ number: 1, title: "b1" });
    const runnerA = new ControlledAgentRunner();
    const runnerB = new ControlledAgentRunner();
    const { orchestrator, store } = wireOrchestrator(
      [
        { repo: "a/x", github: githubA, runner: runnerA },
        { repo: "b/y", github: githubB, runner: runnerB },
      ],
      5,
    );

    await orchestrator.tick();
    expect(runnerA.started).toEqual([1]);
    expect(runnerB.started).toEqual([1]);

    const drainP = orchestrator.drainToCompletion({ timeoutMs: 60_000 });
    // Only repo A settles — the drain must still be pending (repo B in flight).
    runnerA.complete(1);
    await new Promise((r) => setTimeout(r, 10));
    runnerB.complete(1);
    const result = await drainP;

    expect(result.outcome).toBe("completed");
    expect(result.stillInFlight).toEqual([]);
    store.close();
  });
});

describe("Orchestrator DaemonControl (issue #118)", () => {
  let github: FakeGitHub;

  beforeEach(() => {
    github = new FakeGitHub();
  });

  it("killRun aborts one in-flight run by id and leaves every other run untouched (AC3)", async () => {
    github.seed({ number: 1, title: "one", createdAt: "2026-01-01T00:00:00Z" });
    github.seed({ number: 2, title: "two", createdAt: "2026-01-02T00:00:00Z" });
    // AbortAwareAgentRunner records the executor's abort per issue and stays in flight until
    // die() — so the test can observe the abort was targeted, then let the killed run settle.
    const runner = new AbortAwareAgentRunner();
    const { orchestrator, store, scopes } = wireOrchestrator([{ repo: "owner/repo", github, runner }], 2);
    const scoped = scopes.get("owner/repo")!;

    await orchestrator.tick();
    expect(runner.started).toEqual([1, 2]); // both runs are in flight
    const run1Id = scoped.getRunByIssue(1)!.id;
    const run2Id = scoped.getRunByIssue(2)!.id;

    // Kill run #1 by id: only its session receives the abort.
    expect(orchestrator.killRun(run1Id)).toBe(true);
    expect(runner.aborted).toEqual([1]); // run #2's session was NOT aborted
    // The killed session is still alive (the real SDK holds the slot until it unwinds); only
    // its controller is aborted. Settle it now — the failure guard terminalizes it + frees slot.
    runner.die(1);
    await orchestrator.tick(); // let the killed run settle out of the build pool
    await new Promise((r) => setTimeout(r, 5));
    expect(scoped.getRunByIssue(1)!.status).toBe("agent-stuck");
    // Run #2 is wholly unaffected: still running, its session never aborted.
    expect(scoped.getRunByIssue(2)!.status).toBe("running");
    expect(runner.aborted).toEqual([1]);

    // Killing an already-settled (or unknown) run reports nothing to kill.
    expect(orchestrator.killRun(run1Id)).toBe(false);
    expect(orchestrator.killRun(999_999)).toBe(false);

    runner.complete(2);
    store.close();
  });

  it("drain() via DaemonControl begins the same graceful drain a signal would (AC2)", async () => {
    github.seed({ number: 1, title: "one", createdAt: "2026-01-01T00:00:00Z" });
    const runner = new ControlledAgentRunner();
    const { orchestrator, store } = wireOrchestrator([{ repo: "owner/repo", github, runner }], 2);
    const never = new AbortController().signal;

    const loopP = orchestrator.runForever({
      intervalMs: 5_000, // long: a normal interval would not drain within the test window
      drainSignal: never,
      forceSignal: never,
      drainTimeoutMs: 60_000,
    });

    await waitFor(() => runner.started.length === 1);
    // A UI drain (not a signal) triggers the graceful drain.
    orchestrator.drain();
    runner.complete(1);

    const result = await loopP;
    expect(result.outcome).toBe("completed");
    expect(result.stillInFlight).toEqual([]);
    store.close();
  });

  it("forceTick() cuts the inter-tick sleep so the next reconcile round runs immediately (AC2)", async () => {
    github.seed({ number: 1, title: "one", createdAt: "2026-01-01T00:00:00Z" });
    const runner = new ControlledAgentRunner();
    const { orchestrator, store } = wireOrchestrator([{ repo: "owner/repo", github, runner }], 2);
    const never = new AbortController().signal;

    const loopP = orchestrator.runForever({
      intervalMs: 10_000, // long: without a force-tick, the second pickup waits 10s
      drainSignal: never,
      forceSignal: never,
      drainTimeoutMs: 60_000,
    });

    await waitFor(() => runner.started.length === 1); // the first tick picked up #1
    github.seed({ number: 2, title: "two", createdAt: "2026-01-02T00:00:00Z" });
    orchestrator.forceTick();
    // #2 is picked up far sooner than the 10s interval would allow — the force-tick woke the loop.
    await waitFor(() => runner.started.length === 2, 1_000);
    expect(runner.started).toEqual([1, 2]);

    // Cleanly stop the loop.
    orchestrator.drain();
    runner.complete(1);
    runner.complete(2);
    const result = await loopP;
    expect(result.outcome).toBe("completed");
    store.close();
  });

  it("forceTick is a harmless no-op before the loop starts (no sleep is observing the signal)", () => {
    const runner = new ControlledAgentRunner();
    const { orchestrator, store } = wireOrchestrator([{ repo: "owner/repo", github, runner }], 2);
    expect(() => orchestrator.forceTick()).not.toThrow();
    expect(() => orchestrator.drain()).not.toThrow();
    store.close();
  });
});
