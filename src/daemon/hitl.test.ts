import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../log/logger";
import { MEMORY_DB, openStore, type Store } from "../store/store";
import { Executor } from "../executor/executor";
import type { AgentRunContext, AgentRunner, AgentRunResult } from "../executor/agent";
import { EscalationCheckpointer } from "../hitl/escalation-checkpoint";
import { RalphAnswerService } from "../hitl/ralph-answer";
import { LABEL_AWAITING_ANSWER, LABEL_READY, LABEL_REVIEW_MAXED } from "../hitl/labels";
import { scanPausedRuns } from "../hitl/resume";
import { LABEL_DAEMON_ANOMALY } from "./completeness";
import { FakeGitHub } from "../testing/fake-github";
import { FakeWorktreeManager } from "../testing/fake-worktree";
import { PrOpeningAgentRunner } from "../testing/fake-agent";
import { ScriptedFixAgent, ScriptedReviewAgent } from "../testing/fake-review-agents";
import { ReviewLoop, type MergeConfig } from "../review/review-loop";
import type { Worklist } from "../review/worklist";
import type { EscalationQuestion } from "../review/escalation";
import { Reconciler, type ReconcileBudget } from "./reconciler";

const silent = createLogger({ write: () => {} });

/** Single-repo view of the shared global build budget (ADR-0020). */
function budgetFor(getActive: () => number, cap: number): ReconcileBudget {
  return { available: () => Math.max(0, cap - getActive()), hasCapacity: () => getActive() < cap };
}

const question: EscalationQuestion = {
  headline: "Cannot honour the binding storage decision",
  feature: "Ledger persistence",
  whereWeStand: "The committed design says SQLite; the table needs JSONB.",
  decision: "Stay on the committed store or escalate for a schema change?",
  options: ["Keep SQLite, denormalise", "Escalate for Postgres"],
  stakes: "Switching stores is an architecture-level change.",
  recommendation: "Keep SQLite and denormalise this cycle.",
};

/** Escalates on the impl call; on the resume call records the injected context. */
class EscalateThenResumeRunner implements AgentRunner {
  readonly calls: AgentRunContext[] = [];

  async run(ctx: AgentRunContext): Promise<AgentRunResult> {
    this.calls.push(ctx);
    if (ctx.resume) {
      return { ok: true, escalated: false };
    }
    await ctx.onEscalate!(question);
    return { ok: true, escalated: true };
  }
}

