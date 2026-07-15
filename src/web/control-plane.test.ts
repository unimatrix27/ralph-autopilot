import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../log/logger";
import { parseConfig, resolveTargets } from "../config/load";
import type { RalphConfig } from "../config/schema";
import { MEMORY_DB, openStore, type Store } from "../store/store";
import { seedRun } from "../testing/seed-run";
import { FakeGitHub } from "../testing/fake-github";
import {
  buildHealCardQuestion,
  buildPhaseMarker,
  formatHealCard,
  formatRalphQuestion,
  type EscalationQuestion,
} from "../review/escalation";
import { buildStuckCardQuestion } from "../executor/stuck";
import { LABEL_AGENT_STUCK, LABEL_AWAITING_ANSWER, LABEL_REVIEW_MAXED, LABEL_READY } from "../hitl/labels";
import { LABEL_AFK, LABEL_HITL, LABEL_MODE_TDD } from "../core/labels";
import { parseRalphAnswer } from "../hitl/answer";
import {
  analyticsResponseSchema,
  answerResponseSchema,
  backlogResponseSchema,
  healthResponseSchema,
  healthUsageResponseSchema,
  inboxResponseSchema,
  overviewResponseSchema,
  runDetailResponseSchema,
  runsResponseSchema,
  effectiveRoutingResponseSchema,
} from "./contract";
import { createWebPorts, startWebControlPlane } from "./control-plane";
import { RoutingStore } from "../config/routing-store";
import type { DaemonControl } from "./server/ports";
import type { DaemonSnapshot } from "../store/types";
import { randomBytes } from "node:crypto";
import { resolveVapidIdentity } from "../notify/webpush";

const silentLogger = createLogger({ level: "error", write: () => {} });

/**
 * A minimal valid config, with `web` overridable for the test at hand. The override
 * is applied *after* parse so a test can use an ephemeral `port: 0` (which the schema
 * rightly rejects for real config, where a concrete port is required).
 */
function config(web: Partial<RalphConfig["web"]> = {}): RalphConfig {
  const base = parseConfig({
    targets: [{ repo: "owner/repo", commands: { build: "true", test: "true" } }],
  });
  return { ...base, web: { ...base.web, ...web } };
}

function targetMetadata(
  repos: readonly string[],
  priorityLabelsFor: (repo: string) => readonly string[] = () => [],
): Array<{ targetRepo: string; priorityLabels: string[] }> {
  return repos.map((repo) => ({ targetRepo: repo, priorityLabels: [...priorityLabelsFor(repo)] }));
}

function fakeControl(): DaemonControl {
  return {
    drain: () => {},
    forceTick: () => {},
    killRun: () => false,
  };
}

