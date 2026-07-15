/**
 * Issue #27 — the no-silent-loss guarantee, exercised end-to-end through a real
 * reconcile tick (the pure classifier matrix lives in `completeness.test.ts`):
 *
 *  - AC1: the completeness pass labels every island `daemon-anomaly` + logs it,
 *    and clears the label once an issue is no longer anomalous (including an
 *    in-flight run wedged past its lifetime ceiling — the wall-clock backstop);
 *  - AC2: the orphan / liveness sweeper terminates + prunes runs/worktrees with no
 *    live progress (orphaned `running` rows, issues closed under a live run,
 *    orphan worktrees);
 *  - AC3: across a (label set × run status) matrix, after a tick no open issue is
 *    acted-on-by-nothing without the daemon surfacing it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger, type LogFields } from "../log/logger";
import { MEMORY_DB, openStore, type Store } from "../store/store";
import { seedRun } from "../testing/seed-run";
import { Executor } from "../executor/executor";
import { AbortAwareAgentRunner, ControlledAgentRunner, PrOpeningAgentRunner } from "../testing/fake-agent";
import { FakeGitHub } from "../testing/fake-github";
import { FakeWorktreeManager } from "../testing/fake-worktree";
import { branchName } from "../core/slug";
import { buildSnapshot } from "../projection/snapshot";
import { LABEL_DAEMON_ANOMALY } from "./completeness";
import { Reconciler, type ReconcileBudget } from "./reconciler";
import type { ContainerSweeper } from "../container/container-execution";
import { FakeContainerSweeper } from "../testing/fake-transport";
import { containerNameForBranch } from "../container/docker-runner";

/** Single-repo view of the shared global build budget (ADR-0020). */
function budgetFor(getActive: () => number, cap: number): ReconcileBudget {
  return { available: () => Math.max(0, cap - getActive()), hasCapacity: () => getActive() < cap };
}

const isoT0 = "2026-06-01T00:00:00.000Z";
const t0 = Date.parse(isoT0);

type Runner = PrOpeningAgentRunner | ControlledAgentRunner | AbortAwareAgentRunner;

interface Wired {
  reconciler: Reconciler;
  worktrees: FakeWorktreeManager;
  runner: Runner;
  logs: LogFields[];
}

function wire(opts: {
  github: FakeGitHub;
  store: Store;
  runner?: Runner;
  cap?: number;
  maxRunLifetimeMs?: number;
  now?: () => Date;
  containers?: ContainerSweeper;
}): Wired {
  const logs: LogFields[] = [];
  const logger = createLogger({ write: (line) => logs.push(JSON.parse(line) as LogFields) });
  const worktrees = new FakeWorktreeManager();
  const runner = opts.runner ?? new PrOpeningAgentRunner(opts.github);
  const executor = new Executor({
    store: opts.store,
    github: opts.github,
    worktrees,
    agentRunner: runner,
    logger,
  });
  const reconciler = new Reconciler({
    store: opts.store,
    github: opts.github,
    executor,
    worktrees,
    containers: opts.containers,
    logger,
    budget: budgetFor(() => reconciler.activeCount(), opts.cap ?? 5), cap: opts.cap ?? 5,
    priorityLabels: [],
    targetRepo: "owner/repo",
    reconcileIntervalSeconds: 30,
    maxRunLifetimeMs: opts.maxRunLifetimeMs,
    now: opts.now,
  });
  return { reconciler, worktrees, runner, logs };
}

/** The labels GitHub reports for an issue right now. */
function labelsOf(github: FakeGitHub, issue: number): string[] {
  return github.issues.get(issue)?.labels ?? [];
}

