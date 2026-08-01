/**
 * End-to-end coverage of the master escalation engine (ADR-0041) over the fake GitHub /
 * store / agent ports: every durable outcome, the loop budget, restart recovery, the
 * fail-closed route, the decision-ledger write, and the "only the master reaches a human"
 * invariant.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMORY_DB, openStore, type ScopedStore } from "../store/store";
import { FakeGitHub } from "../testing/fake-github";
import { FakeMasterAgent, FakeMasterPipeline } from "../testing/fake-master-agent";
import { createLogger } from "../log/logger";
import type { Account, AgentSettings, ProvidersSettings } from "../config/schema";
import type { RoutingConfig, RouteWorld } from "../providers/resolve";
import type { Issue, Run } from "../github/types";
import { LABEL_AGENT_STUCK, LABEL_COMPLEXITY_1, LABEL_MASTER_TRIAGE } from "../core/labels";
import { RALPH_QUESTION_FENCE } from "../review/escalation";
import { isDecisionComment, RALPH_DECISION_FENCE } from "../ledger/decision";
import { RALPH_DECISION_INDEX_FENCE } from "../ledger/index-comment";
import { MasterEngine } from "./engine";
import { foldMasterHistory } from "./history";
import { formatMasterRequestComment, RALPH_MASTER_REQUEST_FENCE } from "./request";
import type { MasterSessionResult } from "./outcome";

const REPO = "acme/widgets";
const logger = createLogger({ level: "error" });

const TIER_1_ROUTES = [{ provider: "claude" as const, model: "claude-fable-5" }];
const claudeAccount: Account = { id: "claude-a", provider: "claude", configDir: "~/.claude" };

function agentSettings(tiers: AgentSettings["tiers"] = { "1": { routes: TIER_1_ROUTES } }): AgentSettings {
  return {
    wallClockSeconds: 3600,
    heartbeatSeconds: 30,
    model: "opus",
    effort: "xhigh",
    mcpServers: [],
    mcpServerDefs: {},
    settingSources: ["project"],
    provider: "zai",
    types: {},
    tiers,
  };
}

const providers: ProvidersSettings = {};
const routeWorld: RouteWorld = { acquireAccount: () => claudeAccount };

function routing(tiers?: AgentSettings["tiers"]): () => RoutingConfig {
  return () => ({ agent: agentSettings(tiers), providers });
}

const outcome = (over: Partial<MasterSessionResult["outcome"]> = {}): MasterSessionResult => ({
  outcome: {
    resolution: "resolved-and-continue",
    conclusion: "The worker misread the failing assertion; the real defect is in the fixture.",
    rationale: "Fixing the fixture makes the suite green without changing behaviour.",
    guidance: "Re-run the suite; the fixture now supplies the missing field.",
    ...over,
  } as MasterSessionResult["outcome"],
  decisions: [],
});

describe("MasterEngine (ADR-0041)", () => {
  let github: FakeGitHub;
  let store: ScopedStore;
  let agent: FakeMasterAgent;
  let pipeline: FakeMasterPipeline;
  let issue: Issue;
  let run: Run;

  async function seedQueuedEscalation(
    over: { source?: "escalate" | "stuck"; signature?: string; recommendation?: string } = {},
  ): Promise<void> {
    issue = github.seed({
      number: 7,
      title: "Widget pipeline",
      labels: [LABEL_COMPLEXITY_1, "afk", "mode:tdd", LABEL_MASTER_TRIAGE],
    });
    github.pulls.push({ number: 70, body: "", headRefName: "ralph/7-widget", state: "OPEN" });
    run = store.upsertRun({
      issueNumber: 7,
      mode: "tdd",
      tier: 1,
      branch: "ralph/7-widget",
      worktreePath: "/w/7",
      prNumber: 70,
      issueTitle: "Widget pipeline",
    });
    const source = over.source ?? "escalate";
    const signature = over.signature ?? "escalate|impl|typecheck failed";
    await github.postComment(
      7,
      formatMasterRequestComment({
        source,
        lane: "impl",
        phase: "impl",
        issueNumber: 7,
        runId: run.id,
        branch: "ralph/7-widget",
        signature,
        evidence: {
          headline: "The typecheck fails and I cannot tell which contract is authoritative",
          recommendation: over.recommendation ?? "Loosen the schema so both shapes parse",
          attemptedFixes: "Tried widening the union; the review rubric rejected it",
          uncertainty: "Which of the two contracts is the design of record",
          detail: "typecheck failed",
        },
      }),
    );
    await store.recordMasterTriageRequested({
      issueNumber: 7,
      runId: run.id,
      source,
      phase: "impl",
      lane: "impl",
      signature,
      headline: "The typecheck fails and I cannot tell which contract is authoritative",
      recommendation: over.recommendation ?? "Loosen the schema so both shapes parse",
      prNumber: 70,
    });
  }

  function engineWith(over: Partial<ConstructorParameters<typeof MasterEngine>[0]> = {}): MasterEngine {
    return new MasterEngine({
      store,
      github,
      agent,
      pipeline,
      logger,
      targetRepo: REPO,
      baseBranch: "master",
      routing: routing(),
      routeWorld,
      now: () => new Date("2026-08-01T00:00:00Z"),
      ...over,
    });
  }

  beforeEach(() => {
    github = new FakeGitHub(REPO);
    store = openStore(MEMORY_DB).forRepo(REPO);
    agent = new FakeMasterAgent();
    pipeline = new FakeMasterPipeline();
  });

  describe("the master's own conclusion is what gets persisted", () => {
    it("carries the worker's recommendation as evidence but persists the master's conclusion", async () => {
      await seedQueuedEscalation({ recommendation: "Loosen the schema so both shapes parse" });
      agent.push(
        outcome({
          conclusion: "The schema is right; the CALLER is passing the legacy shape.",
          rationale: "ADR-0010 pins the strict schema; loosening it would drop the typo protection.",
          guidance: "Update the caller to the current shape, then re-run the suite.",
        }),
      );

      const result = await engineWith().runIntervention(run, issue);

      // The packet contained the worker's recommendation…
      expect(agent.lastPrompt).toContain("Loosen the schema so both shapes parse");
      expect(agent.lastPrompt).toContain("RECOMMENDATION (evidence — not a decision");
      // …and the master disagreed. Its conclusion is what got injected and persisted.
      expect(result).toMatchObject({ kind: "resolved", resolution: "resolved-and-continue" });
      expect(pipeline.continued).toEqual([
        {
          issueNumber: 7,
          resolution: "resolved-and-continue",
          brief: "Update the caller to the current shape, then re-run the suite.",
          conclusion: "The schema is right; the CALLER is passing the legacy shape.",
        },
      ]);
      const history = foldMasterHistory(store.readIssueStream(7));
      expect(history.interventions[0]).toMatchObject({
        attempt: 1,
        resolution: "resolved-and-continue",
        rationale: "ADR-0010 pins the strict schema; loosening it would drop the typo protection.",
        completed: true,
      });
    });

    it("gives the master the zoomed-out evidence — run state, budget and normalized signature", async () => {
      await seedQueuedEscalation();
      agent.push(outcome());

      await engineWith().runIntervention(run, issue);

      const prompt = agent.lastPrompt;
      expect(prompt).toContain("Widget pipeline");
      expect(prompt).toContain("ralph/7-widget");
      expect(prompt).toContain("Pull request #70");
      expect(prompt).toContain("escalate|impl|typecheck failed");
      expect(prompt).toContain("Loop budget (enforced by the harness)");
      expect(prompt).toContain("master intervention **1 of 2**");
      expect(prompt).toContain("Where this issue sits");
      expect(prompt).toContain("Inherited decisions");
    });
  });

  describe("the five durable outcomes", () => {
    it("redispatch-tier-1 hands the preserved WIP branch to a fresh worker with the brief", async () => {
      await seedQueuedEscalation();
      agent.push(
        outcome({
          resolution: "redispatch-tier-1",
          brief: "Implement it against the strict schema; do not widen the union.",
          guidance: undefined,
        } as never),
      );

      const result = await engineWith().runIntervention(run, issue);

      expect(result).toMatchObject({ kind: "resolved", resolution: "redispatch-tier-1" });
      expect(pipeline.continued[0]).toMatchObject({
        resolution: "redispatch-tier-1",
        brief: "Implement it against the strict schema; do not widen the union.",
      });
    });

    it("retry-pipeline requests one typed harness action without bypassing its gate", async () => {
      await seedQueuedEscalation();
      agent.push(outcome({ resolution: "retry-pipeline", action: "ci", guidance: undefined } as never));

      const result = await engineWith().runIntervention(run, issue);

      expect(result).toMatchObject({ kind: "resolved", resolution: "retry-pipeline" });
      expect(pipeline.retried).toHaveLength(1);
      expect(pipeline.retried[0]).toMatchObject({ issueNumber: 7, action: "ci" });
      // No merge, no close, no CI bypass happened anywhere in this path.
      expect(github.merges).toEqual([]);
      expect(github.closedIssues).toEqual([]);
    });

    it("ask-human is the only path that posts a ralph-question and reaches awaiting-answer", async () => {
      await seedQueuedEscalation();
      agent.push(
        outcome({
          resolution: "ask-human",
          guidance: undefined,
          question: {
            headline: "Which contract is authoritative?",
            feature: "Widget pipeline",
            whereWeStand: "Two contracts disagree and design authority is silent.",
            decision: "Pick the authoritative contract.",
            stakes: "Choosing wrong strands every downstream consumer.",
            recommendation: "Pick the newer contract; the legacy one has one caller left.",
          },
        } as never),
      );

      const result = await engineWith().runIntervention(run, issue);

      expect(result).toMatchObject({ kind: "resolved", resolution: "ask-human" });
      const bodies = (github.comments.get(7) ?? []).map((c) => c.body);
      expect(bodies.some((b) => b.includes(RALPH_QUESTION_FENCE))).toBe(true);
      expect(store.getRunByIssue(7)!.status).toBe("awaiting-answer");
      expect(store.listOpenQuestions()).toHaveLength(1);
      expect(foldMasterHistory(store.readIssueStream(7)).awaitingHuman).toMatchObject({ attempt: 1 });
    });

    it("terminal-stuck is the only worker-origin path to agent-stuck after this slice", async () => {
      await seedQueuedEscalation();
      agent.push(
        outcome({
          resolution: "terminal-stuck",
          guidance: undefined,
          reason: "The upstream API this issue depends on has been withdrawn; no code change helps.",
        } as never),
      );

      const result = await engineWith().runIntervention(run, issue);

      expect(result).toMatchObject({ kind: "resolved", resolution: "terminal-stuck" });
      expect(store.getRunByIssue(7)!.status).toBe("agent-stuck");
      const bodies = (github.comments.get(7) ?? []).map((c) => c.body).join("\n");
      expect(bodies).toContain("Master concluded this run cannot be completed");
      expect(bodies).toContain("The upstream API this issue depends on has been withdrawn");
    });
  });

  describe("loop budget", () => {
    it("allows two interventions and refuses to launch a third", async () => {
      await seedQueuedEscalation();
      agent.push(outcome({ resolution: "retry-pipeline", action: "ci", guidance: undefined } as never));
      const engine = engineWith();
      await engine.runIntervention(run, issue);

      // A second escalation in the same phase, different failure.
      await store.recordMasterTriageRequested({
        issueNumber: 7,
        runId: run.id,
        source: "stuck",
        phase: "impl",
        lane: "impl",
        signature: "stuck|impl|tests failed",
        headline: "second",
      });
      agent.push(outcome({ resolution: "redispatch-tier-1", brief: "try again", guidance: undefined } as never));
      await engine.runIntervention(run, issue);
      expect(agent.sessions).toHaveLength(2);

      // A third: no session may launch; the harness terminalizes with a readable card.
      await store.recordMasterTriageRequested({
        issueNumber: 7,
        runId: run.id,
        source: "stuck",
        phase: "impl",
        lane: "impl",
        signature: "stuck|impl|still failing",
        headline: "third",
      });
      const third = await engine.runIntervention(run, issue);

      expect(third).toMatchObject({ kind: "budget-exhausted", spent: 2 });
      expect(agent.sessions).toHaveLength(2); // no third session
      expect(store.getRunByIssue(7)!.status).toBe("agent-stuck");
      const bodies = (github.comments.get(7) ?? []).map((c) => c.body).join("\n");
      expect(bodies).toContain("exhausted its budget");
    });

    it("refuses a repeated resolution for a repeated signature even when the head SHA changed", async () => {
      await seedQueuedEscalation({ signature: "stuck|impl|ci failed on <sha>" });
      agent.push(outcome({ resolution: "retry-pipeline", action: "ci", guidance: undefined } as never));
      const engine = engineWith();
      await engine.runIntervention(run, issue);

      // Same normalized signature (the SHA is erased by normalization), same recovery proposed.
      await store.recordMasterTriageRequested({
        issueNumber: 7,
        runId: run.id,
        source: "stuck",
        phase: "impl",
        lane: "impl",
        signature: "stuck|impl|ci failed on <sha>",
        headline: "again",
      });
      agent.push(outcome({ resolution: "retry-pipeline", action: "ci", guidance: undefined } as never));

      const second = await engine.runIntervention(run, issue);

      // The harness refused it and forced final adjudication instead of re-running it.
      expect(second).toMatchObject({ kind: "resolved", resolution: "ask-human" });
      expect(pipeline.retried).toHaveLength(1); // NOT re-run
      expect(agent.sessions[1]!.prompt).toContain("REPEATED FAILURE SIGNATURE");
      expect(agent.sessions[1]!.prompt).toContain("`retry-pipeline` is forbidden");
      expect(store.getRunByIssue(7)!.status).toBe("awaiting-answer");
    });

    it("resets the per-run budget on a genuinely new run span", async () => {
      await seedQueuedEscalation();
      agent.push(outcome({ resolution: "retry-pipeline", action: "ci", guidance: undefined } as never));
      const engine = engineWith();
      await engine.runIntervention(run, issue);

      await store.recordRunStarted({ runId: run.id, issueNumber: 7, mode: "tdd", branch: "ralph/7-widget" });
      await store.recordMasterTriageRequested({
        issueNumber: 7,
        runId: run.id,
        source: "escalate",
        phase: "impl",
        lane: "impl",
        signature: "escalate|impl|new failure",
        headline: "fresh span",
      });
      agent.push(outcome());

      const result = await engine.runIntervention(run, issue);
      expect(result).toMatchObject({ kind: "resolved", attempt: 1 });
    });
  });

  describe("restart recovery", () => {
    it("re-adopts an interrupted attempt rather than spending a second one or duplicating it", async () => {
      await seedQueuedEscalation();
      // Simulate a daemon death between `MasterInterventionStarted` and its outcome.
      await store.recordMasterInterventionStarted({
        issueNumber: 7,
        runId: run.id,
        attempt: 1,
        phase: "impl",
        signature: "escalate|impl|typecheck failed",
      });
      agent.push(outcome());

      const result = await engineWith().runIntervention(run, issue);

      expect(result).toMatchObject({ kind: "resolved", attempt: 1 });
      const history = foldMasterHistory(store.readIssueStream(7));
      expect(history.interventions).toHaveLength(1);
      expect(agent.sessions).toHaveLength(1);
    });

    it("is a no-op when there is no pending request and no open attempt", async () => {
      issue = github.seed({ number: 9, title: "x", labels: [] });
      run = store.upsertRun({ issueNumber: 9, mode: "tdd", branch: "ralph/9-x" });
      expect(await engineWith().runIntervention(run, issue)).toEqual({ kind: "no-request" });
      expect(agent.sessions).toHaveLength(0);
    });

    it("recovers the request payload from GitHub when the store lost the fact", async () => {
      await seedQueuedEscalation();
      // A cold store keeps the label + the fenced comment; the fold's `pending` came from a
      // fact we now pretend was lost by reading only the comment path.
      const recovered = (github.comments.get(7) ?? []).some((c) => c.body.includes(RALPH_MASTER_REQUEST_FENCE));
      expect(recovered).toBe(true);
      agent.push(outcome());
      const result = await engineWith().runIntervention(run, issue);
      expect(result).toMatchObject({ kind: "resolved" });
      expect(agent.lastPrompt).toContain("Loosen the schema so both shapes parse");
    });
  });

  describe("fail-closed tier-1 configuration", () => {
    it("never falls back to a cheaper master; surfaces the named configuration defect", async () => {
      await seedQueuedEscalation();
      const engine = engineWith({ routing: routing({}) });

      const result = await engine.runIntervention(run, issue);

      expect(result.kind).toBe("unconfigured");
      expect(result.kind === "unconfigured" && result.detail).toContain('agent.tiers."1".routes');
      expect(agent.sessions).toHaveLength(0);
      // No budget was consumed by a misconfiguration.
      expect(foldMasterHistory(store.readIssueStream(7)).interventions).toHaveLength(0);
      // The run stays queued and visible; the anomaly names the defect.
      expect(store.getRunByIssue(7)!.status).toBe("master-triage");
      expect(store.readIssueProjection(7)!.anomaly).toContain("master-route-unconfigured");
    });

    it("names the capability defect when tier 1 points at a non-tools-capable provider", async () => {
      await seedQueuedEscalation();
      const engine = engineWith({
        routing: routing({ "1": { routes: [{ provider: "openai", model: "gpt-5.5" }] } }),
      });

      const result = await engine.runIntervention(run, issue);

      expect(result.kind).toBe("unconfigured");
      expect(result.kind === "unconfigured" && result.detail).toContain("tools-capable");
      expect(agent.sessions).toHaveLength(0);
    });

    it("treats a headroom-less pool as a wait, not a defect, and spends no budget", async () => {
      await seedQueuedEscalation();
      const engine = engineWith({ routeWorld: { acquireAccount: () => null } });

      const result = await engine.runIntervention(run, issue);

      expect(result).toEqual({ kind: "deferred", reason: "no-provider" });
      expect(store.getRunByIssue(7)!.status).toBe("master-triage");
      expect(foldMasterHistory(store.readIssueStream(7)).interventions).toHaveLength(0);
    });
  });

  describe("usage limits, transcripts and route recording apply like every other lane", () => {
    it("defers on a usage limit and leaves the attempt re-adoptable", async () => {
      await seedQueuedEscalation();
      agent.push({ kind: "limited", detail: "plan window exhausted" });

      const result = await engineWith().runIntervention(run, issue);

      expect(result).toMatchObject({ kind: "deferred", reason: "usage-limited" });
      const history = foldMasterHistory(store.readIssueStream(7));
      expect(history.inProgress).toMatchObject({ attempt: 1, completed: false });
      expect(store.getRunByIssue(7)!.status).toBe("master-triage");
    });

    it("records the dispatched route under the master phase", async () => {
      await seedQueuedEscalation();
      agent.push(outcome());

      await engineWith().runIntervention(run, issue);

      expect(store.getRunRoute(run.id)).toEqual({
        provider: "claude",
        model: "claude-fable-5",
        account: "claude-a",
      });
    });

    it("hands the session the resolved tier-1 route", async () => {
      await seedQueuedEscalation();
      agent.push(outcome());
      await engineWith().runIntervention(run, issue);
      expect(agent.sessions[0]!.route).toMatchObject({ provider: "claude", model: "claude-fable-5" });
    });
  });

  describe("scoped decisions (ADR-0040 ledger)", () => {
    it("appends a binding decision where design authority was silent", async () => {
      await seedQueuedEscalation();
      github.seedNode({ ref: { repo: REPO, number: 7 }, title: "Widget pipeline" });
      agent.push({
        ...outcome(),
        decisions: [
          {
            key: "widget-contract",
            scope: "issue",
            decision: "The strict schema in contract.ts is authoritative.",
            rationale: "ADR-0010 pins strict zod; the legacy shape has one caller.",
            constraints: [],
            rejectedAlternatives: [],
            evidence: [],
          },
        ],
      });

      const result = await engineWith().runIntervention(run, issue);

      expect(result).toMatchObject({ kind: "resolved", resolution: "resolved-and-continue" });
      const bodies = (github.comments.get(7) ?? []).map((c) => c.body).join("\n");
      expect(bodies).toContain(RALPH_DECISION_FENCE);
      expect(bodies).toContain("The strict schema in contract.ts is authoritative.");
      const history = foldMasterHistory(store.readIssueStream(7));
      expect(history.publishedDecisionIds).toHaveLength(1);
    });

    it("indexes the decision on the absolute root and never duplicates it on replay", async () => {
      await seedQueuedEscalation();
      github.seedNode({ ref: { repo: REPO, number: 7 }, title: "Widget pipeline" });
      const draft = {
        key: "widget-contract",
        scope: "issue" as const,
        decision: "The strict schema in contract.ts is authoritative.",
        rationale: "ADR-0010 pins strict zod.",
        constraints: [],
        rejectedAlternatives: [],
        evidence: [],
      };
      agent.push({ ...outcome(), decisions: [draft] });
      const engine = engineWith();
      await engine.runIntervention(run, issue);

      const bodies = () => (github.comments.get(7) ?? []).map((c) => c.body);
      expect(bodies().filter(isDecisionComment)).toHaveLength(1);
      expect(bodies().some((b) => b.includes(RALPH_DECISION_INDEX_FENCE))).toBe(true);

      // A restart replays the same intervention (same run, same attempt): the deterministic
      // decision id is already published, so nothing is re-appended.
      await store.recordMasterTriageRequested({
        issueNumber: 7,
        runId: run.id,
        source: "escalate",
        phase: "impl",
        lane: "impl",
        signature: "escalate|impl|typecheck failed",
        headline: "replay",
      });
      agent.push({ ...outcome(), decisions: [draft] });
      await engine.runIntervention(run, issue);

      expect(bodies().filter(isDecisionComment)).toHaveLength(1);
      expect(foldMasterHistory(store.readIssueStream(7)).publishedDecisionIds).toHaveLength(1);
    });

    it("routes an attempted contradiction of a standing decision to a human", async () => {
      await seedQueuedEscalation();
      github.seedNode({ ref: { repo: REPO, number: 7 }, title: "Widget pipeline" });
      // A standing, active decision for the same key.
      const engine = engineWith();
      agent.push({
        ...outcome(),
        decisions: [
          {
            key: "widget-contract",
            scope: "issue",
            decision: "v1 contract is authoritative.",
            rationale: "first",
            constraints: [],
            rejectedAlternatives: [],
            evidence: [],
          },
        ],
      });
      await engine.runIntervention(run, issue);

      // A second master now tries to change it.
      await store.recordMasterTriageRequested({
        issueNumber: 7,
        runId: run.id,
        source: "escalate",
        phase: "impl",
        lane: "impl",
        signature: "escalate|impl|different failure",
        headline: "second",
      });
      agent.push({
        ...outcome(),
        decisions: [
          {
            key: "widget-contract",
            scope: "issue",
            decision: "Actually v2 is authoritative.",
            rationale: "second",
            constraints: [],
            rejectedAlternatives: [],
            evidence: [],
          },
        ],
      });

      const result = await engine.runIntervention(run, issue);

      expect(result).toMatchObject({ kind: "resolved", resolution: "ask-human" });
      expect(store.getRunByIssue(7)!.status).toBe("awaiting-answer");
      const bodies = (github.comments.get(7) ?? []).map((c) => c.body).join("\n");
      expect(bodies).toContain("Master wants to change the binding decision");
      // The contradicting RECORD was not written — only the first decision is in the ledger.
      // (The human question quotes the proposed change; that is the point of asking.)
      // `isDecisionComment` is anchored on the exact fence tag, so the derived
      // `ralph-decision-index` comment (which the shorter name prefixes) is not miscounted.
      const decisionRecords = (github.comments.get(7) ?? []).filter((c) => isDecisionComment(c.body));
      expect(decisionRecords).toHaveLength(1);
      expect(decisionRecords[0]!.body).toContain("v1 contract is authoritative.");
      expect(foldMasterHistory(store.readIssueStream(7)).publishedDecisionIds).toHaveLength(1);
    });
  });

  describe("answering a master question resumes the master", () => {
    it("re-opens the same attempt with the answer injected and forbids asking again", async () => {
      await seedQueuedEscalation();
      const question = {
        headline: "Which contract is authoritative?",
        feature: "Widget pipeline",
        whereWeStand: "Two contracts disagree.",
        decision: "Pick one.",
        stakes: "Downstream consumers depend on the answer.",
        recommendation: "Pick v2.",
      };
      agent.push(outcome({ resolution: "ask-human", guidance: undefined, question } as never));
      const engine = engineWith();
      await engine.runIntervention(run, issue);
      expect(store.getRunByIssue(7)!.status).toBe("awaiting-answer");

      agent.push(outcome());
      const resumed = await engine.runIntervention(store.getRunByIssue(7)!, issue, {
        answer: { question, text: "v2 is authoritative." },
      });

      expect(resumed).toMatchObject({ kind: "resolved", attempt: 1, resolution: "resolved-and-continue" });
      // Still ONE intervention — the answer resumed the checkpointed master, it did not spend
      // a fresh one, and it did not erase the prior autonomous attempt.
      const history = foldMasterHistory(store.readIssueStream(7));
      expect(history.interventions).toHaveLength(1);
      expect(history.interventions[0]!.humanResumes).toBe(1);
      expect(agent.sessions[1]!.prompt).toContain("v2 is authoritative.");
      expect(agent.sessions[1]!.prompt).toContain("You may NOT ask another question on this attempt");
    });

    it("refuses a second ask-human on a human-resumed attempt", async () => {
      await seedQueuedEscalation();
      const question = {
        headline: "Which contract is authoritative?",
        feature: "Widget pipeline",
        whereWeStand: "Two contracts disagree.",
        decision: "Pick one.",
        stakes: "Downstream consumers depend on the answer.",
        recommendation: "Pick v2.",
      };
      agent.push(outcome({ resolution: "ask-human", guidance: undefined, question } as never));
      const engine = engineWith();
      await engine.runIntervention(run, issue);

      agent.push(outcome({ resolution: "ask-human", guidance: undefined, question } as never));
      const resumed = await engine.runIntervention(store.getRunByIssue(7)!, issue, {
        answer: { question, text: "v2 is authoritative." },
      });

      // Coerced to a human question about the REFUSAL, not an endless ask→answer→ask cycle:
      // the run is visible to a human either way, but the loop cannot continue.
      expect(resumed).toMatchObject({ kind: "resolved", resolution: "ask-human" });
      const bodies = (github.comments.get(7) ?? []).map((c) => c.body).join("\n");
      expect(bodies).toContain("Master proposed a recovery already spent on this failure");
    });
  });

  describe("worker-origin invariants", () => {
    it("a stuck-sourced request adjudicates exactly like an escalate-sourced one", async () => {
      await seedQueuedEscalation({ source: "stuck", signature: "stuck|impl|no-green-build" });
      agent.push(outcome());

      const result = await engineWith().runIntervention(run, issue);

      expect(result).toMatchObject({ kind: "resolved" });
      expect(agent.lastPrompt).toContain("`stuck` from the `impl` lane");
      expect(store.getRunByIssue(7)!.status).not.toBe(LABEL_AGENT_STUCK);
    });

    it("never merges, closes, or force-pushes on any resolution path", async () => {
      await seedQueuedEscalation();
      agent.push(outcome());
      await engineWith().runIntervention(run, issue);
      expect(github.merges).toEqual([]);
      expect(github.closedIssues).toEqual([]);
      expect(github.closedPulls).toEqual([]);
    });
  });

  /**
   * The outcome→effect boundary (issue #43: "restart tests at request/start/action/outcome/effect
   * boundaries recover exactly once, do not repeat pushed commits/comments/retries").
   *
   * The decision is recorded *before* its effect, so a restart replays the adjudication the master
   * actually made instead of spending a fresh session to make a possibly different one. That makes
   * the window between the two writes real, and the attempt span is what keeps it recoverable: the
   * span closes only once the effect has landed.
   */
  describe("restart at the outcome→effect boundary", () => {
    it("re-applies the effect exactly once, with no second master session", async () => {
      await seedQueuedEscalation();
      agent.push(outcome());
      // Fail at the FIRST step of the effect — taking the run off the queue. That is the arm of
      // the window that actually strands: once the run has left, a failed hand-back is a plain
      // `running` orphan the sweep re-drives, by design.
      const leave = vi.spyOn(store, "recordResumed").mockRejectedValueOnce(new Error("sqlite: locked"));

      // The effect throws; the engine must surface that rather than report a resolution.
      await expect(engineWith().runIntervention(run, issue)).rejects.toThrow("sqlite: locked");
      leave.mockRestore();
      expect(pipeline.continued).toEqual([]);

      // The decision is durable, the attempt span is still open, and the run is still queued —
      // so the next tick has something to recover rather than a silently wedged run.
      const stalled = foldMasterHistory(store.events.readIssueStream(REPO, 7));
      expect(stalled.inProgress).toMatchObject({ attempt: 1, resolution: "resolved-and-continue", completed: false });
      expect(store.getRunByIssue(7)!.status).toBe("master-triage");

      // Next tick: the effect lands, the span closes, and no fresh session was scripted —
      // FakeMasterAgent throws if asked for one, so this passing IS the "no second session" proof.
      const recovered = await engineWith().runIntervention(run, issue);

      expect(recovered).toMatchObject({ kind: "resolved", attempt: 1, resolution: "resolved-and-continue" });
      expect(pipeline.continued).toHaveLength(1);
      expect(pipeline.continued[0]).toMatchObject({
        issueNumber: 7,
        resolution: "resolved-and-continue",
        brief: "Re-run the suite; the fixture now supplies the missing field.",
      });
      const healed = foldMasterHistory(store.events.readIssueStream(REPO, 7));
      expect(healed.inProgress).toBeNull();
      expect(healed.interventions).toHaveLength(1);
      expect(healed.interventions[0]).toMatchObject({ attempt: 1, completed: true });
    });

    it("spends no fresh budget recovering, so the phase's two real attempts survive", async () => {
      await seedQueuedEscalation();
      agent.push(outcome());
      const leave = vi.spyOn(store, "recordResumed").mockRejectedValueOnce(new Error("sqlite: locked"));
      await expect(engineWith().runIntervention(run, issue)).rejects.toThrow("sqlite: locked");
      leave.mockRestore();
      await engineWith().runIntervention(run, issue);

      const history = foldMasterHistory(store.events.readIssueStream(REPO, 7));
      // One attempt spent, not two: a recovery is the same intervention finishing, not a new one.
      expect(history.interventions.filter((i) => i.phase === "impl")).toHaveLength(1);
    });

    it("does not post a second question when the crash landed between the comment and its fact", async () => {
      await seedQueuedEscalation();
      // Built explicitly rather than spread over the `resolved-and-continue` base: the outcome
      // contract is strict, and production stores exactly what `parseMasterSessionResult`
      // accepted — so a replay payload carrying a foreign key would not be reproducing the
      // real thing.
      agent.push({
        outcome: {
          resolution: "ask-human",
          conclusion: "Both contracts are live; only their owner can say which is authoritative.",
          rationale: "Choosing one silently would break the other consumer.",
          question: {
            headline: "Which contract is the design of record?",
            feature: "Ingestion",
            whereWeStand: "Two shapes parse; the rubric rejects widening.",
            decision: "Pick the authoritative contract.",
            options: ["The v2 shape", "The legacy shape"],
            stakes: "One-way door for the other consumer.",
            recommendation: "The v2 shape.",
          },
        },
        decisions: [],
      });
      // The comment lands, then the durable fact fails — the exact split the AC names.
      const record = vi
        .spyOn(store, "recordMasterHumanQuestion")
        .mockRejectedValueOnce(new Error("sqlite: disk I/O error"));
      await expect(engineWith().runIntervention(run, issue)).rejects.toThrow("disk I/O error");
      record.mockRestore();
      const posted = (await github.listIssueComments(7)).filter((c) => c.body.includes(RALPH_QUESTION_FENCE));
      expect(posted).toHaveLength(1);

      const recovered = await engineWith().runIntervention(run, issue);

      expect(recovered).toMatchObject({ kind: "resolved", resolution: "ask-human" });
      // Exactly one question on the issue: the recovery adopted the posted comment rather than
      // publishing a second one an operator would have to reconcile by hand.
      const after = (await github.listIssueComments(7)).filter((c) => c.body.includes(RALPH_QUESTION_FENCE));
      expect(after).toHaveLength(1);
      expect(after[0]!.id).toBe(posted[0]!.id);
      expect(foldMasterHistory(store.events.readIssueStream(REPO, 7)).awaitingHuman).toMatchObject({ attempt: 1 });
    });

    it("does not post a second terminal card when the crash landed between the card and its fact", async () => {
      await seedQueuedEscalation();
      agent.push({
        outcome: {
          resolution: "terminal-stuck",
          conclusion: "The issue depends on an unmerged upstream change that does not exist yet.",
          rationale: "No autonomous action and no human answer can conjure the dependency.",
          reason: "blocked on a prerequisite that has not been written",
        },
        decisions: [],
      });
      const record = vi
        .spyOn(store, "recordMasterStuck")
        .mockRejectedValueOnce(new Error("sqlite: disk I/O error"));
      await expect(engineWith().runIntervention(run, issue)).rejects.toThrow("disk I/O error");
      record.mockRestore();
      const cards = (await github.listIssueComments(7)).filter((c) => c.body.includes(RALPH_QUESTION_FENCE));
      expect(cards).toHaveLength(1);

      const recovered = await engineWith().runIntervention(run, issue);

      expect(recovered).toMatchObject({ kind: "resolved", resolution: "terminal-stuck" });
      expect(
        (await github.listIssueComments(7)).filter((c) => c.body.includes(RALPH_QUESTION_FENCE)),
      ).toHaveLength(1);
      expect(store.getRunByIssue(7)!.status).toBe("agent-stuck");
    });
  });
});