describe("createWebPorts", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(MEMORY_DB, { now: () => "2026-06-21T00:00:00.000Z" });
  });
  afterEach(() => store.close());

  it("computes uptime from the injected clock and emits a contract-valid health", () => {
    const startedAt = new Date("2026-06-21T00:00:00.000Z");
    let nowMs = startedAt.getTime() + 42_000;
    const ports = createWebPorts({
      startedAt,
      now: () => new Date(nowMs),
      store,
      targets: targetMetadata([]),
      admitBelowPercent: 85,
      githubFor: () => new FakeGitHub(),
      reconcileIntervalSeconds: 30,
      control: fakeControl(),
    });
    const health = ports.health();
    expect(healthResponseSchema.safeParse(health).success).toBe(true);
    expect(health.uptimeSeconds).toBe(42);
    expect(health.startedAt).toBe(startedAt.toISOString());
    nowMs += 18_000;
    expect(ports.health().uptimeSeconds).toBe(60);
  });

  it("projects the store into a contract-valid overview, narrowing by repo", async () => {
    // Two repos each with an open escalation, so the aggregate sees both and the
    // filter narrows to one (issue #108).
    await seedRun(store.forRepo("owner/a"), { issueNumber: 1, mode: "tdd", status: "awaiting-answer" });
    await seedRun(store.forRepo("owner/b"), { issueNumber: 2, mode: "tdd", status: "awaiting-answer" });

    const ports = createWebPorts({
      startedAt: new Date("2026-06-21T00:00:00.000Z"),
      now: () => new Date("2026-06-21T01:00:00.000Z"),
      store,
      targets: targetMetadata(["owner/a", "owner/b", "owner/idle"]),
      admitBelowPercent: 85,
      githubFor: () => new FakeGitHub(),
      reconcileIntervalSeconds: 30,
      control: fakeControl(),
    });

    const all = ports.overview({});
    expect(overviewResponseSchema.safeParse(all).success).toBe(true);
    expect(all.repo).toBeNull();
    expect(all.reconcileIntervalSeconds).toBe(30);
    expect(all.needsYou.map((n) => n.repo).sort()).toEqual(["owner/a", "owner/b"]);
    // The filter list includes the configured-but-idle repo.
    expect(all.repos).toEqual(["owner/a", "owner/b", "owner/idle"]);

    const onlyA = ports.overview({ repo: "owner/a" });
    expect(onlyA.repo).toBe("owner/a");
    expect(onlyA.needsYou.map((n) => n.repo)).toEqual(["owner/a"]);
    expect(onlyA.repos).toEqual(["owner/a", "owner/b", "owner/idle"]); // full list preserved
  });

  it("projects the run-log history into contract-valid analytics, narrowing by repo + window", () => {
    // A clocked store so each appended log entry lands on a controlled day.
    let ts = "2026-06-20T00:00:00.000Z";
    const clocked = openStore(MEMORY_DB, { now: () => ts });
    try {
      const a = clocked.forRepo("owner/a").upsertRun({ issueNumber: 1, mode: "tdd" });
      const b = clocked.forRepo("owner/b").upsertRun({ issueNumber: 2, mode: "tdd" });
      // owner/a: picked up then merged on 2026-06-20 (2h to merge).
      ts = "2026-06-20T09:00:00.000Z";
      clocked.forRepo("owner/a").appendLog({ runId: a.id, level: "info", event: "pickup" });
      ts = "2026-06-20T11:00:00.000Z";
      clocked.forRepo("owner/a").appendLog({ runId: a.id, level: "info", event: "merged", data: { prNumber: 7 } });
      // owner/b: picked up then merged on 2026-06-21.
      ts = "2026-06-21T08:00:00.000Z";
      clocked.forRepo("owner/b").appendLog({ runId: b.id, level: "info", event: "pickup" });
      ts = "2026-06-21T10:00:00.000Z";
      clocked.forRepo("owner/b").appendLog({ runId: b.id, level: "info", event: "merged", data: { prNumber: 9 } });

      const ports = createWebPorts({
        startedAt: new Date("2026-06-21T00:00:00.000Z"),
        now: () => new Date("2026-06-21T12:00:00.000Z"),
        store: clocked,
        targets: targetMetadata(["owner/a", "owner/b", "owner/idle"]),
        admitBelowPercent: 85,
        githubFor: () => new FakeGitHub(),
        reconcileIntervalSeconds: 30,
        control: fakeControl(),
      });

      const all = ports.analytics({ windowDays: 30 });
      expect(analyticsResponseSchema.safeParse(all).success).toBe(true);
      expect(all.repo).toBeNull();
      expect(all.windowDays).toBe(30);
      expect(all.daily).toHaveLength(30);
      expect(all.summary.totalMerges).toBe(2); // aggregate across both repos
      expect(all.summary.meanTimeToMergeMs).toBe(7_200_000); // both took 2h
      expect(all.repos).toEqual(["owner/a", "owner/b", "owner/idle"]); // configured-but-idle included

      const onlyA = ports.analytics({ repo: "owner/a", windowDays: 7 });
      expect(onlyA.repo).toBe("owner/a");
      expect(onlyA.windowDays).toBe(7);
      expect(onlyA.daily).toHaveLength(7);
      expect(onlyA.summary.totalMerges).toBe(1); // only owner/a's merge
      expect(onlyA.repos).toEqual(["owner/a", "owner/b", "owner/idle"]); // full list preserved
    } finally {
      clocked.close();
    }
  });

  it("projects daemon health, anomalies (with logged reason), and the injected usage state", () => {
    // A persisted tick snapshot for one repo: drives the daemon-health section and parks
    // an issue under daemon-anomaly so it surfaces as an island.
    store.saveBacklogSnapshot("owner/a", {
      generatedAt: "2026-06-21T00:59:50.000Z",
      targetRepo: "owner/a",
      cap: 5,
      reconcileIntervalSeconds: 30,
      daemonStartedAt: "2026-06-21T00:00:00.000Z",
      lastError: null,
      eligible: [],
      blocked: [],
      paused: [{ issueNumber: 42, title: "an island", state: "daemon-anomaly" }],
    });
    // The reason is logged once at the edge (scoped store tags the repo).
    store.forRepo("owner/a").appendLog({
      runId: null,
      issueNumber: 42,
      level: "warn",
      event: "daemon-anomaly",
      data: { reason: "paused-label-missing-run" },
    });

    const ports = createWebPorts({
      startedAt: new Date("2026-06-21T00:00:00.000Z"),
      now: () => new Date("2026-06-21T01:00:00.000Z"),
      store,
      targets: targetMetadata(["owner/a"]),
      admitBelowPercent: 85,
      githubFor: () => new FakeGitHub(),
      reconcileIntervalSeconds: 30,
      // A second login over the threshold, so the usage section is exercised end-to-end.
      usage: () => ({
        activeId: "primary",
        ids: ["primary", "secondary"],
        states: { secondary: { windows: { five_hour: { utilization: 95, resetsAtMs: null } }, cooldownUntilMs: null } },
      }),
      control: fakeControl(),
    });

    const view = ports.healthUsage();
    expect(healthUsageResponseSchema.safeParse(view).success).toBe(true);
    // Daemon health: cap from the snapshot, last tick 10s before now, not stale.
    expect(view.daemon).not.toBeNull();
    expect(view.daemon!.cap).toBe(5);
    expect(view.daemon!.lastTickAt).toBe("2026-06-21T00:59:50.000Z");
    expect(view.daemon!.stale).toBe(false);
    // The island is listed with its logged reason.
    expect(view.anomalies).toEqual([
      { repo: "owner/a", issue: 42, reason: "paused-label-missing-run", title: "an island", since: "2026-06-21T00:00:00.000Z" },
    ]);
    // The injected usage state flows through: the active login (no state) is optimistic;
    // the secondary login is gated at 95% ≥ 85%.
    expect(view.usage.activeId).toBe("primary");
    expect(view.usage.logins.find((l) => l.id === "secondary")!.gated).toBe(true);
    expect(view.usage.paused).toBe(false); // the active login still has headroom
  });

  it("projects the store into a contract-valid backlog, aggregating + narrowing by repo", () => {
    // Persist a per-repo daemon snapshot for two targets so the aggregate backlog sees
    // both repos' sections and the repo filter narrows them (issue #113).
    const baseSnap = (repo: string): DaemonSnapshot => ({
      generatedAt: "2026-06-21T00:00:00.000Z",
      targetRepo: repo,
      cap: 5,
      reconcileIntervalSeconds: 30,
      daemonStartedAt: "2026-06-21T00:00:00.000Z",
      lastError: null,
      eligible: [],
      blocked: [],
      paused: [],
      manualHolds: [],
      modingCandidates: [],
    });
    store.forRepo("owner/a").saveBacklogSnapshot({
      ...baseSnap("owner/a"),
      eligible: [{ issueNumber: 11, title: "next up", priority: "priority:p0", priorityColor: "red" }],
      modingCandidates: [{ issueNumber: 12, title: "needs a mode" }],
    });
    store.forRepo("owner/b").saveBacklogSnapshot({
      ...baseSnap("owner/b"),
      blocked: [{ issueNumber: 20, title: "blocked", blockers: [{ ref: 99, satisfied: false }] }],
      paused: [{ issueNumber: 21, title: "stuck", state: "agent-stuck" }],
    });

    const ports = createWebPorts({
      startedAt: new Date("2026-06-21T00:00:00.000Z"),
      now: () => new Date("2026-06-21T01:00:00.000Z"),
      store,
      targets: targetMetadata(["owner/a", "owner/b", "owner/idle"]),
      admitBelowPercent: 85,
      githubFor: () => new FakeGitHub(),
      reconcileIntervalSeconds: 30,
      control: fakeControl(),
    });

    const all = ports.backlog({});
    expect(backlogResponseSchema.safeParse(all).success).toBe(true);
    expect(all.repo).toBeNull();
    expect(all.eligible.map((e) => [e.repo, e.issue])).toEqual([["owner/a", 11]]);
    expect(all.modingCandidates.map((m) => [m.repo, m.issue])).toEqual([["owner/a", 12]]);
    expect(all.blocked.map((b) => [b.repo, b.issue])).toEqual([["owner/b", 20]]);
    expect(all.blocked[0]!.blockers).toEqual([{ ref: 99, satisfied: false }]);
    expect(all.paused.map((p) => [p.repo, p.issue, p.state])).toEqual([["owner/b", 21, "agent-stuck"]]);
    expect(all.manualHolds).toEqual([]);
    expect(all.repos).toEqual(["owner/a", "owner/b", "owner/idle"]);

    const onlyB = ports.backlog({ repo: "owner/b" });
    expect(onlyB.repo).toBe("owner/b");
    expect(onlyB.eligible).toHaveLength(0);
    expect(onlyB.modingCandidates).toHaveLength(0);
    expect(onlyB.blocked.map((b) => b.issue)).toEqual([20]);
    expect(onlyB.paused.map((p) => p.issue)).toEqual([21]);
    expect(onlyB.repos).toEqual(["owner/a", "owner/b", "owner/idle"]); // full list preserved
  });

  it("indexes runs across repos (newest-first) and serves one run's detail + transcript (issue #111)", async () => {
    // Two runs on two repos; owner/a is older, owner/b newer (clock advances per upsert).
    let ts = "2026-06-21T00:00:00.000Z";
    const clocked = openStore(MEMORY_DB, { now: () => ts });
    try {
      const a = clocked.forRepo("owner/a");
      const b = clocked.forRepo("owner/b");
      const runA = a.upsertRun({ issueNumber: 7, mode: "tdd", branch: "ralph/7-x" });
      await a.recordRunStarted({ runId: runA.id, issueNumber: 7, mode: "tdd", branch: "ralph/7-x" });
      await a.recordReviewPhaseEntered({ runId: runA.id, issueNumber: 7, phase: 1 });
      await a.recordFixAttempt({ runId: runA.id, issueNumber: 7, phase: 1 });
      await a.appendToTranscript(7, String(runA.id), [
        {
          type: "TranscriptMessage",
          data: {
            runId: String(runA.id),
            at: "2026-06-21T00:05:00.000Z",
            role: "assistant",
            sdkType: "assistant",
            blocks: [
              { kind: "text", text: "running tests" },
              { kind: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } },
            ],
          },
        },
      ]);
      ts = "2026-06-21T02:00:00.000Z";
      b.upsertRun({ issueNumber: 9, mode: "infra" });

      const ports = createWebPorts({
        startedAt: new Date("2026-06-21T00:00:00.000Z"),
        now: () => new Date("2026-06-21T03:00:00.000Z"),
        store: clocked,
        targets: targetMetadata(["owner/a", "owner/b"]),
        admitBelowPercent: 85,
        githubFor: () => new FakeGitHub(),
        reconcileIntervalSeconds: 30,
        control: fakeControl(),
      });

      // The runs index: contract-valid, newest activity first, repo filter honoured.
      const index = ports.runs({});
      expect(runsResponseSchema.safeParse(index).success).toBe(true);
      expect(index.runs.map((r) => [r.repo, r.issue])).toEqual([
        ["owner/b", 9],
        ["owner/a", 7],
      ]);
      expect(ports.runs({ repo: "owner/a" }).runs.map((r) => r.issue)).toEqual([7]);

      // The run detail: header + permanent timeline + captured transcript.
      const detail = ports.run({ repo: "owner/a", issue: 7 });
      expect(detail).not.toBeNull();
      expect(runDetailResponseSchema.safeParse(detail).success).toBe(true);
      expect(detail!.run.runId).toBe(String(runA.id));
      expect(detail!.run.branch).toBe("ralph/7-x");
      expect(detail!.run.fixAttempts).toEqual({ "1": 1 });
      expect(detail!.timeline.map((t) => t.type)).toEqual(["RunStarted", "ReviewPhaseEntered", "FixAttempted"]);
      expect(detail!.transcript).toHaveLength(1);
      expect(detail!.transcript[0]!.type).toBe("TranscriptMessage");
      expect(detail!.pruned).toBeNull();

      // A run that does not exist → null (the server answers 404).
      expect(ports.run({ repo: "owner/a", issue: 999 })).toBeNull();
    } finally {
      clocked.close();
    }
  });
});

