/**
 * The worker → master hand-off (ADR-0041), driven through the real {@link Executor} with the
 * fake GitHub/worktree/agent ports.
 *
 * The acceptance criterion these tests exist for is a *negative* one: after this slice a
 * worker `escalate` or `stuck` must produce **no** `ralph-question`, **no** `awaiting-answer`,
 * and **no** terminal `agent-stuck`. Asserting the absence is the point — the old behaviour
 * would still pass a test that only checked the new state was reached.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../log/logger";
import { MEMORY_DB, openStore, type ScopedStore } from "../store/store";
import { FakeGitHub } from "../testing/fake-github";
import { FakeWorktreeManager } from "../testing/fake-worktree";
import { EscalatingAgentRunner, StuckAgentRunner } from "../testing/fake-agent";
import { Executor } from "../executor/executor";
import { EscalationCheckpointer } from "../hitl/escalation-checkpoint";
import {
  LABEL_AGENT_STUCK,
  LABEL_AWAITING_ANSWER,
  LABEL_COMPLEXITY_1,
  LABEL_COMPLEXITY_2,
  LABEL_COMPLEXITY_3,
} from "../core/labels";
import { RALPH_QUESTION_FENCE, type EscalationQuestion } from "../review/escalation";
import { MasterTriageRequester, parseMasterRequestComment } from "./request";
import { foldMasterHistory } from "./history";

const silent = createLogger({ write: () => {} });
const REPO = "acme/widgets";

const question: EscalationQuestion = {
  headline: "Two contracts disagree and design authority is silent",
  feature: "Widget pipeline",
  whereWeStand: "I tried widening the union; the review rubric rejects it.",
  decision: "Which contract is authoritative for the widget payload?",
  stakes: "Choosing wrong strands every downstream consumer of the pipeline.",
  recommendation: "Loosen the schema so both shapes parse.",
};

describe("worker escalate/stuck hand the decision up to the master (ADR-0041)", () => {
  let store: ScopedStore;
  let github: FakeGitHub;
  let worktrees: FakeWorktreeManager;

  beforeEach(() => {
    store = openStore(MEMORY_DB).forRepo(REPO);
    github = new FakeGitHub(REPO);
    worktrees = new FakeWorktreeManager();
  });

  function executorWith(runner: EscalatingAgentRunner | StuckAgentRunner): Executor {
    return new Executor({
      store,
      github,
      worktrees,
      agentRunner: runner,
      logger: silent,
      masterTriage: new MasterTriageRequester({ store, github, worktrees }),
    });
  }

  it("escalate: preserves WIP, enters master-triage, and creates NO human question", async () => {
    github.seed({ number: 5, title: "Widget pipeline", labels: ["ready-for-agent", "afk", "mode:tdd"] });

    const result = await executorWith(new EscalatingAgentRunner(question)).run({
      issue: github.issues.get(5)!,
      mode: "tdd",
    });

    // WIP preserved: the branch was checkpointed and a draft PR opened.
    expect(worktrees.checkpointed).toHaveLength(1);
    expect(result.prNumber).not.toBeNull();
    expect(github.draftPulls).toHaveLength(1);

    // The run is queued for the master, not parked for a human.
    expect(store.getRunByIssue(5)!.status).toBe("master-triage");

    // NO ralph-question, NO awaiting-answer, NO agent-stuck.
    const bodies = (github.comments.get(5) ?? []).map((c) => c.body);
    expect(bodies.some((b) => b.includes(RALPH_QUESTION_FENCE))).toBe(false);
    expect(store.listOpenQuestions()).toHaveLength(0);
    expect(github.addedLabels.map((l) => l.label)).not.toContain(LABEL_AWAITING_ANSWER);
    expect(github.addedLabels.map((l) => l.label)).not.toContain(LABEL_AGENT_STUCK);
  });

  it("stuck: preserves WIP, enters master-triage, and does NOT terminalize", async () => {
    github.seed({ number: 6, title: "Widget pipeline", labels: ["ready-for-agent", "afk", "mode:tdd"] });

    await executorWith(
      new StuckAgentRunner({ category: "no-green-build", reason: "12 edits and the suite is still red" }),
    ).run({ issue: github.issues.get(6)!, mode: "tdd" });

    expect(worktrees.checkpointed).toHaveLength(1);
    expect(store.getRunByIssue(6)!.status).toBe("master-triage");
    const bodies = (github.comments.get(6) ?? []).map((c) => c.body);
    expect(bodies.some((b) => b.includes(RALPH_QUESTION_FENCE))).toBe(false);
    expect(github.addedLabels.map((l) => l.label)).not.toContain(LABEL_AGENT_STUCK);
  });

  it("emits distinct master-request sources for escalate and stuck", async () => {
    github.seed({ number: 5, title: "A", labels: ["ready-for-agent", "afk", "mode:tdd"] });
    github.seed({ number: 6, title: "B", labels: ["ready-for-agent", "afk", "mode:tdd"] });

    await executorWith(new EscalatingAgentRunner(question)).run({ issue: github.issues.get(5)!, mode: "tdd" });
    await executorWith(
      new StuckAgentRunner({ category: "futility", reason: "cannot be completed as scoped" }),
    ).run({ issue: github.issues.get(6)!, mode: "tdd" });

    expect(foldMasterHistory(store.readIssueStream(5)).pending).toMatchObject({
      source: "escalate",
      lane: "impl",
      phase: "impl",
    });
    expect(foldMasterHistory(store.readIssueStream(6)).pending).toMatchObject({
      source: "stuck",
      lane: "impl",
      phase: "impl",
    });
  });

  it("carries the worker's recommendation and evidence into a durable, parseable request", async () => {
    github.seed({ number: 5, title: "Widget pipeline", labels: ["ready-for-agent", "afk", "mode:tdd"] });

    await executorWith(new EscalatingAgentRunner(question)).run({ issue: github.issues.get(5)!, mode: "tdd" });

    const payload = (github.comments.get(5) ?? [])
      .map((c) => parseMasterRequestComment(c.body))
      .find((p) => p !== null);
    expect(payload).not.toBeNull();
    expect(payload!.evidence.recommendation).toBe("Loosen the schema so both shapes parse.");
    expect(payload!.evidence.attemptedFixes).toContain("widening the union");
    expect(payload!.evidence.question).toEqual(question);
    expect(payload!.signature).toContain("escalate|impl|");
  });

  it("frees the worker's ordinary slot — the session returns, nothing is reserved", async () => {
    github.seed({ number: 5, title: "Widget pipeline", labels: ["ready-for-agent", "afk", "mode:tdd"] });
    const runner = new EscalatingAgentRunner(question);

    const result = await executorWith(runner).run({ issue: github.issues.get(5)!, mode: "tdd" });

    // The executor returned (the caller's `occupySlot` frees on settle) and the worktree
    // was torn down — there is no reservation and no hand-off.
    expect(result.runId).toBeGreaterThan(0);
    expect(worktrees.removed).toHaveLength(1);
  });

  describe("first escalation promotes the issue to complexity:1", () => {
    it("swaps a lower tier for exactly complexity:1, atomically", async () => {
      github.seed({
        number: 5,
        title: "Widget pipeline",
        labels: ["ready-for-agent", "afk", "mode:tdd", LABEL_COMPLEXITY_3],
      });

      await executorWith(new EscalatingAgentRunner(question)).run({ issue: github.issues.get(5)!, mode: "tdd" });

      expect(github.labelPatches).toEqual([
        { issue: 5, remove: [LABEL_COMPLEXITY_3], add: [LABEL_COMPLEXITY_1] },
      ]);
      expect(github.issues.get(5)!.labels).toContain(LABEL_COMPLEXITY_1);
      expect(github.issues.get(5)!.labels).not.toContain(LABEL_COMPLEXITY_3);
      expect(foldMasterHistory(store.readIssueStream(5)).promoted).toBe(true);
    });

    it("collapses DUPLICATE complexity labels to exactly complexity:1 in one patch", async () => {
      github.seed({
        number: 5,
        title: "Widget pipeline",
        labels: ["ready-for-agent", "afk", "mode:tdd", LABEL_COMPLEXITY_2, LABEL_COMPLEXITY_3],
      });

      await executorWith(new EscalatingAgentRunner(question)).run({ issue: github.issues.get(5)!, mode: "tdd" });

      expect(github.labelPatches).toEqual([
        { issue: 5, remove: [LABEL_COMPLEXITY_2, LABEL_COMPLEXITY_3], add: [LABEL_COMPLEXITY_1] },
      ]);
      const labels = github.issues.get(5)!.labels;
      expect(labels.filter((l) => l.startsWith("complexity:"))).toEqual([LABEL_COMPLEXITY_1]);
    });

    it("is idempotent — a second escalation on an already-promoted issue writes no label", async () => {
      github.seed({
        number: 5,
        title: "Widget pipeline",
        labels: ["ready-for-agent", "afk", "mode:tdd", LABEL_COMPLEXITY_1],
      });

      await executorWith(new EscalatingAgentRunner(question)).run({ issue: github.issues.get(5)!, mode: "tdd" });

      expect(github.labelPatches).toEqual([]);
      // …and no second promotion fact.
      const promotions = store
        .readIssueStream(5)
        .filter((e) => e.type === "ComplexityPromoted");
      expect(promotions).toHaveLength(0);
    });

    it("records the run at tier 1 so every later dispatch reads the promoted profile", async () => {
      github.seed({
        number: 5,
        title: "Widget pipeline",
        labels: ["ready-for-agent", "afk", "mode:tdd", LABEL_COMPLEXITY_2],
      });

      await executorWith(new EscalatingAgentRunner(question)).run({ issue: github.issues.get(5)!, mode: "tdd" });

      expect(store.getRunByIssue(5)!.tier).toBe(1);
    });
  });

  describe("without a master engine wired the legacy behaviour is untouched", () => {
    it("escalate still posts a ralph-question and parks on awaiting-answer", async () => {
      github.seed({ number: 5, title: "Widget pipeline", labels: ["ready-for-agent", "afk", "mode:tdd"] });
      const executor = new Executor({
        store,
        github,
        worktrees,
        agentRunner: new EscalatingAgentRunner(question),
        logger: silent,
        escalation: new EscalationCheckpointer({ store, github, worktrees }),
      });

      await executor.run({ issue: github.issues.get(5)!, mode: "tdd" });

      const bodies = (github.comments.get(5) ?? []).map((c) => c.body);
      expect(bodies.some((b) => b.includes(RALPH_QUESTION_FENCE))).toBe(true);
      expect(store.getRunByIssue(5)!.status).toBe("awaiting-answer");
      expect(github.labelPatches).toEqual([]);
    });

    it("stuck still terminalizes to agent-stuck", async () => {
      github.seed({ number: 6, title: "Widget pipeline", labels: ["ready-for-agent", "afk", "mode:tdd"] });
      const executor = new Executor({
        store,
        github,
        worktrees,
        agentRunner: new StuckAgentRunner({ category: "futility", reason: "no" }),
        logger: silent,
      });

      await executor.run({ issue: github.issues.get(6)!, mode: "tdd" });

      expect(store.getRunByIssue(6)!.status).toBe("agent-stuck");
    });
  });
});
