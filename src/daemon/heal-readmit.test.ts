/**
 * The retired heal-readmit lane (#86 → ADR-0042 / issue #43).
 *
 * `agent-stuck` used to be a *healable* human-attention state: the operator answered its
 * stuck-card through `ralph-answer`, the label swapped back to `ready-for-agent`, and the next
 * tick re-admitted a fresh run with the answer injected into its impl prompt. The triage
 * cutover removed that: `agent-stuck` is a terminal only a completed master adjudication may
 * select, so an answer must never be able to un-terminalize it — that would make the master's
 * conclusion advisory, and one lifecycle would have quietly become two.
 *
 * What survives, and is asserted end-to-end here: the terminal still posts its self-explaining
 * card (the conclusion has to stay readable on the issue), the run is still marked terminal
 * with its span closed, and the issue still parks — but it is never offered as a question, no
 * answer re-admits it, and a run re-admitted by an operator's own re-label carries no injected
 * guidance, because there is no longer a lane that writes any.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../log/logger";
import { MEMORY_DB, openStore, type Store } from "../store/store";
import { Executor } from "../executor/executor";
import type { AgentRunContext, AgentRunner, AgentRunResult } from "../executor/agent";
import type { StuckReport } from "../executor/stuck-tool";
import { STUCK_CARD_FEATURE } from "../executor/stuck";
import { parseRalphQuestionComment } from "../review/escalation";
import { RalphAnswerService } from "../hitl/ralph-answer";
import { LABEL_AGENT_STUCK, LABEL_READY } from "../hitl/labels";
import { FakeGitHub } from "../testing/fake-github";
import { FakeWorktreeManager } from "../testing/fake-worktree";
import { buildLaunchMarker } from "../github/marker";
import { Reconciler, type ReconcileBudget } from "./reconciler";

const silent = createLogger({ write: () => {} });

function budgetFor(getActive: () => number, cap: number): ReconcileBudget {
  return { available: () => Math.max(0, cap - getActive()), hasCapacity: () => getActive() < cap };
}

const STUCK_REASON = "typecheck never went green after six edits to the migration";

/**
 * Bounds out on its first run (the stuck terminal), then on any later run records the context
 * it was handed and opens a PR — so a test can tell "never re-admitted" apart from
 * "re-admitted", and inspect what a re-admitted run was given.
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

describe("agent-stuck is a terminal, not a healable pause (ADR-0042 §7, issue #43)", () => {
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

  it("posts its card, parks, and is never offered for answering or re-admitted by an answer", async () => {
    github.seed({ number: 50, title: "Flaky migration" });

    // Tick 1: the impl run bounds out → the stuck terminal + a stuck-card comment.
    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(store.getRunByIssue(50)!.status).toBe("agent-stuck");
    const callsAfterStuck = runner.calls.length;
    expect(callsAfterStuck).toBe(1);
    // The span is closed — the run concluded, it is not paused mid-flight.
    expect((await store.aggregateIssue(50)).state.ended).toBe(true);

    // The conclusion is readable on the issue: the self-explaining card survives the cutover,
    // because a terminal a human cannot read is a terminal a human cannot act on.
    const card = parseRalphQuestionComment((github.comments.get(50) ?? [])[0]!.body);
    expect(card).not.toBeNull();
    expect(card!.feature).toBe(STUCK_CARD_FEATURE);
    expect(card!.whereWeStand).toContain(STUCK_REASON);

    // Tick 2 (effect): the `agent-stuck` label is a level-triggered effect of the agent-stuck
    // status (issue #82, ADR-0027) — the stuck terminal set the status in its session; the next
    // tick's desired-vs-actual diff applies the label (the accepted ≤1-tick latency). This tick
    // is also the no-self-restart guarantee: a parked stuck issue is never re-admitted on its
    // own — the diff labels it, but no fresh run starts.
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(runner.calls.length).toBe(callsAfterStuck);
    expect(store.getRunByIssue(50)!.status).toBe("agent-stuck");
    expect(github.issues.get(50)!.labels).toContain(LABEL_AGENT_STUCK);
    expect(github.issues.get(50)!.labels).not.toContain(LABEL_READY);

    // The card is NOT in the answer queue: it is a conclusion, not a question (#43). The
    // operator is told the issue is parked deliberately — through the terminal listing, not
    // through an answerable item.
    const answers = new RalphAnswerService(github);
    expect(await answers.list()).toEqual([]);
    expect((await answers.listTerminals()).map((t) => [t.issue.number, t.label])).toEqual([
      [50, LABEL_AGENT_STUCK],
    ]);

    // …so there is nothing for `serveOne` to serve, and no answer can swap the terminal back
    // to `ready-for-agent`. This is the load-bearing negative: the retired #86 lane's whole
    // mechanism was that swap.
    expect(
      await answers.serveOne(async () => "Regenerate the lockfile, then split the migration"),
    ).toBeNull();
    expect(github.issues.get(50)!.labels).toContain(LABEL_AGENT_STUCK);
    expect(github.issues.get(50)!.labels).not.toContain(LABEL_READY);

    // Tick 3: still parked, still no fresh run, no PR — the terminal holds until a human
    // acts on the issue itself.
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(runner.calls.length).toBe(callsAfterStuck);
    expect(store.getRunByIssue(50)!.prNumber).toBeNull();
    expect(worktrees.attached).toHaveLength(0); // never re-attached a WIP branch
  });

  it("re-admits on an operator's own re-label — carrying no injected guidance", async () => {
    // The supported move after the cutover: the operator reads the card, edits/re-scopes the
    // issue, and re-labels it `ready-for-agent` by hand. That re-admits a FRESH run (a stuck
    // run kept no WIP branch), and the run starts from the issue body alone — the executor no
    // longer scans the thread for stuck-heal guidance, because no answer can ever write any.
    github.seed({ number: 51, title: "Flaky migration" });
    await reconciler.tick();
    await reconciler.awaitInFlight();
    await reconciler.tick(); // the diff applies `agent-stuck`
    await reconciler.awaitInFlight();
    expect(runner.calls).toHaveLength(1);

    await github.applyLabelPatch(51, { remove: [LABEL_AGENT_STUCK], add: [LABEL_READY] });

    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(runner.calls).toHaveLength(2);
    const readmitted = runner.calls.at(-1)!;
    // Re-admit, not resume — and the run context has no other injection channel: the #86
    // guidance field is gone from `AgentRunContext` entirely (ADR-0042 / #43).
    expect(readmitted.resume).toBeUndefined();
    expect(store.getRunByIssue(51)!.prNumber).not.toBeNull();
  });
});