describe("createWebPorts — web push (issue #119)", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(MEMORY_DB, { now: () => "2026-06-21T00:00:00.000Z" });
  });
  afterEach(() => store.close());

  const vapid = resolveVapidIdentity({
    privateKeyScalarB64url: randomBytes(32).toString("base64url"),
    subject: "mailto:operator@example.com",
  });

  function portsFor(v: typeof vapid | null) {
    return createWebPorts({
      startedAt: new Date("2026-06-21T00:00:00.000Z"),
      now: () => new Date("2026-06-21T00:00:00.000Z"),
      store,
      targets: targetMetadata([]),
      admitBelowPercent: 85,
      githubFor: () => new FakeGitHub(),
      reconcileIntervalSeconds: 30,
      control: fakeControl(),
      vapid: v,
    });
  }

  it("serves the VAPID public key when configured, disabled when not", () => {
    expect(portsFor(vapid).webpushVapid()).toEqual({ enabled: true, publicKey: vapid.publicKey });
    expect(portsFor(null).webpushVapid()).toEqual({ enabled: false, publicKey: null });
  });

  it("persists a subscription through the subscribe port (survives in the store)", async () => {
    const ports = portsFor(vapid);
    const res = await ports.webpushSubscribe({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: { p256dh: "BGk-p256dh", auth: "authsecret" },
    });
    expect(res).toEqual({ kind: "subscribed", response: { ok: true, endpoint: "https://fcm.googleapis.com/fcm/send/abc" } });
    expect(store.listPushSubscriptions().map((s) => s.endpoint)).toEqual(["https://fcm.googleapis.com/fcm/send/abc"]);
  });

  it("refuses to subscribe (disabled → 503 outcome) when push is not configured", async () => {
    const res = await portsFor(null).webpushSubscribe({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: { p256dh: "BGk", auth: "a" },
    });
    expect(res.kind).toBe("disabled");
    expect(store.listPushSubscriptions()).toEqual([]);
  });

  it("unsubscribe removes the subscription and is idempotent", async () => {
    const ports = portsFor(vapid);
    await ports.webpushSubscribe({ endpoint: "https://push/ep", keys: { p256dh: "k", auth: "a" } });
    await ports.webpushUnsubscribe({ endpoint: "https://push/ep" });
    await ports.webpushUnsubscribe({ endpoint: "https://push/ep" }); // no throw
    expect(store.listPushSubscriptions()).toEqual([]);
  });
});