describe("completeness invariant — surface islands as daemon-anomaly (AC1)", () => {
  let store: Store;
  let github: FakeGitHub;

  beforeEach(() => {
    store = openStore(MEMORY_DB).forRepo("owner/repo");
    github = new FakeGitHub();
  });
  afterEach(() => store.close());

  it("#9 — an answered review-maxed heal that nothing can resume is labelled + logged", async () => {
    // The operator answered: the CLI swapped `review-maxed` → `ready-for-agent`.
    // The run row is still `review-maxed`, but its resume context was lost — so
    // `findResumableRuns` resumes nothing and the gate excludes it. An island.
    github.seed({ number: 7, title: "lost heal", labels: ["ready-for-agent", "afk", "mode:tdd"] });
    await seedRun(store, { issueNumber: 7, mode: "tdd", status: "review-maxed", branch: branchName(7, "lost heal") });

    const { reconciler, logs } = wire({ github, store });
    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(labelsOf(github, 7)).toContain(LABEL_DAEMON_ANOMALY);
    const anomaly = logs.find((l) => l.event === "daemon.anomaly" && l.issue === 7);
    expect(anomaly).toMatchObject({ reason: "paused-run-unresumable", runStatus: "review-maxed" });
    // And surfaced in the run log for live views.
    expect(store.recentLog().some((e) => e.event === "daemon-anomaly" && e.issueNumber === 7)).toBe(true);
  });

  it("a human-attention label with no run row to resume is surfaced", async () => {
    github.seed({ number: 4, title: "orphan question", labels: ["awaiting-answer", "afk", "mode:tdd"] });

    const { reconciler, logs } = wire({ github, store });
    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(labelsOf(github, 4)).toContain(LABEL_DAEMON_ANOMALY);
    expect(logs.find((l) => l.event === "daemon.anomaly" && l.issue === 4)).toMatchObject({
      reason: "paused-label-missing-run",
    });
  });

  it("surfaces the anomaly only once, not on every tick (the label is the standing signal)", async () => {
    github.seed({ number: 4, title: "orphan question", labels: ["awaiting-answer", "afk", "mode:tdd"] });
    const { reconciler, logs } = wire({ github, store });

    await reconciler.tick();
    await reconciler.awaitInFlight();
    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(logs.filter((l) => l.event === "daemon.anomaly" && l.issue === 4)).toHaveLength(1);
    expect(github.addedLabels.filter((a) => a.issue === 4 && a.label === LABEL_DAEMON_ANOMALY)).toHaveLength(1);
  });

  it("clears daemon-anomaly once an issue is no longer anomalous (self-heal)", async () => {
    // A stale anomaly label on an otherwise-eligible issue. The completeness pass
    // holds its own `daemon-anomaly` marker out of the gate (it is the daemon's
    // output, not an input), so the issue reads as eligible and the pass clears the
    // label — the next fill then re-admits it (daemon-anomaly excludes the gate).
    github.seed({ number: 5, title: "healed", labels: ["ready-for-agent", "afk", "mode:tdd", LABEL_DAEMON_ANOMALY] });

    const { reconciler } = wire({ github, store });
    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(github.removedLabels).toContainEqual({ issue: 5, label: LABEL_DAEMON_ANOMALY });
    expect(labelsOf(github, 5)).not.toContain(LABEL_DAEMON_ANOMALY);
  });

  it("keeps a daemon-anomaly that is the sole human-attention surface (a #28 claim park)", async () => {
    // The claim-failure path (#28) parks an unclaimable issue: `ready-for-agent`
    // swapped for `daemon-anomaly` + a terminal `agent-stuck` run row. The
    // completeness pass must NOT strip the label — it is the only surface telling a
    // human to look. (The classifier reads this as awaiting-human; clearing it would
    // silently un-surface the anomaly the next tick.)
    github.seed({ number: 6, title: "unclaimable", labels: ["afk", "mode:tdd", LABEL_DAEMON_ANOMALY] });
    await seedRun(store, { issueNumber: 6, mode: "tdd", status: "agent-stuck", branch: branchName(6, "unclaimable") });

    const { reconciler } = wire({ github, store });
    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(labelsOf(github, 6)).toContain(LABEL_DAEMON_ANOMALY);
    expect(github.removedLabels).not.toContainEqual({ issue: 6, label: LABEL_DAEMON_ANOMALY });
  });

  it("clears a stale daemon-anomaly once another human-attention label carries the issue", async () => {
    // A swept orphan: the sweep parked it on `agent-stuck`, so the `daemon-anomaly`
    // the completeness pass added while it was an island is now stale — `agent-stuck`
    // is the surface a human reads. The pass self-heals (clears the stale marker).
    github.seed({ number: 7, title: "swept", labels: ["afk", "mode:tdd", "agent-stuck", LABEL_DAEMON_ANOMALY] });
    await seedRun(store, { issueNumber: 7, mode: "tdd", status: "agent-stuck", branch: branchName(7, "swept") });

    const { reconciler } = wire({ github, store });
    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(github.removedLabels).toContainEqual({ issue: 7, label: LABEL_DAEMON_ANOMALY });
    expect(labelsOf(github, 7)).not.toContain(LABEL_DAEMON_ANOMALY);
    expect(labelsOf(github, 7)).toContain("agent-stuck");
  });

  it("does not flag healthy issues — eligible, hitl, untriaged, paused-and-waiting", async () => {
    github.seed({ number: 1, title: "eligible" });
    github.seed({ number: 2, title: "hitl", labels: ["ready-for-agent", "afk", "hitl", "mode:tdd"] });
    github.seed({ number: 3, title: "triage", labels: ["needs-triage"] });
    github.seed({ number: 4, title: "waiting", labels: ["awaiting-answer", "afk", "mode:tdd"] });
    await seedRun(store, { issueNumber: 4, mode: "tdd", status: "awaiting-answer", branch: branchName(4, "waiting") });

    const { reconciler } = wire({ github, store });
    await reconciler.tick();
    await reconciler.awaitInFlight();

    for (const n of [1, 2, 3, 4]) {
      expect(labelsOf(github, n), `issue ${n}`).not.toContain(LABEL_DAEMON_ANOMALY);
    }
  });
});

