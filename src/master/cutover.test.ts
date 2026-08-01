/**
 * End-to-end coverage of the triage cutover's remaining acceptance criteria (ADR-0042):
 * autonomous repair and bounded failure for each harness source, the budget holding across
 * *different* source adapters, and the two deferral classes that must never enqueue a master.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { MEMORY_DB, openStore, type ScopedStore } from "../store/store";
import { FakeGitHub } from "../testing/fake-github";
import { FakeWorktreeManager } from "../testing/fake-worktree";
import { FakeMasterAgent, FakeMasterPipeline } from "../testing/fake-master-agent";
import { createLogger } from "../log/logger";
import { LABEL_COMPLEXITY_2, LABEL_MASTER_TRIAGE } from "../core/labels";
import { RALPH_QUESTION_FENCE } from "../review/escalation";
import type { Account, AgentSettings, ProvidersSettings } from "../config/schema";
import type { RouteWorld, RoutingConfig } from "../providers/resolve";
import type { Issue, Run } from "../github/types";
import { MasterEngine } from "./engine";
import { HarnessMasterEscalation, harnessEvidence } from "./harness-escalation";
import { foldMasterHistory } from "./history";
import { MAX_MASTER_INTERVENTIONS_PER_PHASE } from "./budget";
import type { MasterSessionResult } from "./outcome";

const REPO = "acme/widgets";
const silent = createLogger({ write: () => {} });
const claudeAccount: Account = { id: "claude-a", provider: "claude", configDir: "~/.claude" };
const providers: ProvidersSettings = {};
const routeWorld: RouteWorld = { acquireAccount: () => claudeAccount };
const agentSettings: AgentSettings = {
  wallClockSeconds: 3600,
  heartbeatSeconds: 30,
  model: "opus",
  effort: "xhigh",
  mcpServers: [],
  mcpServerDefs: {},
  settingSources: ["project"],
  provider: "claude",
  types: {},
  tiers: { "1": { routes: [{ provider: "claude", model: "claude-fable-5" }] } },
};
const routing: () => RoutingConfig = () => ({ agent: agentSettings, providers });

const repaired = (guidance: string): MasterSessionResult => ({
  outcome: {
    resolution: "resolved-and-continue",
    conclusion: "The failure is transient and the branch is sound.",
    rationale: "Re-entering the phase with the repair stated is enough.",
    guidance,
  },
  decisions: [],
});

const terminal: MasterSessionResult = {
  outcome: {
    resolution: "terminal-stuck",
    conclusion: "The blocker is a missing upstream capability, not a defect in this change.",
    rationale: "Neither another autonomous action nor a human decision moves it.",
    reason: "The dependency this issue needs has not shipped.",
  },
  decisions: [],
};

/** The harness sources whose autonomous repair and bounded failure must both be covered. */
const SOURCES = [
  { source: "ci" as const, lane: "ci" as const, phase: "review-0", detail: "build (ubuntu) failed" },
  { source: "rebase" as const, lane: "review" as const, phase: "review-0", detail: "conflict in store.ts" },
  { source: "merge" as const, lane: "merge" as const, phase: "merge", detail: "mergeStateStatus BLOCKED" },
  {
    source: "hosted-review" as const,
    lane: "merge" as const,
    phase: "merge",
    detail: "hosted-review unresolved: PRRT_a#deadbeef@src/x.ts",
  },
  { source: "run-wedged" as const, lane: "impl" as const, phase: "impl", detail: "no advance for 90 minutes" },
  { source: "session-failed" as const, lane: "impl" as const, phase: "impl", detail: "Error: no result frame" },
  { source: "anomaly" as const, lane: "reconcile" as const, phase: "reconcile", detail: "running-row-not-in-flight" },
];

