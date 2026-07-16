import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../log/logger";
import { MEMORY_DB, openStore, type Store } from "../store/store";
import { FakeGitHub } from "../testing/fake-github";
import { FakeWorktreeManager } from "../testing/fake-worktree";
import { ControlledAgentRunner, PrOpeningAgentRunner, StuckAgentRunner } from "../testing/fake-agent";
import { parseLaunchMarker } from "../github/marker";
import { LABEL_AWAITING_MERGE } from "../core/labels";
import { LABEL_AGENT_STUCK, LABEL_READY } from "../hitl/labels";
import { UsageLimitError } from "../core/usage";
import type { PullRequest } from "../github/types";
import { ScriptedFixAgent, ScriptedReviewAgent } from "../testing/fake-review-agents";
import { ReviewLoop } from "../review/review-loop";
import { BranchDivergedError, GitWorktreeManager } from "./worktree";
import { Executor } from "./executor";

const silent = createLogger({ write: () => {} });

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll `predicate` until it is true or the deadline passes (real timers). */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor: condition not met before timeout");
    }
    await delay(5);
  }
}

describe("Executor", () => {
  let store: Store;
  let github: FakeGitHub;
  let worktrees: FakeWorktreeManager;
  let agentRunner: PrOpeningAgentRunner;
  let executor: Executor;

  beforeEach(() => {
    store = openStore(MEMORY_DB).forRepo("acme/widgets");
    github = new FakeGitHub();
    worktrees = new FakeWorktreeManager();
    agentRunner = new PrOpeningAgentRunner(github);
    executor = new Executor({ store, github, worktrees, agentRunner, logger: silent });
  });
  afterEach(() => store.close());

  it("takes an eligible issue to an open PR that closes it", async () => {
    github.seed({ number: 2, title: "Core loop" });
    const result = await executor.run({ issue: github.issues.get(2)!, mode: "tdd" });

    expect(result.branch).toBe("ralph/2-core-loop");
    expect(result.prNumber).not.toBeNull();

    const pr = await github.findPullRequestForBranch("ralph/2-core-loop");
    expect(pr).not.toBeNull();
    expect(pr!.body).toContain("Closes #2");
    expect(parseLaunchMarker(pr!.body)).toEqual({ issueNumber: 2, branch: "ralph/2-core-loop" });
  });

  it("records the run in SQLite with the branch, worktree, and PR number", async () => {
    github.seed({ number: 2, title: "Core loop" });
    const result = await executor.run({ issue: github.issues.get(2)!, mode: "tdd" });

    const run = store.getRunByIssue(2);
    expect(run).toBeDefined();
    expect(run!.branch).toBe("ralph/2-core-loop");
    expect(run!.worktreePath).toBe(result.worktreePath);
    expect(run!.prNumber).toBe(result.prNumber);
  });

  it("removes ready-for-agent on pickup", async () => {
    github.seed({ number: 2, title: "Core loop" });
    await executor.run({ issue: github.issues.get(2)!, mode: "tdd" });

    expect(github.removedLabels).toContainEqual({ issue: 2, label: "ready-for-agent" });
    expect(github.issues.get(2)!.labels).not.toContain("ready-for-agent");
  });

  // #241: a re-admitted heal of an issue that already pushed reviewed work must
  // ATTACH (preserve the branch), never `create` (which deletes the remote branch and
  // resets to base — the data-loss wipe). An OPEN PR on the branch is the signal.
  it("attaches (not creates) when an OPEN PR already exists for the branch (#241)", async () => {
    github.seed({ number: 2, title: "Core loop" });
    github.pulls.push({
      number: 99,
      body: "existing reviewed work",
      headRefName: "ralph/2-core-loop",
      state: "OPEN",
    });

    const claimed = await executor.claim({ issue: github.issues.get(2)!, mode: "tdd" });

    expect(worktrees.attached).toHaveLength(1);
    expect(worktrees.attached[0]!.branch).toBe("ralph/2-core-loop");
    expect(worktrees.created).toHaveLength(0); // never the wipe path
    expect(claimed.branch).toBe("ralph/2-core-loop");
  });

  it("creates a fresh worktree when no open PR exists (true fresh start)", async () => {
    github.seed({ number: 3, title: "Brand new" });
    // A CLOSED PR is not protected work — still a fresh start.
    github.pulls.push({
      number: 50,
      body: "old",
      headRefName: "ralph/3-brand-new",
      state: "CLOSED",
    });

    await executor.claim({ issue: github.issues.get(3)!, mode: "tdd" });

    expect(worktrees.created).toHaveLength(1);
    expect(worktrees.created[0]!.branch).toBe("ralph/3-brand-new");
    expect(worktrees.attached).toHaveLength(0);
  });

  it("creates the agent's own worktree and cleans it up afterwards", async () => {
    github.seed({ number: 2, title: "Core loop" });
    const result = await executor.run({ issue: github.issues.get(2)!, mode: "tdd" });

    expect(worktrees.created).toHaveLength(1);
    expect(worktrees.created[0]!.branch).toBe("ralph/2-core-loop");
    expect(worktrees.removed).toContain(result.worktreePath);
  });

  // ── run-span lifecycle wirings (issue #80, AC1) ───────────────────────────
  // The run span (`RunStarted … RunEnded`, ADR-0022) is appended at the executor's
  // lifecycle chokepoints. These assert the wirings through the real claim/resume/
  // discard paths via the issue-stream read-model — so deleting any append turns a
  // test red, not green (the gap the phase-1 review flagged).

  it("a pickup opens the run span (RunStarted) and resets any prior resume context (issue #80, AC1)", async () => {
    github.seed({ number: 2, title: "Core loop" });
    const branch = "ralph/2-core-loop";

    // A prior, paused span that left a WIP checkpoint on the issue stream — the state
    // a re-pickup must abandon. Set the checkpoint *after* its RunStarted, since the
    // RunStarted fold itself clears the span's resume context.
    const prior = store.upsertRun({
      issueNumber: 2,
      mode: "tdd",
      status: "awaiting-answer",
      branch,
      worktreePath: "/wt/2",
    });
    await store.recordRunStarted({ runId: prior.id, issueNumber: 2, mode: "tdd", branch, worktreePath: "/wt/2" });
    store.setResumeContext(prior.id, { question: { headline: "paused" } } as never, branch);
    expect(store.getResumeContext(prior.id)).toBeDefined();

    // Re-pickup through the real claim path.
    const claimed = await executor.claim({ issue: github.issues.get(2)!, mode: "tdd" });

    // RunStarted opened the fresh span: the projection reads running, not ended, tagged
    // with the run's correlation id.
    const agg = await store.aggregateIssue(2);
    expect(agg.state.status).toBe("running");
    expect(agg.state.ended).toBe(false);
    expect(agg.state.runId).toBe(String(claimed.runId));
    // …and the fresh span carries no checkpoint — the RunStarted fold reset it (the
    // headline behaviour this slice event-sources). Without the wiring it would survive.
    expect(store.getResumeContext(claimed.runId)).toBeUndefined();
  });

  it("a resume continues the run span (Resumed), flipping the projection back to running (issue #80, AC1)", async () => {
    github.seed({ number: 2, title: "Core loop" });
    const branch = "ralph/2-core-loop";
    const run = store.upsertRun({
      issueNumber: 2,
      mode: "tdd",
      status: "awaiting-answer",
      branch,
      worktreePath: "/wt/2",
      prNumber: 11,
    });
    // Model the paused span on the issue stream: a pickup, then an escalation.
    await store.recordRunStarted({ runId: run.id, issueNumber: 2, mode: "tdd", branch, worktreePath: "/wt/2" });
    await store.addQuestion({ issueNumber: 2, runId: run.id, kind: "heal-card", headline: "paused" });
    expect((await store.aggregateIssue(2)).state.status).toBe("awaiting-answer");

    await executor.resume({
      issue: github.issues.get(2)!,
      mode: "tdd",
      run: store.getRunByIssue(2)!,
      answer: "go",
      // No phase → impl-resume path (issue #9).
      context: { question: { headline: "paused" } as never },
    });

    // The Resumed event continued the same span — back to running, still not ended (it
    // is a resume, not a fresh RunStarted). Without the wiring it would stay awaiting-answer.
    const agg = await store.aggregateIssue(2);
    expect(agg.state.status).toBe("running");
    expect(agg.state.ended).toBe(false);
  });

  it("discarding an orphan closes its run span (RunEnded) — stuck for an open issue (issue #80, AC1)", async () => {
    const issue = github.seed({ number: 2, title: "Core loop" });
    const branch = "ralph/2-core-loop";
    const run = store.upsertRun({
      issueNumber: 2,
      mode: "tdd",
      status: "running",
      branch,
      worktreePath: "/wt/2",
    });
    await store.recordRunStarted({ runId: run.id, issueNumber: 2, mode: "tdd", branch, worktreePath: "/wt/2" });
    expect((await store.aggregateIssue(2)).state.ended).toBe(false);

    // Orphan with no live PR on an OPEN issue → bounded-out terminal.
    await executor.discardOrphan(store.getRunByIssue(2)!, issue);

    // RunEnded closed the span, and the run terminalised to agent-stuck (open issue).
    expect((await store.aggregateIssue(2)).state.ended).toBe(true);
    expect(store.getRunByIssue(2)!.status).toBe("agent-stuck");
    expect(github.issues.get(2)!.labels).toContain(LABEL_AGENT_STUCK);
  });

  it("review parks awaiting-ci off-slot; resumeAfterCi → awaiting-merge; a later integrate merges it", async () => {
    github.seed({ number: 2, title: "Core loop" });
    const reviewLoop = new ReviewLoop({
      store,
      github,
      reviewAgent: new ScriptedReviewAgent([{ items: [{ severity: "nit", title: "tidy" }] }]),
      fixAgent: new ScriptedFixAgent(),
      logger: silent,
      maxFixAttempts: 3,
      worktrees,
      baseBranch: "main",
      merge: {
        method: "squash",
        waitForChecks: true,
        ciTimeoutMinutes: 30,
        pollIntervalSeconds: 30,
        deleteBranch: true,
      },
    });
    const ex = new Executor({ store, github, worktrees, agentRunner, logger: silent, reviewLoop });

    const result = await ex.run({ issue: github.issues.get(2)!, mode: "tdd" });

    // The build flow parks the pre-review CI wait off the build pool (ADR-0022 stage
    // 1): it does NOT review or merge yet, and tags the run with the durable
    // awaiting-ci marker so the reconciler's CI poller can advance it.
    expect(github.merges).toHaveLength(0);
    expect(store.getRunByIssue(2)!.status).toBe("awaiting-ci");
    expect(github.issues.get(2)!.labels).toContain("awaiting-ci");
    // The build worktree was still torn down once the run parked.
    expect(worktrees.removed).toContain(result.worktreePath);

    // The CI poller's verdict (green) re-admits the run into review, which hands off
    // to the merge queue — clearing the awaiting-ci marker for the awaiting-merge one.
    const parked = store.getRunByIssue(2)!;
    const pr = (await github.findPullRequestForBranch(result.branch))!;
    await ex.resumeAfterCi(parked, github.issues.get(2)!, pr, { state: "green", failures: [] });

    expect(github.merges).toHaveLength(0);
    // Status hands off to awaiting-merge (the `ReviewPassed` fact). Its label is now a
    // level-triggered reconciler effect (issue #82, ADR-0027), not set inline here; the
    // off-slot CI marker is still cleared inline as the run leaves the CI gate.
    expect(store.getRunByIssue(2)!.status).toBe("awaiting-merge");
    expect(github.addedLabels.some((l) => l.label === "awaiting-merge")).toBe(false);
    expect(github.issues.get(2)!.labels).not.toContain("awaiting-ci");

    // The integration flow re-attaches and merges, clearing the queue marker.
    const run = store.getRunByIssue(2)!;
    await ex.integrate(run, github.issues.get(2)!, pr);

    expect(github.merges).toEqual([
      { prNumber: result.prNumber, method: "squash", deleteBranch: true },
    ]);
    expect(store.getRunByIssue(2)!.status).toBe("merged");
    expect(github.issues.get(2)!.labels).not.toContain("awaiting-merge");
  });

  it("sets agent-stuck and opens no PR when the agent self-stops on its budget (AC2)", async () => {
    github.seed({ number: 6, title: "Hardening" });
    const stuck = new StuckAgentRunner({ category: "no-green-build", reason: "build never went green" });
    const ex = new Executor({ store, github, worktrees, agentRunner: stuck, logger: silent });

    const result = await ex.run({ issue: github.issues.get(6)!, mode: "tdd" });

    // No PR; the run status is agent-stuck (the reconciler's per-tick diff projects the
    // label from it — issue #82, ADR-0027; no imperative addLabel here), worktree cleaned.
    expect(result.prNumber).toBeNull();
    expect(await github.findPullRequestForBranch("ralph/6-hardening")).toBeNull();
    expect(store.getRunByIssue(6)!.status).toBe("agent-stuck");
    expect(github.addedLabels.some((l) => l.label === LABEL_AGENT_STUCK)).toBe(false);
    expect(worktrees.removed).toContain(result.worktreePath);
  });

  it("sets agent-stuck on a wall-clock kill and cleans the worktree (AC1)", async () => {
    github.seed({ number: 6, title: "Hardening" });
    // The runner reports the daemon-imposed wall-clock kill as a stuck terminal.
    const killed = new StuckAgentRunner({ category: "wall-clock", reason: "exceeded 3600s ceiling" });
    const ex = new Executor({ store, github, worktrees, agentRunner: killed, logger: silent });

    const result = await ex.run({ issue: github.issues.get(6)!, mode: "tdd" });

    expect(result.prNumber).toBeNull();
    // Status agent-stuck (the reconciler diff's label source, #82); no inline addLabel.
    expect(store.getRunByIssue(6)!.status).toBe("agent-stuck");
    expect(github.addedLabels.some((l) => l.label === LABEL_AGENT_STUCK)).toBe(false);
    expect(worktrees.removed).toContain(result.worktreePath);
    // The stuck terminal was recorded in the run log for live views.
    const stuckEvent = store.tailLog(store.getRunByIssue(6)!.id).find((e) => e.event === "agent-stuck");
    expect(stuckEvent?.data).toMatchObject({ category: "wall-clock" });
  });

  it("does not run the review loop on a stuck terminal", async () => {
    github.seed({ number: 6, title: "Hardening" });
    const stuck = new StuckAgentRunner({ category: "futility", reason: "cannot be done as scoped" });
    let reviewRan = false;
    const reviewLoop = {
      async run() {
        reviewRan = true;
        return { kind: "merged" as const };
      },
    };
    const ex = new Executor({ store, github, worktrees, agentRunner: stuck, logger: silent, reviewLoop: reviewLoop as never });

    await ex.run({ issue: github.issues.get(6)!, mode: "tdd" });

    expect(reviewRan).toBe(false);
    expect(github.merges).toHaveLength(0);
  });

  it("heartbeats the run log during the impl session (#42)", async () => {
    github.seed({ number: 8, title: "Long impl" });
    const controlled = new ControlledAgentRunner(github);
    // A tight heartbeat so several lines land while the agent is held "in flight".
    const ex = new Executor({ store, github, worktrees, agentRunner: controlled, logger: silent, heartbeatMs: 5 });

    const runPromise = ex.run({ issue: github.issues.get(8)!, mode: "tdd" });
    await waitFor(() => controlled.started.includes(8));

    const run = store.getRunByIssue(8)!;
    // Heartbeats accumulate in the run log the monitor tails — live progress.
    await waitFor(() => store.tailLog(run.id).some((e) => e.event === "impl-heartbeat"));
    const beats = store.tailLog(run.id).filter((e) => e.event === "impl-heartbeat");
    expect(beats[0]!.data).toHaveProperty("elapsedSeconds");

    controlled.complete(8, "ralph/8-long-impl");
    await runPromise;

    // The heartbeat stops once the session ends — no unbounded growth after.
    const before = store.tailLog(run.id).filter((e) => e.event === "impl-heartbeat").length;
    await delay(25);
    const after = store.tailLog(run.id).filter((e) => e.event === "impl-heartbeat").length;
    expect(before).toBeGreaterThan(0);
    expect(after).toBe(before);
  });

  it("does not heartbeat when disabled (heartbeatMs <= 0)", async () => {
    github.seed({ number: 9, title: "No beats" });
    const controlled = new ControlledAgentRunner(github);
    const ex = new Executor({ store, github, worktrees, agentRunner: controlled, logger: silent, heartbeatMs: 0 });

    const runPromise = ex.run({ issue: github.issues.get(9)!, mode: "tdd" });
    await waitFor(() => controlled.started.includes(9));
    await delay(20);
    const run = store.getRunByIssue(9)!;
    expect(store.tailLog(run.id).some((e) => e.event === "impl-heartbeat")).toBe(false);

    controlled.complete(9, "ralph/9-no-beats");
    await runPromise;
  });

  it("tears down the worktree and run row when the claim fails after worktree creation (AC4)", async () => {
    github.seed({ number: 9, title: "claim boom" });
    // The label removal is the last claim step, after the worktree + run row exist.
    github.removeLabel = async () => {
      throw new Error("gh removeLabel failed");
    };

    await expect(executor.claim({ issue: github.issues.get(9)!, mode: "tdd" })).rejects.toThrow(
      "removeLabel",
    );

    // No worktree leaked, and no `running` row left to wedge the issue.
    expect(worktrees.created).toHaveLength(1);
    expect(worktrees.removed).toEqual(worktrees.created.map((c) => c.path));
    expect(store.getRunByIssue(9)).toBeUndefined();
  });

  it("still cleans up the worktree when the agent throws", async () => {
    github.seed({ number: 3, title: "boom" });
    const throwing = {
      async run() {
        throw new Error("agent exploded");
      },
    };
    const ex = new Executor({ store, github, worktrees, agentRunner: throwing, logger: silent });
    await expect(ex.run({ issue: github.issues.get(3)!, mode: "tdd" })).rejects.toThrow("exploded");
    expect(worktrees.removed).toHaveLength(1);
  });

  it("terminalizes a mid-impl failure off `running` to agent-stuck and labels the issue (#34, AC1)", async () => {
    github.seed({ number: 34, title: "wedged" });
    const throwing = {
      async run() {
        throw new SyntaxError("Unexpected token '\\'");
      },
    };
    const ex = new Executor({ store, github, worktrees, agentRunner: throwing, logger: silent });

    await expect(ex.run({ issue: github.issues.get(34)!, mode: "tdd" })).rejects.toThrow("Unexpected token");

    // Never left `running` with no live agent: the row is terminal and the issue
    // is human-visible.
    expect(store.getRunByIssue(34)!.status).toBe("agent-stuck");
    expect(github.issues.get(34)!.labels).toContain(LABEL_AGENT_STUCK);
    // The thrown-session terminal closes the run span too (#80): the failure guard
    // appends RunEnded{stuck}, so the projection shows the span ended — mirroring
    // recordAgentStuck (stuck.test.ts) and discardOrphan, not left open for a later
    // re-pickup to abandon. Asymmetry here would mislabel this `agent-stuck` outcome.
    expect((await store.aggregateIssue(34)).state.ended).toBe(true);
    // The structured failure is in the run log for live views.
    const log = store.tailLog(store.getRunByIssue(34)!.id);
    expect(log.some((e) => e.event === "executor-failed")).toBe(true);
  });

  it("does NOT terminalize to agent-stuck when a session is interrupted by a drain (Codex SIGINT, #131)", async () => {
    // The OpenAI (Codex) CLI shares the daemon's process group (ADR-0033), so a terminal
    // SIGINT during a graceful drain kills it mid-session and it throws out of the failure
    // guard — an interruption, not a fault. With the drain signal aborted, the run must be
    // left RESUMABLE (running, PR open, no human label) so the next startup's orphan sweep
    // re-drives it from the surviving PR — never falsely paged as agent-stuck (the live
    // incident on #117/#136/#111 after enabling the Codex provider).
    github.seed({ number: 71, title: "drained mid-codex" });
    const drain = new AbortController();
    drain.abort(); // the daemon is already draining when the session dies
    const branch = "ralph/71-drained-mid-codex";
    const openThenThrow = {
      async run(ctx: { issue: { number: number }; branch: string }) {
        github.openPullRequest(ctx.branch, `Closes #${ctx.issue.number}`);
        // Mirrors the live signature: `Codex Exec exited with code 1` on the group SIGINT.
        throw new Error("Codex Exec exited with code 1: Reading prompt from stdin...");
      },
    };
    const ex = new Executor({
      store,
      github,
      worktrees,
      agentRunner: openThenThrow as never,
      logger: silent,
      drainSignal: drain.signal,
    });

    await expect(ex.run({ issue: github.issues.get(71)!, mode: "tdd" })).rejects.toThrow("Codex Exec");

    // Left `running` (NOT agent-stuck) for the next startup's orphan sweep to re-drive…
    expect(store.getRunByIssue(71)!.status).toBe("running");
    // …no human-attention label was added…
    expect(github.issues.get(71)!.labels).not.toContain(LABEL_AGENT_STUCK);
    // …the agent's PR is left OPEN, not closed as an orphan…
    expect(await github.listOpenPullRequests()).toHaveLength(1);
    expect((await github.findPullRequestForBranch(branch))!.state).toBe("OPEN");
    // …and the worktree is still torn down (the slot frees).
    expect(worktrees.removed).toContain(worktrees.created[0]!.path);
  });

  it("still terminalizes a session fault to agent-stuck when NOT draining (the guard is drain-scoped)", async () => {
    // Symmetry: a drain signal that is merely present but NOT aborted must not disable the
    // failure guard — a genuine fault outside a drain still terminalizes (mirrors #34), so
    // the no-silent-loss invariant holds the other way.
    github.seed({ number: 72, title: "genuine fault, no drain" });
    const drain = new AbortController(); // never aborted
    const throwing = {
      async run() {
        throw new Error("Codex Exec exited with code 1: Reading prompt from stdin...");
      },
    };
    const ex = new Executor({
      store,
      github,
      worktrees,
      agentRunner: throwing as never,
      logger: silent,
      drainSignal: drain.signal,
    });

    await expect(ex.run({ issue: github.issues.get(72)!, mode: "tdd" })).rejects.toThrow("Codex Exec");
    expect(store.getRunByIssue(72)!.status).toBe("agent-stuck");
    expect(github.issues.get(72)!.labels).toContain(LABEL_AGENT_STUCK);
  });

  it("does NOT terminalize when a session throws a usage-limit mid-review — leaves it resumable (ADR-0028)", async () => {
    // A transient OAuth weekly-cap hit mid-review/fix must NOT bin a reviewed PR to
    // agent-stuck. Like the drain case, the run is left RESUMABLE (running, PR open, no
    // human label) so the per-tick orphan sweep re-drives it on the login with headroom
    // (the backend already tripped the meter cooldown). This is the live #2128/#2117
    // incident: account A weekly-capped, every backlog item terminalized to agent-stuck.
    github.seed({ number: 73, title: "capped mid-review" });
    const branch = "ralph/73-capped-mid-review";
    const openThenCap = {
      async run(ctx: { issue: { number: number }; branch: string }) {
        github.openPullRequest(ctx.branch, `Closes #${ctx.issue.number}`);
        throw new UsageLimitError("Claude AI usage limit reached|1750000000");
      },
    };
    const ex = new Executor({ store, github, worktrees, agentRunner: openThenCap as never, logger: silent });

    await expect(ex.run({ issue: github.issues.get(73)!, mode: "tdd" })).rejects.toBeInstanceOf(UsageLimitError);

    expect(store.getRunByIssue(73)!.status).toBe("running"); // resumable, not terminal
    expect(github.issues.get(73)!.labels).not.toContain(LABEL_AGENT_STUCK);
    expect((await github.findPullRequestForBranch(branch))!.state).toBe("OPEN");
    expect(worktrees.removed).toContain(worktrees.created[0]!.path); // slot still frees
  });

  it("closes the orphaned PR a failed impl session opened and leaves none dangling (#34, AC2/AC4)", async () => {
    // Mirrors the live #9 incident: the agent opened a PR, then the result-parse
    // threw — the run wedged `running` with the PR dangling and no live agent.
    github.seed({ number: 34, title: "orphan pr" });
    const branch = "ralph/34-orphan-pr";
    const openThenThrow = {
      async run(ctx: { issue: { number: number }; branch: string }) {
        github.openPullRequest(ctx.branch, `Closes #${ctx.issue.number}`);
        throw new SyntaxError("Unexpected token '\\'");
      },
    };
    const ex = new Executor({ store, github, worktrees, agentRunner: openThenThrow as never, logger: silent });

    await expect(ex.run({ issue: github.issues.get(34)!, mode: "tdd" })).rejects.toThrow();

    // No `running` orphan…
    expect(store.getRunByIssue(34)!.status).toBe("agent-stuck");
    // …and no dangling PR: the one the agent opened is closed.
    const pr = await github.findPullRequestForBranch(branch);
    expect(pr!.state).toBe("CLOSED");
    expect(await github.listOpenPullRequests()).toHaveLength(0);
    // The worktree was still torn down.
    expect(worktrees.removed).toContain(worktrees.created[0]!.path);
  });

  it("does NOT terminalize a succeeded run when the post-success PR read trips on rate-limit (issue 2071)", async () => {
    // The live incident: the agent succeeded and opened a PR, then the
    // `findPullRequestForBranch` read back tripped a GitHub rate-limit blip — and
    // the failure guard flipped the *successful* run to `agent-stuck`, paging a
    // human for work that actually landed. The read failure must instead leave the
    // row `running` so the orphan sweep re-drives it once GitHub is reachable.
    github.seed({ number: 34, title: "rate-limited pr read" });
    const branch = "ralph/34-rate-limited-pr-read";
    const openThenSucceed = {
      async run(ctx: { issue: { number: number }; branch: string }) {
        github.openPullRequest(ctx.branch, `Closes #${ctx.issue.number}`);
        return { ok: true, escalated: false };
      },
    };
    // The post-success read throws a rate-limit error (gh client retries already
    // exhausted); every other github call still works.
    github.findPullRequestForBranch = (async () => {
      throw new Error("GraphQL: API rate limit already exceeded for user ID 8167862.");
    }) as typeof github.findPullRequestForBranch;
    const ex = new Executor({ store, github, worktrees, agentRunner: openThenSucceed as never, logger: silent });

    // It does NOT reject — the run settles cleanly, with no PR number recorded yet.
    const result = await ex.run({ issue: github.issues.get(34)!, mode: "tdd" });
    expect(result.prNumber).toBeNull();

    // Left `running` (NOT agent-stuck) for the next tick's orphan sweep to recover…
    expect(store.getRunByIssue(34)!.status).toBe("running");
    // …the issue is not labelled for human attention…
    expect(github.issues.get(34)!.labels).not.toContain(LABEL_AGENT_STUCK);
    // …the agent's PR is left OPEN, not closed as an orphan…
    expect(await github.listOpenPullRequests()).toHaveLength(1);
    // …and the worktree is still torn down (the slot frees).
    expect(worktrees.removed).toContain(worktrees.created[0]!.path);
  });

  it("defers (re-adds ready-for-agent, drops the run) on a Claude usage-limit hit — never agent-stuck", async () => {
    // The session-limit storm: the agent aborts on the OAuth plan limit. That is
    // transient, so the run must NOT terminalize to agent-stuck — it should restore
    // `ready-for-agent` and drop the run so the issue is re-admitted once the usage
    // cooldown clears.
    github.seed({ number: 42, title: "usage limited" });
    const limitedRunner = {
      async run() {
        return { ok: false, escalated: false, limited: true };
      },
    };
    const ex = new Executor({ store, github, worktrees, agentRunner: limitedRunner as never, logger: silent });

    const result = await ex.run({ issue: github.issues.get(42)!, mode: "tdd" });
    expect(result.prNumber).toBeNull();

    // The run row is dropped (not agent-stuck) — a clean slate for re-admission…
    expect(store.getRunByIssue(42)).toBeUndefined();
    // …the issue is back to `ready-for-agent` and carries NO human-attention label…
    expect(github.issues.get(42)!.labels).toContain(LABEL_READY);
    expect(github.issues.get(42)!.labels).not.toContain(LABEL_AGENT_STUCK);
    // …no PR was opened, and the worktree was still torn down.
    expect(await github.listOpenPullRequests()).toHaveLength(0);
    expect(worktrees.removed).toContain(worktrees.created[0]!.path);
  });

  // ── GitHub rate-limit defer-not-stuck on the terminal paths (issue #101) ──────
  // ADR-0023's defect class on the GitHub side: a transient `gh` rate-limit must
  // never manufacture `agent-stuck`. The merge and resume paths bypass/exhaust the
  // gh client's retry, so a limit there must DEFER (retry next tick), not terminalize.

  /** A real ReviewLoop with a clean review + no CI gate, so runIntegration goes straight to merge. */
  function makeIntegrationReviewLoop(): ReviewLoop {
    return new ReviewLoop({
      store,
      github,
      reviewAgent: new ScriptedReviewAgent([{ items: [] }]),
      fixAgent: new ScriptedFixAgent(),
      logger: silent,
      maxFixAttempts: 3,
      worktrees,
      baseBranch: "main",
      merge: { method: "squash", waitForChecks: false, ciTimeoutMinutes: 30, pollIntervalSeconds: 30, deleteBranch: true },
    });
  }

  /** Seed an `awaiting-merge` run (event stream populated) with an open PR, ready for integrate. */
  async function seedAwaitingMerge(n: number, title: string): Promise<{ branch: string; pr: PullRequest }> {
    github.seed({ number: n, title });
    const branch = `ralph/${n}-${title.toLowerCase().replace(/\s+/g, "-")}`;
    const pr = github.openPullRequest(branch, `Closes #${n}`);
    const wt = `/wt/${n}`;
    const created = store.upsertRun({ issueNumber: n, mode: "tdd", status: "running", branch, worktreePath: wt, prNumber: pr.number });
    await store.recordRunStarted({ runId: created.id, issueNumber: n, mode: "tdd", branch, worktreePath: wt });
    // Status is event-derived (#83): the review→integration hand-off fact folds to awaiting-merge.
    await store.recordReviewPassed({ runId: created.id, issueNumber: n });
    await github.addLabel(n, LABEL_AWAITING_MERGE);
    return { branch, pr };
  }

  it("defers (stays awaiting-merge, keeps the PR open) when `gh pr merge` trips a rate-limit (#101 AC2)", async () => {
    const { pr } = await seedAwaitingMerge(50, "merge limited");
    // The merge trips the GraphQL rate limit (the gh client's retries already exhausted).
    github.mergePullRequest = (async () => {
      throw new Error("GraphQL: API rate limit already exceeded for user ID 8167862.");
    }) as typeof github.mergePullRequest;
    const ex = new Executor({ store, github, worktrees, agentRunner, logger: silent, reviewLoop: makeIntegrationReviewLoop() });

    // It does NOT reject and does NOT terminalize — the run defers cleanly.
    await ex.integrate(store.getRunByIssue(50)!, github.issues.get(50)!, pr);

    // Still awaiting-merge (status + durable label) for the next tick's merge worker to retry…
    expect(store.getRunByIssue(50)!.status).toBe("awaiting-merge");
    expect(github.issues.get(50)!.labels).toContain(LABEL_AWAITING_MERGE);
    // …NOT flipped to agent-stuck, and the clean PR is left OPEN (never closed)…
    expect(github.issues.get(50)!.labels).not.toContain(LABEL_AGENT_STUCK);
    expect(github.closedPulls).toHaveLength(0);
    expect((await github.findPullRequestForBranch(pr.headRefName))!.state).toBe("OPEN");
    // …and the worktree is still torn down (the merge lease frees for the next tick).
    expect(worktrees.removed.length).toBeGreaterThan(0);
  });

  it("terminalizes agent-stuck + closes the PR when `gh pr merge` fails with a genuine fault (#101 AC2)", async () => {
    const { pr } = await seedAwaitingMerge(51, "merge boom");
    github.mergePullRequest = (async () => {
      throw new Error("pull request is not mergeable: merge conflict");
    }) as typeof github.mergePullRequest;
    const ex = new Executor({ store, github, worktrees, agentRunner, logger: silent, reviewLoop: makeIntegrationReviewLoop() });

    await expect(ex.integrate(store.getRunByIssue(51)!, github.issues.get(51)!, pr)).rejects.toThrow(/not mergeable/);

    // A genuine fault still terminalizes (the no-silent-loss invariant holds the other way).
    expect(store.getRunByIssue(51)!.status).toBe("agent-stuck");
    expect(github.issues.get(51)!.labels).toContain(LABEL_AGENT_STUCK);
    expect(github.closedPulls).toContain(pr.number);
    // The queue marker is cleared on a real terminal (the run left the merge queue).
    expect(github.issues.get(51)!.labels).not.toContain(LABEL_AWAITING_MERGE);
  });

  it("defers (restores the paused state, re-arms ready-for-agent) when a resumed session trips a rate-limit (#101 AC3)", async () => {
    github.seed({ number: 60, title: "resume limited" });
    const branch = "ralph/60-resume-limited";
    const created = store.upsertRun({ issueNumber: 60, mode: "tdd", status: "running", branch });
    await store.recordRunStarted({ runId: created.id, issueNumber: 60, mode: "tdd", branch });
    // Status is event-derived (#83): an escalation fact folds the run to awaiting-answer.
    await store.addQuestion({ issueNumber: 60, runId: created.id, kind: "escalate", headline: "h" });
    const limitedResume = {
      async run() {
        throw new Error("GraphQL: API rate limit already exceeded for user ID 8167862.");
      },
    };
    const ex = new Executor({ store, github, worktrees, agentRunner: limitedResume as never, logger: silent });

    // It does NOT reject and does NOT terminalize — the resume defers.
    await ex.resume({
      issue: github.issues.get(60)!,
      mode: "tdd",
      run: store.getRunByIssue(60)!,
      answer: "go",
      // No phase → impl-resume path, which drives the (rate-limited) agent (issue #9).
      context: { question: { headline: "h" } as never },
    });

    // Restored to the prior paused status (NOT agent-stuck)…
    expect(store.getRunByIssue(60)!.status).toBe("awaiting-answer");
    expect(github.issues.get(60)!.labels).not.toContain(LABEL_AGENT_STUCK);
    // …and re-armed `ready-for-agent` so the next tick's findResumableRuns re-resumes it.
    expect(github.issues.get(60)!.labels).toContain(LABEL_READY);
    // The worktree is still torn down (the slot frees for the next tick).
    expect(worktrees.removed.length).toBeGreaterThan(0);
  });

  it("terminalizes and closes the recorded PR when the review loop throws mid-run (#34, AC1/AC2)", async () => {
    github.seed({ number: 34, title: "review boom" });
    const reviewLoop = {
      async runReview() {
        throw new Error("review loop exploded");
      },
    };
    const ex = new Executor({
      store,
      github,
      worktrees,
      agentRunner,
      logger: silent,
      reviewLoop: reviewLoop as never,
    });

    await expect(ex.run({ issue: github.issues.get(34)!, mode: "tdd" })).rejects.toThrow("exploded");

    expect(store.getRunByIssue(34)!.status).toBe("agent-stuck");
    expect(github.issues.get(34)!.labels).toContain(LABEL_AGENT_STUCK);
    // The PR the impl agent opened (recorded on the run row) is closed, not left open.
    expect(await github.listOpenPullRequests()).toHaveLength(0);
    expect(worktrees.removed).toContain(worktrees.created[0]!.path);
  });

  // #21: healing a rebase-conflict park must never orphan the reviewed PR. Even on the guard path
  // that DOES terminalize (a divergence the daemon cannot attribute to its own runner push), the
  // reviewed work is parked HEALABLE instead of terminalizing to agent-stuck with the PR auto-closed.
  it("resume whose branch diverged unattributably parks review-maxed and leaves the reviewed PR OPEN (#21)", async () => {
    github.seed({ number: 21, title: "diverged heal" });
    const branch = "ralph/21-diverged-heal";
    const wt = "/wt/21";
    const pr = github.openPullRequest(branch, "Closes #21");
    const run = store.upsertRun({ issueNumber: 21, mode: "tdd", status: "running", branch, worktreePath: wt, prNumber: pr.number });
    await store.recordRunStarted({ runId: run.id, issueNumber: 21, mode: "tdd", branch, worktreePath: wt });
    // Model a rebase-conflict heal park at phase 0 (a review-maxed heal-card the operator answered).
    await store.recordReviewMaxedQuestion({ issueNumber: 21, runId: run.id, phase: 0, headline: "heal" });
    expect(store.getRunByIssue(21)!.status).toBe("review-maxed");

    // On resume the pre-review sync finds origin diverged from the local ref by a rewrite the daemon
    // CANNOT attribute to its own push (no recorded runner head) → the #255 guard fires.
    worktrees.scriptRebase(new BranchDivergedError(branch));
    const reviewLoop = new ReviewLoop({
      store,
      github,
      reviewAgent: new ScriptedReviewAgent([{ items: [] }]),
      fixAgent: new ScriptedFixAgent(),
      logger: silent,
      maxFixAttempts: 3,
      worktrees,
      baseBranch: "main",
      merge: { method: "squash", waitForChecks: false, ciTimeoutMinutes: 30, pollIntervalSeconds: 30, deleteBranch: true },
    });
    const ex = new Executor({ store, github, worktrees, agentRunner, logger: silent, reviewLoop });

    // The resume returns cleanly — it is NOT propagated into withFailureGuard (which would
    // terminalize agent-stuck and auto-close the PR).
    await ex.resume({
      issue: github.issues.get(21)!,
      mode: "tdd",
      run: store.getRunByIssue(21)!,
      answer: "retry the resolve",
      // A phase → review-loop re-entry (a review-maxed heal, issue #9).
      context: { phase: 0, question: { headline: "heal" } as never },
    });

    // Parked HEALABLE, not orphaned: review-maxed (NOT agent-stuck), the reviewed PR left OPEN.
    expect(store.getRunByIssue(21)!.status).toBe("review-maxed");
    expect(github.issues.get(21)!.labels).not.toContain(LABEL_AGENT_STUCK);
    expect(github.closedPulls).toHaveLength(0);
    expect((await github.findPullRequestForBranch(branch))!.state).toBe("OPEN");
  });

  it("still labels + closes the orphan PR when the failure-log append throws (#34, AC1/AC2)", async () => {
    // A transient append failure inside recordExecutorFailure (the same fault
    // startHeartbeat swallows) must not mask the original error or skip the
    // human-surfacing label + PR close.
    github.seed({ number: 34, title: "log boom" });
    const branch = "ralph/34-log-boom";
    const realAppendLog = store.appendLog.bind(store);
    store.appendLog = ((input: Parameters<typeof realAppendLog>[0]) => {
      if (input.event === "executor-failed") {
        throw new Error("SQLITE_BUSY: database is locked");
      }
      return realAppendLog(input);
    }) as typeof store.appendLog;

    const openThenThrow = {
      async run(ctx: { issue: { number: number }; branch: string }) {
        github.openPullRequest(ctx.branch, `Closes #${ctx.issue.number}`);
        throw new SyntaxError("Unexpected token '\\'");
      },
    };
    const ex = new Executor({ store, github, worktrees, agentRunner: openThenThrow as never, logger: silent });

    // The original error propagates — the store error never masks it.
    await expect(ex.run({ issue: github.issues.get(34)!, mode: "tdd" })).rejects.toThrow("Unexpected token");

    // …and both human-surfacing steps still ran despite the append throw.
    expect(store.getRunByIssue(34)!.status).toBe("agent-stuck");
    expect(github.issues.get(34)!.labels).toContain(LABEL_AGENT_STUCK);
    const pr = await github.findPullRequestForBranch(branch);
    expect(pr!.state).toBe("CLOSED");
    expect(await github.listOpenPullRequests()).toHaveLength(0);
  });

  it("still labels + closes the orphan PR when the run-row lookup throws (#34, AC1/AC2)", async () => {
    // A transient row-read failure inside recordExecutorFailure must fall through
    // to the branch PR lookup, not throw out and skip the label + PR close.
    github.seed({ number: 34, title: "lookup boom" });
    const branch = "ralph/34-lookup-boom";
    let failLookup = false;
    const realGetRunByIssue = store.getRunByIssue.bind(store);
    store.getRunByIssue = ((issueNumber: number) => {
      if (failLookup) throw new Error("SQLITE_BUSY: database is locked");
      return realGetRunByIssue(issueNumber);
    }) as typeof store.getRunByIssue;

    const openThenThrow = {
      async run(ctx: { issue: { number: number }; branch: string }) {
        github.openPullRequest(ctx.branch, `Closes #${ctx.issue.number}`);
        failLookup = true; // simulate a transient SQLITE_BUSY during failure handling
        throw new SyntaxError("Unexpected token '\\'");
      },
    };
    const ex = new Executor({ store, github, worktrees, agentRunner: openThenThrow as never, logger: silent });

    await expect(ex.run({ issue: github.issues.get(34)!, mode: "tdd" })).rejects.toThrow("Unexpected token");

    failLookup = false; // restore the real read for assertions
    expect(store.getRunByIssue(34)!.status).toBe("agent-stuck");
    expect(github.issues.get(34)!.labels).toContain(LABEL_AGENT_STUCK);
    const pr = await github.findPullRequestForBranch(branch);
    expect(pr!.state).toBe("CLOSED");
    expect(await github.listOpenPullRequests()).toHaveLength(0);
  });

  it("terminalizes a resume failure off `running` too (#34, AC3)", async () => {
    github.seed({ number: 34, title: "resume boom" });
    const branch = "ralph/34-resume-boom";
    const run = store.upsertRun({ issueNumber: 34, mode: "tdd", status: "awaiting-answer", branch });
    const throwing = {
      async run() {
        throw new Error("resume exploded");
      },
    };
    const ex = new Executor({ store, github, worktrees, agentRunner: throwing, logger: silent });

    await expect(
      ex.resume({
        issue: github.issues.get(34)!,
        mode: "tdd",
        run: store.getRunByIssue(34)!,
        answer: "do it",
        // No phase → impl-resume path, which drives the (throwing) agent (issue #9).
        context: { question: { headline: "h" } as never },
      }),
    ).rejects.toThrow("resume exploded");

    expect(store.getRunByIssue(34)!.status).toBe("agent-stuck");
    expect(github.issues.get(34)!.labels).toContain(LABEL_AGENT_STUCK);
    expect(run.id).toBe(store.getRunByIssue(34)!.id);
  });
});