describe("orphan / liveness sweeper (AC2)", () => {
  let store: Store;
  let github: FakeGitHub;

  beforeEach(() => {
    store = openStore(MEMORY_DB).forRepo("owner/repo");
    github = new FakeGitHub();
  });
  afterEach(() => store.close());

  it("terminates + prunes a `running` row with no PR that the daemon isn't executing", async () => {
    // A crash left a `running` row mid-operation (not in flight, no PR opened yet).
    github.seed({ number: 6, title: "abandoned", labels: ["afk", "mode:tdd"] });
    // A crash-abandoned `running` row carries no status fact — it reads as `running`
    // off the run-read default, exactly what the orphan sweep expects.
    store.upsertRun({
      issueNumber: 6,
      mode: "tdd",
      branch: branchName(6, "abandoned"),
      worktreePath: "/fake-wt/6-abandoned",
    });

    const { reconciler } = wire({ github, store });
    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(store.getRunByIssue(6)!.status).toBe("agent-stuck");
    expect(labelsOf(github, 6)).toContain("agent-stuck");
  });

  it("terminates + prunes a non-terminal run whose issue was closed under it", async () => {
    const branch = branchName(8, "closed under");
    const issue = github.seed({ number: 8, title: "closed under", labels: ["afk", "mode:tdd"] });
    issue.state = "CLOSED";
    await seedRun(store, {
      issueNumber: 8,
      mode: "tdd",
      status: "awaiting-answer",
      branch,
      worktreePath: "/fake-wt/8-closed-under",
    });

    const { reconciler, worktrees } = wire({ github, store });
    await reconciler.tick();
    await reconciler.awaitInFlight();

    // Terminal: the issue concluded out-of-band. The orphan-discard projects the
    // effect-neutral `closed` (issue #81), read truthfully — it never merged — rather than
    // the legacy `merged`. Terminal for completeness all the same, with no daemon-set label.
    expect(store.getRunByIssue(8)!.status).toBe("closed");
    expect(worktrees.removed).toContain("/fake-wt/8-closed-under");
  });

  it("prunes a tracked worktree that no live run or agent references", async () => {
    const { reconciler, worktrees, logs } = wire({ github, store });
    // A worktree left on disk with no run row pointing at it (interrupted teardown).
    const orphan = await worktrees.create("ralph/99-orphan", "99-orphan");

    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(worktrees.removed).toContain(orphan);
    expect(logs.some((l) => l.event === "sweep.orphan-worktree-pruned")).toBe(true);
    expect(store.recentLog().some((e) => e.event === "orphan-worktree-pruned")).toBe(true);
  });

  it("does not prune a worktree backing an in-flight run", async () => {
    github.seed({ number: 1, title: "live" });
    const runner = new ControlledAgentRunner();
    const { reconciler, worktrees } = wire({ github, store, runner, cap: 1 });

    await reconciler.tick(); // launches #1; its worktree is now live (in flight)
    expect(reconciler.activeCount()).toBe(1);
    const created = worktrees.created.map((c) => c.path);
    expect(created.length).toBe(1);

    await reconciler.tick(); // sweep must not prune the in-flight run's worktree
    expect(worktrees.removed).not.toContain(created[0]);

    runner.complete(1);
    await reconciler.awaitInFlight();
  });

});

