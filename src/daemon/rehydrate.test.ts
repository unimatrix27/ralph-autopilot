/**
 * Startup reconciliation (issue #8, DESIGN §1/§7, ADR-0003). After a crash the
 * daemon must re-derive reality from GitHub before its first tick:
 *  - warm store (`running` rows survive, in-memory state lost): re-attach a run
 *    whose PR survives and drive it to merge; else mark it terminal and remove
 *    its worktree (AC1, AC3);
 *  - cold store (SQLite lost): rehydrate a paused run from GitHub so it resumes
 *    once answered (AC2).
 * Every scenario runs against the in-memory fakes (AC4).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../log/logger";
import { MEMORY_DB, openStore, type Store } from "../store/store";
import { Executor } from "../executor/executor";
import { EscalationCheckpointer } from "../hitl/escalation-checkpoint";
import { ResumingAgentRunner } from "../testing/fake-agent";
import { FakeGitHub } from "../testing/fake-github";
import { FakeWorktreeManager } from "../testing/fake-worktree";
import { seedRun } from "../testing/seed-run";
import { ScriptedFixAgent, ScriptedReviewAgent } from "../testing/fake-review-agents";
import { RalphAnswerService } from "../hitl/ralph-answer";
import {
  buildHealCardQuestion,
  buildPhaseMarker,
  formatRalphQuestion,
  type EscalationQuestion,
} from "../review/escalation";
import { buildLaunchMarker } from "../github/marker";
import { branchName } from "../core/slug";
import {
  LABEL_AGENT_STUCK,
  LABEL_AWAITING_ANSWER,
  LABEL_READY,
  LABEL_REVIEW_MAXED,
} from "../hitl/labels";
import { LABEL_AWAITING_MERGE } from "../core/labels";
import { ReviewLoop, type MergeConfig } from "../review/review-loop";
import type { Worklist } from "../review/worklist";
import { Reconciler, type ReconcileBudget } from "./reconciler";

const silent = createLogger({ write: () => {} });

/** Single-repo view of the shared global build budget (ADR-0020). */
function budgetFor(getActive: () => number, cap: number): ReconcileBudget {
  return { available: () => Math.max(0, cap - getActive()), hasCapacity: () => getActive() < cap };
}

const mergeConfig: MergeConfig = {
  method: "squash",
  waitForChecks: true,
  ciTimeoutMinutes: 30,
  pollIntervalSeconds: 30,
  deleteBranch: true,
};

const clean: Worklist = { items: [{ severity: "nit", title: "rename a local" }] };

const question: EscalationQuestion = {
  headline: "Cannot honour the binding storage decision",
  feature: "Ledger persistence",
  whereWeStand: "The committed design says SQLite; the table needs JSONB.",
  decision: "Stay on the committed store or escalate for a schema change?",
  options: ["Keep SQLite, denormalise", "Escalate for Postgres"],
  stakes: "Switching stores is an architecture-level change.",
  recommendation: "Keep SQLite and denormalise this cycle.",
};

/** A marker+`Closes` PR body, as the impl agent would have stamped it. */
function prBody(issueNumber: number, branch: string): string {
  return `Closes #${issueNumber}\n\n${buildLaunchMarker({ issueNumber, branch })}`;
}

interface Wired {
  reconciler: Reconciler;
  worktrees: FakeWorktreeManager;
  runner: ResumingAgentRunner;
}