const inboxQuestion: EscalationQuestion = {
  headline: "Delete the legacy adapter?",
  feature: "Ingestion",
  whereWeStand: "Review wants it gone; old consumers still call it.",
  decision: "Remove it or keep it behind a flag?",
  options: ["Delete it", "Keep behind a flag"],
  stakes: "One-way door for old consumers.",
  recommendation: "Keep behind a flag.",
};

/** Seed an awaiting-answer escalation carrying a ralph-question comment. */
function seedEscalation(github: FakeGitHub, number: number, createdAt: string): void {
  github.seed({ number, title: `Escalation ${number}`, createdAt, labels: [LABEL_AWAITING_ANSWER, "afk", "mode:tdd"] });
  void github.postComment(number, formatRalphQuestion({ ...inboxQuestion, headline: `Q${number}` }));
}

/** Seed a review-maxed heal-card carrying its phase marker (a review-origin pause). */
function seedHealCard(github: FakeGitHub, number: number, createdAt: string, phase: 0 | 1 | 2): void {
  github.seed({ number, title: `Maxed ${number}`, createdAt, labels: [LABEL_REVIEW_MAXED, "afk", "mode:tdd"] });
  void github.postComment(
    number,
    formatHealCard({ phase, attempts: 3, worklist: { items: [{ severity: "P0", title: "race on retry" }] } }) +
      "\n" +
      buildPhaseMarker(phase),
  );
}