describe("escalate → ralph-answer → resume (AC2, AC5)", () => {
  let store: Store;
  let github: FakeGitHub;
  let worktrees: FakeWorktreeManager;
  let runner: EscalateThenResumeRunner;
  let reconciler: Reconciler;

  beforeEach(() => {
    store = openStore(MEMORY_DB).forRepo("owner/repo");
    github = new FakeGitHub();
    worktrees = new FakeWorktreeManager();
    runner = new EscalateThenResumeRunner();
    const executor = new Executor({
      store,
      github,
      worktrees,
      agentRunner: runner,
      logger: silent,
      escalation: new EscalationCheckpointer({ store, github, worktrees }),
    });
    reconciler = new Reconciler({
      store,
      github,
      executor,
      worktrees,
      logger: silent,
      budget: budgetFor(() => reconciler.activeCount(), 2), cap: 2,
      priorityLabels: [],
      targetRepo: "owner/repo",
      reconcileIntervalSeconds: 30,
    });
  });
  afterEach(() => store.close());

  it("frees the slot on escalate (AC2), then resumes the same agent from its WIP branch with the answer injected (AC5)", async () => {
    github.seed({ number: 4, title: "HITL" });

    // Tick 1: the impl agent escalates; the slot frees when execute settles.
    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(reconciler.activeCount()).toBe(0); // AC2 — slot freed
    expect(store.getRunByIssue(4)!.status).toBe("awaiting-answer");

    // Tick 2 (effect): the `awaiting-answer` label is a level-triggered effect of the
    // awaiting-answer status (issue #82, ADR-0027) — the escalate set the status in its
    // session; the next tick's desired-vs-actual diff applies the label (the accepted
    // ≤1-tick latency) so ralph-answer can queue it.
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(github.issues.get(4)!.labels).toContain(LABEL_AWAITING_ANSWER);
    expect(github.issues.get(4)!.labels).not.toContain(LABEL_READY);
    const branch = store.getRunByIssue(4)!.branch!;
    // The worktree was created for the impl run and torn down on escalate.
    expect(worktrees.created.map((c) => c.branch)).toContain(branch);
    expect(worktrees.removed).toHaveLength(1);
    // A draft PR checkpointed the WIP.
    expect(github.draftPulls).toHaveLength(1);

    // Operator answers out of band via the GitHub-only CLI service.
    const answerService = new RalphAnswerService(github);
    await answerService.serveOne(async () => "1"); // pick "Keep SQLite, denormalise"
    expect(github.issues.get(4)!.labels).toContain(LABEL_READY);

    // Tick 2: the daemon resumes the SAME run from its WIP branch.
    await reconciler.tick();
    await reconciler.awaitInFlight();

    // Resumed by re-attaching the existing branch — not a fresh worktree.
    expect(worktrees.attached.map((a) => a.branch)).toEqual([branch]);
    expect(worktrees.created.filter((c) => c.branch === branch)).toHaveLength(1); // no second create

    // The resume call carried the operator's answer, injected into the session.
    const resumeCall = runner.calls.find((c) => c.resume);
    expect(resumeCall).toBeDefined();
    expect(resumeCall!.branch).toBe(branch);
    expect(resumeCall!.resume!.answer).toEqual({
      kind: "option",
      text: "Keep SQLite, denormalise",
      optionIndex: 0,
    });
    expect(resumeCall!.resume!.question.headline).toBe(question.headline);

    // The open question was marked answered; the run is back in flight (running).
    expect(store.listOpenQuestions()).toHaveLength(0);
    expect(store.getRunByIssue(4)!.status).toBe("running");
  });

  it("does not resume until the answer has actually landed", async () => {
    github.seed({ number: 4, title: "HITL" });
    await reconciler.tick();
    await reconciler.awaitInFlight();

    // Still awaiting — no answer yet. A tick must not resume it.
    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(worktrees.attached).toHaveLength(0);
    expect(runner.calls.filter((c) => c.resume)).toHaveLength(0);
    expect(store.getRunByIssue(4)!.status).toBe("awaiting-answer");
  });
});

const mergeConfig: MergeConfig = {
  method: "squash",
  waitForChecks: true,
  ciTimeoutMinutes: 30,
  pollIntervalSeconds: 30,
  deleteBranch: true,
};

const blocked: Worklist = { items: [{ severity: "P0", title: "correctness bug on the retry path" }] };
const clean: Worklist = { items: [{ severity: "nit", title: "tidy a local" }] };

/**
 * Issue #9: a `review-maxed` heal must re-enter the BUILD-flow review (`runReview`)
 * at the stored phase with the operator's guidance injected — NOT re-run the impl
 * prompt (which would discard the review tail) and NOT silently wedge (the heal-card
 * stores enough resume context that `findResumableRuns` returns the run once
 * answered). It hands back off to `awaiting-merge`; the integration flow lands it.
 */
