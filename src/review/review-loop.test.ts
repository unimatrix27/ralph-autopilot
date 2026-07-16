import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../log/logger";
import { MEMORY_DB, openStore, type Store } from "../store/store";
import { FakeGitHub } from "../testing/fake-github";
import { FakeWorktreeManager } from "../testing/fake-worktree";
import { ScriptedFixAgent, ScriptedReviewAgent } from "../testing/fake-review-agents";
import { WallClockExceededError } from "../executor/wall-clock";
import {
  AgentOutputParseError,
  RunnerInfraError,
  type FixAgentRunner,
  type FixContext,
  type FixOutcome,
  type ReviewAgentRunner,
  type ReviewContext,
} from "./agents";
import { LABEL_AWAITING_ANSWER, LABEL_REVIEW_MAXED } from "../hitl/labels";
import { parseEscalationQuestion, RALPH_QUESTION_FENCE } from "./escalation";
import { formatReviewComment, parseReviewComment } from "./review-comment";
import { type MergeConfig, ReviewLoop, type ReviewLoopContext } from "./review-loop";
import { gatingItems, type Worklist } from "./worklist";

const BASE = "main";
const mergeConfig: MergeConfig = {
  method: "squash",
  waitForChecks: true,
  ciTimeoutMinutes: 30,
  pollIntervalSeconds: 30,
  deleteBranch: true,
};

const silent = createLogger({ write: () => {} });
const BRANCH = "ralph/3-review-loop";

const clean: Worklist = { items: [{ severity: "nit", title: "rename a local" }] };
const blocked: Worklist = { items: [{ severity: "P0", title: "race on retry" }] };

// The same finding raised by the review agent and an ingested bot comment, with
// different casing/whitespace and a weaker disposition on the bot copy. A
// compliant pipeline collapses these to a single, most-severe item.
const duplicated: Worklist = {
  items: [
    { severity: "P1", title: "Race  on retry", source: "pr-comment" },
    { severity: "P0", title: "race on retry", source: "review" },
  ],
};

const escalation = {
  headline: "Delete the legacy adapter?",
  feature: "Ingestion",
  whereWeStand: "Review wants the adapter gone; that is a structural one-way door.",
  decision: "Remove it or keep it behind a flag?",
  stakes: "Removing it could break any consumer still on the old path.",
  recommendation: "Keep behind a flag.",
};