/** Seed an agent-stuck issue carrying an open stuck-card (#86). */
function seedStuck(github: FakeGitHub, number: number, createdAt: string): void {
  github.seed({ number, title: `Stuck ${number}`, createdAt, labels: [LABEL_AGENT_STUCK, "afk", "mode:tdd"] });
  void github.postComment(number, formatRalphQuestion(buildStuckCardQuestion({ category: "fix-iterations", reason: "looped" })));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

class BlockingListFakeGitHub extends FakeGitHub {
  constructor(
    private readonly repo: string,
    private readonly started: string[],
    private readonly release: Promise<void>,
  ) {
    super();
  }

  override async listOpenIssues() {
    this.started.push(this.repo);
    await this.release;
    return super.listOpenIssues();
  }
}

describe("createWebPorts — Inbox + answers (issue #112)", () => {
  let store: Store;
  const githubs: Record<string, FakeGitHub> = {};
  beforeEach(() => {
    store = openStore(MEMORY_DB, { now: () => "2026-06-22T00:00:00.000Z" });
    githubs["owner/a"] = new FakeGitHub();
    githubs["owner/b"] = new FakeGitHub();
  });
  afterEach(() => store.close());

  const ports = () =>
    createWebPorts({
      startedAt: new Date("2026-06-22T00:00:00.000Z"),
      now: () => new Date("2026-06-22T00:00:00.000Z"),
      store,
      targets: targetMetadata(["owner/a", "owner/b", "owner/idle"], () => [
        "priority:p0",
        "priority:p1",
        "priority:p2",
      ]),
      admitBelowPercent: 85,
      githubFor: (repo: string) => githubs[repo] ?? new FakeGitHub(),
      reconcileIntervalSeconds: 30,
      control: fakeControl(),
    });

  it("lists open questions across repos oldest-first as structured cards with consequence + deep links (AC1/AC3)", async () => {
    // owner/a: an awaiting-answer escalation with a tracked run (branch + PR for deep links).
    seedEscalation(githubs["owner/a"]!, 11, "2026-02-02T00:00:00Z");
    store.forRepo("owner/a").upsertRun({ issueNumber: 11, mode: "tdd", branch: "ralph/11-x", prNumber: 42 });
    // owner/b: an older agent-stuck stuck-card (no tracked run → null enrichment).
    seedStuck(githubs["owner/b"]!, 10, "2026-02-01T00:00:00Z");

    const res = await ports().inbox({});
    expect(inboxResponseSchema.safeParse(res).success).toBe(true);
    expect(res.reconcileIntervalSeconds).toBe(30);
    // Oldest-first across repos, regardless of kind.
    expect(res.cards.map((c) => [c.repo, c.issue, c.attentionLabel, c.consequence])).toEqual([
      ["owner/b", 10, "agent-stuck", "readmit-fresh"],
      ["owner/a", 11, "awaiting-answer", "resume-from-wip"],
    ]);
    // Stakes + recommendation are carried; the run enrichment yields deep links.
    expect(res.cards[1]!.question.stakes).toBe(inboxQuestion.stakes);
    expect(res.cards[1]!.question.recommendation).toBe(inboxQuestion.recommendation);
    expect(res.cards[1]!.run).toEqual({ runId: expect.any(String), branch: "ralph/11-x", prNumber: 42 });
    expect(res.cards[0]!.run).toBeNull();
  });

  it("echoes the repo filter while preserving the full repo list, and surfaces a review phase", async () => {
    seedHealCard(githubs["owner/a"]!, 20, "2026-02-03T00:00:00Z", 1);
    seedEscalation(githubs["owner/b"]!, 21, "2026-02-04T00:00:00Z");

    const onlyA = await ports().inbox({ repo: "owner/a" });
    expect(onlyA.repo).toBe("owner/a");
    expect(onlyA.repos).toEqual(["owner/a", "owner/b", "owner/idle"]);
    expect(onlyA.cards.map((c) => c.issue)).toEqual([20]);
    // A review-origin pause carries its phase; consequence is resume-from-wip.
    expect(onlyA.cards[0]!.attentionLabel).toBe("review-maxed");
    expect(onlyA.cards[0]!.phase).toBe(1);
    expect(onlyA.cards[0]!.consequence).toBe("resume-from-wip");
  });

  it("starts selected repo inbox reads concurrently before awaiting any one repo", async () => {
    const release = deferred();
    const started: string[] = [];
    githubs["owner/a"] = new BlockingListFakeGitHub("owner/a", started, release.promise);
    githubs["owner/b"] = new BlockingListFakeGitHub("owner/b", started, release.promise);
    seedEscalation(githubs["owner/a"]!, 31, "2026-02-03T00:00:00Z");
    seedStuck(githubs["owner/b"]!, 30, "2026-02-02T00:00:00Z");

    const pending = ports().inbox({});
    try {
      expect(started).toEqual(["owner/a", "owner/b"]);
    } finally {
      release.resolve();
    }

    const res = await pending;
    expect(res.cards.map((c) => [c.repo, c.issue])).toEqual([
      ["owner/b", 30],
      ["owner/a", 31],
    ]);
  });

  it("one-click accept posts through RalphAnswerService: ralph-answer comment + label swap (AC2)", async () => {
    seedEscalation(githubs["owner/a"]!, 11, "2026-02-02T00:00:00Z");
    githubs["owner/a"]!.listOpenIssues = async () => {
      throw new Error("answer writes must not scan the full repo queue");
    };
    const result = await ports().answer({ repo: "owner/a", issue: 11, kind: "accept-recommendation" });

    expect(result.kind).toBe("answered");
    if (result.kind === "answered") {
      expect(answerResponseSchema.safeParse(result.response).success).toBe(true);
      expect(result.response.consequence).toBe("resume-from-wip");
      expect(result.response.resumesNextTickSeconds).toBe(30);
    }
    // The accepted recommendation is the durable answer text.
    const answer = parseRalphAnswer((githubs["owner/a"]!.comments.get(11) ?? []).at(-1)!.body)!;
    expect(answer).toEqual({ kind: "accept-recommendation", text: inboxQuestion.recommendation });
    // The label swapped back to ready-for-agent (re-arms the daemon next tick).
    const labels = githubs["owner/a"]!.issues.get(11)!.labels;
    expect(labels).toContain(LABEL_READY);
    expect(labels).not.toContain(LABEL_AWAITING_ANSWER);
    expect(githubs["owner/a"]!.labelPatches).toEqual([
      { issue: 11, remove: [LABEL_AWAITING_ANSWER], add: [LABEL_READY] },
    ]);
  });

  it("option-pick and free-text both resolve through the answer seam (AC2)", async () => {
    seedEscalation(githubs["owner/a"]!, 11, "2026-02-02T00:00:00Z");

    const optionResult = await ports().answer({ repo: "owner/a", issue: 11, kind: "option", optionIndex: 0 });
    expect(optionResult.kind).toBe("answered");
    // Re-seed a fresh open question for the free-text attempt (the prior answer swapped the label).
    seedEscalation(githubs["owner/a"]!, 12, "2026-02-05T00:00:00Z");
    const textResult = await ports().answer({ repo: "owner/a", issue: 12, kind: "free-text", text: "log a deprecation first" });
    expect(textResult.kind).toBe("answered");

    // Option 0 → "Delete it"; the free-text reply is verbatim.
    const optAnswer = parseRalphAnswer((githubs["owner/a"]!.comments.get(11) ?? []).at(-1)!.body)!;
    expect(optAnswer).toEqual({ kind: "option", text: "Delete it", optionIndex: 0 });
    const textAnswer = parseRalphAnswer((githubs["owner/a"]!.comments.get(12) ?? []).at(-1)!.body)!;
    expect(textAnswer).toEqual({ kind: "free-text", text: "log a deprecation first" });
  });

  it("answering an agent-stuck stuck-card reports the re-admit-fresh consequence (AC3)", async () => {
    seedStuck(githubs["owner/a"]!, 34, "2026-02-10T00:00:00Z");
    const result = await ports().answer({ repo: "owner/a", issue: 34, kind: "free-text", text: "regenerate the lockfile" });
    expect(result.kind).toBe("answered");
    if (result.kind === "answered") {
      expect(result.response.attentionLabel).toBe("agent-stuck");
      expect(result.response.consequence).toBe("readmit-fresh");
    }
    // The stuck label swapped to ready-for-agent (re-admit, never a stale paused run).
    const labels = githubs["owner/a"]!.issues.get(34)!.labels;
    expect(labels).toContain(LABEL_READY);
    expect(labels).not.toContain(LABEL_AGENT_STUCK);
  });

  it("404s an answer for an issue with no open question, and 400s a malformed body", async () => {
    seedEscalation(githubs["owner/a"]!, 11, "2026-02-02T00:00:00Z");

    const missing = await ports().answer({ repo: "owner/a", issue: 999, kind: "accept-recommendation" });
    expect(missing).toEqual({ kind: "no-open-question", error: expect.any(String) });

    const badOption = await ports().answer({ repo: "owner/a", issue: 11, kind: "option", optionIndex: 9 });
    expect(badOption.kind).toBe("invalid-answer");

    const emptyText = await ports().answer({ repo: "owner/a", issue: 11, kind: "free-text", text: "   " });
    expect(emptyText.kind).toBe("invalid-answer");

    // The malformed attempts did NOT mutate the issue (no answer posted, label unchanged).
    expect(githubs["owner/a"]!.issues.get(11)!.labels).toContain(LABEL_AWAITING_ANSWER);
  });

  it("rejects answer writes outside the configured target repos before resolving a GitHub client", async () => {
    const requestedRepos: string[] = [];
    const guardedPorts = createWebPorts({
      startedAt: new Date("2026-06-22T00:00:00.000Z"),
      now: () => new Date("2026-06-22T00:00:00.000Z"),
      store,
      targets: targetMetadata(["owner/a"]),
      admitBelowPercent: 85,
      githubFor: (repo: string) => {
        requestedRepos.push(repo);
        return new FakeGitHub();
      },
      reconcileIntervalSeconds: 30,
      control: fakeControl(),
    });

    const result = await guardedPorts.answer({
      repo: "owner/not-configured",
      issue: 11,
      kind: "accept-recommendation",
    });

    expect(result).toEqual({
      kind: "invalid-answer",
      error: "owner/not-configured is not a configured target repo",
    });
    expect(requestedRepos).toEqual([]);
  });

  it("after answering, the question leaves the Inbox (AC6 — the daemon resumes next tick)", async () => {
    seedEscalation(githubs["owner/a"]!, 11, "2026-02-02T00:00:00Z");
    seedEscalation(githubs["owner/a"]!, 12, "2026-02-03T00:00:00Z");

    expect((await ports().inbox({})).cards.map((c) => c.issue)).toEqual([11, 12]);
    await ports().answer({ repo: "owner/a", issue: 11, kind: "accept-recommendation" });
    // #11 answered → label gone → no longer in the queue; #12 remains.
    expect((await ports().inbox({})).cards.map((c) => c.issue)).toEqual([12]);
  });
});

describe("createWebPorts — Tier-1 power actions (issue #114)", () => {
  let store: Store;
  const githubs: Record<string, FakeGitHub> = {};
  beforeEach(() => {
    store = openStore(MEMORY_DB, { now: () => "2026-06-22T00:00:00.000Z" });
    githubs["owner/a"] = new FakeGitHub();
    githubs["owner/b"] = new FakeGitHub();
  });
  afterEach(() => store.close());

  // owner/a carries the configured priority set; owner/b has none (the default).
  const ports = () =>
    createWebPorts({
      startedAt: new Date("2026-06-22T00:00:00.000Z"),
      now: () => new Date("2026-06-22T00:00:00.000Z"),
      store,
      targets: targetMetadata(["owner/a", "owner/b"], (repo: string) =>
        repo === "owner/a" ? ["priority:p0", "priority:p1"] : [],
      ),
      admitBelowPercent: 85,
      githubFor: (repo: string) => githubs[repo] ?? new FakeGitHub(),
      reconcileIntervalSeconds: 30,
      control: fakeControl(),
    });

  it("readmit swaps the paused label for ready-for-agent (AC1)", async () => {
    githubs["owner/a"]!.seed({ number: 11, labels: [LABEL_AGENT_STUCK, "afk", LABEL_MODE_TDD] });
    const result = await ports().powerAction({ repo: "owner/a", issue: 11, kind: "readmit" });

    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      expect(result.response.action).toBe("readmit");
      expect(result.response.appliesNextTickSeconds).toBe(30); // "acts next tick (~30s)" — AC3
      expect(result.response.repo).toBe("owner/a");
      expect(result.response.issue).toBe(11);
    }
    const labels = githubs["owner/a"]!.issues.get(11)!.labels;
    expect(labels).toContain(LABEL_READY);
    expect(labels).not.toContain(LABEL_AGENT_STUCK);
    expect(githubs["owner/a"]!.labelPatches).toEqual([
      { issue: 11, remove: [LABEL_AGENT_STUCK], add: [LABEL_READY] },
    ]);
  });

  it("does not apply additions or report success when a label-swap removal fails", async () => {
    githubs["owner/a"]!.seed({ number: 21, labels: [LABEL_AGENT_STUCK, LABEL_AFK, LABEL_MODE_TDD] });
    githubs["owner/a"]!.applyLabelPatch = async () => {
      throw new Error("remove-label failed");
    };

    await expect(ports().powerAction({ repo: "owner/a", issue: 21, kind: "readmit" })).rejects.toThrow(
      "remove-label failed",
    );

    const labels = githubs["owner/a"]!.issues.get(21)!.labels;
    expect(labels).toContain(LABEL_AGENT_STUCK);
    expect(labels).not.toContain(LABEL_READY);
    expect(githubs["owner/a"]!.addedLabels).toEqual([]);
  });

  it("readmit of an answerable pause posts a ralph-answer before re-arming", async () => {
    seedEscalation(githubs["owner/a"]!, 18, "2026-02-02T00:00:00Z");
    const result = await ports().powerAction({ repo: "owner/a", issue: 18, kind: "readmit" });

    expect(result.kind).toBe("applied");
    const answer = parseRalphAnswer((githubs["owner/a"]!.comments.get(18) ?? []).at(-1)!.body);
    expect(answer).toEqual({
      kind: "free-text",
      text: "Re-admitted from the web control plane without additional guidance.",
    });
    const labels = githubs["owner/a"]!.issues.get(18)!.labels;
    expect(labels).toContain(LABEL_READY);
    expect(labels).not.toContain(LABEL_AWAITING_ANSWER);
  });

  it("readmit of review-maxed also uses the answer path so review resumes", async () => {
    seedHealCard(githubs["owner/a"]!, 19, "2026-02-03T00:00:00Z", 1);
    const result = await ports().powerAction({ repo: "owner/a", issue: 19, kind: "readmit" });

    expect(result.kind).toBe("applied");
    expect(parseRalphAnswer((githubs["owner/a"]!.comments.get(19) ?? []).at(-1)!.body)).toMatchObject({
      kind: "free-text",
      text: "Re-admitted from the web control plane without additional guidance.",
    });
    const labels = githubs["owner/a"]!.issues.get(19)!.labels;
    expect(labels).toContain(LABEL_READY);
    expect(labels).not.toContain(LABEL_REVIEW_MAXED);
  });

  it("does not bare-label-rearm an answerable pause with no question or answer", async () => {
    githubs["owner/a"]!.seed({ number: 20, labels: [LABEL_AWAITING_ANSWER, LABEL_AFK, LABEL_MODE_TDD] });
    const result = await ports().powerAction({ repo: "owner/a", issue: 20, kind: "readmit" });

    expect(result.kind).toBe("bad-request");
    const labels = githubs["owner/a"]!.issues.get(20)!.labels;
    expect(labels).toContain(LABEL_AWAITING_ANSWER);
    expect(labels).not.toContain(LABEL_READY);
  });

  it("close closes the issue via the gh client port (confirm was enforced at the contract edge) (AC1/AC2)", async () => {
    githubs["owner/a"]!.seed({ number: 12, labels: [LABEL_READY, "afk", LABEL_MODE_TDD] });
    const result = await ports().powerAction({ repo: "owner/a", issue: 12, kind: "close", confirm: true });

    expect(result.kind).toBe("applied");
    expect(githubs["owner/a"]!.closedIssues).toContain(12);
    expect(githubs["owner/a"]!.issues.get(12)!.state).toBe("CLOSED");
    // A close fires no label mutation — only the state change.
    expect(githubs["owner/a"]!.addedLabels.filter((a) => a.issue === 12)).toEqual([]);
  });

  it("set-mode swaps the current mode for the chosen one (AC1)", async () => {
    githubs["owner/a"]!.seed({ number: 13, labels: [LABEL_READY, "afk", LABEL_MODE_TDD] });
    const result = await ports().powerAction({ repo: "owner/a", issue: 13, kind: "set-mode", mode: "infra" });

    expect(result.kind).toBe("applied");
    const labels = githubs["owner/a"]!.issues.get(13)!.labels;
    expect(labels).toContain("mode:infra");
    expect(labels).not.toContain("mode:tdd");
  });

  it("set-priority swaps the configured priority and rejects an unconfigured one (AC1)", async () => {
    githubs["owner/a"]!.seed({ number: 14, labels: [LABEL_READY, "afk", LABEL_MODE_TDD, "priority:p1"] });

    const applied = await ports().powerAction({ repo: "owner/a", issue: 14, kind: "set-priority", priority: "priority:p0" });
    expect(applied.kind).toBe("applied");
    const labels = githubs["owner/a"]!.issues.get(14)!.labels;
    expect(labels).toContain("priority:p0");
    expect(labels).not.toContain("priority:p1");

    // An unconfigured priority is rejected — no label injection, no mutation.
    const rejected = await ports().powerAction({ repo: "owner/a", issue: 14, kind: "set-priority", priority: "priority:evil" });
    expect(rejected).toEqual({ kind: "bad-request", error: expect.any(String) });
    expect(githubs["owner/a"]!.issues.get(14)!.labels).toContain("priority:p0"); // unchanged
  });

  it("set-priority is rejected for a repo with no priorities configured (no menu to offer)", async () => {
    githubs["owner/b"]!.seed({ number: 15, labels: [LABEL_READY, "afk", LABEL_MODE_TDD] });
    const rejected = await ports().powerAction({ repo: "owner/b", issue: 15, kind: "set-priority", priority: "priority:p0" });
    expect(rejected.kind).toBe("bad-request");
  });

  it("pause / unpause apply the afk ↔ hitl swap (AC1)", async () => {
    githubs["owner/a"]!.seed({ number: 16, labels: [LABEL_READY, LABEL_AFK, LABEL_MODE_TDD] });

    const paused = await ports().powerAction({ repo: "owner/a", issue: 16, kind: "pause" });
    expect(paused.kind).toBe("applied");
    let labels = githubs["owner/a"]!.issues.get(16)!.labels;
    expect(labels).toContain(LABEL_HITL);
    expect(labels).not.toContain(LABEL_AFK);

    const unpaused = await ports().powerAction({ repo: "owner/a", issue: 16, kind: "unpause" });
    expect(unpaused.kind).toBe("applied");
    labels = githubs["owner/a"]!.issues.get(16)!.labels;
    expect(labels).toContain(LABEL_AFK);
    expect(labels).not.toContain(LABEL_HITL);
  });

  it("rejects a power action outside the configured target repos before resolving a GitHub client", async () => {
    const requestedRepos: string[] = [];
    const guardedPorts = createWebPorts({
      startedAt: new Date("2026-06-22T00:00:00.000Z"),
      now: () => new Date("2026-06-22T00:00:00.000Z"),
      store,
      targets: targetMetadata(["owner/a"]),
      admitBelowPercent: 85,
      githubFor: (repo: string) => {
        requestedRepos.push(repo);
        return new FakeGitHub();
      },
      reconcileIntervalSeconds: 30,
      control: fakeControl(),
    });

    const result = await guardedPorts.powerAction({ repo: "owner/not-configured", issue: 11, kind: "pause" });
    expect(result).toEqual({ kind: "bad-request", error: "owner/not-configured is not a configured target repo" });
    expect(requestedRepos).toEqual([]);
  });

  it("404s a power action for an issue that does not exist (no write attempted)", async () => {
    const result = await ports().powerAction({ repo: "owner/a", issue: 999, kind: "readmit" });
    expect(result).toEqual({ kind: "not-found", error: expect.any(String) });
    expect(githubs["owner/a"]!.addedLabels).toEqual([]);
  });

  it("after re-admit, the issue leaves the Paused section next tick (AC4 — the daemon re-arms)", async () => {
    // A daemon snapshot parks the issue under agent-stuck; re-admit clears the label so the
    // next backlog read reflects the new state.
    githubs["owner/a"]!.seed({ number: 17, labels: [LABEL_AGENT_STUCK, "afk", LABEL_MODE_TDD] });
    store.forRepo("owner/a").saveBacklogSnapshot({
      generatedAt: "2026-06-22T00:00:00.000Z",
      targetRepo: "owner/a",
      cap: 5,
      reconcileIntervalSeconds: 30,
      daemonStartedAt: "2026-06-22T00:00:00.000Z",
      lastError: null,
      eligible: [],
      blocked: [],
      paused: [{ issueNumber: 17, title: "was stuck", state: "agent-stuck" }],
      manualHolds: [],
      modingCandidates: [],
    });

    await ports().powerAction({ repo: "owner/a", issue: 17, kind: "readmit" });
    // The GitHub label is now ready (the daemon's next snapshot rebuild will move it out of paused).
    expect(githubs["owner/a"]!.issues.get(17)!.labels).toContain(LABEL_READY);
    expect(githubs["owner/a"]!.issues.get(17)!.labels).not.toContain(LABEL_AGENT_STUCK);
  });
});