describe("agent-stuck run whose issue resolves out-of-band (#274)", () => {
  let store: Store;
  let github: FakeGitHub;

  beforeEach(() => {
    store = openStore(MEMORY_DB).forRepo("owner/repo");
    github = new FakeGitHub();
  });
  afterEach(() => store.close());

  it("closes out an agent-stuck run whose issue was closed out-of-band within one tick", async () => {
    // #2371 bounded out as `agent-stuck`. Days later a *separate* PR (#2398) merged and
    // closed the issue directly on GitHub, bypassing the daemon's re-admit-and-merge
    // flow entirely. The stuck run's span was never closed (RunStuck does not close
    // it), so its projected status is pinned at `agent-stuck` and it surfaces forever
    // in the web HITL queue — until the reconciler closes the span out (issue #274).
    // The issue no longer carries the `agent-stuck` GitHub label (closed out-of-band).
    const issue = github.seed({ number: 2371, title: "stuck then closed", labels: ["afk", "mode:tdd"] });
    issue.state = "CLOSED"; // resolved out-of-band — a human merged a separate PR
    await seedRun(store, {
      issueNumber: 2371,
      mode: "tdd",
      status: "agent-stuck",
      branch: branchName(2371, "stuck then closed"),
      worktreePath: "/fake-wt/2371",
    });

    const { reconciler } = wire({ github, store });
    await reconciler.tick();
    await reconciler.awaitInFlight();

    // The span closes as the effect-neutral out-of-band terminal: projected status
    // flips OFF `agent-stuck` (to `closed`) within one reconciler tick.
    expect(store.getRunByIssue(2371)!.status).toBe("closed");
    // So the web control plane's "agent stuck" HITL queue no longer surfaces it.
    expect(buildSnapshot(store.raw).agentStuck.map((q) => q.issueNumber)).not.toContain(2371);

    // Idempotent: a second tick does not re-close it or regress the status.
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(store.getRunByIssue(2371)!.status).toBe("closed");
    expect(buildSnapshot(store.raw).agentStuck.map((q) => q.issueNumber)).not.toContain(2371);
  });

  it("also closes out an agent-stuck run whose issue was deleted (gone)", async () => {
    // Same as above but the issue vanished entirely (deleted / transferred), so
    // `getIssue` returns null — still an out-of-band conclusion to close the span for.
    github.seed({ number: 2372, title: "stuck then gone", labels: ["afk", "mode:tdd"] });
    await seedRun(store, {
      issueNumber: 2372,
      mode: "tdd",
      status: "agent-stuck",
      branch: branchName(2372, "stuck then gone"),
      worktreePath: "/fake-wt/2372",
    });
    github.issues.delete(2372); // the issue is gone from GitHub entirely

    const { reconciler } = wire({ github, store });
    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(store.getRunByIssue(2372)!.status).toBe("closed");
    expect(buildSnapshot(store.raw).agentStuck.map((q) => q.issueNumber)).not.toContain(2372);
  });

  it("leaves an agent-stuck run whose issue is still OPEN untouched (re-admittable)", async () => {
    // The normal case: a parked, awaiting-human `agent-stuck` issue still OPEN. A
    // human re-labels `ready-for-agent` to re-admit it. The reconciler must NOT close
    // its span out — that would silently drop a deliberately-parked issue.
    github.seed({ number: 2463, title: "parked", labels: ["agent-stuck", "afk", "mode:tdd"] });
    await seedRun(store, {
      issueNumber: 2463,
      mode: "tdd",
      status: "agent-stuck",
      branch: branchName(2463, "parked"),
      worktreePath: "/fake-wt/2463",
    });

    const { reconciler } = wire({ github, store });
    await reconciler.tick();
    await reconciler.awaitInFlight();

    // Still parked for a human — status unchanged, still surfaced in the queue.
    expect(store.getRunByIssue(2463)!.status).toBe("agent-stuck");
    expect(buildSnapshot(store.raw).agentStuck.map((q) => q.issueNumber)).toEqual([2463]);
    expect(labelsOf(github, 2463)).toContain("agent-stuck");
  });
});