function wire(opts: {
  github: FakeGitHub;
  store: Store;
  withReview?: boolean;
  cap?: number;
}): Wired {
  const { github, store } = opts;
  const worktrees = new FakeWorktreeManager();
  const runner = new ResumingAgentRunner();
  const reviewLoop = opts.withReview
    ? new ReviewLoop({
        store,
        github,
        reviewAgent: new ScriptedReviewAgent([clean]),
        fixAgent: new ScriptedFixAgent(),
        logger: silent,
        maxFixAttempts: 3,
        worktrees,
        baseBranch: "main",
        merge: mergeConfig,
      })
    : undefined;
  const executor = new Executor({
    store,
    github,
    worktrees,
    agentRunner: runner,
    logger: silent,
    reviewLoop,
    escalation: new EscalationCheckpointer({ store, github, worktrees }),
  });
  const reconciler = new Reconciler({
    store,
    github,
    executor,
    worktrees,
    logger: silent,
    budget: budgetFor(() => reconciler.activeCount(), opts.cap ?? 5), cap: opts.cap ?? 5,
    priorityLabels: [],
    targetRepo: "owner/repo",
    reconcileIntervalSeconds: 30,
  });
  return { reconciler, worktrees, runner };
}

describe("startup reconciliation — orphaned running rows (AC1, AC3, AC4)", () => {
  let store: Store;
  let github: FakeGitHub;

  beforeEach(() => {
    store = openStore(MEMORY_DB).forRepo("owner/repo");
    github = new FakeGitHub();
  });
  afterEach(() => store.close());

  it("re-attaches a crashed `running` run whose PR survives and drives it to merge", async () => {
    // Simulated crash: a `running` row with no in-memory state. Its PR is still open.
    const branch = branchName(5, "Re-attach me");
    github.seed({ number: 5, title: "Re-attach me", labels: ["afk", "mode:tdd"] });
    const pr = github.openPullRequest(branch, prBody(5, branch));
    github.setCiGreen(pr.number);
    store.upsertRun({
      issueNumber: 5,
      mode: "tdd",
      branch,
      worktreePath: "/stale-wt/5",
      prNumber: pr.number,
    });
    // A stale active-agent row from before the crash.
    store.addAgent({ runId: store.getRunByIssue(5)!.id, worktreePath: "/stale-wt/5", branch });

    const { reconciler, worktrees } = wire({ github, store, withReview: true });
    // The orchestrator ends stale active-agent rows once globally before any repo
    // rehydrates (AC4) — the agents table is not repo-scoped. Simulate that here.
    store.endAllActiveAgents();
    await reconciler.rehydrate();
    await reconciler.awaitInFlight();

    // Re-attached (not freshly created) and re-driven through review, which parks
    // the pre-review CI wait off-slot (ADR-0022 stage 1) rather than blocking on it.
    expect(worktrees.attached.map((a) => a.branch)).toContain(branch);
    expect(worktrees.created).toHaveLength(0);
    expect(store.getRunByIssue(5)!.status).toBe("awaiting-ci");

    // A tick: the CI poller reads green and re-admits into review → awaiting-merge.
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(store.getRunByIssue(5)!.status).toBe("awaiting-merge");

    // The single-concurrency merge worker (driven by a tick) then integrates it.
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(store.getRunByIssue(5)!.status).toBe("merged");
    expect(github.merges.map((m) => m.prNumber)).toContain(pr.number);
    // No orphaned worktree survives (AC3) and stale agents are closed (AC4).
    expect(worktrees.removed).toContain("/fake-wt/5-re-attach-me");
    expect(store.listActiveAgents()).toHaveLength(0);
  });

  it("marks a crashed `running` run with no PR terminal and removes its worktree (AC1, AC3)", async () => {
    github.seed({ number: 6, title: "No PR", labels: ["afk", "mode:tdd"] });
    store.upsertRun({
      issueNumber: 6,
      mode: "tdd",
      branch: branchName(6, "No PR"),
      worktreePath: "/stale-wt/6",
    });

    const { reconciler, worktrees } = wire({ github, store, withReview: true });
    await reconciler.rehydrate();
    await reconciler.awaitInFlight();

    expect(store.getRunByIssue(6)!.status).toBe("agent-stuck");
    expect(github.issues.get(6)!.labels).toContain(LABEL_AGENT_STUCK);
    expect(worktrees.removed).toContain("/stale-wt/6");
  });

  it("leaves a healthy warm store with no orphans untouched", async () => {
    github.seed({ number: 9, title: "done" });
    await seedRun(store, { issueNumber: 9, mode: "tdd", status: "merged", branch: branchName(9, "done") });

    const { reconciler, worktrees } = wire({ github, store });
    await reconciler.rehydrate();
    await reconciler.awaitInFlight();

    expect(store.getRunByIssue(9)!.status).toBe("merged");
    expect(worktrees.attached).toHaveLength(0);
    expect(worktrees.removed).toHaveLength(0);
  });
});