describe("review-maxed heal → ralph-answer → resume re-enters the review loop (issue #9)", () => {
  let store: Store;
  let github: FakeGitHub;
  let worktrees: FakeWorktreeManager;
  let impl: PrOpeningAgentRunner;
  let reviewAgent: ScriptedReviewAgent;
  let fixAgent: ScriptedFixAgent;
  let reconciler: Reconciler;

  beforeEach(() => {
    store = openStore(MEMORY_DB).forRepo("owner/repo");
    github = new FakeGitHub();
    worktrees = new FakeWorktreeManager();
    impl = new PrOpeningAgentRunner(github);
    // Phase 1 blocks long enough to max out (3 reviews at maxFixAttempts=2), then
    // once more on resume (one guided fix), then clean so the heal lands a merge.
    reviewAgent = new ScriptedReviewAgent([blocked, blocked, blocked, blocked, clean, clean]);
    fixAgent = new ScriptedFixAgent();
    const reviewLoop = new ReviewLoop({
      store,
      github,
      reviewAgent,
      fixAgent,
      logger: silent,
      maxFixAttempts: 2,
      worktrees,
      baseBranch: "main",
      merge: mergeConfig,
    });
    const executor = new Executor({ store, github, worktrees, agentRunner: impl, logger: silent, reviewLoop });
    reconciler = new Reconciler({
      store,
      github,
      executor,
      worktrees,
      logger: silent,
      budget: budgetFor(() => reconciler.activeCount(), 2), cap: 2,
      priorityLabels: [],
    });
  });
  afterEach(() => store.close());

  it("resumes the review loop (correct phase + guidance) ending at awaiting-merge, not the impl prompt, then lands the merge", async () => {
    github.seed({ number: 11, title: "Heal me" });

    // Tick 1: impl opens the PR; the review loop parks the pre-review CI wait
    // off-slot (ADR-0022 stage 1) before any review runs.
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(store.getRunByIssue(11)!.status).toBe("awaiting-ci");

    // Tick 2: the CI poller reads CI (none → terminal) and re-admits into review,
    // which maxes out phase 1 → review-maxed + heal-card.
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(store.getRunByIssue(11)!.status).toBe("review-maxed");

    // Tick 3 (effect): the `review-maxed` label is a level-triggered effect of the
    // review-maxed status (issue #82, ADR-0027) — the maxout set the status in its
    // session; the next tick's desired-vs-actual diff applies the label (the accepted
    // ≤1-tick latency) so ralph-answer can queue it.
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(github.issues.get(11)!.labels).toContain(LABEL_REVIEW_MAXED);
    expect(store.listOpenQuestions().some((q) => q.kind === "heal-card")).toBe(true);
    const implRunsAfterMaxout = impl.runs.length; // exactly one impl pass
    const reviewCallsAfterMaxout = reviewAgent.calls.length; // phase-1 maxout reviews

    // The heal-card carries the maxed-out phase so the resume re-enters review there.
    expect(store.getResumeContext(store.getRunByIssue(11)!.id)!.context.phase).toBe(1);

    // Operator answers the heal-card via the GitHub-only CLI: review-maxed → ready.
    const answerService = new RalphAnswerService(github);
    await answerService.serveOne(async () => "1"); // "Provide guidance and re-enable the run (heal)"
    expect(github.issues.get(11)!.labels).toContain(LABEL_READY);

    // Tick 3: the run is NOT wedged — it resumes into the review loop and ends at
    // awaiting-merge. A heal carries operator guidance, so it runs the gate inline
    // (no second CI park) and goes straight through review.
    await reconciler.tick();
    await reconciler.awaitInFlight();

    // The impl agent was NOT re-run: a heal is a review re-entry, not a fresh impl pass.
    expect(impl.runs.length).toBe(implRunsAfterMaxout);
    // The review loop re-ran (more review passes happened on resume).
    expect(reviewAgent.calls.length).toBeGreaterThan(reviewCallsAfterMaxout);
    // Re-attached the WIP branch — resume, not restart (no second worktree create).
    expect(worktrees.attached.map((a) => a.branch)).toContain("ralph/11-heal-me");
    expect(worktrees.created.filter((c) => c.branch === "ralph/11-heal-me")).toHaveLength(1);
    // The fix agent during the RESUMED phase 1 received the operator's guidance.
    const guidedFix = fixAgent.calls.find((c) => c.guidance);
    expect(guidedFix).toBeDefined();
    expect(guidedFix!.phase).toBe(1);
    expect(guidedFix!.guidance).toContain("Provide guidance and re-enable the run");
    // The build flow handed off — awaiting-merge, NOT merged in one shot (ADR-0017).
    // The merge worker leases by status (not the label), and the `awaiting-merge` label
    // is a level-triggered reconciler effect of that status (issue #82, ADR-0027) applied
    // by the per-tick diff (exercised by the #82 reconciler tests).
    expect(store.getRunByIssue(11)!.status).toBe("awaiting-merge");
    expect(github.merges).toHaveLength(0);
    // The open heal-card question was marked answered (not left wedged).
    expect(store.listOpenQuestions()).toHaveLength(0);

    // Tick 4: the single-concurrency merge worker integrates the awaiting-merge run.
    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(github.merges.length).toBeGreaterThan(0);
    expect(store.getRunByIssue(11)!.status).toBe("merged");
  });
});

