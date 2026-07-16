/**
 * End-to-end heal of an `agent-stuck` terminal (#86, "Option A"). A run bounds out
 * → `agent-stuck` + a stuck-card; the operator answers it through the GitHub-only
 * `ralph-answer` CLI, which swaps `agent-stuck → ready-for-agent`; the next tick
 * **re-admits a fresh run** (a stuck run kept no WIP branch — re-admit, not resume),
 * and that run's impl prompt carries the operator's guidance. An unanswered stuck
 * issue is never re-admitted on its own (AC6).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../log/logger";
import { MEMORY_DB, openStore, type Store } from "../store/store";
import { Executor } from "../executor/executor";
import type { AgentRunContext, AgentRunner, AgentRunResult } from "../executor/agent";
import { buildImplPrompt } from "../executor/prompts";
import type { StuckReport } from "../executor/stuck-tool";
import { RalphAnswerService } from "../hitl/ralph-answer";
import { LABEL_AGENT_STUCK, LABEL_READY } from "../hitl/labels";
import { FakeGitHub } from "../testing/fake-github";
import { FakeWorktreeManager } from "../testing/fake-worktree";
import { buildLaunchMarker } from "../github/marker";
import { parseConfig, resolveTargets } from "../config/load";
import { Reconciler, type ReconcileBudget } from "./reconciler";

const silent = createLogger({ write: () => {} });
const config = resolveTargets(
  parseConfig({ targets: [{ repo: "owner/repo", commands: { build: "npm run build", test: "npm test" } }] }),
)[0]!;

function budgetFor(getActive: () => number, cap: number): ReconcileBudget {
  return { available: () => Math.max(0, cap - getActive()), hasCapacity: () => getActive() < cap };
}

const STUCK_REASON = "typecheck never went green after six edits to the migration";

/**
 * Bounds out on its first run (the stuck terminal), then on the re-admitted run
 * records the context it was handed and opens a PR — so a test can assert the
 * re-admit was a fresh impl (no resume) carrying the operator's guidance.
 */
class StuckThenHealRunner implements AgentRunner {
  readonly calls: AgentRunContext[] = [];

  constructor(
    private readonly github: FakeGitHub,
    private readonly report: StuckReport,
  ) {}

  async run(ctx: AgentRunContext): Promise<AgentRunResult> {
    this.calls.push(ctx);
    if (this.calls.length === 1) {
      return { ok: false, escalated: false, stuck: this.report };
    }
    const marker = buildLaunchMarker({ issueNumber: ctx.issue.number, branch: ctx.branch });
    this.github.openPullRequest(ctx.branch, `Closes #${ctx.issue.number}\n\n${marker}`);
    return { ok: true, escalated: false };
  }
}

describe("agent-stuck → ralph-answer → re-admit a fresh run with guidance (#86, AC3/AC6)", () => {
  let store: Store;
  let github: FakeGitHub;
  let worktrees: FakeWorktreeManager;
  let runner: StuckThenHealRunner;
  let reconciler: Reconciler;

  beforeEach(() => {
    store = openStore(MEMORY_DB).forRepo("owner/repo");
    github = new FakeGitHub();
    worktrees = new FakeWorktreeManager();
    runner = new StuckThenHealRunner(github, { category: "no-green-build", reason: STUCK_REASON });
    const executor = new Executor({ store, github, worktrees, agentRunner: runner, logger: silent });
    reconciler = new Reconciler({
      store,
      github,
      executor,
      worktrees,
      logger: silent,
      budget: budgetFor(() => reconciler.activeCount(), 2),
      cap: 2,
      priorityLabels: [],
      targetRepo: "owner/repo",
    });
  });
  afterEach(() => store.close());

  it("re-admits a fresh run carrying the operator's guidance, only after it is answered", async () => {
    github.seed({ number: 50, title: "Flaky migration" });

    // Tick 1: the impl run bounds out → agent-stuck + a stuck-card comment.
    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(store.getRunByIssue(50)!.status).toBe("agent-stuck");
    const callsAfterStuck = runner.calls.length;
    expect(callsAfterStuck).toBe(1);

    // Tick 2 (effect): the `agent-stuck` label is a level-triggered effect of the
    // agent-stuck status (issue #82, ADR-0027) — the stuck terminal set the status in its
    // session; the next tick's desired-vs-actual diff applies the label (the accepted
    // ≤1-tick latency). This tick is also AC6: an UNANSWERED stuck issue is never
    // re-admitted on its own — the diff labels it, but no fresh run starts (a no-op).
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(runner.calls.length).toBe(callsAfterStuck);
    expect(store.getRunByIssue(50)!.status).toBe("agent-stuck");
    expect(github.issues.get(50)!.labels).toContain(LABEL_AGENT_STUCK);
    expect(github.issues.get(50)!.labels).not.toContain(LABEL_READY);
    // The stuck-card is healable — surfaced in the GitHub-only answer queue (#86).
    const queued = await new RalphAnswerService(github).list();
    expect(queued.map((q) => q.issue.number)).toContain(50);

    // The operator answers the stuck-card via the GitHub-only CLI: agent-stuck → ready.
    await new RalphAnswerService(github).serveOne(
      async () => "Regenerate the lockfile, then split the migration into its own issue",
    );
    expect(github.issues.get(50)!.labels).toContain(LABEL_READY);
    expect(github.issues.get(50)!.labels).not.toContain(LABEL_AGENT_STUCK);

    // Tick 3: the issue is re-admitted as a FRESH run.
    await reconciler.tick();
    await reconciler.awaitInFlight();

    // A second impl pass ran — re-admit, not resume.
    expect(runner.calls.length).toBe(callsAfterStuck + 1);
    const healCall = runner.calls.at(-1)!;
    expect(healCall.resume).toBeUndefined(); // not a resume
    expect(worktrees.attached).toHaveLength(0); // never re-attached a WIP branch
    expect(worktrees.created.filter((c) => c.branch === healCall.branch).length).toBeGreaterThanOrEqual(2);

    // AC3 (load-bearing): the re-admitted run carries the operator's guidance AND why
    // the prior attempt stopped — and it lands in the actual impl prompt.
    expect(healCall.stuckHeal).toBeDefined();
    expect(healCall.stuckHeal!.answer.text).toContain("Regenerate the lockfile");
    expect(healCall.stuckHeal!.question.whereWeStand).toContain(STUCK_REASON);
    const prompt = buildImplPrompt(healCall.issue, healCall.mode, healCall.branch, config, healCall.stuckHeal);
    expect(prompt).toContain("Regenerate the lockfile, then split the migration into its own issue");
    expect(prompt).toContain(STUCK_REASON);

    // The fresh run progressed (PR opened) — the dead end is healed, not stuck again.
    expect(store.getRunByIssue(50)!.prNumber).not.toBeNull();
  });
});
