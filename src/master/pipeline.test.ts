/**
 * The executor-backed master pipeline port (ADR-0041): how a resolved master hands its run back.
 * The property under test is that every arm lands on an entry point the daemon already owns —
 * so repaired work re-enters the ordinary CI/review/merge pipeline and nothing routes around it.
 */
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../log/logger";
import { FakeGitHub } from "../testing/fake-github";
import type { Executor } from "../executor/executor";
import type { Run } from "../store/types";
import type { Issue } from "../github/types";
import { createExecutorMasterPipeline, masterBriefQuestion } from "./pipeline";

const silent = createLogger({ write: () => {} });

const issue: Issue = {
  number: 7,
  title: "Widget pipeline",
  body: "b",
  state: "OPEN",
  labels: ["afk", "mode:tdd", "complexity:1"],
  createdAt: "2026-01-01T00:00:00Z",
};

const run: Run = {
  id: 1,
  repo: "acme/widgets",
  issueNumber: 7,
  mode: "tdd",
  tier: 1,
  status: "running",
  branch: "ralph/7-widget",
  worktreePath: "/w/7",
  prNumber: 70,
  issueTitle: "Widget pipeline",
  runnerPushedSha: null,
  createdAt: "t",
  updatedAt: "t",
};

function wire() {
  const github = new FakeGitHub("acme/widgets");
  const executor = {
    resume: vi.fn(async () => ({ runId: 1, branch: "b", worktreePath: "/w", prNumber: 70 })),
    recoverReview: vi.fn(async () => ({ runId: 1, branch: "b", worktreePath: "/w", prNumber: 70 })),
    integrate: vi.fn(async () => ({ runId: 1, branch: "b", worktreePath: "/w", prNumber: 70 })),
  } as unknown as Executor;
  return { github, executor, pipeline: createExecutorMasterPipeline({ executor, github, logger: silent }) };
}

describe("master pipeline hand-back (ADR-0041)", () => {
  it("resolved-and-continue resumes the preserved WIP branch with the guidance as the answer", async () => {
    const { executor, pipeline } = wire();

    await pipeline.continueRun({
      run,
      issue,
      resolution: "resolved-and-continue",
      brief: "Update the caller, then re-run the suite.",
      conclusion: "The schema is right; the caller is wrong.",
      phase: "impl",
    });

    const resume = (executor.resume as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(resume.run).toBe(run);
    expect(resume.answer.text).toBe("Update the caller, then re-run the suite.");
    // The injected question states who decided and why — the worker is being told, not asked.
    expect(resume.context.question.headline).toContain("master escalation");
    expect(resume.context.question.whereWeStand).toContain("The schema is right; the caller is wrong.");
    expect(resume.context.question.whereWeStand).toContain("authoritative");
  });

  it("redispatch-tier-1 uses the same mechanism with a re-dispatch brief", async () => {
    const { executor, pipeline } = wire();

    await pipeline.continueRun({
      run,
      issue,
      resolution: "redispatch-tier-1",
      brief: "Implement against the strict schema.",
      conclusion: "The approach was wrong from the start.",
      phase: "impl",
    });

    const resume = (executor.resume as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(resume.answer.text).toBe("Implement against the strict schema.");
    expect(resume.context.question.headline).toContain("re-dispatched");
    // An `impl` request carries no phase — the resume drives the implementation session.
    expect(resume.context.phase).toBeUndefined();
  });

  /**
   * The "repair and resume the EXACT phase" contract (ADR-0042). `phase`-presence is the resume
   * dispatch axis (#9): without it a maxed-out phase-2 review would restart the implementation
   * and discard the whole review tail.
   */
  it.each([
    ["review-0", 0],
    ["review-1", 1],
    ["review-2", 2],
  ] as const)("a %s request re-enters the review loop at exactly phase %i", async (key, phase) => {
    const { executor, pipeline } = wire();

    await pipeline.continueRun({
      run,
      issue,
      resolution: "resolved-and-continue",
      brief: "Guard the retry on the idempotency key.",
      conclusion: "The reviewer is right about the double-fire.",
      phase: key,
    });

    const resume = (executor.resume as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(resume.context.phase).toBe(phase);
    expect(resume.answer.text).toBe("Guard the retry on the idempotency key.");
  });

  it("ignores an unrecognised phase key rather than forging a review phase", async () => {
    const { executor, pipeline } = wire();

    await pipeline.continueRun({
      run,
      issue,
      resolution: "resolved-and-continue",
      brief: "Look again.",
      conclusion: "Transient.",
      phase: "reconcile",
    });

    const resume = (executor.resume as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(resume.context.phase).toBeUndefined();
  });

  it("retry ci/review re-enters the review loop — which RE-RUNS the gate, never skips it", async () => {
    for (const action of ["ci", "review"] as const) {
      const { github, executor, pipeline } = wire();
      github.openPullRequest("ralph/7-widget", "body");

      await pipeline.retry({ run, issue, action, brief: "re-run it" });

      expect(executor.recoverReview).toHaveBeenCalledTimes(1);
      expect(executor.integrate).not.toHaveBeenCalled();
      expect(github.merges).toEqual([]);
    }
  });

  it("retry merge asks the harness-owned merge, which still owns the decision", async () => {
    const { github, executor, pipeline } = wire();
    github.openPullRequest("ralph/7-widget", "body");

    await pipeline.retry({ run, issue, action: "merge", brief: "try the merge again" });

    expect(executor.integrate).toHaveBeenCalledTimes(1);
    // The port never merges directly — it asks the executor's gated integration flow.
    expect(github.merges).toEqual([]);
  });

  it("retry reconcile drives nothing — the next tick's orphan pass re-derives from GitHub", async () => {
    const { executor, pipeline } = wire();

    await pipeline.retry({ run, issue, action: "reconcile", brief: "look again" });

    expect(executor.recoverReview).not.toHaveBeenCalled();
    expect(executor.integrate).not.toHaveBeenCalled();
  });

  it("a retry with no open PR drives nothing rather than inventing one", async () => {
    const { executor, pipeline } = wire();

    await pipeline.retry({ run, issue, action: "review", brief: "re-run it" });

    expect(executor.recoverReview).not.toHaveBeenCalled();
  });

  it("the injected brief question clears the escalation schema (it rides the real resume path)", () => {
    const q = masterBriefQuestion({ resolution: "resolved-and-continue", conclusion: "c" });
    for (const field of ["headline", "feature", "whereWeStand", "decision", "stakes", "recommendation"] as const) {
      expect(q[field].length).toBeGreaterThan(0);
    }
  });
});