describe("Executor.claim with a pre-existing ralph branch (issue #28, AC4)", () => {
  let store: Store;
  let github: FakeGitHub;
  let clone: string;
  let wtRoot: string;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" });
  }

  beforeEach(() => {
    store = openStore(MEMORY_DB).forRepo("acme/widgets");
    github = new FakeGitHub();
    const base = mkdtempSync(join(tmpdir(), "ralph-claim-"));
    clone = join(base, "clone");
    wtRoot = join(base, "wt");
    execFileSync("git", ["init", "-b", "master", clone]);
    git(clone, "config", "user.email", "test@example.com");
    git(clone, "config", "user.name", "Test");
    writeFileSync(join(clone, "README.md"), "base\n");
    git(clone, "add", "README.md");
    git(clone, "commit", "-m", "initial");
  });
  afterEach(() => store.close());

  it("claims an issue whose ralph branch already exists, instead of looping (AC4)", async () => {
    const worktrees = new GitWorktreeManager(clone, wtRoot);
    const executor = new Executor({
      store,
      github,
      worktrees,
      agentRunner: new PrOpeningAgentRunner(github),
      logger: silent,
    });
    github.seed({ number: 28, title: "Re-pickup collides" });

    // A prior run left the branch behind (worktree torn down, branch survives) —
    // exactly what made `git worktree add -b` fail every tick before the fix.
    const stale = await worktrees.create("ralph/28-re-pickup-collides", "28-re-pickup-collides");
    await worktrees.remove(stale);
    expect(git(clone, "branch", "--list", "ralph/28-re-pickup-collides")).toContain(
      "ralph/28-re-pickup-collides",
    );

    // The fresh claim must succeed (branch reset/reused), not throw.
    const claimed = await executor.claim({ issue: github.issues.get(28)!, mode: "tdd" });

    expect(claimed.branch).toBe("ralph/28-re-pickup-collides");
    expect(existsSync(claimed.worktreePath)).toBe(true);
    expect(git(claimed.worktreePath, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(
      "ralph/28-re-pickup-collides",
    );
    expect(store.getRunByIssue(28)!.status).toBe("running");
    expect(github.removedLabels).toContainEqual({ issue: 28, label: LABEL_READY });
  });
});