describe("orphan container sweep — kill containers with no live run (issue #219 / ADR-0038)", () => {
  let store: Store;
  let github: FakeGitHub;

  beforeEach(() => {
    store = openStore(MEMORY_DB).forRepo("owner/repo");
    github = new FakeGitHub();
  });
  afterEach(() => store.close());

  it("kills a container whose run row was lost (a crash mid-flight) and logs it", async () => {
    // A daemon crash lost the run row but left its container running — nothing in-store backs it.
    const orphanBranch = branchName(42, "crashed");
    const containers = new FakeContainerSweeper(new Set([orphanBranch]));

    const { reconciler, logs } = wire({ github, store, containers });
    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(containers.killed).toEqual([containerNameForBranch(orphanBranch)]);
    expect(logs.find((l) => l.event === "sweep.orphan-containers-killed")).toMatchObject({
      containers: [containerNameForBranch(orphanBranch)],
    });
  });

  it("spares a container backing a live (non-terminal) run, killing only the stray", async () => {
    // #5 has a live, non-terminal run (paused awaiting an answer, its issue still OPEN — the sweep
    // leaves it for resume); #99 backs no run row → a stray container the sweep must reap.
    const liveBranch = branchName(5, "paused");
    const orphanBranch = branchName(99, "stray");
    github.seed({ number: 5, title: "paused", labels: ["awaiting-answer", "afk", "mode:tdd"] });
    await seedRun(store, { issueNumber: 5, mode: "tdd", status: "awaiting-answer", branch: liveBranch });
    const containers = new FakeContainerSweeper(new Set([liveBranch, orphanBranch]));

    const { reconciler } = wire({ github, store, containers });
    await reconciler.tick();
    await reconciler.awaitInFlight();

    // The live run's container is spared; only the strayed one is killed.
    expect(store.getRunByIssue(5)!.status).toBe("awaiting-answer"); // still non-terminal — left alone.
    expect(containers.killed).toEqual([containerNameForBranch(orphanBranch)]);
  });

  it("is an exact no-op when no container sweeper is wired (in-process mode)", async () => {
    // No `containers` port → the sweep does nothing and the tick proceeds normally.
    const { reconciler, logs } = wire({ github, store });
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(logs.some((l) => l.event === "sweep.orphan-containers-killed")).toBe(false);
    expect(logs.some((l) => l.event === "sweep.orphan-containers-failed")).toBe(false);
  });
});