/**
 * Issue #9 (operator ruling): a review-loop **escalation** (the fix agent refused
 * to apply a risky finding blind) is, like a `review-maxed` maxout, a review-origin
 * pause. Once answered it must re-enter the review loop at the escalation's phase
 * with the operator's ruling injected as fix guidance — NOT re-run the impl prompt
 * (which would discard the reviewed PR and re-implement from scratch). The escalate
 * resume context carries the phase so the dispatch can tell it apart from an
 * impl-agent escalation (which has no phase and does resume the impl session).
 */
describe("review-loop escalation → ralph-answer → resume re-enters the review loop (issue #9)", () => {
  const fixEscalation: EscalationQuestion = {
    headline: "Risky structural change flagged in review",
    feature: "Phase-1 normal review",
    whereWeStand: "Review wants the legacy adapter deleted; that is a one-way door across three call sites.",
    decision: "Delete the legacy adapter now or keep it behind a flag?",
    options: ["Delete it now", "Keep it behind a flag this cycle"],
    stakes: "Deleting it is irreversible for any consumer still on the old path.",
    recommendation: "Keep it behind a flag this cycle.",
  };

  let store: Store;
  let github: FakeGitHub;
  let worktrees: FakeWorktreeManager;
  let impl: PrOpeningAgentRunner;
  let reviewAgent: ScriptedReviewAgent;
  let fixAgent: ScriptedFixAgent;
  let reconciler: Reconciler;

  beforeEach(() => {
    store = openStore(MEMORY_DB).forRepo("owner/repo");
    github = new FakeGitHub();
    worktrees = new FakeWorktreeManager();
    impl = new PrOpeningAgentRunner(github);
    // Phase 1 blocks → a fix attempt → the fix agent escalates. On resume the
    // re-entered phase 1 blocks once more (one guided fix) then goes clean.
    reviewAgent = new ScriptedReviewAgent([blocked, blocked, clean, clean]);
    // First fix attempt escalates; every later attempt resolves the worklist.
    fixAgent = new ScriptedFixAgent([{ kind: "escalate", question: fixEscalation }]);
    const reviewLoop = new ReviewLoop({
      store,
      github,
      reviewAgent,
      fixAgent,
      logger: silent,
      maxFixAttempts: 3,
      worktrees,
      baseBranch: "main",
      merge: mergeConfig,
    });
    const executor = new Executor({
      store,
      github,
      worktrees,
      agentRunner: impl,
      logger: silent,
      reviewLoop,
      escalation: new EscalationCheckpointer({ store, github, worktrees }),
    });
    reconciler = new Reconciler({
      store,
      github,
      executor,
      worktrees,
      logger: silent,
      budget: budgetFor(() => reconciler.activeCount(), 2), cap: 2,
      priorityLabels: [],
    });
  });
  afterEach(() => store.close());

  it("stores the phase on the escalate context and resumes the review loop, not the impl prompt", async () => {
    github.seed({ number: 13, title: "Escalate me" });

    // Tick 1: impl opens the PR; the review loop parks the pre-review CI wait off-slot.
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(store.getRunByIssue(13)!.status).toBe("awaiting-ci");

    // Tick 2: the CI poller re-admits into review; phase 1 review blocks → fix agent escalates.
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(store.getRunByIssue(13)!.status).toBe("awaiting-answer");

    // Tick 3 (effect): the `awaiting-answer` label is a level-triggered effect of the
    // status (issue #82, ADR-0027) — the escalate set the status; the next tick's diff
    // applies the label (the accepted ≤1-tick latency) so ralph-answer can queue it.
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(github.issues.get(13)!.labels).toContain(LABEL_AWAITING_ANSWER);
    const q = store.listOpenQuestions().find((x) => x.issueNumber === 13);
    expect(q?.kind).toBe("escalate");
    const implRunsAfterEscalate = impl.runs.length; // exactly one impl pass

    // The escalate resume context carries the review phase — the discriminant the
    // dispatch uses to re-enter the review loop instead of the impl prompt.
    expect(store.getResumeContext(store.getRunByIssue(13)!.id)!.context.phase).toBe(1);

    // Operator answers the escalation via the GitHub-only CLI: awaiting → ready.
    const answerService = new RalphAnswerService(github);
    await answerService.serveOne(async () => "2"); // "Keep it behind a flag this cycle"
    expect(github.issues.get(13)!.labels).toContain(LABEL_READY);

    // Tick 3: the run resumes into the REVIEW loop (not a fresh impl pass).
    await reconciler.tick();
    await reconciler.awaitInFlight();

    // The impl agent was NOT re-run: a review-origin heal is a review re-entry.
    expect(impl.runs.length).toBe(implRunsAfterEscalate);
    // Re-attached the WIP branch — resume, not restart (no second worktree create).
    expect(worktrees.attached.map((a) => a.branch)).toContain("ralph/13-escalate-me");
    expect(worktrees.created.filter((c) => c.branch === "ralph/13-escalate-me")).toHaveLength(1);
    // The fix agent on the RESUMED phase 1 received the operator's ruling as guidance.
    const guidedFix = fixAgent.calls.find((c) => c.guidance);
    expect(guidedFix).toBeDefined();
    expect(guidedFix!.phase).toBe(1);
    expect(guidedFix!.guidance).toContain("Keep it behind a flag this cycle");
    // Build flow handed off to awaiting-merge; the question was answered (not wedged).
    expect(store.getRunByIssue(13)!.status).toBe("awaiting-merge");
    expect(store.listOpenQuestions()).toHaveLength(0);

    // Tick 4: the merge worker integrates → merged.
    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(github.merges.length).toBeGreaterThan(0);
    expect(store.getRunByIssue(13)!.status).toBe("merged");
  });
});

