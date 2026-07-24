import { describe, expect, it } from "vitest";
import type { Issue } from "../github/types";
import { admit, type World } from "../core/admission";
import { projectBacklog } from "../daemon/backlog";
import type { RuntimeBacklog, RuntimeSnapshot } from "../projection/snapshot";
import { backlogResponseSchema } from "./contract";
import { snapshotToBacklog } from "./backlog";

const NOW = new Date("2026-06-21T12:00:00.000Z");
const QUEUED_NO_PRIORITIES = { actions: ["pause", "set-mode", "close"], priorityLabels: [] };
const ATTENTION_NO_PRIORITIES = { actions: ["readmit", "close"], priorityLabels: [] };
const MANUAL_HOLD_NO_PRIORITIES = { actions: ["unpause", "set-mode", "close"], priorityLabels: [] };
const MODING_NO_PRIORITIES = { actions: ["set-mode", "close"], priorityLabels: [] };

/** An empty runtime snapshot; tests fill in only the backlog sections they exercise. */
function emptySnapshot(): RuntimeSnapshot {
  return {
    runningAgents: [],
    backlog: { eligible: [], blocked: [], paused: [], manualHolds: [], modingCandidates: [], noProvider: [] },
    awaitingAnswer: [],
    reviewMaxed: [],
    agentStuck: [],
    awaitingCi: [],
    awaitingMerge: [],
    recentOutcomes: [],
    daemon: null,
  };
}

/** A snapshot whose backlog is `backlog`, with any omitted section defaulted empty. */
function withBacklog(backlog: Partial<RuntimeBacklog>): RuntimeSnapshot {
  return { ...emptySnapshot(), backlog: { ...emptySnapshot().backlog, ...backlog } };
}