describe("ReviewLoop", () => {
  let store: Store;
  let github: FakeGitHub;
  let worktrees: FakeWorktreeManager;

  beforeEach(() => {
    store = openStore(MEMORY_DB).forRepo("acme/widgets");
    github = new FakeGitHub();
    worktrees = new FakeWorktreeManager();
  });
  afterEach(() => store.close());

  /** Seed an issue, its PR, a run + agent, and return a loop context. */
  function setup(): ReviewLoopContext {
    const issue = github.seed({ number: 3, title: "Review loop" });
    const pr = github.openPullRequest(BRANCH, `Closes #3\n`);
    const run = store.upsertRun({
      issueNumber: 3,
      mode: "tdd",
      status: "running",
      branch: BRANCH,
      worktreePath: "/wt/3",
      prNumber: pr.number,
    });
    const agent = store.addAgent({ runId: run.id, worktreePath: "/wt/3", branch: BRANCH });
    return {
      issue,
      mode: "tdd",
      runId: run.id,
      agentId: agent.id,
      prNumber: pr.number,
      branch: BRANCH,
      worktreePath: "/wt/3",
      logger: silent,
    };
  }

  function wire(opts: {
    review: Worklist[];
    fix?: FixOutcome[];
    maxFixAttempts?: number;
    maxContainerRetries?: number;
    merge?: Partial<MergeConfig>;
  }): { loop: ReviewLoop; reviewAgent: ScriptedReviewAgent; fixAgent: ScriptedFixAgent } {
    const reviewAgent = new ScriptedReviewAgent(opts.review);
    const fixAgent = new ScriptedFixAgent(opts.fix ?? []);
    const loop = new ReviewLoop({
      store,
      github,
      reviewAgent,
      fixAgent,
      logger: silent,
      maxFixAttempts: opts.maxFixAttempts ?? 3,
      maxContainerRetries: opts.maxContainerRetries ?? 2,
      worktrees,
      baseBranch: BASE,
      merge: { ...mergeConfig, ...opts.merge },
    });
    return { loop, reviewAgent, fixAgent };
  }

  /** Build a loop with explicit review/fix runners (e.g. ones that throw). */
  function wireRunners(
    reviewAgent: ReviewAgentRunner,
    fixAgent: FixAgentRunner,
    opts: { maxFixAttempts?: number; maxContainerRetries?: number } = {},
  ): ReviewLoop {
    return new ReviewLoop({
      store,
      github,
      reviewAgent,
      fixAgent,
      logger: silent,
      maxFixAttempts: opts.maxFixAttempts ?? 3,
      maxContainerRetries: opts.maxContainerRetries ?? 2,
      worktrees,
      baseBranch: BASE,
      merge: mergeConfig,
    });
  }

  it("ingests automated PR comments into the review pass (nits don't gate)", async () => {
    const ctx = setup();
    github.seedPullRequestComment(ctx.prNumber, {
      author: "chatgpt-codex-connector",
      body: "Consider tightening the retry backoff.",
    });
    // Phase 1 and phase 2 both clean → merges; one review per phase.
    const { loop, reviewAgent } = wire({ review: [clean] });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "merged" });
    // The review agent was handed the ingested bot comment.
    expect(reviewAgent.calls[0]!.prComments).toHaveLength(1);
    expect(reviewAgent.calls[0]!.prComments[0]!.author).toBe("chatgpt-codex-connector");
  });

  it("applies dedupeWorklist before gating: a two-source duplicate collapses to one", async () => {
    const ctx = setup();
    // Phase 1 review returns a duplicated finding; fix lands it clean; phase 2 clean.
    const { loop, fixAgent } = wire({
      review: [duplicated, clean, clean],
      fix: [{ kind: "fixed" }],
    });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "merged" });
    // The fix agent was handed the deterministically consolidated worklist: the
    // review + bot-comment copies of the same finding collapsed to one item,
    // ranked at the most severe disposition (P0), not double-counted.
    const phase1Fix = fixAgent.calls.find((c) => c.phase === 1)!;
    expect(phase1Fix.worklist.items).toHaveLength(1);
    expect(phase1Fix.worklist.items[0]!.severity).toBe("P0");
  });

  it("fix agent resolves blockers across attempts, then the phase passes", async () => {
    const ctx = setup();
    // Blocked twice, then a fix lands it clean for phase 1, then phase 2 clean.
    const { loop, fixAgent } = wire({
      review: [blocked, blocked, clean, clean],
    });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "merged" });
    // Two phase-1 fix attempts before it went clean.
    expect(fixAgent.calls.filter((c) => c.phase === 1)).toHaveLength(2);
  });

  it("surfaces a wall-clock-killed review session as review-maxed (issue #13)", async () => {
    const ctx = setup();
    // The review SDK session hung and was hard-killed at the ceiling.
    const reviewAgent: ReviewAgentRunner = {
      review: async (_c: ReviewContext) => {
        throw new WallClockExceededError(3600);
      },
    };
    const fixAgent: FixAgentRunner = {
      fix: async (_c: FixContext) => ({ kind: "fixed" }),
    };
    const loop = wireRunners(reviewAgent, fixAgent);

    const outcome = await loop.run(ctx);

    // A hung review never merges — it maxes out (heal-card), slot freed.
    expect(outcome).toEqual({ kind: "review-maxed", phase: 1 });
    expect(store.getRunByIssue(3)!.status).toBe("review-maxed");
    expect(github.merges).toHaveLength(0);
    // A heal-card was posted so a human can look at why the session stalled.
    expect(store.listOpenQuestions().some((q) => q.kind === "heal-card")).toBe(true);
  });

  it("surfaces unparseable agent output as review-maxed, not a fatal crash (#15)", async () => {
    const ctx = setup();
    // The review agent's output would not parse even after the runner's re-prompts
    // (a backtick-heavy task leaking invalid JSON). The runner gives up with a typed
    // error; the loop must max out gracefully, NOT let it crash the run.
    const reviewAgent: ReviewAgentRunner = {
      review: async (_c: ReviewContext) => {
        throw new AgentOutputParseError(3, "Unexpected token '`'", '{ "items": [ { "title": `x` } ] }');
      },
    };
    const fixAgent: FixAgentRunner = {
      fix: async (_c: FixContext) => ({ kind: "fixed" }),
    };
    const loop = wireRunners(reviewAgent, fixAgent);

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "review-maxed", phase: 1 });
    expect(store.getRunByIssue(3)!.status).toBe("review-maxed");
    expect(github.merges).toHaveLength(0);
    // The PR was NOT closed and a heal-card was posted — the run is recoverable.
    expect(store.listOpenQuestions().some((q) => q.kind === "heal-card")).toBe(true);
  });

  it("retries a transient container no-result (infra fault) and passes with no human (issue #220)", async () => {
    const ctx = setup();
    // The review container produces NO result frame on its first dispatch (a dropped pipe / killed
    // container), then a re-dispatch succeeds. This must self-heal, NOT max out on the first try.
    let reviewCalls = 0;
    const reviewAgent: ReviewAgentRunner = {
      review: async (_c: ReviewContext) => {
        reviewCalls++;
        if (reviewCalls === 1) {
          throw new RunnerInfraError("review", "docker exited (code=125 signal=null); stderr tail: no such image");
        }
        return clean; // both phases clean → merge
      },
    };
    const fixAgent: FixAgentRunner = { fix: async (_c: FixContext) => ({ kind: "fixed" }) };
    const loop = wireRunners(reviewAgent, fixAgent, { maxContainerRetries: 2 });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "merged" });
    // No fix attempt was consumed (the failure was infra, not a finding), and no heal-card surfaced.
    expect(store.getFixAttempts(ctx.runId, 1)).toBe(0);
    expect(store.listOpenQuestions()).toHaveLength(0);
  });

  it("retries a fix-side container no-result and self-heals when the re-review is clean (ADR-0016)", async () => {
    const ctx = setup();
    // Phase 1 finds a blocker → a fix runs in a container that drops its pipe (no result). The fix
    // may already have pushed runner-direct, so the bounded retry re-reviews and finds it clean.
    // With maxFixAttempts:1 this also proves the infra retry is NOT charged to the fix budget.
    let reviewCalls = 0;
    const reviewAgent: ReviewAgentRunner = {
      review: async (_c: ReviewContext) => {
        reviewCalls++;
        return reviewCalls === 1 ? blocked : clean;
      },
    };
    let fixCalls = 0;
    const fixAgent: FixAgentRunner = {
      fix: async (_c: FixContext) => {
        fixCalls++;
        throw new RunnerInfraError("fix", "runner exited without a result frame");
      },
    };
    const loop = wireRunners(reviewAgent, fixAgent, { maxFixAttempts: 1, maxContainerRetries: 2 });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "merged" });
    expect(fixCalls).toBe(1); // the fix ran once, its no-result was retried as infra, the re-review was clean
    expect(store.listOpenQuestions()).toHaveLength(0);
  });

  it("a PERSISTENT container infra fault maxes out with the honest infra heal-card, not the JSON one (issue #220)", async () => {
    const ctx = setup();
    const reviewAgent: ReviewAgentRunner = {
      review: async (_c: ReviewContext) => {
        throw new RunnerInfraError("review", "docker exited (code=137 signal=SIGKILL); stderr tail: OOM");
      },
    };
    const fixAgent: FixAgentRunner = { fix: async (_c: FixContext) => ({ kind: "fixed" }) };
    const loop = wireRunners(reviewAgent, fixAgent, { maxContainerRetries: 2 });

    const outcome = await loop.run(ctx);

    // Still review-maxed (status unchanged → resume-from-WIP preserves the PR), but via the infra path.
    expect(outcome).toEqual({ kind: "review-maxed", phase: 1 });
    expect(store.getRunByIssue(3)!.status).toBe("review-maxed");
    expect(github.merges).toHaveLength(0);
    const body = (github.comments.get(3) ?? []).map((c) => c.body).join("\n");
    // Honest: names the infra fault + carries the real docker detail.
    expect(body).toContain("container infrastructure fault");
    expect(body).toContain("docker exited (code=137");
    // NOT the misleading "fix your JSON" card.
    expect(body).not.toContain("parseable JSON");
  });

  it("maxContainerRetries:0 terminalizes on the first container no-result", async () => {
    const ctx = setup();
    let reviewCalls = 0;
    const reviewAgent: ReviewAgentRunner = {
      review: async (_c: ReviewContext) => {
        reviewCalls++;
        throw new RunnerInfraError("review", "boom");
      },
    };
    const fixAgent: FixAgentRunner = { fix: async (_c: FixContext) => ({ kind: "fixed" }) };
    const loop = wireRunners(reviewAgent, fixAgent, { maxContainerRetries: 0 });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "review-maxed", phase: 1 });
    expect(reviewCalls).toBe(1); // no retry
  });

  it("surfaces a wall-clock-killed fix session as review-maxed (issue #13)", async () => {
    const ctx = setup();
    // Review finds a blocker; the fix SDK session then hangs and is hard-killed.
    const reviewAgent: ReviewAgentRunner = {
      review: async (_c: ReviewContext) => blocked,
    };
    const fixAgent: FixAgentRunner = {
      fix: async (_c: FixContext) => {
        throw new WallClockExceededError(3600);
      },
    };
    const loop = wireRunners(reviewAgent, fixAgent);

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "review-maxed", phase: 1 });
    expect(store.getRunByIssue(3)!.status).toBe("review-maxed");
    expect(github.merges).toHaveLength(0);
  });

  it("caps at 3 fix attempts per phase, then review-maxes", async () => {
    const ctx = setup();
    const { loop, fixAgent } = wire({ review: [blocked], maxFixAttempts: 3 });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "review-maxed", phase: 1 });
    expect(fixAgent.calls).toHaveLength(3); // never a 4th attempt
    expect(store.getFixAttempts(ctx.runId, 1)).toBe(3);
  });

  it("phase-1 maxout sets review-maxed + a heal-card and never enters phase 2", async () => {
    const ctx = setup();
    const { loop, reviewAgent } = wire({ review: [blocked], maxFixAttempts: 3 });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "review-maxed", phase: 1 });
    // The run status the reconciler's per-tick diff projects the `review-maxed` label
    // from (issue #82, ADR-0027) — the loop sets no label imperatively.
    expect(store.getRunByIssue(3)!.status).toBe("review-maxed");
    expect(github.addedLabels.some((l) => l.label === LABEL_REVIEW_MAXED)).toBe(false);
    // Heal-card recorded as an open question.
    const questions = store.listOpenQuestions();
    expect(questions).toHaveLength(1);
    expect(questions[0]!.kind).toBe("heal-card");
    // A ralph-question comment was posted.
    const comments = github.comments.get(3) ?? [];
    expect(comments.some((c) => c.body.includes("```" + RALPH_QUESTION_FENCE))).toBe(true);
    // Phase 2 was never reviewed.
    expect(reviewAgent.calls.every((c) => c.phase === 1)).toBe(true);
    // And no merge.
    expect(github.merges).toHaveLength(0);
  });

  it("runs phase 2 only after phase 1 is clean, with behaviour-preserving fixes", async () => {
    const ctx = setup();
    // Phase 1 clean immediately; phase 2 blocked once then clean.
    const { loop, reviewAgent, fixAgent } = wire({
      review: [clean, blocked, clean],
    });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "merged" });
    const phases = reviewAgent.calls.map((c) => c.phase);
    // Phase 1 first, phase 2 only afterwards.
    expect(phases).toEqual([1, 2, 2]);
    const phase2Fixes = fixAgent.calls.filter((c) => c.phase === 2);
    expect(phase2Fixes).toHaveLength(1);
    expect(phase2Fixes[0]!.behaviourPreserving).toBe(true);
    // Phase-1 fixes (none here) would never be behaviour-preserving.
    expect(fixAgent.calls.filter((c) => c.phase === 1 && c.behaviourPreserving)).toHaveLength(0);
  });

  it("both phases clean → harness merges directly (squash, delete-branch) and closes the issue", async () => {
    const ctx = setup();
    // No checks on this PR (the dogfood repo): Phase 0 and the merge-time CI wait
    // are no-ops, so the harness merges immediately once both phases are clean.
    const { loop } = wire({ review: [clean] });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "merged" });
    expect(github.merges).toEqual([
      { prNumber: ctx.prNumber, method: "squash", deleteBranch: true },
    ]);
    // The merge is a deterministic harness action — the PR is merged now, not on
    // some later GitHub event. The issue auto-closes via `Closes #n`.
    expect((await github.findPullRequestForBranch(BRANCH))!.state).toBe("MERGED");
    expect(github.issues.get(3)!.state).toBe("CLOSED");
    expect(store.getRunByIssue(3)!.status).toBe("merged");
    // The merge closed the run span (issue #80) — RunEnded{merged}, the canonical
    // successful terminal, asserted through the real merge path's read-model.
    expect((await store.aggregateIssue(3)).state.ended).toBe(true);
  });

  it("brings the branch current with base before merging (rebase-aware)", async () => {
    const ctx = setup();
    const { loop } = wire({ review: [clean] });

    await loop.run(ctx);

    // The branch is rebased onto base twice — once before review (so review never
    // runs on a non-mergeable branch) and once before the merge (catching base
    // moving while review ran).
    expect(worktrees.rebased).toEqual([
      { worktreePath: ctx.worktreePath, branch: BRANCH, baseBranch: BASE },
      { worktreePath: ctx.worktreePath, branch: BRANCH, baseBranch: BASE },
    ]);
    expect(github.merges).toHaveLength(1);
  });

  it("a fix agent can escalate instead of applying a risky structural change", async () => {
    const ctx = setup();
    const { loop, reviewAgent } = wire({
      review: [blocked],
      fix: [{ kind: "escalate", question: escalation }],
    });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "escalated", phase: 1 });
    // Status swaps to awaiting-answer (the reconciler diff projects its label, #82),
    // not review-maxed; the loop sets neither label imperatively.
    expect(store.getRunByIssue(3)!.status).toBe("awaiting-answer");
    expect(github.addedLabels.some((l) => l.label === LABEL_AWAITING_ANSWER)).toBe(false);
    expect(github.addedLabels.some((l) => l.label === LABEL_REVIEW_MAXED)).toBe(false);
    // A parseable ralph-question was posted and indexed.
    const questions = store.listOpenQuestions();
    expect(questions[0]!.kind).toBe("escalate");
    const comment = (github.comments.get(3) ?? [])[0]!;
    const fence = comment.body.split("```" + RALPH_QUESTION_FENCE)[1]!.split("```")[0]!;
    expect(parseEscalationQuestion(JSON.parse(fence)).headline).toBe(escalation.headline);
    // It checkpointed for resume-not-restart, carrying the review phase so the resume
    // re-enters the review loop there (not the impl prompt) — issue #9.
    expect(store.getResumeContext(ctx.runId)!.context.phase).toBe(1);
    // Stopped before phase 2 and never merged.
    expect(reviewAgent.calls.every((c) => c.phase === 1)).toBe(true);
    expect(github.merges).toHaveLength(0);
  });

  it("threads mode:infra to the review and fix agents (AC4 — no test gate)", async () => {
    const ctx = { ...setup(), mode: "infra" as const };
    const { loop, reviewAgent, fixAgent } = wire({
      review: [blocked, clean, clean],
      fix: [{ kind: "fixed" }],
    });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "merged" });
    expect(reviewAgent.calls.every((c) => c.mode === "infra")).toBe(true);
    expect(fixAgent.calls.every((c) => c.mode === "infra")).toBe(true);
  });

  it("reports live phase transitions on the agent record", async () => {
    const ctx = setup();
    const { loop } = wire({ review: [blocked, clean, clean], fix: [{ kind: "fixed" }] });

    await loop.run(ctx);

    // The merge phase is the last recorded after both review phases pass.
    expect(store.getAgent(ctx.agentId!)!.phase).toBe("merge");
  });

  // ---- ralph-review comment: review→fix handoff on the PR (issue #47) ------

  /** The parsed ralph-review comments posted to the PR for a given phase. */
  function reviewComments(prNumber: number, phase: 1 | 2) {
    return (github.comments.get(prNumber) ?? [])
      .map((c) => ({ id: c.id, data: parseReviewComment(c.body) }))
      .filter((c) => c.data?.phase === phase);
  }

  it("posts the deduped worklist as a structured ralph-review comment on the PR", async () => {
    const ctx = setup();
    // Phase 1 keeps surfacing a two-source duplicate that never clears → maxout, so
    // the rolling comment's final state still carries the collapsed finding.
    const { loop } = wire({ review: [duplicated], maxFixAttempts: 3 });

    const outcome = await loop.run(ctx);
    expect(outcome).toEqual({ kind: "review-maxed", phase: 1 });

    // A phase-1 ralph-review comment was posted to the PR (not the issue), carrying
    // the deterministically deduped worklist — the review + bot-comment copies of
    // the same finding collapsed to one most-severe (P0) item, machine-parseable
    // from the fenced payload.
    const phase1 = reviewComments(ctx.prNumber, 1);
    expect(phase1).toHaveLength(1);
    const data = phase1[0]!.data!;
    expect(data.worklist.items).toHaveLength(1);
    expect(data.worklist.items[0]!.severity).toBe("P0");
    // It is on the PR, not the issue thread.
    expect((github.comments.get(3) ?? []).some((c) => parseReviewComment(c.body))).toBe(false);
  });

  it("keeps ONE rolling comment per phase, edited as attempts resolve items", async () => {
    const ctx = setup();
    // Phase 1: blocked, blocked, then clean (2 fix attempts); phase 2 clean.
    const { loop } = wire({ review: [blocked, blocked, clean, clean] });

    await loop.run(ctx);

    // Exactly one phase-1 comment despite three review passes — it was edited in
    // place, not duplicated per iteration (avoids burying the thread).
    const phase1 = reviewComments(ctx.prNumber, 1);
    expect(phase1).toHaveLength(1);
    // Its final state reflects the resolved phase: no gating items remain.
    expect(gatingItems(phase1[0]!.data!.worklist)).toHaveLength(0);
    // Phase 2 has its own single rolling comment — one per phase, not one per iteration.
    expect(reviewComments(ctx.prNumber, 2)).toHaveLength(1);
  });

  it("the integration re-review (a second runPhase per phase) edits the existing comment, not a duplicate (AC-4)", async () => {
    const ctx = setup();
    // ADR-0017: a moved integration rebase whose net diff changed re-runs runPhase
    // for P1+P2 under the merge lease — each phase reviews TWICE (build + integration).
    worktrees.scriptRebase({ kind: "clean", moved: false }, { kind: "clean", moved: true });
    worktrees.scriptBranchDiffHash("net-before", "net-after");
    github.setCiGreen(ctx.prNumber);
    const { loop, reviewAgent } = wire({ review: [clean] });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "merged" });
    // Each phase reviewed twice (4 passes total) — the integration re-review ran.
    expect(reviewAgent.calls).toHaveLength(4);
    // Yet still exactly ONE ralph-review comment per phase: the integration
    // re-review recovered the build review's comment from the PR and edited it in
    // place rather than posting a duplicate.
    expect(reviewComments(ctx.prNumber, 1)).toHaveLength(1);
    expect(reviewComments(ctx.prNumber, 2)).toHaveLength(1);
  });

  it("recovers the rolling comment after a restart mid-phase — edits it, no duplicate", async () => {
    const ctx = setup();
    // A daemon that already posted phase 1's rolling comment, then restarted: the
    // comment is on the PR but the new process's reviewCommentId is undefined.
    // Recovery must find it by parsing its payload's phase and edit it in place.
    const priorComment = github.seedPullRequestComment(ctx.prNumber, {
      author: "ralph-autopilot",
      body: formatReviewComment({ phase: 1, worklist: blocked }),
    });
    const { loop } = wire({ review: [blocked, clean, clean] });

    await loop.run(ctx);

    const phase1 = reviewComments(ctx.prNumber, 1);
    expect(phase1).toHaveLength(1);
    // The SAME comment the prior process posted (recovered by id, not re-created).
    expect(phase1[0]!.id).toBe(priorComment.id);
    expect(gatingItems(phase1[0]!.data!.worklist)).toHaveLength(0);
  });

  it("hands the fix agent a PR reference so it reads findings from the ralph-review comment", async () => {
    const ctx = setup();
    const { loop, fixAgent } = wire({ review: [blocked, clean, clean] });

    await loop.run(ctx);

    // The phase-1 fix sources its worklist from the PR's rolling ralph-review
    // comment (GitHub is the source of truth), so it carries the PR reference.
    const phase1Fix = fixAgent.calls.find((c) => c.phase === 1)!;
    expect(phase1Fix.reviewComment).toEqual({ prNumber: ctx.prNumber, phase: 1 });
  });

  it("does not re-ingest the daemon's own ralph-review comment as an external finding", async () => {
    const ctx = setup();
    github.seedPullRequestComment(ctx.prNumber, {
      author: "chatgpt-codex-connector",
      body: "Consider tightening the retry backoff.",
    });
    // Phase 1 clean → phase 2 clean. Phase 1 posts a ralph-review comment, which is
    // present on the PR when phase 2 lists the comments.
    const { loop, reviewAgent } = wire({ review: [clean] });

    await loop.run(ctx);

    // Every review pass ingests the genuine bot comment but never its own
    // ralph-review comment (the daemon's structured output, not a finding).
    for (const call of reviewAgent.calls) {
      expect(call.prComments.some((c) => c.author === "chatgpt-codex-connector")).toBe(true);
      expect(call.prComments.some((c) => parseReviewComment(c.body) !== null)).toBe(false);
    }
  });

  it("does NOT route the CI-gate fix through a ralph-review comment (deterministic CI worklist)", async () => {
    const ctx = setup();
    github.setChecksSequence(ctx.prNumber, [
      { state: "red", failures: ["build"] },
      { state: "green", failures: [] },
    ]);
    const { loop, fixAgent } = wire({ review: [clean], fix: [{ kind: "fixed" }] });

    await loop.run(ctx);

    // The phase-0 CI fix gets its worklist inline (the failing checks), not via a
    // ralph-review comment — those carry review-agent findings only.
    const ciFix = fixAgent.calls.find((c) => c.phase === 0)!;
    expect(ciFix.reviewComment).toBeUndefined();
    // And no ralph-review comment was posted for phase 0.
    expect(
      (github.comments.get(ctx.prNumber) ?? []).filter((c) => parseReviewComment(c.body)?.phase === 0),
    ).toHaveLength(0);
  });

  // ---- Phase 0 — CI gate (await CI BEFORE review) -------------------------

  it("awaits CI before review: green proceeds to phase 1 (no checks = no-op)", async () => {
    const ctx = setup();
    github.setCiGreen(ctx.prNumber);
    const { loop, reviewAgent } = wire({ review: [clean] });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "merged" });
    // CI was polled before any review pass ran.
    expect(github.checkPolls[0]).toBe(ctx.prNumber);
    expect(reviewAgent.calls.length).toBeGreaterThan(0);
  });

  it("red CI skips review, runs the fix loop, and proceeds once CI goes green", async () => {
    const ctx = setup();
    // CI red, then green after one fix; review clean for the phases that follow.
    github.setChecksSequence(ctx.prNumber, [
      { state: "red", failures: ["build"] },
      { state: "green", failures: [] },
    ]);
    const { loop, reviewAgent, fixAgent } = wire({ review: [clean], fix: [{ kind: "fixed" }] });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "merged" });
    // The first fix ran on the CI worklist (phase 0), BEFORE any review.
    expect(fixAgent.calls[0]!.phase).toBe(0);
    expect(fixAgent.calls[0]!.worklist.items[0]!.title).toContain("CI check failing: build");
    expect(fixAgent.calls[0]!.behaviourPreserving).toBe(false);
    // Review only ran after CI was green.
    expect(reviewAgent.calls.length).toBeGreaterThan(0);
  });

  it("red CI that never recovers maxes out as review-maxed (ci) and skips review", async () => {
    const ctx = setup();
    github.setCiRed(ctx.prNumber, ["pr-checks"]); // stays red across every re-await
    const { loop, reviewAgent, fixAgent } = wire({
      review: [clean],
      fix: [{ kind: "fixed" }],
      maxFixAttempts: 3,
    });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "review-maxed", phase: 0 });
    expect(fixAgent.calls).toHaveLength(3); // bounded fix loop, no 4th attempt
    expect(fixAgent.calls.every((c) => c.phase === 0)).toBe(true);
    // Review was skipped entirely and nothing merged.
    expect(reviewAgent.calls).toHaveLength(0);
    expect(github.merges).toHaveLength(0);
    // A review-maxed (ci) heal-card was surfaced; the run status (the reconciler diff's
    // label source, #82) is review-maxed, set with no imperative addLabel.
    expect(store.getRunByIssue(3)!.status).toBe("review-maxed");
    expect(store.listOpenQuestions()[0]!.kind).toBe("heal-card");
  });

  it("a CI timeout maxes out immediately without a fix attempt", async () => {
    const ctx = setup();
    github.setChecks(ctx.prNumber, { state: "timeout", failures: ["slow-check"] });
    const { loop, fixAgent, reviewAgent } = wire({ review: [clean] });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "review-maxed", phase: 0 });
    expect(fixAgent.calls).toHaveLength(0);
    expect(reviewAgent.calls).toHaveLength(0);
  });

  it("a fix agent can escalate out of the CI gate", async () => {
    const ctx = setup();
    github.setCiRed(ctx.prNumber, ["build"]);
    const { loop, reviewAgent } = wire({
      review: [clean],
      fix: [{ kind: "escalate", question: escalation }],
    });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "escalated", phase: 0 });
    expect(reviewAgent.calls).toHaveLength(0);
    // Status swaps to awaiting-answer (the reconciler diff's label source, #82).
    expect(store.getRunByIssue(3)!.status).toBe("awaiting-answer");
    expect(github.addedLabels.some((l) => l.label === LABEL_AWAITING_ANSWER)).toBe(false);
  });

  it("skips the CI gate when waitForChecks is false (merges without polling)", async () => {
    const ctx = setup();
    const { loop } = wire({ review: [clean], merge: { waitForChecks: false } });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "merged" });
    expect(github.checkPolls).toHaveLength(0);
  });

  // ---- Phase 0 CI gate hardening (issue #125) ----------------------------

  it("re-reads CI once before maxing: a green that lands in the poll window proceeds instead of maxing (AC4)", async () => {
    const ctx = setup();
    // Every blocking await sees red (the slow CI has not flipped yet within the poll
    // window), so the fix loop spends its full budget; but a green lands by the time
    // of the single reconfirm read just before the gate would flip to review-maxed.
    github.setCiRed(ctx.prNumber, ["build"]);
    github.setReadChecks(ctx.prNumber, { state: "green", failures: [] });
    const { loop, reviewAgent, fixAgent } = wire({ review: [clean, clean], maxFixAttempts: 3 });

    const outcome = await loop.resumeAfterCi(ctx, { state: "red", failures: ["build"] });

    // The reconfirm read caught the green → the gate proceeded to review, not maxout.
    expect(outcome).toEqual({ kind: "awaiting-merge" });
    expect(fixAgent.calls).toHaveLength(3); // full budget spent before the reconfirm
    expect(github.readCheckPolls).toContain(ctx.prNumber); // the single reconfirm read happened
    expect(reviewAgent.calls.length).toBeGreaterThan(0); // review ran after the rescue
    expect(store.getRunByIssue(3)!.status).not.toBe("review-maxed");
  });

  it("re-reads CI once before maxing on a timeout hard-stop too (green-in-window rescue, AC4)", async () => {
    const ctx = setup();
    // The off-slot poller hands a `timeout` (pending never settled in budget) — a hard
    // stop that spends no fix attempt — but a green has landed by the reconfirm read.
    github.setReadChecks(ctx.prNumber, { state: "green", failures: [] });
    const { loop, reviewAgent, fixAgent } = wire({ review: [clean, clean] });

    const outcome = await loop.resumeAfterCi(ctx, { state: "timeout", failures: ["slow-check"] });

    expect(outcome).toEqual({ kind: "awaiting-merge" });
    expect(fixAgent.calls).toHaveLength(0); // a timeout is a hard stop: no fix attempt
    expect(github.readCheckPolls).toContain(ctx.prNumber);
    expect(reviewAgent.calls.length).toBeGreaterThan(0);
  });

  it("a genuinely stable red still maxes after the full budget and the reconfirm read (AC5)", async () => {
    const ctx = setup();
    // Red on every await AND on the reconfirm read — a real, stable failure.
    github.setCiRed(ctx.prNumber, ["build"]);
    github.setReadChecks(ctx.prNumber, { state: "red", failures: ["build"] });
    const { loop, fixAgent, reviewAgent } = wire({ review: [clean], maxFixAttempts: 3 });

    const outcome = await loop.resumeAfterCi(ctx, { state: "red", failures: ["build"] });

    expect(outcome).toEqual({ kind: "review-maxed", phase: 0 });
    expect(fixAgent.calls).toHaveLength(3); // the full budget, no early max
    expect(reviewAgent.calls).toHaveLength(0); // review never ran on red CI
    expect(store.getRunByIssue(3)!.status).toBe("review-maxed");
  });

  // The off-slot CI park re-admits a run via resumeAfterCi (the poller's seeded
  // re-entry, ADR-0022). Across that re-entry the CI phase must spend its FULL
  // configured budget before maxing — a run can never max at fewer attempts than
  // configured (the example-monorepo #2113 incident maxed at attempts=1 with maxFixAttempts=3).
  for (const maxFixAttempts of [1, 2, 3, 5]) {
    it(`off-slot CI re-entry spends the full ${maxFixAttempts}-attempt budget before maxing (AC1)`, async () => {
      const ctx = setup();
      // Red on every read, including the reconfirm — a stable failure the fix cannot clear.
      github.setCiRed(ctx.prNumber, ["build"]);
      github.setReadChecks(ctx.prNumber, { state: "red", failures: ["build"] });
      const { loop, fixAgent } = wire({ review: [clean], maxFixAttempts });

      const outcome = await loop.resumeAfterCi(ctx, { state: "red", failures: ["build"] });

      expect(outcome).toEqual({ kind: "review-maxed", phase: 0 });
      // Exactly the configured budget of fix attempts ran — never fewer.
      expect(fixAgent.calls).toHaveLength(maxFixAttempts);
      expect(fixAgent.calls.every((c) => c.phase === 0)).toBe(true);
      // The event-sourced fix-attempt counter (ADR-0024) folded the full budget.
      expect(store.getFixAttempts(ctx.runId, 0)).toBe(maxFixAttempts);
    });
  }

  // ---- Rebase-aware merge ------------------------------------------------

  it("re-reviews under the merge lease when a moved integration rebase changed the net branch diff", async () => {
    const ctx = setup();
    // Pre-review rebase is a no-op; the integration (merge-time) rebase moves the
    // branch AND its net diff vs base changes (a conflict resolution or a base change
    // that altered the merged result) — so it is re-reviewed (issue #65).
    worktrees.scriptRebase({ kind: "clean", moved: false }, { kind: "clean", moved: true });
    worktrees.scriptBranchDiffHash("net-before", "net-after");
    github.setCiGreen(ctx.prNumber);
    const { loop, reviewAgent } = wire({ review: [clean] });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "merged" });
    // Build review (P1 + P2) plus the integration re-review (P1 + P2) = 4 passes.
    expect(reviewAgent.calls).toHaveLength(4);
    // CI gated three times: build gate, the post-rebase re-await, and the
    // post-re-review re-gate before landing.
    expect(github.checkPolls).toHaveLength(3);
    expect(github.merges).toHaveLength(1);
  });

  it("skips re-review when a moved integration rebase's net branch diff is unchanged (pure fast-forward replay)", async () => {
    const ctx = setup();
    // The integration rebase moves the branch, but the net diff vs base is identical
    // before and after — base only advanced in files this branch did not touch, a
    // pure fast-forward replay. CI is re-gated, but re-review is skipped (issue #65).
    worktrees.scriptRebase({ kind: "clean", moved: false }, { kind: "clean", moved: true });
    worktrees.scriptBranchDiffHash("same-net-diff", "same-net-diff");
    github.setCiGreen(ctx.prNumber);
    const { loop, reviewAgent } = wire({ review: [clean] });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "merged" });
    // Only the build review ran (P1 + P2) — no integration re-review pass.
    expect(reviewAgent.calls).toHaveLength(2);
    // CI was still re-gated on the move (the post-rebase re-await), on top of the
    // build gate — but there is no post-re-review re-gate, since review was skipped.
    expect(github.checkPolls).toHaveLength(2);
    expect(github.merges).toHaveLength(1);
  });

  it("falls back to re-review when a moved rebase's net branch diff is unavailable (conservative)", async () => {
    const ctx = setup();
    // The branch moved but the net diff could not be computed (branchDiffHash → null)
    // — the conservative fallback re-reviews rather than skipping it blind (issue #65).
    worktrees.scriptRebase({ kind: "clean", moved: false }, { kind: "clean", moved: true });
    worktrees.scriptBranchDiffHash(null, null);
    github.setCiGreen(ctx.prNumber);
    const { loop, reviewAgent } = wire({ review: [clean] });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "merged" });
    // Re-review still ran (P1 + P2 build + P1 + P2 integration) = 4 passes.
    expect(reviewAgent.calls).toHaveLength(4);
    expect(github.merges).toHaveLength(1);
  });

  it("does not re-review when the integration rebase did not move the branch", async () => {
    const ctx = setup();
    worktrees.scriptRebase({ kind: "clean", moved: false }, { kind: "clean", moved: false });
    github.setCiGreen(ctx.prNumber);
    const { loop, reviewAgent } = wire({ review: [clean] });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "merged" });
    // Only the build review ran (P1 + P2); integration merged directly.
    expect(reviewAgent.calls).toHaveLength(2);
    expect(github.merges).toHaveLength(1);
  });

  it("integration re-review that cannot pass maxes out (under the lease), not merge", async () => {
    const ctx = setup();
    worktrees.scriptRebase({ kind: "clean", moved: false }, { kind: "clean", moved: true });
    github.setCiGreen(ctx.prNumber);
    // Build review passes (P1, P2 clean); the integration re-review finds a blocker
    // the fix loop cannot clear → review-maxed, and crucially it never merges.
    const { loop } = wire({ review: [clean, clean, blocked], maxFixAttempts: 3 });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "review-maxed", phase: 1 });
    expect(github.merges).toHaveLength(0);
    expect(store.getRunByIssue(3)!.status).toBe("review-maxed");
  });

  it("a branch that did not move merges without re-awaiting CI", async () => {
    const ctx = setup();
    worktrees.scriptRebase({ kind: "clean", moved: false }, { kind: "clean", moved: false });
    github.setCiGreen(ctx.prNumber);
    const { loop } = wire({ review: [clean] });

    await loop.run(ctx);

    // Only the CI gate polled CI; neither (unmoved) rebase needs a re-await.
    expect(github.checkPolls).toHaveLength(1);
    expect(github.merges).toHaveLength(1);
  });

  it("a moved branch whose CI then goes red maxes out as review-maxed (ci)", async () => {
    const ctx = setup();
    // Pre-review rebase is a no-op; the merge-time rebase moves the branch.
    worktrees.scriptRebase({ kind: "clean", moved: false }, { kind: "clean", moved: true });
    // CI gate clean (none), then the post-rebase re-await at merge stays red.
    github.setChecksSequence(ctx.prNumber, [
      { state: "none", failures: [] },
      { state: "red", failures: ["build"] },
    ]);
    const { loop } = wire({ review: [clean], fix: [{ kind: "fixed" }], maxFixAttempts: 3 });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "review-maxed", phase: 0 });
    expect(github.merges).toHaveLength(0);
  });

  it("a rebase conflict is handed to a fix agent, then the PR merges", async () => {
    const ctx = setup();
    worktrees.scriptRebase({ kind: "conflict", files: ["src/app.ts"], baseSha: "base-1" });
    const { loop, fixAgent } = wire({ review: [clean], fix: [{ kind: "fixed" }] });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "merged" });
    // The fix agent got a conflict worklist naming the conflicted file.
    const conflictFix = fixAgent.calls.find((c) =>
      c.worklist.items.some((i) => i.title.includes("Resolve rebase conflict in src/app.ts")),
    );
    expect(conflictFix).toBeDefined();
    // #273: the harness does NOT force-push the rebase from the daemon worktree anymore — the
    // container runner owns that push end-to-end. The daemon now VERIFIES the resolution landed
    // against the DISPATCH-time base it was handed (#20), not origin's (possibly-advanced) current base.
    expect(worktrees.rebaseVerifyCalls).toEqual([
      { worktreePath: ctx.worktreePath, branch: BRANCH, baseBranch: BASE, dispatchBaseSha: "base-1" },
    ]);
    expect(github.merges).toHaveLength(1);
  });

  it("a rebase-conflict resolution that did NOT land fails loud (review-maxed) with the honest not-landed card, never merging (#273/#20)", async () => {
    const ctx = setup();
    worktrees.scriptRebase({ kind: "conflict", files: ["src/app.ts"], baseSha: "base-1" });
    // The container reported `fixed` but origin/<branch> still does not contain the DISPATCH base it
    // was handed — a silent no-op push, a wipe, or a branch still forked off an older base. This is a
    // genuine #273 not-landed failure, distinct from a benign base-advanced race (#20).
    worktrees.scriptRebaseVerify(false);
    const { loop } = wire({ review: [clean], fix: [{ kind: "fixed" }] });

    const outcome = await loop.run(ctx);

    // Fail loud: the resolution did not reach origin — surface it, do not merge a conflicting PR.
    expect(outcome).toEqual({ kind: "review-maxed", phase: 0 });
    expect(github.merges).toHaveLength(0);
    expect(worktrees.rebaseVerifyCalls).toHaveLength(1);
    // Verified against the base it was DISPATCHED against, not origin's current base.
    expect(worktrees.rebaseVerifyCalls[0]!.dispatchBaseSha).toBe("base-1");
    expect(store.getRunByIssue(3)!.status).toBe("review-maxed");
    // The existing not-landed heal-card, exactly as today — it names the not-landed failure, NOT a
    // base-advance race.
    const body = (github.comments.get(3) ?? []).map((c) => c.body).join("\n");
    expect(body).toContain("did not land on origin");
    expect(body).toContain("force-push landed nothing");
    expect(body).not.toContain("base branch advanced");
  });

  it("a rebase conflict implying a risky structural change escalates (never resolved blind)", async () => {
    const ctx = setup();
    worktrees.scriptRebase({ kind: "conflict", files: ["src/core/ledger.ts"], baseSha: "base-1" });
    const { loop } = wire({
      review: [clean],
      fix: [{ kind: "escalate", question: escalation }],
    });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "escalated", phase: 0 });
    expect(github.merges).toHaveLength(0);
    // Escalated, not resolved → the daemon never verified.
    expect(worktrees.rebaseVerifyCalls).toHaveLength(0);
    expect(store.getRunByIssue(3)!.status).toBe("awaiting-answer");
  });

  it("a rebase-conflict fix reported `failed` maxes out gracefully, never orphaning the PR (#273)", async () => {
    const ctx = setup();
    worktrees.scriptRebase({ kind: "conflict", files: ["src/app.ts"], baseSha: "base-1" });
    // The runner-owned push refused (#241 no-net-diff guard) or a concurrent push rejected the
    // force-with-lease → the container reports `failed` → AgentOutputParseError. This path calls
    // runFix directly (bypassing boundedFixLoop), so before #273 this throw escaped uncaught to
    // withFailureGuard = agent-stuck + PR auto-close — the exact orphaning the PR claims to fix.
    const reviewAgent: ReviewAgentRunner = { review: async (_c: ReviewContext) => clean };
    const fixAgent: FixAgentRunner = {
      fix: async (_c: FixContext) => {
        throw new AgentOutputParseError(
          3,
          "fix session failed (issue #3): refusing to force-push ralph/3: leaves no net diff vs origin/main (#241)",
          "fix session failed (issue #3): refusing to force-push ralph/3: leaves no net diff vs origin/main (#241)",
        );
      },
    };
    const loop = wireRunners(reviewAgent, fixAgent);

    const outcome = await loop.run(ctx);

    // Healable, not orphaned: review-maxed (phase 0), PR preserved (never merged; the loop returns
    // cleanly rather than throwing into the executor's terminalize-and-close-PR guard).
    expect(outcome).toEqual({ kind: "review-maxed", phase: 0 });
    expect(store.getRunByIssue(3)!.status).toBe("review-maxed");
    expect(github.merges).toHaveLength(0);
    // The fix `failed` before anything landed — the daemon never verified.
    expect(worktrees.rebaseVerifyCalls).toHaveLength(0);
    // An honest heal-card surfaced (resume-from-WIP re-runs the resolve): it names the real push
    // failure and carries its detail, and is NOT the misleading "fix your JSON" card.
    expect(store.listOpenQuestions().some((q) => q.kind === "heal-card")).toBe(true);
    const body = (github.comments.get(3) ?? []).map((c) => c.body).join("\n");
    expect(body).toContain("rebase-conflict resolution container reported a failure");
    expect(body).toContain("no net diff");
    expect(body).not.toContain("parseable JSON");
  });

  it("a rebase-conflict fix hitting a transient container no-result retries and self-heals (#273/#220)", async () => {
    const ctx = setup();
    worktrees.scriptRebase({ kind: "conflict", files: ["src/app.ts"], baseSha: "base-1" });
    const reviewAgent: ReviewAgentRunner = { review: async (_c: ReviewContext) => clean };
    let fixCalls = 0;
    const fixAgent: FixAgentRunner = {
      fix: async (_c: FixContext) => {
        fixCalls++;
        // First dispatch: the container drops its pipe (infra fault). Retry lands the resolution.
        if (fixCalls === 1) throw new RunnerInfraError("fix", "runner exited without a result frame");
        return { kind: "fixed" };
      },
    };
    const loop = wireRunners(reviewAgent, fixAgent, { maxContainerRetries: 2 });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "merged" });
    expect(fixCalls).toBe(2); // the infra fault was retried, not charged to a fix budget or maxed
    expect(worktrees.rebaseVerifyCalls).toHaveLength(1); // the retry landed → daemon verified it
    expect(store.listOpenQuestions()).toHaveLength(0);
  });

  it("a rebase-conflict fix whose container never returns (persistent infra) maxes out via the infra card (#273/#220)", async () => {
    const ctx = setup();
    worktrees.scriptRebase({ kind: "conflict", files: ["src/app.ts"], baseSha: "base-1" });
    const reviewAgent: ReviewAgentRunner = { review: async (_c: ReviewContext) => clean };
    let fixCalls = 0;
    const fixAgent: FixAgentRunner = {
      fix: async (_c: FixContext) => {
        fixCalls++;
        throw new RunnerInfraError("fix", "docker exited (code=125 signal=null); stderr tail: no such image");
      },
    };
    const loop = wireRunners(reviewAgent, fixAgent, { maxContainerRetries: 2 });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "review-maxed", phase: 0 });
    expect(fixCalls).toBe(3); // initial dispatch + maxContainerRetries re-dispatches
    expect(github.merges).toHaveLength(0);
    expect(worktrees.rebaseVerifyCalls).toHaveLength(0);
    // The honest infra card (names the box fault + carries the real docker detail), not the JSON one.
    const body = (github.comments.get(3) ?? []).map((c) => c.body).join("\n");
    expect(body).toContain("container infrastructure fault");
    expect(body).toContain("docker exited (code=125");
    expect(body).not.toContain("parseable JSON");
  });

  // ---- Phase-0 rebase verification races a moving base (#20) --------------

  it("a resolution that lands on its dispatch base, then base advances with no new conflict, merges with no human (#20)", async () => {
    const ctx = setup();
    // A sibling PR merged into base mid-review → a rebase conflict. The container resolves it and it
    // lands on the base it was DISPATCHED against (base-1). A second sibling then merges into base
    // inside the fix window, but on a disjoint file: the re-rebase round picks it up cleanly. The run
    // self-heals to a merge — no phantom "push landed nothing" heal-card (the exact #20 regression).
    worktrees.scriptRebase(
      { kind: "conflict", files: ["src/app.ts"], baseSha: "base-1" },
      { kind: "clean", moved: true }, // re-rebase onto the advanced base — clean (disjoint files)
    );
    worktrees.scriptRebaseVerify(true); // the resolution landed on its dispatch base
    github.setCiGreen(ctx.prNumber);
    const { loop, fixAgent } = wire({ review: [clean], fix: [{ kind: "fixed" }] });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "merged" });
    // Exactly ONE conflict fix dispatch — the base advance did not need another (it was a clean re-rebase).
    expect(fixAgent.calls.filter((c) => c.rebaseConflict)).toHaveLength(1);
    // The daemon verified against the DISPATCH base it handed the fix, not origin's advanced base.
    expect(worktrees.rebaseVerifyCalls).toHaveLength(1);
    expect(worktrees.rebaseVerifyCalls[0]!.dispatchBaseSha).toBe("base-1");
    // The landed resolution was adopted so the re-rebase round could run.
    expect(worktrees.adopted).toEqual([{ worktreePath: ctx.worktreePath, branch: BRANCH }]);
    // No heal-card: the race self-healed.
    expect(store.listOpenQuestions()).toHaveLength(0);
    expect(github.merges).toHaveLength(1);
  });

  it("a landed resolution whose base then advances into a NEW conflict triggers a second, bounded fix dispatch (#20)", async () => {
    const ctx = setup();
    // First conflict resolves + lands on base-1. Base then advances into a genuinely NEW conflict
    // (a fresh round, dispatched against base-2), which also lands; the final re-rebase is clean.
    worktrees.scriptRebase(
      { kind: "conflict", files: ["src/app.ts"], baseSha: "base-1" },
      { kind: "conflict", files: ["src/other.ts"], baseSha: "base-2" },
      { kind: "clean", moved: true },
    );
    worktrees.scriptRebaseVerify(true, true);
    github.setCiGreen(ctx.prNumber);
    const { loop, fixAgent } = wire({ review: [clean], fix: [{ kind: "fixed" }, { kind: "fixed" }] });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "merged" });
    // TWO conflict fix dispatches — the second is the fresh conflict the advanced base introduced.
    expect(fixAgent.calls.filter((c) => c.rebaseConflict)).toHaveLength(2);
    // Each round verified against the base IT was dispatched against — never a single moving base.
    expect(worktrees.rebaseVerifyCalls.map((v) => v.dispatchBaseSha)).toEqual(["base-1", "base-2"]);
    expect(store.listOpenQuestions()).toHaveLength(0);
    expect(github.merges).toHaveLength(1);
  });

  it("a base too hot to converge maxes out with a heal-card that names the RACE, not a phantom push failure (#20)", async () => {
    const ctx = setup();
    // Every landed resolution finds base advanced into yet another conflict — a pathologically hot
    // base. After the bounded rounds, max out with a heal-card that names the race honestly.
    worktrees.scriptRebase(
      { kind: "conflict", files: ["src/app.ts"], baseSha: "base-1" },
      { kind: "conflict", files: ["src/app.ts"], baseSha: "base-2" },
      { kind: "conflict", files: ["src/app.ts"], baseSha: "base-3" },
      { kind: "conflict", files: ["src/app.ts"], baseSha: "base-4" },
    );
    worktrees.scriptRebaseVerify(true, true, true); // every dispatched resolution genuinely lands
    const { loop, fixAgent } = wire({
      review: [clean],
      fix: [{ kind: "fixed" }, { kind: "fixed" }, { kind: "fixed" }],
    });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "review-maxed", phase: 0 });
    expect(github.merges).toHaveLength(0);
    // Exactly the bounded number of fix dispatches (3), then the bound halts a 4th.
    expect(fixAgent.calls.filter((c) => c.rebaseConflict)).toHaveLength(3);
    expect(store.getRunByIssue(3)!.status).toBe("review-maxed");
    // The heal-card names the base-advance RACE and explicitly NOT a failed / no-op push.
    const body = (github.comments.get(3) ?? []).map((c) => c.body).join("\n");
    expect(body).toContain("base branch advanced");
    expect(body).toMatch(/hot-base race/);
    expect(body).not.toContain("force-push landed nothing");
    expect(body).not.toContain("did not land on origin");
  });

  // ---- Build / integration split ----------------------------------------

  it("runReview parks awaiting-ci off-slot on a first pass after the pre-review resolve (ADR-0022)", async () => {
    const ctx = setup();
    const { loop, reviewAgent } = wire({ review: [clean] });

    const outcome = await loop.runReview(ctx);

    // The pre-review CI wait moves off the build pool: runReview rebases, then hands
    // back `awaiting-ci` without polling CI or running any review pass.
    expect(outcome).toEqual({ kind: "awaiting-ci" });
    expect(worktrees.rebased).toHaveLength(1); // the pre-review resolve still ran
    expect(github.checkPolls).toHaveLength(0); // no in-process CI poll
    expect(reviewAgent.calls).toHaveLength(0); // no review until CI settles
    expect(github.merges).toHaveLength(0);
  });

  it("resumeAfterCi continues from a green CI verdict to awaiting-merge without re-polling", async () => {
    const ctx = setup();
    const { loop } = wire({ review: [clean] });

    const outcome = await loop.resumeAfterCi(ctx, { state: "green", failures: [] });

    expect(outcome).toEqual({ kind: "awaiting-merge" });
    // The poller's verdict seeds the gate — resumeAfterCi does not re-poll CI itself.
    expect(github.checkPolls).toHaveLength(0);
    expect(github.merges).toHaveLength(0); // the merge belongs to the integration flow
  });

  it("resumeAfterCi surfaces a terminal (review-maxed) without reaching awaiting-merge", async () => {
    const ctx = setup();
    const { loop } = wire({ review: [blocked], maxFixAttempts: 3 });

    const outcome = await loop.resumeAfterCi(ctx, { state: "green", failures: [] });

    expect(outcome).toEqual({ kind: "review-maxed", phase: 1 });
    expect(github.merges).toHaveLength(0);
  });

  it("resumeAfterCi runs the red-CI fix loop from the poller's verdict (no re-poll for the first assess)", async () => {
    const ctx = setup();
    // The seed is red; the fix agent pushes, then the on-slot re-await goes green.
    github.setChecksSequence(ctx.prNumber, [{ state: "green", failures: [] }]);
    const { loop, fixAgent, reviewAgent } = wire({ review: [clean], fix: [{ kind: "fixed" }] });

    const outcome = await loop.resumeAfterCi(ctx, { state: "red", failures: ["build"] });

    expect(outcome).toEqual({ kind: "awaiting-merge" });
    // The first CI assess used the poller's seed (no poll); only the post-fix
    // re-await polled once on-slot.
    expect(github.checkPolls).toHaveLength(1);
    // The CI fix ran on the seeded failing check, before any review.
    expect(fixAgent.calls[0]!.phase).toBe(0);
    expect(fixAgent.calls[0]!.worklist.items[0]!.title).toContain("CI check failing: build");
    expect(reviewAgent.calls.length).toBeGreaterThan(0);
  });

  it("runIntegration resolves against base then merges (no review pass)", async () => {
    const ctx = setup();
    const { loop, reviewAgent } = wire({ review: [clean] });

    const outcome = await loop.runIntegration(ctx);

    expect(outcome).toEqual({ kind: "merged" });
    expect(github.merges).toHaveLength(1);
    // Integration only resolves + merges — it does not re-run review in phase 1.
    expect(reviewAgent.calls).toHaveLength(0);
    expect(worktrees.rebased).toHaveLength(1);
  });

  it("run is runReview then runIntegration: a clean run still merges", async () => {
    const ctx = setup();
    const { loop } = wire({ review: [clean] });

    const outcome = await loop.run(ctx);

    expect(outcome).toEqual({ kind: "merged" });
    // One rebase from review (pre-review) and one from integration (pre-merge).
    expect(worktrees.rebased).toHaveLength(2);
  });

  // ---- Heal re-entry into runReview (issue #9) --------------------------

  it("runReview re-enters at the stored phase on a heal: phase 1, skipping the phase-0 prologue, ending at awaiting-merge", async () => {
    const ctx = setup();
    github.setCiGreen(ctx.prNumber); // would be polled if the phase-0 gate ran
    // Phase 1 blocked once then clean; phase 2 clean.
    const { loop, fixAgent } = wire({ review: [blocked, clean, clean], fix: [{ kind: "fixed" }] });

    const outcome = await loop.runReview({ ...ctx, resume: { phase: 1, guidance: "Apply the operator ruling." } });

    // The build flow hands off to integration — it does NOT merge in one shot (ADR-0017).
    expect(outcome).toEqual({ kind: "awaiting-merge" });
    expect(github.merges).toHaveLength(0);
    // The phase-0 prologue (base-sync + CI gate) was skipped — re-entry starts at the stored phase.
    expect(worktrees.rebased).toHaveLength(0);
    expect(github.checkPolls).toHaveLength(0);
    // The phase-1 fix agent ran with the operator's guidance injected.
    const guided = fixAgent.calls.find((c) => c.phase === 1);
    expect(guided!.guidance).toBe("Apply the operator ruling.");
  });

  it("a heal that re-enters at phase 2 runs only phase 2, with guidance, then ends at awaiting-merge", async () => {
    const ctx = setup();
    const { loop, reviewAgent, fixAgent } = wire({ review: [blocked, clean], fix: [{ kind: "fixed" }] });

    const outcome = await loop.runReview({ ...ctx, resume: { phase: 2, guidance: "Structural ruling." } });

    expect(outcome).toEqual({ kind: "awaiting-merge" });
    // Only phase 2 was reviewed — phases 0 and 1 were skipped on re-entry.
    expect(reviewAgent.calls.every((c) => c.phase === 2)).toBe(true);
    expect(worktrees.rebased).toHaveLength(0);
    expect(github.checkPolls).toHaveLength(0);
    const guided = fixAgent.calls.find((c) => c.phase === 2);
    expect(guided!.guidance).toBe("Structural ruling.");
    expect(guided!.behaviourPreserving).toBe(true);
  });

  it("scopes the guidance to the re-entered phase only (phase-2 fixes are not given phase-1 guidance)", async () => {
    const ctx = setup();
    // Re-enter at phase 1; phase 1 needs a fix, then phase 2 also needs a fix.
    const { loop, fixAgent } = wire({
      review: [blocked, clean, blocked, clean],
      fix: [{ kind: "fixed" }, { kind: "fixed" }],
    });

    await loop.runReview({ ...ctx, resume: { phase: 1, guidance: "Only-for-phase-1." } });

    const phase1Fix = fixAgent.calls.find((c) => c.phase === 1);
    const phase2Fix = fixAgent.calls.find((c) => c.phase === 2);
    expect(phase1Fix!.guidance).toBe("Only-for-phase-1.");
    expect(phase2Fix!.guidance).toBeUndefined();
  });
});
