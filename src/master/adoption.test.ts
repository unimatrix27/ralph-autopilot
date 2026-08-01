/**
 * The migration matrix (ADR-0042 "Recovery and migration"): every pre-cutover park either
 * adopts into the master queue exactly once, or is deliberately left alone with a stated
 * reason. Pure planner first, then the reconciler pass end-to-end over the fake ports.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { MEMORY_DB, openStore, type ScopedStore } from "../store/store";
import { FakeGitHub } from "../testing/fake-github";
import { FakeWorktreeManager } from "../testing/fake-worktree";
import { createLogger } from "../log/logger";
import { Reconciler, type ReconcileBudget } from "../daemon/reconciler";
import { Executor } from "../executor/executor";
import { LABEL_AGENT_STUCK, LABEL_AWAITING_ANSWER, LABEL_MASTER_TRIAGE, LABEL_REVIEW_MAXED } from "../core/labels";
import { RALPH_QUESTION_FENCE, formatRalphQuestion } from "../review/escalation";
import { legacyHealCardComment } from "../testing/legacy-cards";
import { seedRun } from "../testing/seed-run";
import type { Issue, Run } from "../store/types";
import { HarnessMasterEscalation } from "./harness-escalation";
import { foldMasterHistory } from "./history";
import { planAdoption, hasMasterAdjudication } from "./adoption";
import { RALPH_MASTER_REQUEST_FENCE } from "./request";

const REPO = "owner/repo";
const silent = createLogger({ write: () => {} });

const issue = (over: Partial<Issue> = {}): Pick<Issue, "number" | "state" | "labels"> => ({
  number: 1,
  state: "OPEN",
  labels: [],
  ...over,
});

const run = (over: Partial<Run> = {}): Run =>
  ({
    id: 1,
    repo: REPO,
    issueNumber: 1,
    mode: "tdd",
    tier: null,
    status: "running",
    branch: "ralph/1-x",
    worktreePath: "/w/1",
    prNumber: 10,
    issueTitle: "x",
    runnerPushedSha: null,
    createdAt: "",
    updatedAt: "",
    ...over,
  }) as Run;

const base = {
  healPhase: null,
  masterAdjudicated: false,
  masterQueued: false,
  unansweredQuestion: false,
};

describe("planAdoption (ADR-0042 migration)", () => {
  it("adopts a pre-cutover `review-maxed` label, preserving its heal phase", () => {
    const plan = planAdoption({
      ...base,
      issue: issue({ labels: [LABEL_REVIEW_MAXED] }),
      run: run({ status: "review-maxed" }),
      healPhase: 2,
    });
    expect(plan).toMatchObject({ kind: "review-maxed", source: "review-maxed", phase: "review-2" });
  });

  it("adopts a `review-maxed` run status even when the label was hand-removed", () => {
    const plan = planAdoption({ ...base, issue: issue(), run: run({ status: "review-maxed" }) });
    expect(plan?.kind).toBe("review-maxed");
    // No recoverable heal phase → phase 1, the review phase a maxout most often reaches.
    expect(plan?.phase).toBe("review-1");
  });

  it("adopts a non-master `agent-stuck` terminal", () => {
    const plan = planAdoption({
      ...base,
      issue: issue({ labels: [LABEL_AGENT_STUCK] }),
      run: run({ status: "agent-stuck" }),
    });
    expect(plan).toMatchObject({ kind: "agent-stuck", source: "stuck", phase: "impl" });
  });

  it("leaves an `agent-stuck` a master ALREADY adjudicated alone", () => {
    expect(
      planAdoption({
        ...base,
        issue: issue({ labels: [LABEL_AGENT_STUCK] }),
        run: run({ status: "agent-stuck" }),
        masterAdjudicated: true,
      }),
    ).toBeNull();
  });

  it("leaves a live unanswered question alone — that is a real question", () => {
    expect(
      planAdoption({
        ...base,
        issue: issue({ labels: [LABEL_AWAITING_ANSWER] }),
        run: run({ status: "awaiting-answer" }),
        unansweredQuestion: true,
      }),
    ).toBeNull();
  });

  it("adopts an ANSWERED-but-stranded pause that also carries a retired label", () => {
    // The #132 wedge on a pre-cutover build: answered, never re-armed, and `review-maxed`.
    const plan = planAdoption({
      ...base,
      issue: issue({ labels: [LABEL_AWAITING_ANSWER, LABEL_REVIEW_MAXED] }),
      run: run({ status: "review-maxed" }),
      unansweredQuestion: false,
    });
    expect(plan?.kind).toBe("review-maxed");
  });

  it("leaves an already-queued or already-adjudicating run alone (no double request)", () => {
    expect(
      planAdoption({ ...base, issue: issue({ labels: [LABEL_REVIEW_MAXED] }), run: run(), masterQueued: true }),
    ).toBeNull();
    expect(
      planAdoption({ ...base, issue: issue({ labels: [LABEL_REVIEW_MAXED] }), run: run({ status: "master-triage" }) }),
    ).toBeNull();
  });

  it("leaves a run with no run row alone — there is nothing to adjudicate", () => {
    expect(planAdoption({ ...base, issue: issue({ labels: [LABEL_REVIEW_MAXED] }), run: null })).toBeNull();
  });

  it("leaves a closed issue alone", () => {
    expect(
      planAdoption({
        ...base,
        issue: issue({ state: "CLOSED", labels: [LABEL_AGENT_STUCK] }),
        run: run({ status: "agent-stuck" }),
      }),
    ).toBeNull();
  });

  it("reads a completed master adjudication out of the stream", () => {
    expect(hasMasterAdjudication([])).toBe(false);
    expect(
      hasMasterAdjudication([{ type: "MasterStuck", data: {}, streamPosition: 0, globalPosition: 0 }]),
    ).toBe(true);
  });
});

function budgetFor(getActive: () => number, cap: number): ReconcileBudget {
  return { available: () => Math.max(0, cap - getActive()), hasCapacity: () => getActive() < cap };
}

describe("the reconciler's adoption pass (ADR-0042 migration)", () => {
  let github: FakeGitHub;
  let store: ScopedStore;
  let reconciler: Reconciler;

  beforeEach(() => {
    github = new FakeGitHub(REPO);
    store = openStore(MEMORY_DB).forRepo(REPO);
    const worktrees = new FakeWorktreeManager();
    const executor = new Executor({
      store,
      github,
      worktrees,
      agentRunner: { run: async () => ({ ok: true, escalated: false }) },
      logger: silent,
    });
    reconciler = new Reconciler({
      store,
      github,
      executor,
      worktrees,
      logger: silent,
      budget: budgetFor(() => reconciler.activeCount(), 0), // no capacity: adoption only
      cap: 0,
      priorityLabels: [],
      targetRepo: REPO,
      masterEscalation: new HarnessMasterEscalation({ store, github, logger: silent }),
    });
  });

  it("adopts a pre-cutover review-maxed park exactly once, preserving its evidence", async () => {
    github.seed({ number: 5, title: "Old maxout", labels: [LABEL_REVIEW_MAXED, "afk", "mode:tdd"] });
    void github.postComment(
      5,
      legacyHealCardComment({ phase: 1, attempts: 3, blockers: [{ severity: "P0", title: "race on retry" }] }),
    );
    await seedRun(store, { issueNumber: 5, mode: "tdd", status: "review-maxed", branch: "ralph/5-old", prNumber: 50 });

    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(store.getRunByIssue(5)!.status).toBe("master-triage");
    const requests = (github.comments.get(5) ?? []).filter((c) => c.body.includes(RALPH_MASTER_REQUEST_FENCE));
    expect(requests).toHaveLength(1);
    // The retired label is stripped on the same tick, and no second question was posted.
    expect(github.issues.get(5)!.labels).not.toContain(LABEL_REVIEW_MAXED);
    expect((github.comments.get(5) ?? []).filter((c) => c.body.includes(RALPH_QUESTION_FENCE))).toHaveLength(1);

    // A second tick adopts nothing more — idempotent by (phase, signature).
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(store.readIssueStream(5).filter((e) => e.type === "MasterTriageRequested")).toHaveLength(1);
  });

  it("adopts a pre-cutover non-master agent-stuck terminal and converges to one state label", async () => {
    github.seed({ number: 6, title: "Old stuck", labels: [LABEL_AGENT_STUCK, "afk", "mode:tdd"] });
    await seedRun(store, { issueNumber: 6, mode: "tdd", status: "agent-stuck", branch: "ralph/6-old" });

    await reconciler.tick();
    await reconciler.awaitInFlight();
    // The status flips immediately; the level-triggered label effect lands on the next tick.
    expect(store.getRunByIssue(6)!.status).toBe("master-triage");
    await reconciler.tick();
    await reconciler.awaitInFlight();

    const labels = github.issues.get(6)!.labels;
    expect(labels).toContain(LABEL_MASTER_TRIAGE);
    expect(labels).not.toContain(LABEL_AGENT_STUCK);
    expect(labels).not.toContain(LABEL_REVIEW_MAXED);
  });

  it("never adopts a live unanswered question — the operator keeps it", async () => {
    github.seed({ number: 7, title: "Real question", labels: [LABEL_AWAITING_ANSWER, "afk", "mode:tdd"] });
    void github.postComment(
      7,
      formatRalphQuestion({
        headline: "Which contract is authoritative?",
        feature: "Ledger",
        whereWeStand: "Two committed contracts disagree about the storage node.",
        decision: "Which one governs?",
        stakes: "Choosing wrong changes what every future session is bound by.",
        recommendation: "Keep the older one unless the constraint lapsed.",
      }),
    );
    const seeded = await seedRun(store, { issueNumber: 7, mode: "tdd", status: "awaiting-answer" });
    expect(seeded.issueNumber).toBe(7);

    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(store.getRunByIssue(7)!.status).toBe("awaiting-answer");
    expect(foldMasterHistory(store.readIssueStream(7)).pending).toBeNull();
    expect(github.issues.get(7)!.labels).toContain(LABEL_AWAITING_ANSWER);
  });

  it("leaves a retired label with no run row to the completeness pass, not to adoption", async () => {
    github.seed({ number: 8, title: "No run", labels: [LABEL_REVIEW_MAXED, "afk", "mode:tdd"] });

    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(store.getRunByIssue(8)).toBeUndefined();
    expect((github.comments.get(8) ?? []).filter((c) => c.body.includes(RALPH_MASTER_REQUEST_FENCE))).toHaveLength(0);
  });

  it("survives a partial GitHub write — the request lands even when the label strip fails", async () => {
    github.seed({ number: 9, title: "Partial", labels: [LABEL_REVIEW_MAXED, "afk", "mode:tdd"] });
    await seedRun(store, { issueNumber: 9, mode: "tdd", status: "review-maxed", branch: "ralph/9-x" });
    const originalRemove = github.removeLabel.bind(github);
    let failed = false;
    github.removeLabel = async (n: number, label: string): Promise<void> => {
      if (label === LABEL_REVIEW_MAXED && !failed) {
        failed = true;
        throw new Error("rate limited");
      }
      return originalRemove(n, label);
    };

    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(store.getRunByIssue(9)!.status).toBe("master-triage");

    // The next tick's desired-vs-actual diff converges the labels anyway.
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(github.issues.get(9)!.labels).not.toContain(LABEL_REVIEW_MAXED);
    expect(store.readIssueStream(9).filter((e) => e.type === "MasterTriageRequested")).toHaveLength(1);
  });
});
