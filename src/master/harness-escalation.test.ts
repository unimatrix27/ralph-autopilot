/**
 * The triage cutover's table-driven contract (ADR-0042): **every** issue-scoped failure
 * source appends exactly one master request, preserves its typed reason/evidence, projects
 * `master-triage`, and posts no human question.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { MEMORY_DB, openStore, type ScopedStore } from "../store/store";
import { FakeGitHub } from "../testing/fake-github";
import { createLogger } from "../log/logger";
import { LABEL_COMPLEXITY_1, LABEL_COMPLEXITY_2 } from "../core/labels";
import { RALPH_QUESTION_FENCE } from "../review/escalation";
import { MASTER_REQUEST_SOURCES, type MasterLane, type MasterRequestSource } from "../store/types";
import { HarnessMasterEscalation, harnessEvidence, type PreservedSourceFact } from "./harness-escalation";
import { foldMasterHistory } from "./history";
import { parseMasterRequestComment, RALPH_MASTER_REQUEST_FENCE } from "./request";

const REPO = "acme/widgets";
const logger = createLogger({ level: "error" });

interface SourceCase {
  source: MasterRequestSource;
  lane: MasterLane;
  phase: string;
  headline: string;
  detail: string;
  sourceFacts?: readonly PreservedSourceFact[];
}

/** One row per issue-scoped source the cutover must route through the master queue. */
const SOURCES: SourceCase[] = [
  {
    source: "review-maxed",
    lane: "review",
    phase: "review-1",
    headline: "Phase-1 correctness review still reports blockers after 3 fix attempts",
    detail: "P0 the invoice total double-counts tax",
    sourceFacts: [{ kind: "review-maxed", phase: 1 }],
  },
  {
    source: "review-maxed",
    lane: "review",
    phase: "review-2",
    headline: "Phase-2 quality review still reports blockers after 3 fix attempts",
    detail: "P1 the renderer duplicates the formatting helper",
    sourceFacts: [{ kind: "review-maxed", phase: 2 }],
  },
  {
    source: "ci",
    lane: "ci",
    phase: "review-0",
    headline: "CI gate never greened",
    detail: "build (ubuntu-latest) failed",
    sourceFacts: [{ kind: "review-maxed", phase: 0 }],
  },
  {
    source: "rebase",
    lane: "review",
    phase: "review-0",
    headline: "Rebase onto base exhausted its rounds",
    detail: "conflict in src/store/store.ts after 3 rounds",
  },
  {
    source: "merge",
    lane: "merge",
    phase: "merge",
    headline: "Merge preparation never became mergeable",
    detail: "mergeStateStatus BLOCKED past the CI budget",
  },
  {
    source: "hosted-review",
    lane: "merge",
    phase: "merge",
    headline: "GitHub-hosted Codex review has unresolved conversations",
    detail: "thread PRRT_a: the retry loop can spin forever",
  },
  {
    source: "run-wedged",
    lane: "impl",
    phase: "impl",
    headline: "The issue-run session wedged past its lifetime ceiling",
    detail: "no advance for 90 minutes; container reaped",
    sourceFacts: [{ kind: "run-stuck", reason: "wedged past lifetime" }],
  },
  {
    source: "session-failed",
    lane: "impl",
    phase: "impl",
    headline: "The implementation session threw past its deterministic retries",
    detail: "Error: agent produced no result frame",
    sourceFacts: [{ kind: "run-stuck", reason: "session failed" }],
  },
  {
    source: "anomaly",
    lane: "reconcile",
    phase: "reconcile",
    headline: "Reconciler classified this run as an island",
    detail: "running-row-not-in-flight",
    sourceFacts: [{ kind: "anomaly", reason: "running-row-not-in-flight" }],
  },
];