/**
 * Issue #132: a GitHub rate-limit incident during resume must not strand an *answered*
 * escalation at `awaiting-answer` forever. The defer-not-stuck path (#102) re-parks the
 * run and tries to re-arm `ready-for-agent`; if that re-arm is itself rate-limited the
 * run is left answered-but-not-re-armed — invisible to `ralph-answer` (already-answered)
 * and to resume (no `ready-for-agent`). The reconciler must surface it as a
 * `daemon-anomaly` AND idempotently re-arm it until the re-arm lands, so it ends up
 * resumable, never wedged. This reproduces the #2112/#2113 sequence.
 */
describe("rate-limited resume re-arm no longer wedges an answered escalation (#132)", () => {
  /** Escalates on impl; the FIRST resume hits a GitHub rate limit, later resumes succeed. */
  class EscalateThenRateLimitedResumeRunner implements AgentRunner {
    readonly calls: AgentRunContext[] = [];
    private resumes = 0;

    async run(ctx: AgentRunContext): Promise<AgentRunResult> {
      this.calls.push(ctx);
      if (ctx.resume) {
        this.resumes += 1;
        if (this.resumes === 1) {
          // The sustained GitHub rate limit the daemon hit mid-resume (~13:31–13:55).
          throw new Error("graphql: API rate limit already exceeded");
        }
        return { ok: true, escalated: false };
      }
      await ctx.onEscalate!(question);
      return { ok: true, escalated: true };
    }
  }

  /** FakeGitHub whose `ready-for-agent` re-arm fails while `failReArm` is set. */
  class ReArmRateLimitedGitHub extends FakeGitHub {
    failReArm = false;
    override async addLabel(issueNumber: number, label: string): Promise<void> {
      if (label === LABEL_READY && this.failReArm) {
        throw new Error("gh issue edit: API rate limit already exceeded");
      }
      return super.addLabel(issueNumber, label);
    }
  }

  let store: Store;
  let github: ReArmRateLimitedGitHub;
  let worktrees: FakeWorktreeManager;
  let runner: EscalateThenRateLimitedResumeRunner;
  let reconciler: Reconciler;

  beforeEach(() => {
    store = openStore(MEMORY_DB).forRepo("owner/repo");
    github = new ReArmRateLimitedGitHub();
    worktrees = new FakeWorktreeManager();
    runner = new EscalateThenRateLimitedResumeRunner();
    const executor = new Executor({
      store,
      github,
      worktrees,
      agentRunner: runner,
      logger: silent,
      escalation: new EscalationCheckpointer({ store, github, worktrees }),
    });
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
      reconcileIntervalSeconds: 30,
    });
  });
  afterEach(() => store.close());

  it("surfaces the stranded answer as a daemon-anomaly and re-arms it until resumable (AC1, AC2, AC3)", async () => {
    github.seed({ number: 2112, title: "HITL" });

    // Tick 1: the impl agent escalates → awaiting-answer. Tick 2: the effect labels it.
    await reconciler.tick();
    await reconciler.awaitInFlight();
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(store.getRunByIssue(2112)!.status).toBe("awaiting-answer");
    expect(github.issues.get(2112)!.labels).toContain(LABEL_AWAITING_ANSWER);

    // The operator answers out of band: awaiting-answer → ready-for-agent + a ralph-answer.
    await new RalphAnswerService(github).serveOne(async () => "1");
    expect(github.issues.get(2112)!.labels).toContain(LABEL_READY);

    // Tick 3: the daemon resumes, but the resume session hits the rate limit AND the
    // deferred re-arm (addLabel ready-for-agent) is itself rate-limited (#2112/#2113).
    github.failReArm = true;
    await reconciler.tick();
    await reconciler.awaitInFlight();

    // The wedge the incident produced: the run is back paused with the answer in the
    // ledger, but `ready-for-agent` never re-landed — so resume's normal path skips it.
    expect(store.getRunByIssue(2112)!.status).toBe("awaiting-answer");
    expect(github.issues.get(2112)!.labels).not.toContain(LABEL_READY);
    const wedged = await scanPausedRuns(github, store);
    expect(wedged.resumable).toEqual([]); // not resumable — the wedge
    expect(wedged.strandedAnswered.map((s) => s.issue.number)).toEqual([2112]); // but detected

    // Tick 4: the completeness pass surfaces it as a daemon-anomaly (AC2) and re-arms it.
    // The rate limit persists, so the re-arm is retried, not lost.
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(github.issues.get(2112)!.labels).toContain(LABEL_DAEMON_ANOMALY);
    expect(github.issues.get(2112)!.labels).not.toContain(LABEL_READY); // re-arm still rate-limited

    // The rate limit clears.
    github.failReArm = false;

    // Tick 5: the retried re-arm lands — the issue is resumable again, not wedged (AC1, AC3).
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(github.issues.get(2112)!.labels).toContain(LABEL_READY);
    const healed = await scanPausedRuns(github, store);
    expect(healed.resumable.map((r) => r.issue.number)).toContain(2112);

    // Tick 6: it actually resumes (resume, not restart) and leaves the pause; the anomaly
    // self-clears now the issue is being worked again.
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(runner.calls.filter((c) => c.resume).length).toBeGreaterThanOrEqual(2);
    expect(store.getRunByIssue(2112)!.status).not.toBe("awaiting-answer");
    expect(github.issues.get(2112)!.labels).not.toContain(LABEL_DAEMON_ANOMALY);
  });
});