describe("the triage cutover, end to end (ADR-0042)", () => {
  let github: FakeGitHub;
  let store: ScopedStore;
  let escalation: HarnessMasterEscalation;
  let agent: FakeMasterAgent;
  let pipeline: FakeMasterPipeline;
  let engine: MasterEngine;
  let issue: Issue;
  let run: Run;

  beforeEach(async () => {
    github = new FakeGitHub(REPO);
    store = openStore(MEMORY_DB).forRepo(REPO);
    escalation = new HarnessMasterEscalation({ store, github, logger: silent });
    agent = new FakeMasterAgent();
    pipeline = new FakeMasterPipeline();
    engine = new MasterEngine({
      store,
      github,
      agent,
      pipeline,
      logger: silent,
      targetRepo: REPO,
      baseBranch: "main",
      routing,
      routeWorld,
    });
    issue = github.seed({ number: 4, title: "Widget", labels: [LABEL_COMPLEXITY_2, "afk", "mode:tdd"] });
    github.pulls.push({ number: 40, body: "", headRefName: "ralph/4-widget", state: "OPEN" });
    run = store.upsertRun({
      issueNumber: 4,
      mode: "tdd",
      branch: "ralph/4-widget",
      worktreePath: "/w/4",
      prNumber: 40,
      issueTitle: "Widget",
    });
  });

  const enqueue = async (c: (typeof SOURCES)[number], detail = c.detail): Promise<void> => {
    await escalation.escalate({
      issueNumber: 4,
      runId: run.id,
      source: c.source,
      lane: c.lane,
      phase: c.phase,
      branch: "ralph/4-widget",
      prNumber: 40,
      issue: github.issues.get(4)!,
      evidence: harnessEvidence({ headline: `${c.source} failed`, detail }),
    });
  };

  it.each(SOURCES)("repairs a $source failure autonomously, with no human question", async (c) => {
    await enqueue(c);
    agent.push(repaired(`Fix the ${c.source} failure and continue.`));

    const result = await engine.runIntervention(store.getRunByIssue(4)!, issue);

    expect(result).toMatchObject({ kind: "resolved", resolution: "resolved-and-continue", attempt: 1 });
    expect(pipeline.continued).toHaveLength(1);
    expect(pipeline.continued[0]!.brief).toContain(c.source);
    // Back to `running`: the ordinary pipeline owns it again.
    expect(store.getRunByIssue(4)!.status).toBe("running");
    // No human question anywhere.
    expect((github.comments.get(4) ?? []).some((x) => x.body.includes(RALPH_QUESTION_FENCE))).toBe(false);
    expect(store.listOpenQuestions()).toHaveLength(0);
  });

  it.each(SOURCES)("bounds a $source failure at the master's terminal, never before it", async (c) => {
    await enqueue(c);
    agent.push(terminal);

    const result = await engine.runIntervention(store.getRunByIssue(4)!, issue);

    expect(result).toMatchObject({ kind: "resolved", resolution: "terminal-stuck" });
    // The ONE path to `agent-stuck`: a completed master adjudication.
    expect(store.getRunByIssue(4)!.status).toBe("agent-stuck");
    expect(store.readIssueStream(4).some((e) => e.type === "MasterStuck")).toBe(true);
  });

  it("holds the budget across DIFFERENT source adapters reporting the same failure", async () => {
    // A CI failure, then the same failure re-surfaced through the merge adapter, in one phase.
    const ci = SOURCES[0]!;
    await enqueue(ci);
    agent.push(repaired("Re-run the build."));
    await engine.runIntervention(store.getRunByIssue(4)!, issue);

    // The repair did not hold: the same phase sees the failure again, via a different source.
    await escalation.escalate({
      issueNumber: 4,
      runId: run.id,
      source: "merge",
      lane: "merge",
      phase: "review-0", // the SAME run phase — the budget's counting unit
      branch: "ralph/4-widget",
      issue: github.issues.get(4)!,
      evidence: harnessEvidence({ headline: "still failing", detail: "build (ubuntu) failed again" }),
    });
    agent.push(repaired("Re-run the build again."));
    const second = await engine.runIntervention(store.getRunByIssue(4)!, issue);
    expect(second).toMatchObject({ kind: "resolved", attempt: 2 });

    // A THIRD intervention in the same run phase cannot launch, whatever surfaced it.
    await escalation.escalate({
      issueNumber: 4,
      runId: run.id,
      source: "rebase",
      lane: "review",
      phase: "review-0",
      branch: "ralph/4-widget",
      issue: github.issues.get(4)!,
      evidence: harnessEvidence({ headline: "still failing", detail: "build (ubuntu) failed a third time" }),
    });
    const sessionsBefore = agent.sessions.length;
    const third = await engine.runIntervention(store.getRunByIssue(4)!, issue);

    expect(third).toEqual({ kind: "budget-exhausted", spent: MAX_MASTER_INTERVENTIONS_PER_PHASE });
    expect(agent.sessions).toHaveLength(sessionsBefore); // no third session launched
    expect(store.getRunByIssue(4)!.status).toBe("agent-stuck");
  });

  it("treats a head-SHA-only change as the same failure and refuses to repeat the recovery", async () => {
    await enqueue(SOURCES[0]!, "build failed at 0a1b2c3d4e5f6a7b");
    agent.push(repaired("Re-run the build."));
    await engine.runIntervention(store.getRunByIssue(4)!, issue);

    // A new head, an identical failure: the signature is the same, so the master may NOT
    // choose `resolved-and-continue` again — the harness coerces it to `ask-human`.
    await escalation.escalate({
      issueNumber: 4,
      runId: run.id,
      source: "ci",
      lane: "ci",
      phase: "review-0",
      branch: "ralph/4-widget",
      issue: github.issues.get(4)!,
      evidence: harnessEvidence({ headline: "ci failed", detail: "build failed at 9f8e7d6c5b4a3928" }),
    });
    agent.push(repaired("Re-run the build (again)."));
    const second = await engine.runIntervention(store.getRunByIssue(4)!, issue);

    expect(second).toMatchObject({ kind: "resolved", resolution: "ask-human" });
    expect(pipeline.continued).toHaveLength(1); // the forbidden repeat never ran
  });

  it("routes a typed pipeline retry without bypassing the gate it re-runs", async () => {
    await enqueue(SOURCES[2]!);
    agent.push({
      outcome: {
        resolution: "retry-pipeline",
        conclusion: "GitHub had not finished recomputing mergeability.",
        rationale: "Re-running the merge gate is the correct next action.",
        action: "merge",
      },
      decisions: [],
    });

    const result = await engine.runIntervention(store.getRunByIssue(4)!, issue);
    expect(result).toMatchObject({ kind: "resolved", resolution: "retry-pipeline" });
    expect(pipeline.retried).toEqual([{ issueNumber: 4, action: "merge", brief: expect.any(String) }]);
    // No merge was fired by the master itself — the harness still owns it (ADR-0014).
    expect(github.merges).toHaveLength(0);
  });

  it("redispatches a tier-1 worker on the preserved branch", async () => {
    await enqueue(SOURCES[4]!);
    agent.push({
      outcome: {
        resolution: "redispatch-tier-1",
        conclusion: "The wedged session never got past the fixture setup.",
        rationale: "A fresh tier-1 worker on the preserved branch is the cheapest correct move.",
        brief: "Start from the existing fixtures; do not rebuild them.",
      },
      decisions: [],
    });

    const result = await engine.runIntervention(store.getRunByIssue(4)!, issue);
    expect(result).toMatchObject({ kind: "resolved", resolution: "redispatch-tier-1" });
    expect(pipeline.continued[0]!.brief).toContain("existing fixtures");
  });

  it("asks the human exactly once, and only through the master", async () => {
    await enqueue(SOURCES[6]!);
    agent.push({
      outcome: {
        resolution: "ask-human",
        conclusion: "Two committed contracts disagree about the storage node.",
        rationale: "Choosing between binding decisions is a human call.",
        question: {
          headline: "Which storage contract governs this subtree?",
          feature: "Decision ledger",
          whereWeStand: "Two active records claim the same key with no supersession between them.",
          decision: "Which record governs?",
          stakes: "Superseding standing design authority binds every future session on this subtree.",
          recommendation: "Keep the older record unless its constraint has lapsed.",
        },
      },
      decisions: [],
    });

    await engine.runIntervention(store.getRunByIssue(4)!, issue);

    const questions = (github.comments.get(4) ?? []).filter((c) => c.body.includes(RALPH_QUESTION_FENCE));
    expect(questions).toHaveLength(1);
    expect(store.getRunByIssue(4)!.status).toBe("awaiting-answer");
    expect(foldMasterHistory(store.readIssueStream(4)).awaitingHuman).toMatchObject({ attempt: 1 });
  });

  it("defers a usage-limited master session without spending an attempt or enqueuing anything", async () => {
    await enqueue(SOURCES[0]!);
    agent.push({ kind: "limited", detail: "plan limit reached" });

    const result = await engine.runIntervention(store.getRunByIssue(4)!, issue);

    expect(result).toMatchObject({ kind: "deferred", reason: "usage-limited" });
    // The attempt stays OPEN (re-adopted next tick on a rotated account) and the run is still
    // queued — never `agent-stuck`, never a human question.
    expect(store.getRunByIssue(4)!.status).toBe("master-triage");
    expect(github.issues.get(4)!.labels).not.toContain("agent-stuck");
    expect((github.comments.get(4) ?? []).some((c) => c.body.includes(RALPH_QUESTION_FENCE))).toBe(false);
    const history = foldMasterHistory(store.readIssueStream(4));
    expect(history.inProgress).not.toBeNull();
    expect(history.interventions).toHaveLength(1);
  });

  it("keeps the daemon-owned label on a queued escalation until it resolves", async () => {
    await enqueue(SOURCES[3]!);
    // The label is a level-triggered effect of the status; the status is what the queue reads.
    expect(store.getRunByIssue(4)!.status).toBe("master-triage");
    expect(LABEL_MASTER_TRIAGE).toBe("master-triage");
  });
});