describe("createWebPorts — daemon control threading (issue #118)", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(MEMORY_DB, { now: () => "2026-06-23T00:00:00.000Z" });
  });
  afterEach(() => store.close());

  it("threads the provided DaemonControl straight through to the ports (no control logic added)", () => {
    const control: DaemonControl = {
      drain: () => {},
      forceTick: () => {},
      killRun: () => false,
    };
    const ports = createWebPorts({
      startedAt: new Date("2026-06-23T00:00:00.000Z"),
      now: () => new Date("2026-06-23T00:00:00.000Z"),
      store,
      targets: targetMetadata(["owner/a"]),
      admitBelowPercent: 85,
      githubFor: () => new FakeGitHub(),
      reconcileIntervalSeconds: 30,
      control,
    });
    // The web layer holds the orchestrator-implemented port verbatim — it never wraps or
    // reaches reconciler internals. The /api/daemon/* routes call this exact object.
    expect(ports.control).toBe(control);
  });
});

describe("startWebControlPlane", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(MEMORY_DB, { now: () => "2026-06-21T00:00:00.000Z" });
  });
  afterEach(() => store.close());

  it("returns null when the web layer is disabled (daemon runs headless)", async () => {
    const cfg = config({ enabled: false });
    const handle = await startWebControlPlane({
      config: cfg,
      targets: resolveTargets(cfg),
      logger: silentLogger,
      store,
      control: fakeControl(),
    });
    expect(handle).toBeNull();
  });

  it("binds an ephemeral port and stops cleanly", async () => {
    const cfg = config({ port: 0 });
    const handle = await startWebControlPlane({
      config: cfg,
      targets: resolveTargets(cfg),
      logger: silentLogger,
      store,
      control: fakeControl(),
    });
    expect(handle).not.toBeNull();
    expect(handle?.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    await handle?.stop();
  });

  // Issue #240: the control-plane port is a single-daemon resource, so a bind
  // collision (EADDRINUSE) means a second daemon is already listening — the exact
  // two-daemon race the singleton guard prevents. It must be FATAL (rethrown), not a
  // swallowed warning that lets the daemon run on headless and race.
  it("throws on EADDRINUSE rather than running headless", async () => {
    const net = await import("node:net");
    const blocker = net.createServer();
    await new Promise<void>((res) => blocker.listen(0, "127.0.0.1", res));
    const port = (blocker.address() as import("node:net").AddressInfo).port;
    try {
      const cfg = config({ port });
      await expect(
        startWebControlPlane({
          config: cfg,
          targets: resolveTargets(cfg),
          logger: silentLogger,
          store,
          control: fakeControl(),
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await new Promise<void>((res) => blocker.close(() => res()));
    }
  });
});

describe("createWebPorts — runtime routing (ADR-0037 P4.1, issue #166)", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(MEMORY_DB, { now: () => "2026-06-29T00:00:00.000Z" });
  });
  afterEach(() => store.close());

  function portsWithRouting(): ReturnType<typeof createWebPorts> {
    const cfg = parseConfig({ targets: [{ repo: "owner/repo", commands: { build: "true", test: "true" } }] });
    const routingStore = new RoutingStore({ config: cfg, targets: resolveTargets(cfg) }); // overlay-only
    return createWebPorts({
      startedAt: new Date("2026-06-29T00:00:00.000Z"),
      now: () => new Date("2026-06-29T00:00:00.000Z"),
      store,
      targets: targetMetadata(["owner/repo"]),
      admitBelowPercent: 85,
      githubFor: () => new FakeGitHub(),
      reconcileIntervalSeconds: 30,
      control: fakeControl(),
      routing: routingStore,
    });
  }

  it("reads a contract-valid effective routing and reflects a write on the next read (overlay)", () => {
    const ports = portsWithRouting();
    const before = ports.routing({});
    expect(effectiveRoutingResponseSchema.safeParse(before).success).toBe(true);
    expect(before.types.find((t) => t.type === "review")?.preference).toEqual([{ provider: "claude" }]);

    const applied = ports.applyRouting({ target: "type", type: "review", routing: { provider: "claude", model: "sonnet" } });
    expect(applied.kind).toBe("applied");

    // The next read of the same overlay reflects the edit — no daemon restart.
    const after = ports.routing({});
    expect(after.types.find((t) => t.type === "review")?.preference).toEqual([{ provider: "claude", model: "sonnet" }]);
  });

  it("rejects a capability-invalid edit (impl → openai) as bad-request (AC3)", () => {
    const ports = portsWithRouting();
    const result = ports.applyRouting({ target: "type", type: "impl", routing: { provider: "openai" } });
    expect(result.kind).toBe("bad-request");
    expect(result.kind === "bad-request" && result.error).toMatch(/not tools-capable/i);
  });
});