describe("wedged in-flight run — slot-safe auto-termination (#61)", () => {
  let store: Store;
  let github: FakeGitHub;

  beforeEach(() => {
    store = openStore(MEMORY_DB).forRepo("owner/repo");
    github = new FakeGitHub();
  });
  afterEach(() => store.close());

  it("auto-terminates a wedged run, frees the slot via the single owner, and self-clears the anomaly", async () => {
    // The per-session wall-clock failed to settle a run: it sits in flight past the
    // lifetime ceiling, holding a slot. #61: the orphan sweep actively terminates it
    // through the executor's abort handle — the kill is slot-safe because the slot is
    // freed by occupySlot's single owner once the aborted session settles, never by a
    // second writer to the in-flight map.
    github.seed({ number: 2, title: "wedged" });
    let clock = t0;
    const fixedStore = openStore(MEMORY_DB, { now: () => new Date(clock).toISOString() }).forRepo("owner/repo");
    const runner = new AbortAwareAgentRunner();
    const { reconciler, worktrees, logs } = wire({
      github,
      store: fixedStore,
      runner,
      cap: 1,
      maxRunLifetimeMs: 1000,
      now: () => new Date(clock),
    });

    await reconciler.tick(); // launches #2; run row stamped at t0, still in flight
    expect(reconciler.activeCount()).toBe(1);
    const liveWorktree = worktrees.created.map((c) => c.path)[0];

    // A healthy in-flight run within its lifetime is NOT terminated — the daemon
    // never frees a slot whose session is still doing legitimate work.
    clock = t0 + 500;
    await reconciler.tick();
    expect(runner.aborted).not.toContain(2);
    expect(reconciler.activeCount()).toBe(1);

    // Past the lifetime ceiling: the sweep terminates it via the executor's abort
    // handle (the session's subprocess is killed). The kill is sent this tick…
    clock = t0 + 5000;
    await reconciler.tick();
    expect(runner.aborted).toContain(2); // actively terminated, not merely surfaced
    expect(logs.some((l) => l.event === "sweep.wedged-run-terminated" && l.issue === 2)).toBe(true);
    // …but the session has not settled yet, so the slot is STILL held — no premature
    // release while the session is alive, and the worktree it backs is not pruned.
    expect(reconciler.activeCount()).toBe(1);
    expect(worktrees.removed).not.toContain(liveWorktree);
    // While it settles it is still surfaced as a daemon-anomaly for the operator.
    expect(labelsOf(github, 2)).toContain(LABEL_DAEMON_ANOMALY);
    expect(logs.find((l) => l.event === "daemon.anomaly" && l.issue === 2)).toMatchObject({
      reason: "run-wedged-past-lifetime",
    });

    // The aborted session finally dies → the failure guard terminalizes the run to
    // `agent-stuck`, prunes the worktree, and the slot frees through occupySlot's
    // single owner (its `.finally`) — the cap is correctly restored.
    runner.die(2);
    await reconciler.awaitInFlight();
    expect(reconciler.activeCount()).toBe(0);
    expect(fixedStore.getRunByIssue(2)!.status).toBe("agent-stuck");
    expect(labelsOf(github, 2)).toContain("agent-stuck");
    expect(worktrees.removed).toContain(liveWorktree);

    // Once the run is terminal the completeness pass self-clears the daemon-anomaly
    // (agent-stuck is now the human-attention surface) — no leftover marker.
    clock = t0 + 6000;
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(labelsOf(github, 2)).not.toContain(LABEL_DAEMON_ANOMALY);

    fixedStore.close();
  });

  it("does not write the in-flight map directly — the slot only frees after the session settles", async () => {
    // The slot-safe invariant: termination sends the abort but leaves the in-flight
    // map untouched. Across repeated ticks while the aborted session is still
    // settling, the slot stays held (occupySlot is the single writer); a healthy run
    // launched onto the freed cap proves it was the *settle*, not the sweep, that
    // released it.
    github.seed({ number: 2, title: "wedged" });
    github.seed({ number: 3, title: "next up" });
    let clock = t0;
    const fixedStore = openStore(MEMORY_DB, { now: () => new Date(clock).toISOString() }).forRepo("owner/repo");
    const runner = new AbortAwareAgentRunner();
    const { reconciler } = wire({
      github,
      store: fixedStore,
      runner,
      cap: 1,
      maxRunLifetimeMs: 1000,
      now: () => new Date(clock),
    });

    await reconciler.tick(); // launches #2 (cap 1)
    expect(runner.started).toEqual([2]);

    clock = t0 + 5000;
    await reconciler.tick(); // sweep aborts #2 — but the slot stays held while it settles
    await reconciler.tick(); // a re-entrant sweep re-aborts; still no second writer
    expect(reconciler.activeCount()).toBe(1);
    expect(runner.started).toEqual([2]); // cap still full: #3 NOT launched onto a live slot

    runner.die(2); // the session finally settles → occupySlot frees the slot
    await reconciler.awaitInFlight();
    expect(reconciler.activeCount()).toBe(0);

    await reconciler.tick(); // now the freed cap admits #3
    expect(runner.started).toEqual([2, 3]);

    runner.complete(3);
    await reconciler.awaitInFlight();
    fixedStore.close();
  });
});