describe("HarnessMasterEscalation — the triage cutover (ADR-0042)", () => {
  let github: FakeGitHub;
  let store: ScopedStore;
  let escalation: HarnessMasterEscalation;

  beforeEach(() => {
    github = new FakeGitHub(REPO);
    store = openStore(MEMORY_DB).forRepo(REPO);
    escalation = new HarnessMasterEscalation({ store, github, logger });
  });

  async function seed(labels: string[] = [LABEL_COMPLEXITY_2, "afk", "mode:tdd"]): Promise<number> {
    github.seed({ number: 9, title: "Widget pipeline", labels });
    store.upsertRun({
      issueNumber: 9,
      mode: "tdd",
      branch: "ralph/9-widget",
      worktreePath: "/w/9",
      prNumber: 90,
      issueTitle: "Widget pipeline",
    });
    return 9;
  }

  it("routes every issue-scoped source into the master queue with exactly one request", async () => {
    for (const c of SOURCES) {
      github = new FakeGitHub(REPO);
      store = openStore(MEMORY_DB).forRepo(REPO);
      escalation = new HarnessMasterEscalation({ store, github, logger });
      await seed();
      const run = store.getRunByIssue(9)!;

      const result = await escalation.escalate({
        issueNumber: 9,
        runId: run.id,
        source: c.source,
        lane: c.lane,
        phase: c.phase,
        branch: "ralph/9-widget",
        prNumber: 90,
        evidence: harnessEvidence({ headline: c.headline, detail: c.detail }),
        ...(c.sourceFacts ? { sourceFacts: c.sourceFacts } : {}),
      });

      expect(result.kind, `${c.source}/${c.phase}`).toBe("queued");
      // Exactly one queued request, projecting `master-triage` — never the source's own state.
      expect(store.getRunByIssue(9)!.status, `${c.source} status`).toBe("master-triage");
      const history = foldMasterHistory(store.readIssueStream(9));
      expect(history.pending, `${c.source} pending`).not.toBeNull();
      expect(history.pending!.source).toBe(c.source);
      expect(history.pending!.phase).toBe(c.phase);
      expect(history.pending!.lane).toBe(c.lane);

      // The typed reason/evidence is durable on GitHub for a cold-store rebuild.
      const comments = github.comments.get(9) ?? [];
      const requests = comments.filter((c2) => c2.body.includes(RALPH_MASTER_REQUEST_FENCE));
      expect(requests, `${c.source} request comments`).toHaveLength(1);
      const payload = parseMasterRequestComment(requests[0]!.body)!;
      expect(payload.source).toBe(c.source);
      expect(payload.evidence.headline).toBe(c.headline);
      expect(payload.evidence.detail).toBe(c.detail);

      // …and NO human question was posted.
      expect(comments.some((c2) => c2.body.includes(RALPH_QUESTION_FENCE)), `${c.source} question`).toBe(false);
    }
  });

  it("preserves the pre-cutover source fact as history in the same durable transition", async () => {
    await seed();
    const run = store.getRunByIssue(9)!;
    await escalation.escalate({
      issueNumber: 9,
      runId: run.id,
      source: "review-maxed",
      lane: "review",
      phase: "review-1",
      evidence: harnessEvidence({ headline: "maxed", detail: "P0 blocker" }),
      sourceFacts: [{ kind: "review-maxed", phase: 1 }],
    });

    const stream = store.readIssueStream(9).map((e) => e.type);
    // The fact survives as history …
    expect(stream).toContain("ReviewMaxed");
    // … and the request follows it, so the latest projection is `master-triage`.
    expect(stream.indexOf("ReviewMaxed")).toBeLessThan(stream.indexOf("MasterTriageRequested"));
    expect(store.getRunByIssue(9)!.status).toBe("master-triage");
  });

  it("appends both facts atomically — no reader can observe the intermediate state", async () => {
    await seed();
    const run = store.getRunByIssue(9)!;
    await escalation.escalate({
      issueNumber: 9,
      runId: run.id,
      source: "session-failed",
      lane: "impl",
      phase: "impl",
      evidence: harnessEvidence({ headline: "threw", detail: "boom" }),
      sourceFacts: [{ kind: "run-stuck", reason: "session failed" }],
    });
    const events = store.readIssueStream(9);
    const stuck = events.find((e) => e.type === "RunStuck")!;
    const request = events.find((e) => e.type === "MasterTriageRequested")!;
    // Same commit ⇒ same global position batch: a live consumer pages one transition.
    expect(request.streamPosition).toBe(stuck.streamPosition + 1);
    expect(request.globalPosition).toBe(stuck.globalPosition + 1);
    expect(store.getRunByIssue(9)!.status).toBe("master-triage");
  });

  it("promotes the issue to complexity:1 permanently and idempotently", async () => {
    await seed();
    const run = store.getRunByIssue(9)!;
    const first = await escalation.escalate({
      issueNumber: 9,
      runId: run.id,
      source: "ci",
      lane: "ci",
      phase: "review-0",
      evidence: harnessEvidence({ headline: "ci red", detail: "build failed" }),
    });
    expect(first.kind === "queued" && first.promotedFrom).toBe(2);
    expect(github.issues.get(9)!.labels).toContain(LABEL_COMPLEXITY_1);
    expect(github.issues.get(9)!.labels).not.toContain(LABEL_COMPLEXITY_2);
    const patches = github.labelPatches.length;

    // A second, materially different escalation writes no second promotion.
    await escalation.escalate({
      issueNumber: 9,
      runId: run.id,
      source: "merge",
      lane: "merge",
      phase: "merge",
      evidence: harnessEvidence({ headline: "blocked", detail: "BLOCKED forever" }),
    });
    expect(github.labelPatches).toHaveLength(patches);
    expect(store.readIssueStream(9).filter((e) => e.type === "ComplexityPromoted")).toHaveLength(1);
  });

  it("is idempotent per (phase, signature) — a re-detected failure appends nothing", async () => {
    await seed();
    const run = store.getRunByIssue(9)!;
    const input = {
      issueNumber: 9,
      runId: run.id,
      source: "anomaly" as const,
      lane: "reconcile" as const,
      phase: "reconcile",
      evidence: harnessEvidence({ headline: "island", detail: "running-row-not-in-flight" }),
      sourceFacts: [{ kind: "anomaly" as const, reason: "running-row-not-in-flight" }],
    };
    await escalation.escalate(input);
    const second = await escalation.escalate(input);
    expect(second.kind).toBe("already-queued");
    expect(store.readIssueStream(9).filter((e) => e.type === "MasterTriageRequested")).toHaveLength(1);
    expect((github.comments.get(9) ?? []).filter((c) => c.body.includes(RALPH_MASTER_REQUEST_FENCE))).toHaveLength(1);
  });

  it("treats a head-SHA-only change as the SAME failure (no second request)", async () => {
    await seed();
    const run = store.getRunByIssue(9)!;
    await escalation.escalate({
      issueNumber: 9,
      runId: run.id,
      source: "ci",
      lane: "ci",
      phase: "review-0",
      evidence: harnessEvidence({ headline: "ci red", detail: "build failed at 0a1b2c3d4e5f6a7b" }),
    });
    const second = await escalation.escalate({
      issueNumber: 9,
      runId: run.id,
      source: "ci",
      lane: "ci",
      phase: "review-0",
      evidence: harnessEvidence({ headline: "ci red", detail: "build failed at 9f8e7d6c5b4a3928" }),
    });
    expect(second.kind).toBe("already-queued");
  });

  it("still escalates a materially different failure in the same phase", async () => {
    await seed();
    const run = store.getRunByIssue(9)!;
    await escalation.escalate({
      issueNumber: 9,
      runId: run.id,
      source: "ci",
      lane: "ci",
      phase: "review-0",
      evidence: harnessEvidence({ headline: "ci red", detail: "build failed" }),
    });
    const second = await escalation.escalate({
      issueNumber: 9,
      runId: run.id,
      source: "ci",
      lane: "ci",
      phase: "review-0",
      evidence: harnessEvidence({ headline: "ci red", detail: "lint failed" }),
    });
    expect(second.kind).toBe("queued");
  });

  it("keeps the escalation when the evidence comment cannot be posted", async () => {
    await seed();
    const run = store.getRunByIssue(9)!;
    github.failNextComment("network is down");
    const result = await escalation.escalate({
      issueNumber: 9,
      runId: run.id,
      source: "merge",
      lane: "merge",
      phase: "merge",
      evidence: harnessEvidence({ headline: "blocked", detail: "BLOCKED" }),
    });
    expect(result.kind).toBe("queued");
    expect(result.kind === "queued" && result.commentId).toBeNull();
    // The fact — which is what the queue reads — landed regardless.
    expect(store.getRunByIssue(9)!.status).toBe("master-triage");
  });

  it("covers every declared MasterRequestSource in the routing table", () => {
    const routed = new Set(SOURCES.map((c) => c.source));
    // The two worker-origin sources are ADR-0041's and keep their own requester.
    for (const source of MASTER_REQUEST_SOURCES) {
      if (source === "escalate" || source === "stuck") {
        continue;
      }
      expect(routed.has(source), `source ${source} has no cutover route`).toBe(true);
    }
  });
});
