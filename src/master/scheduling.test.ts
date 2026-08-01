/**
 * Master scheduling through the real {@link Reconciler} (ADR-0041): master work outranks
 * fresh admission, runs on the ordinary global cap, is globally serialized, and never blocks
 * unrelated slot usage — plus the restart-recovery guarantee that exactly one pending master
 * intervention is rehydrated and no session (or decision comment) is duplicated.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../log/logger";
import { MEMORY_DB, openStore, type ScopedStore } from "../store/store";
import { FakeGitHub } from "../testing/fake-github";
import { FakeWorktreeManager } from "../testing/fake-worktree";
import { PrOpeningAgentRunner } from "../testing/fake-agent";
import { FakeMasterAgent, FakeMasterPipeline } from "../testing/fake-master-agent";
import { Executor } from "../executor/executor";
import { Reconciler, type ReconcileBudget } from "../daemon/reconciler";
import { rehydrateRunsFromGitHub } from "../daemon/rehydrate";
import { classifyIssueState } from "../daemon/completeness";
import { LABEL_MASTER_TRIAGE } from "../core/labels";
import type { Account, AgentSettings, ProvidersSettings } from "../config/schema";
import type { RoutingConfig, RouteWorld } from "../providers/resolve";
import { buildLaunchMarker } from "../github/marker";
import { MasterEngine } from "./engine";
import { MasterLease } from "./lease";
import { foldMasterHistory } from "./history";
import { formatMasterRequestComment } from "./request";
import { formatRalphAnswer } from "../hitl/answer";
import type { MasterSessionResult } from "./outcome";

const silent = createLogger({ write: () => {} });
const REPO = "owner/repo";

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
  provider: "zai",
  types: {},
  tiers: { "1": { routes: [{ provider: "claude", model: "claude-fable-5" }] } },
};
const routing = (): RoutingConfig => ({ agent: agentSettings, providers });

const resolvedOutcome: MasterSessionResult = {
  outcome: {
    resolution: "resolved-and-continue",
    conclusion: "The fixture was wrong, not the code.",
    rationale: "Fixing the fixture keeps behaviour unchanged.",
    guidance: "Re-run the suite.",
  },
  decisions: [],
};

function budgetFor(active: () => number, cap: number): ReconcileBudget {
  return { available: () => Math.max(0, cap - active()), hasCapacity: () => active() < cap };
}

describe("master scheduling in the reconcile tick (ADR-0041)", () => {
  let store: ScopedStore;
  let github: FakeGitHub;
  let agent: FakeMasterAgent;
  let pipeline: FakeMasterPipeline;
  let lease: MasterLease;

  beforeEach(() => {
    store = openStore(MEMORY_DB).forRepo(REPO);
    github = new FakeGitHub(REPO);
    agent = new FakeMasterAgent();
    pipeline = new FakeMasterPipeline();
    lease = new MasterLease();
  });
  afterEach(() => store.close());

  function wire(opts: { cap?: number; sharedLease?: MasterLease; tiers?: AgentSettings["tiers"] } = {}) {
    const cap = opts.cap ?? 5;
    const routingFor = (): RoutingConfig =>
      opts.tiers === undefined ? routing() : { agent: { ...agentSettings, tiers: opts.tiers }, providers };
    const worktrees = new FakeWorktreeManager();
    const runner = new PrOpeningAgentRunner(github);
    const executor = new Executor({ store, github, worktrees, agentRunner: runner, logger: silent });
    let reconciler: Reconciler;
    const engine = new MasterEngine({
      store,
      github,
      agent,
      pipeline,
      logger: silent,
      targetRepo: REPO,
      baseBranch: "master",
      routing: routingFor,
      routeWorld,
    });
    reconciler = new Reconciler({
      store,
      github,
      executor,
      worktrees,
      logger: silent,
      budget: budgetFor(() => reconciler.activeCount(), cap),
      cap,
      priorityLabels: [],
      targetRepo: REPO,
      reconcileIntervalSeconds: 30,
      masterEngine: engine,
      masterLease: opts.sharedLease ?? lease,
    });
    return { reconciler, runner, engine };
  }

  /** Seed an issue queued for master escalation, with its durable request comment. */
  async function seedQueued(issueNumber: number, title: string): Promise<void> {
    github.seed({
      number: issueNumber,
      title,
      labels: ["afk", "mode:tdd", "complexity:1", LABEL_MASTER_TRIAGE],
      createdAt: `2026-01-0${issueNumber}T00:00:00Z`,
    });
    const branch = `ralph/${issueNumber}-x`;
    const pr = github.openPullRequest(branch, buildLaunchMarker({ issueNumber, branch }));
    const run = store.upsertRun({
      issueNumber,
      mode: "tdd",
      tier: 1,
      branch,
      worktreePath: `/w/${issueNumber}`,
      prNumber: pr.number,
      issueTitle: title,
    });
    await github.postComment(
      issueNumber,
      formatMasterRequestComment({
        source: "escalate",
        lane: "impl",
        phase: "impl",
        issueNumber,
        runId: run.id,
        branch,
        signature: `escalate|impl|blocked ${issueNumber}`,
        evidence: { headline: "blocked", recommendation: "do X", detail: `blocked ${issueNumber}` },
      }),
    );
    await store.recordMasterTriageRequested({
      issueNumber,
      runId: run.id,
      source: "escalate",
      phase: "impl",
      lane: "impl",
      signature: `escalate|impl|blocked ${issueNumber}`,
      headline: "blocked",
      recommendation: "do X",
      prNumber: pr.number,
    });
  }

  it("selects master work BEFORE a fresh admission when only one slot is free", async () => {
    await seedQueued(3, "queued master");
    // A fresh, older, otherwise-eligible issue competing for the single slot.
    github.seed({ number: 1, title: "fresh", createdAt: "2025-01-01T00:00:00Z" });
    agent.push(resolvedOutcome);

    const { reconciler, runner } = wire({ cap: 1 });
    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(agent.sessions).toHaveLength(1);
    expect(agent.sessions[0]!.issue.number).toBe(3);
    // The fresh issue did not launch this tick — the master took the only slot.
    expect(runner.runs.map((r) => r.issue.number)).not.toContain(1);
  });

  it("never exceeds the ordinary global cap", async () => {
    await seedQueued(3, "queued master");
    agent.push(resolvedOutcome);
    const { reconciler } = wire({ cap: 1 });

    await reconciler.tick();
    // While the master session holds the slot, the pool is full.
    expect(reconciler.inFlightCount()).toBeLessThanOrEqual(1);
    await reconciler.awaitInFlight();
    expect(reconciler.inFlightCount()).toBe(0);
  });

  it("globally serializes: a second queued master waits without blocking unrelated slots", async () => {
    await seedQueued(3, "first");
    await seedQueued(4, "second");
    github.seed({ number: 1, title: "fresh", createdAt: "2025-01-01T00:00:00Z" });
    agent.push(resolvedOutcome);

    const { reconciler, runner } = wire({ cap: 5 });
    await reconciler.tick();
    // The unrelated fresh issue got a slot in the SAME tick — a waiting master never
    // blocks ordinary admission.
    expect(runner.runs.map((r) => r.issue.number)).toContain(1);
    await reconciler.awaitInFlight();

    // …and exactly one master ran: the second waits on the global lease.
    expect(agent.sessions).toHaveLength(1);
  });

  it("holds the lease across repos — a second reconciler cannot start a master concurrently", async () => {
    await seedQueued(3, "first");
    await seedQueued(4, "second");
    agent.push(resolvedOutcome);
    agent.push(resolvedOutcome);
    const shared = new MasterLease();
    const a = wire({ sharedLease: shared });
    const b = wire({ sharedLease: shared });

    a.reconciler.serviceMasterQueue();
    // The second reconciler sees the lease held and takes nothing — no slot, no session.
    b.reconciler.serviceMasterQueue();
    expect(b.reconciler.inFlightCount()).toBe(0);

    await Promise.all([a.reconciler.awaitInFlight(), b.reconciler.awaitInFlight()]);
    expect(agent.sessions).toHaveLength(1);
    // Once released, the next tick may take the other one.
    b.reconciler.serviceMasterQueue();
    await b.reconciler.awaitInFlight();
    expect(agent.sessions).toHaveLength(2);
  });

  it("services the second queued master on a later tick", async () => {
    await seedQueued(3, "first");
    await seedQueued(4, "second");
    agent.push(resolvedOutcome);
    agent.push(resolvedOutcome);
    const { reconciler } = wire();

    await reconciler.tick();
    await reconciler.awaitInFlight();
    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(agent.sessions.map((s) => s.issue.number)).toEqual([3, 4]);
  });

  it("excludes a master-triage issue from ordinary admission", async () => {
    await seedQueued(3, "queued master");
    // Make it look admissible in every other way.
    github.issues.get(3)!.labels.push("ready-for-agent");
    agent.push(resolvedOutcome);

    const { reconciler, runner } = wire();
    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(runner.runs.map((r) => r.issue.number)).not.toContain(3);
  });

  it("classifies a queued escalation as in-flight, never as awaiting-human", () => {
    expect(
      classifyIssueState({
        issueNumber: 3,
        issueState: "OPEN",
        labels: ["afk", "mode:tdd", LABEL_MASTER_TRIAGE],
        runStatus: "master-triage",
        inFlight: false,
        wedged: false,
        gateEligible: false,
        resumable: false,
        answered: false,
      }),
    ).toEqual({ kind: "in-flight" });
  });

  it("applies the daemon-owned master-triage label as a level-triggered effect", async () => {
    await seedQueued(3, "queued master");
    github.issues.get(3)!.labels = github.issues.get(3)!.labels.filter((l) => l !== LABEL_MASTER_TRIAGE);
    agent.push(resolvedOutcome);

    const { reconciler } = wire();
    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(github.issues.get(3)!.labels).toContain(LABEL_MASTER_TRIAGE);
    expect(github.issues.get(3)!.labels).not.toContain("daemon-anomaly");
  });

  it("surfaces an unroutable tier 1 as a VISIBLE daemon-anomaly, not a silent in-flight", async () => {
    await seedQueued(3, "queued master");
    const { reconciler } = wire({ tiers: {} });

    await reconciler.tick();
    await reconciler.awaitInFlight();
    // A second tick: the first dispatched (and refused); this one classifies the queued run.
    await reconciler.tick();
    await reconciler.awaitInFlight();

    expect(agent.sessions).toHaveLength(0);
    expect(github.issues.get(3)!.labels).toContain("daemon-anomaly");
    expect(store.getRunByIssue(3)!.status).toBe("master-triage");
  });

  it("routes an answered MASTER question back to the master, never to the worker", async () => {
    await seedQueued(3, "queued master");
    const question = {
      headline: "Which contract is authoritative?",
      feature: "Widget",
      whereWeStand: "Two contracts disagree.",
      decision: "Pick one.",
      stakes: "Downstream consumers depend on it.",
      recommendation: "Pick v2.",
    };
    agent.push({
      outcome: {
        resolution: "ask-human",
        conclusion: "Only a human can pick.",
        rationale: "Design authority is silent and the call is a product one.",
        question,
      },
      decisions: [],
    });
    const { reconciler, runner } = wire();
    await reconciler.tick();
    await reconciler.awaitInFlight();
    expect(store.getRunByIssue(3)!.status).toBe("awaiting-answer");

    // The operator answers and re-arms, exactly as `ralph-answer` does.
    await github.postComment(3, formatRalphAnswer({ kind: "free-text", text: "v2 is authoritative." }));
    github.issues.get(3)!.labels.push("ready-for-agent");
    agent.push(resolvedOutcome);

    await reconciler.tick();
    await reconciler.awaitInFlight();

    // The MASTER resumed (a second master session), and no worker impl run was launched.
    expect(agent.sessions).toHaveLength(2);
    expect(agent.sessions[1]!.prompt).toContain("v2 is authoritative.");
    expect(runner.runs.map((r) => r.issue.number)).not.toContain(3);
  });

  describe("daemon restart", () => {
    it("rehydrates exactly one pending master intervention from GitHub on a cold store", async () => {
      await seedQueued(3, "queued master");
      // Simulate the cold store: drop every local row/event but keep GitHub intact.
      const cold = openStore(MEMORY_DB).forRepo(REPO);

      const rebuilt = await rehydrateRunsFromGitHub(github, cold, silent);

      expect(rebuilt).toEqual([3]);
      expect(cold.getRunByIssue(3)!.status).toBe("master-triage");
      const history = foldMasterHistory(cold.readIssueStream(3));
      expect(history.pending).toMatchObject({ source: "escalate", phase: "impl", signature: "escalate|impl|blocked 3" });
      expect(cold.readIssueStream(3).filter((e) => e.type === "MasterTriageRequested")).toHaveLength(1);
      cold.close();
    });

    it("never duplicates a session when the daemon died mid-intervention", async () => {
      await seedQueued(3, "queued master");
      // The daemon started the intervention and died before its outcome landed.
      const run = store.getRunByIssue(3)!;
      await store.recordMasterInterventionStarted({
        issueNumber: 3,
        runId: run.id,
        attempt: 1,
        phase: "impl",
        signature: "escalate|impl|blocked 3",
      });
      agent.push(resolvedOutcome);

      const { reconciler } = wire();
      await reconciler.tick();
      await reconciler.awaitInFlight();
      // A second tick must not run the same intervention again.
      await reconciler.tick();
      await reconciler.awaitInFlight();

      expect(agent.sessions).toHaveLength(1);
      expect(foldMasterHistory(store.readIssueStream(3)).interventions).toHaveLength(1);
    });
  });

  /**
   * The drain contract (ADR-0042). A drain must not START a master session — the daemon is on
   * its way out, and a fresh tier-1 session would either be killed mid-adjudication or hold the
   * process open past its deadline. The queue is durable (a `MasterTriageRequested` fact plus the
   * `master-triage` label on GitHub), so nothing is lost by simply not starting: the next normal
   * startup re-folds the queue and services it.
   */
  describe("drain", () => {
    it("starts no master session while draining, and preserves the queue durably", async () => {
      await seedQueued(3, "queued master");
      agent.push(resolvedOutcome);
      const { reconciler } = wire();

      // The drain pump feeds ONLY the merge worker (the orchestrator stops calling `tick`).
      reconciler.serviceMergeWorker();
      await reconciler.awaitInFlight();
      expect(agent.sessions).toHaveLength(0);

      // The request is still queued and still visible on GitHub — nothing was consumed.
      expect(foldMasterHistory(store.readIssueStream(3)).pending).not.toBeNull();
      expect(store.getRunByIssue(3)!.status).toBe("master-triage");

      // After a normal startup the very next tick adjudicates it.
      await reconciler.tick();
      await reconciler.awaitInFlight();
      expect(agent.sessions).toHaveLength(1);
    });
  });
});