describe("startup reconciliation — cold store (AC2, AC4)", () => {
  let store: Store;
  let github: FakeGitHub;

  beforeEach(() => {
    store = openStore(MEMORY_DB).forRepo("owner/repo");
    github = new FakeGitHub();
  });
  afterEach(() => store.close());

  it("rehydrates a paused run from GitHub so it resumes once answered (AC2)", async () => {
    // Cold store (empty). GitHub holds a paused run: an `awaiting-answer` issue, a
    // draft PR carrying the launch marker, and the `ralph-question` comment.
    const branch = branchName(4, "HITL");
    github.seed({ number: 4, title: "HITL", labels: [LABEL_AWAITING_ANSWER, "afk", "mode:tdd"] });
    const pr = github.openPullRequest(branch, prBody(4, branch));
    void github.postComment(4, formatRalphQuestion(question));

    const { reconciler, worktrees, runner } = wire({ github, store });

    // Rehydrate rebuilds the run row, question index, and resume context.
    await reconciler.rehydrate();
    await reconciler.awaitInFlight();

    const run = store.getRunByIssue(4);
    expect(run?.status).toBe("awaiting-answer");
    expect(run?.branch).toBe(branch);
    expect(run?.prNumber).toBe(pr.number);
    expect(store.listOpenQuestions().map((q) => q.issueNumber)).toEqual([4]);

    // Operator answers via the GitHub-only CLI service — swaps the label back.
    const answerService = new RalphAnswerService(github);
    await answerService.serveOne(async () => "1"); // "Keep SQLite, denormalise"
    expect(github.issues.get(4)!.labels).toContain(LABEL_READY);

    // Next tick: the rehydrated run resumes from its WIP branch with the answer.
    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(worktrees.attached.map((a) => a.branch)).toEqual([branch]);
    const resumeCall = runner.runs.find((c) => c.resume);
    expect(resumeCall).toBeDefined();
    expect(resumeCall!.branch).toBe(branch);
    expect(resumeCall!.resume!.question.headline).toBe(question.headline);
    expect(resumeCall!.resume!.answer).toEqual({
      kind: "option",
      text: "Keep SQLite, denormalise",
      optionIndex: 0,
    });
    expect(store.getRunByIssue(4)!.status).toBe("running");
    expect(store.listOpenQuestions()).toHaveLength(0);
  });

  it("rebuilds an in-flight review run from its PR marker and re-drives it to merge", async () => {
    // Cold store: an in-flight review run (PR open, `ready-for-agent` removed on
    // pickup, no human-attention label) must come back as `running` and re-drive.
    const branch = branchName(7, "Mid review");
    github.seed({ number: 7, title: "Mid review", labels: ["afk", "mode:tdd"] });
    const pr = github.openPullRequest(branch, prBody(7, branch));
    github.setCiGreen(pr.number);

    const { reconciler, worktrees } = wire({ github, store, withReview: true });
    await reconciler.rehydrate();
    await reconciler.awaitInFlight();

    // Rebuilt as `running`, re-driven through review, which parks the pre-review CI
    // wait off-slot (ADR-0022 stage 1).
    expect(worktrees.attached.map((a) => a.branch)).toContain(branch);
    expect(store.getRunByIssue(7)!.status).toBe("awaiting-ci");

    // A tick advances it (CI green) into review → awaiting-merge.
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(store.getRunByIssue(7)!.status).toBe("awaiting-merge");

    // The merge worker integrates it on the next tick.
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(store.getRunByIssue(7)!.status).toBe("merged");
    expect(github.merges.map((m) => m.prNumber)).toContain(pr.number);
  });

  it("rebuilds an awaiting-merge run from its label and hands it to the merge worker (not a re-review)", async () => {
    // Cold store: a run that passed review carries the `awaiting-merge` label on
    // its issue. It must be rebuilt as `awaiting-merge` (the merge worker's queue),
    // NOT as `running` (which the orphan pass would re-review and merge off-lease).
    const branch = branchName(11, "ready to merge");
    github.seed({ number: 11, title: "ready to merge", labels: ["afk", "mode:tdd", LABEL_AWAITING_MERGE] });
    const pr = github.openPullRequest(branch, prBody(11, branch));
    github.setCiGreen(pr.number);

    const { reconciler, worktrees } = wire({ github, store, withReview: true });
    await reconciler.rehydrate();
    await reconciler.awaitInFlight();

    // Reconstructed into the merge queue; the orphan pass did NOT re-attach/re-review it.
    expect(store.getRunByIssue(11)!.status).toBe("awaiting-merge");
    expect(worktrees.attached.map((a) => a.branch)).not.toContain(branch);

    // The single-concurrency merge worker integrates it on the next tick.
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(store.getRunByIssue(11)!.status).toBe("merged");
    expect(github.merges.map((m) => m.prNumber)).toContain(pr.number);
  });

  it("rebuilds an awaiting-ci run from its label and re-parks the CI wait (ADR-0022 stage 1)", async () => {
    // Cold store: a run parked on the off-slot pre-review CI gate carries the durable
    // `awaiting-ci` label. It must be rebuilt as `awaiting-ci` (the CI poller's queue),
    // NOT as `running` (which the orphan pass would re-attach and re-review from
    // scratch) — so the parked wait survives a restart (AC2).
    const branch = branchName(14, "waiting on ci");
    github.seed({ number: 14, title: "waiting on ci", labels: ["afk", "mode:tdd", "awaiting-ci"] });
    const pr = github.openPullRequest(branch, prBody(14, branch));
    // CI still pending at restart: the rebuilt run stays parked, not re-driven.
    github.setReadChecks(pr.number, { state: "pending", failures: ["build"] });

    const { reconciler, worktrees } = wire({ github, store, withReview: true });
    await reconciler.rehydrate();
    await reconciler.awaitInFlight();

    // Reconstructed into the CI-poller queue; the orphan pass did NOT re-attach it.
    expect(store.getRunByIssue(14)!.status).toBe("awaiting-ci");
    expect(worktrees.attached.map((a) => a.branch)).not.toContain(branch);

    // A tick polls CI (still pending) and leaves it parked — no premature re-admit.
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(store.getRunByIssue(14)!.status).toBe("awaiting-ci");

    // CI goes green: the next tick re-admits it into review → awaiting-merge.
    github.setReadChecks(pr.number, { state: "green", failures: [] });
    github.setCiGreen(pr.number);
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(store.getRunByIssue(14)!.status).toBe("awaiting-merge");
    expect(worktrees.attached.map((a) => a.branch)).toContain(branch);
  });

  it("does not rebuild a run for a PR whose issue closed while the daemon was down", async () => {
    const branch = branchName(8, "merged already");
    const issue = github.seed({ number: 8, title: "merged already", labels: ["afk", "mode:tdd"] });
    issue.state = "CLOSED";
    github.openPullRequest(branch, prBody(8, branch));

    const { reconciler } = wire({ github, store, withReview: true });
    await reconciler.rehydrate();
    await reconciler.awaitInFlight();

    expect(store.getRunByIssue(8)).toBeUndefined();
  });

  it("rehydrates a review-maxed heal so it resumes into the review loop once answered (issue #9)", async () => {
    // Cold store: a `review-maxed` issue, a draft PR with the marker, and the
    // heal-card `ralph-question` carrying the hidden phase marker — the only place
    // the phase survives a cold store (the same marker a review-loop escalation uses).
    const branch = branchName(12, "Heal cold");
    github.seed({ number: 12, title: "Heal cold", labels: [LABEL_REVIEW_MAXED, "afk", "mode:tdd"] });
    const pr = github.openPullRequest(branch, prBody(12, branch));
    github.setCiGreen(pr.number);
    const healCard = buildHealCardQuestion({
      phase: 1,
      attempts: 2,
      worklist: { items: [{ severity: "P0", title: "race on retry" }] },
    });
    void github.postComment(12, `${formatRalphQuestion(healCard)}\n${buildPhaseMarker(1)}`);

    const { reconciler, worktrees, runner } = wire({ github, store, withReview: true });
    await reconciler.rehydrate();
    await reconciler.awaitInFlight();

    // The rebuilt resume context recovered the phase the heal-card was raised at, so
    // the dispatch re-enters the review loop there.
    expect(store.getResumeContext(store.getRunByIssue(12)!.id)!.context.phase).toBe(1);

    // Operator answers the heal-card via the GitHub-only CLI: review-maxed → ready.
    const answerService = new RalphAnswerService(github);
    await answerService.serveOne(async () => "1");
    expect(github.issues.get(12)!.labels).toContain(LABEL_READY);

    // Next tick: the run resumes into the REVIEW loop (not the impl agent), ending at
    // awaiting-merge; a further tick lets the merge worker land it.
    await reconciler.tick();
    await reconciler.awaitInFlight();
    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(runner.runs).toHaveLength(0); // the impl agent was never invoked — review re-entry only
    expect(worktrees.attached.map((a) => a.branch)).toContain(branch);
    expect(store.getRunByIssue(12)!.status).toBe("merged");
    expect(github.merges.map((m) => m.prNumber)).toContain(pr.number);
  });

  it("rehydrates a review-loop escalation so it resumes into the review loop, not the impl prompt (issue #9)", async () => {
    // Cold store: an `awaiting-answer` issue whose escalation came from the review
    // loop. Its `ralph-question` carries the hidden phase marker — the only place
    // the phase survives a cold store, the analogue of the heal-card's phase line.
    const branch = branchName(15, "Escalate cold");
    github.seed({ number: 15, title: "Escalate cold", labels: [LABEL_AWAITING_ANSWER, "afk", "mode:tdd"] });
    const pr = github.openPullRequest(branch, prBody(15, branch));
    github.setCiGreen(pr.number);
    // A review-loop escalation comment = the question plus the hidden phase marker.
    void github.postComment(15, `${formatRalphQuestion(question)}\n${buildPhaseMarker(1)}`);

    const { reconciler, worktrees, runner } = wire({ github, store, withReview: true });
    await reconciler.rehydrate();
    await reconciler.awaitInFlight();

    // The rebuilt resume context recovered the phase from the marker, so the
    // dispatch will re-enter the review loop (not the impl prompt).
    expect(store.getResumeContext(store.getRunByIssue(15)!.id)!.context.phase).toBe(1);

    // Operator answers via the GitHub-only CLI: awaiting-answer → ready.
    const answerService = new RalphAnswerService(github);
    await answerService.serveOne(async () => "1");
    expect(github.issues.get(15)!.labels).toContain(LABEL_READY);

    // Next tick: the run resumes into the REVIEW loop (not the impl agent) and the
    // merge worker lands it on the tick after.
    await reconciler.tick();
    await reconciler.awaitInFlight();
    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(runner.runs).toHaveLength(0); // the impl agent was never invoked — review re-entry only
    expect(worktrees.attached.map((a) => a.branch)).toContain(branch);
    expect(store.getRunByIssue(15)!.status).toBe("merged");
    expect(github.merges.map((m) => m.prNumber)).toContain(pr.number);
  });
});