describe("snapshotToBacklog", () => {
  it("produces a contract-valid payload (parse → serialize round-trips)", () => {
    const out = snapshotToBacklog(emptySnapshot(), { now: () => NOW, repos: ["owner/a"] });
    expect(backlogResponseSchema.safeParse(out).success).toBe(true);
    expect(backlogResponseSchema.parse(JSON.parse(JSON.stringify(out)))).toEqual(out);
    expect(out.generatedAt).toBe(NOW.toISOString());
    expect(out.repo).toBeNull(); // aggregate by default
    expect(out.repos).toEqual(["owner/a"]);
  });

  it("lists eligible issues in the snapshot's pick-order, verbatim (never re-sorted)", () => {
    // A non-issue-number order: #30 picked before #12 (its priority/age won the
    // admission tie-break). The transform must preserve this exact order.
    const snap = withBacklog({
      eligible: [
        { repo: "owner/a", issueNumber: 30, title: "high priority", priority: "priority:p0", priorityColor: "red" },
        { repo: "owner/a", issueNumber: 12, title: "older, lower", priority: null, priorityColor: null },
      ],
      blocked: [],
      paused: [],
      manualHolds: [],
      modingCandidates: [],
    });
    const { eligible } = snapshotToBacklog(snap, { now: () => NOW });
    expect(eligible.map((e) => e.issue)).toEqual([30, 12]);
    expect(eligible[0]).toEqual({
      repo: "owner/a",
      issue: 30,
      title: "high priority",
      priority: "priority:p0",
      priorityColor: "red",
      powerActionSurface: "queued",
    });
    expect(eligible[1]!.priority).toBeNull();
    expect(eligible[1]!.priorityColor).toBeNull();
  });

  it("renders each blocked issue's dependency mini-graph with per-ref satisfaction", () => {
    const snap = withBacklog({
      eligible: [],
      blocked: [
        {
          repo: "owner/a",
          issueNumber: 20,
          title: "waiting on deps",
          blockers: [
            { ref: 7, satisfied: true },
            { ref: 8, satisfied: false },
          ],
        },
      ],
      paused: [],
      manualHolds: [],
      modingCandidates: [],
    });
    const { blocked } = snapshotToBacklog(snap, { now: () => NOW });
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toEqual({
      repo: "owner/a",
      issue: 20,
      title: "waiting on deps",
      blockers: [
        { ref: 7, satisfied: true },
        { ref: 8, satisfied: false },
      ],
      powerActionSurface: "queued",
    });
  });

  it("carries paused issues with their attention state, and moding candidates separately", () => {
    const snap = withBacklog({
      eligible: [],
      blocked: [],
      paused: [
        { repo: "owner/a", issueNumber: 30, title: "stuck", state: "agent-stuck" },
        { repo: "owner/b", issueNumber: 31, title: "island", state: "daemon-anomaly" },
      ],
      manualHolds: [],
      modingCandidates: [{ repo: "owner/a", issueNumber: 40, title: "no mode yet" }],
    });
    const out = snapshotToBacklog(snap, { now: () => NOW });
    expect(out.paused.map((p) => [p.issue, p.state])).toEqual([
      [30, "agent-stuck"],
      [31, "daemon-anomaly"],
    ]);
    // Moding candidates are their own section — never folded into paused.
    expect(out.modingCandidates).toEqual([
      { repo: "owner/a", issue: 40, title: "no mode yet", powerActionSurface: "moding" },
    ]);
    // The static descriptor is emitted once, in the catalog — not on the row.
    expect(out.powerActions["owner/a"]?.moding).toEqual(MODING_NO_PRIORITIES);
  });

  it("carries manual holds as their own unpauseable section", () => {
    const snap = withBacklog({
      eligible: [],
      blocked: [],
      paused: [],
      manualHolds: [{ repo: "owner/a", issueNumber: 41, title: "held by operator" }],
      modingCandidates: [],
    });
    const out = snapshotToBacklog(snap, { now: () => NOW });
    expect(out.manualHolds).toEqual([
      { repo: "owner/a", issue: 41, title: "held by operator", powerActionSurface: "manual-hold" },
    ]);
    expect(out.powerActions["owner/a"]?.["manual-hold"]).toEqual(MANUAL_HOLD_NO_PRIORITIES);
  });

  it("derives the power-action catalog per (repo, surface) and tags each row with its surface", () => {
    const snap = withBacklog({
      eligible: [{ repo: "owner/a", issueNumber: 1, title: "a", priority: null, priorityColor: null }],
      blocked: [{ repo: "owner/b", issueNumber: 2, title: "b", blockers: [{ ref: 9, satisfied: false }] }],
      paused: [{ repo: "owner/a", issueNumber: 3, title: "c", state: "review-maxed" }],
      manualHolds: [{ repo: "owner/a", issueNumber: 4, title: "held" }],
      modingCandidates: [{ repo: "owner/a", issueNumber: 5, title: "no mode" }],
    });
    const out = snapshotToBacklog(snap, {
      now: () => NOW,
      priorityLabelsFor: (repo) => (repo === "owner/a" ? ["priority:p0", "priority:p1"] : []),
    });

    // Rows carry only their surface tag — never the full descriptor.
    expect(out.eligible[0]!.powerActionSurface).toBe("queued");
    expect(out.blocked[0]!.powerActionSurface).toBe("queued");
    expect(out.paused[0]!.powerActionSurface).toBe("attention");
    expect(out.manualHolds[0]!.powerActionSurface).toBe("manual-hold");
    expect(out.modingCandidates[0]!.powerActionSurface).toBe("moding");

    // The catalog holds each distinct (repo, surface) affordance exactly once. owner/a carries
    // the configured priority set; owner/b (the blocked row) has none.
    expect(out.powerActions["owner/a"]?.queued).toEqual({
      actions: ["pause", "set-mode", "set-priority", "close"],
      priorityLabels: ["priority:p0", "priority:p1"],
    });
    expect(out.powerActions["owner/b"]?.queued).toEqual(QUEUED_NO_PRIORITIES);
    expect(out.powerActions["owner/a"]?.attention).toEqual({
      ...ATTENTION_NO_PRIORITIES,
      priorityLabels: ["priority:p0", "priority:p1"],
    });
    expect(out.powerActions["owner/a"]?.["manual-hold"]?.actions).toEqual([
      "unpause",
      "set-mode",
      "set-priority",
      "close",
    ]);
    expect(out.powerActions["owner/a"]?.moding).toEqual({
      actions: ["set-mode", "close"],
      priorityLabels: ["priority:p0", "priority:p1"],
    });
  });

  it("aggregates across repos and exposes the full repo set for the filter", () => {
    const snap = withBacklog({
      eligible: [{ repo: "owner/a", issueNumber: 1, title: "a", priority: null, priorityColor: null }],
      blocked: [{ repo: "owner/b", issueNumber: 2, title: "b", blockers: [{ ref: 9, satisfied: false }] }],
      paused: [{ repo: "owner/c", issueNumber: 3, title: "c", state: "review-maxed" }],
      manualHolds: [],
      modingCandidates: [{ repo: "owner/d", issueNumber: 4, title: "d" }],
    });
    // `repos` unions the configured set with every repo seen in any section, sorted.
    const out = snapshotToBacklog(snap, { now: () => NOW, repos: ["owner/a", "owner/e"] });
    expect(out.repos).toEqual(["owner/a", "owner/b", "owner/c", "owner/d", "owner/e"]);
    expect(out.repo).toBeNull();
    expect(out.eligible).toHaveLength(1);
    expect(out.blocked).toHaveLength(1);
    expect(out.paused).toHaveLength(1);
    expect(out.modingCandidates).toHaveLength(1);
  });

  it("narrows every section to the repo filter while keeping the full repo list", () => {
    const snap = withBacklog({
      eligible: [
        { repo: "owner/a", issueNumber: 1, title: "a1", priority: null, priorityColor: null },
        { repo: "owner/b", issueNumber: 2, title: "b2", priority: null, priorityColor: null },
      ],
      blocked: [{ repo: "owner/b", issueNumber: 5, title: "b5", blockers: [{ ref: 9, satisfied: false }] }],
      paused: [{ repo: "owner/a", issueNumber: 7, title: "a7", state: "agent-stuck" }],
      manualHolds: [{ repo: "owner/b", issueNumber: 9, title: "held" }],
      modingCandidates: [{ repo: "owner/b", issueNumber: 8, title: "b8" }],
    });
    const out = snapshotToBacklog(snap, { now: () => NOW, repo: "owner/a" });
    expect(out.repo).toBe("owner/a");
    // The filter dropdown still sees every repo.
    expect(out.repos).toEqual(["owner/a", "owner/b"]);
    // Every section is narrowed to owner/a only.
    expect(out.eligible.map((e) => e.issue)).toEqual([1]);
    expect(out.blocked).toHaveLength(0);
    expect(out.paused.map((p) => p.issue)).toEqual([7]);
    expect(out.manualHolds).toHaveLength(0);
    expect(out.modingCandidates).toHaveLength(0);
  });

  it("renders the no-provider wait distinctly, with the reset ETA, reusing the queued surface (ADR-0037 P3.2, #165)", () => {
    const snap = withBacklog({
      noProvider: [
        { repo: "owner/a", issueNumber: 7, title: "parked on a provider", resetsAt: "2026-06-29T14:30:00.000Z" },
        { repo: "owner/a", issueNumber: 8, title: "also parked", resetsAt: "2026-06-29T14:30:00.000Z" },
      ],
    });
    const out = snapshotToBacklog(snap, { now: () => NOW });
    // The waiting issues are their own section — not folded into eligible "queued for a slot".
    expect(out.eligible).toEqual([]);
    expect(out.noProvider).toEqual([
      { repo: "owner/a", issue: 7, title: "parked on a provider", resetsAt: "2026-06-29T14:30:00.000Z", powerActionSurface: "queued" },
      { repo: "owner/a", issue: 8, title: "also parked", resetsAt: "2026-06-29T14:30:00.000Z", powerActionSurface: "queued" },
    ]);
    expect(backlogResponseSchema.safeParse(out).success).toBe(true);
  });

  it("carries a null reset ETA through the no-provider wait (degrades gracefully)", () => {
    const snap = withBacklog({
      noProvider: [{ repo: "owner/a", issueNumber: 9, title: "no eta known", resetsAt: null }],
    });
    const out = snapshotToBacklog(snap, { now: () => NOW });
    expect(out.noProvider[0]?.resetsAt).toBeNull();
    expect(backlogResponseSchema.safeParse(out).success).toBe(true);
  });

  it("narrows the no-provider wait to the repo filter and includes its repos in the filter set", () => {
    const snap = withBacklog({
      noProvider: [
        { repo: "owner/a", issueNumber: 1, title: "a", resetsAt: null },
        { repo: "owner/z", issueNumber: 2, title: "z", resetsAt: null },
      ],
    });
    const out = snapshotToBacklog(snap, { now: () => NOW, repo: "owner/a" });
    expect(out.noProvider.map((n) => n.issue)).toEqual([1]);
    expect(out.repos).toEqual(["owner/a", "owner/z"]);
  });

  it("preserves the admission pick-order end-to-end (admit → projectBacklog → transform)", () => {
    // Two same-age eligible issues whose admission order differs from issue-number
    // order: the priority tie-break promotes the p0 issue (#50) above the p1 one
    // (#10), so a transform that re-sorted by issue number would be caught here.
    const ready = ["ready-for-agent", "afk", "mode:tdd"];
    const SAME_AGE = "2026-01-01T00:00:00Z";
    const lower: Issue = {
      number: 10,
      title: "p1, lower number",
      body: "",
      state: "OPEN",
      labels: [...ready, "priority:p1"],
      createdAt: SAME_AGE,
    };
    const prioritized: Issue = {
      number: 50,
      title: "p0, higher number",
      body: "",
      state: "OPEN",
      labels: [...ready, "priority:p0"],
      createdAt: SAME_AGE,
    };
    const world: World = {
      isInFlight: () => false,
      getRun: () => undefined,
      isDependencySatisfied: async () => true,
      openSlots: 5,
      priorityLabels: ["priority:p0", "priority:p1"],
      hasImplProviderHeadroom: () => true,
      hasMemoryHeadroom: () => true,
      repo: "owner/repo",
    };

    return admit([lower, prioritized], world).then(async (plan) => {
      // Admission's pick-order: #50 (p0) before #10 (p1), despite the lower number.
      expect(plan.eligible.map((p) => p.issue.number)).toEqual([50, 10]);

      const view = await projectBacklog([lower, prioritized], plan, world.priorityLabels, world.isDependencySatisfied, world.repo);
      // Wrap the repo-less projection into the aggregate (repo-tagged) snapshot shape,
      // exactly as buildSnapshot's tagRepo does.
      const tag = <T>(items: T[]) => items.map((i) => ({ ...i, repo: "owner/repo" }));
      const snap = withBacklog({
        eligible: tag(view.eligible),
        blocked: tag(view.blocked),
        paused: tag(view.paused),
        manualHolds: tag(view.manualHolds),
        modingCandidates: tag(view.modingCandidates),
      });

      const out = snapshotToBacklog(snap, { now: () => NOW });
      // The web view shows the exact ordering the admission gate uses.
      expect(out.eligible.map((e) => e.issue)).toEqual([50, 10]);
    });
  });
});