describe("matrix — no (label set × run status) combo leaves an unsurfaced island (AC3)", () => {
  let store: Store;
  let github: FakeGitHub;

  beforeEach(() => {
    store = openStore(MEMORY_DB).forRepo("owner/repo");
    github = new FakeGitHub();
  });
  afterEach(() => store.close());

  // Visible states a human (or the triage funnel) can see and act on; an open issue
  // in none of these, not in flight, and not picked up this tick, is a silent island.
  const HUMAN_ATTENTION = ["awaiting-answer", "review-maxed", "agent-stuck", "hitl", LABEL_DAEMON_ANOMALY];

  const LABEL_SETS: Record<string, string[]> = {
    eligible: ["ready-for-agent", "afk", "mode:tdd"],
    noAfk: ["ready-for-agent", "mode:tdd"],
    hitl: ["ready-for-agent", "afk", "hitl", "mode:tdd"],
    noMode: ["ready-for-agent", "afk"],
    awaiting: ["awaiting-answer", "afk", "mode:tdd"],
    reviewMaxed: ["review-maxed", "afk", "mode:tdd"],
    agentStuck: ["agent-stuck", "afk", "mode:tdd"],
    needsTriage: ["needs-triage"],
    empty: [],
  };
  const RUN_STATUSES = [null, "running", "awaiting-answer", "review-maxed", "agent-stuck", "merged"] as const;

  it("after a tick, every open issue is acted on, visibly waiting, or labelled an anomaly", async () => {
    let combos = 0;
    for (const [name, labels] of Object.entries(LABEL_SETS)) {
      for (const runStatus of RUN_STATUSES) {
        combos++;
        const localStore = openStore(MEMORY_DB).forRepo("owner/repo");
        const localGitHub = new FakeGitHub();
        const n = 100 + combos;
        localGitHub.seed({ number: n, title: `${name}/${runStatus}`, labels: [...labels] });
        if (runStatus) {
          await seedRun(localStore, {
            issueNumber: n,
            mode: "tdd",
            status: runStatus,
            branch: branchName(n, name),
            worktreePath: `/fake-wt/${n}`,
          });
        }
        const { reconciler } = wire({ github: localGitHub, store: localStore, cap: 5 });

        await reconciler.tick();

        // Snapshot the world the moment the completeness pass saw it (pre-drain):
        // in-flight pickups/resumes are still in flight here.
        const inFlight = reconciler.activeCount() > 0;
        const labelsNow = labelsOf(localGitHub, n);
        const stillOpen = localGitHub.issues.get(n)!.state === "OPEN";
        const run = localStore.getRunByIssue(n);
        const picked = run !== undefined && (runStatus === null || run.status !== runStatus);
        const visiblyWaiting = labelsNow.some((l) => HUMAN_ATTENTION.includes(l));
        // No non-terminal run holds the issue: either it was eligible (then it was
        // picked up — covered above) or it is pre-gate, which the daemon correctly
        // leaves to the triage funnel. The gate is the authority on "should act", so
        // the tick itself is the oracle: an unheld issue the tick didn't pick up was
        // not eligible, hence benign — never a hidden island.
        const noHoldingRun = run === undefined || run.status === "merged" || run.status === "agent-stuck";

        // The no-silent-island guarantee: an open issue with a non-terminal run the
        // daemon neither worked nor visibly surfaced (a `daemon-anomaly` / human
        // label) is an island — it must never occur.
        const surfaced = !stillOpen || inFlight || picked || visiblyWaiting || noHoldingRun;
        expect(surfaced, `island for ${name}/${runStatus}: labels=${JSON.stringify(labelsNow)}`).toBe(true);

        await reconciler.awaitInFlight();
        localStore.close();
      }
    }
    expect(combos).toBe(Object.keys(LABEL_SETS).length * RUN_STATUSES.length);
  });
});
