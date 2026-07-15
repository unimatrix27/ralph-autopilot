import { describe, expect, it } from "vitest";
import type { Issue } from "../github/types";
import type { Run, RunStatus } from "../store/types";
import { admit, type World } from "./admission";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    title: "Do the thing",
    body: "",
    state: "OPEN",
    labels: ["ready-for-agent", "afk", "mode:tdd"],
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** A run row carrying just the status fields {@link admit} inspects. */
function run(status: RunStatus): Run {
  return {
    id: 1,
    issueNumber: 1,
    mode: "tdd",
    status,
    branch: null,
    worktreePath: null,
    prNumber: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function world(overrides: Partial<World> = {}): World {
  return {
    isInFlight: () => false,
    getRun: () => undefined,
    isDependencySatisfied: async () => true,
    openSlots: 10,
    priorityLabels: [],
    hasImplProviderHeadroom: () => true,
    ...overrides,
  };
}

const numbers = (issues: { issue: Issue }[]) => issues.map((p) => p.issue.number);

describe("admit — the eligibility gate seam", () => {
  it("admits an OPEN + ready-for-agent + afk + mode issue and reports its mode", async () => {
    const iss = issue();
    const plan = await admit([iss], world());
    expect(plan.picked).toEqual([{ issue: iss, mode: "tdd" }]);
    expect(plan.excluded).toEqual([]);
  });

  it("reads mode:infra", async () => {
    const iss = issue({ labels: ["ready-for-agent", "afk", "mode:infra"] });
    const plan = await admit([iss], world());
    expect(plan.picked).toEqual([{ issue: iss, mode: "infra" }]);
  });

  it("reads mode:ui", async () => {
    const iss = issue({ labels: ["ready-for-agent", "afk", "mode:ui"] });
    const plan = await admit([iss], world());
    expect(plan.picked).toEqual([{ issue: iss, mode: "ui" }]);
  });

  it.each([
    ["a closed issue", issue({ state: "CLOSED" }), "not-open"],
    ["an issue without ready-for-agent", issue({ labels: ["afk", "mode:tdd"] }), "not-ready"],
    ["an issue missing afk", issue({ labels: ["ready-for-agent", "mode:tdd"] }), "not-afk"],
    ["an issue carrying hitl", issue({ labels: ["ready-for-agent", "afk", "hitl", "mode:tdd"] }), "hitl"],
    ["an issue missing a mode label", issue({ labels: ["ready-for-agent", "afk"] }), "no-mode"],
    [
      "a milestone-log issue",
      issue({ labels: ["ready-for-agent", "afk", "mode:tdd", "[log] milestone"] }),
      "log-issue",
    ],
  ])("excludes %s with reason %s", async (_desc, iss, reason) => {
    const plan = await admit([iss], world());
    expect(plan.picked).toEqual([]);
    expect(plan.excluded).toEqual([{ issue: iss, reason }]);
  });

  it("excludes a paused issue even when it still carries ready-for-agent (AC1)", async () => {
    for (const paused of ["awaiting-answer", "review-maxed", "agent-stuck", "daemon-anomaly"]) {
      const iss = issue({ labels: ["ready-for-agent", "afk", "mode:tdd", paused] });
      const plan = await admit([iss], world());
      expect(plan.picked).toEqual([]);
      expect(plan.excluded).toEqual([{ issue: iss, reason: "paused" }]);
    }
  });

  it("excludes an issue with an unsatisfied ## Blocked by dependency, carrying each ref's status", async () => {
    const blocked = issue({ body: "## Blocked by\n- #1\n- #2\n" });
    const plan = await admit([blocked], world({ isDependencySatisfied: async (n) => n === 1 }));
    expect(plan.picked).toEqual([]);
    // The blocked exclusion carries every ref + its satisfaction, so the read model can
    // show which dependency is unmet (#20) without re-resolving it.
    expect(plan.excluded).toEqual([
      {
        issue: blocked,
        reason: "blocked",
        blockers: [
          { ref: 1, satisfied: true },
          { ref: 2, satisfied: false },
        ],
      },
    ]);
  });

  it("admits an issue whose dependencies are all satisfied", async () => {
    const blocked = issue({ body: "## Blocked by\n- #1\n" });
    const plan = await admit([blocked], world({ isDependencySatisfied: async (n) => n === 1 }));
    expect(plan.picked).toEqual([{ issue: blocked, mode: "tdd" }]);
  });
});

describe("admit — in-flight and active-run exclusions", () => {
  it("excludes an issue already in flight via the isInFlight port", async () => {
    const iss = issue({ number: 2 });
    const plan = await admit([iss], world({ isInFlight: (n) => n === 2 }));
    expect(plan.picked).toEqual([]);
    expect(plan.excluded).toEqual([{ issue: iss, reason: "in-flight" }]);
  });

  it.each<RunStatus>(["running", "awaiting-answer", "review-maxed"])(
    "excludes an issue held by a still-active %s run via the getRun port",
    async (status) => {
      const iss = issue();
      const plan = await admit([iss], world({ getRun: () => run(status) }));
      expect(plan.picked).toEqual([]);
      expect(plan.excluded).toEqual([{ issue: iss, reason: "held" }]);
    },
  );

  it.each<RunStatus>(["agent-stuck", "merged"])(
    "re-admits an issue whose run is terminal (%s) — eligibility is from labels, not SQLite",
    async (status) => {
      const iss = issue();
      const plan = await admit([iss], world({ getRun: () => run(status) }));
      expect(plan.picked).toEqual([{ issue: iss, mode: "tdd" }]);
      expect(plan.excluded).toEqual([]);
    },
  );

  it("reports in-flight before consulting the gate or resolving dependencies", async () => {
    let depCalls = 0;
    const iss = issue({ number: 2, body: "## Blocked by\n- #99\n" });
    const plan = await admit(
      [iss],
      world({
        isInFlight: (n) => n === 2,
        isDependencySatisfied: async () => {
          depCalls += 1;
          return true;
        },
      }),
    );
    expect(plan.excluded).toEqual([{ issue: iss, reason: "in-flight" }]);
    expect(depCalls).toBe(0);
  });
});

describe("admit — dependency resolution is lazy and cached", () => {
  it("resolves each blocker once across issues (cache) and only for issues that reach the check (lazy)", async () => {
    const calls: number[] = [];
    const isDependencySatisfied = async (n: number): Promise<boolean> => {
      calls.push(n);
      return true;
    };
    // #99 is shared by two eligible issues; #98 belongs to an issue that fails a
    // cheap label check (no afk) and so never reaches the blocked-by test.
    const a = issue({ number: 1, body: "## Blocked by\n- #99\n" });
    const b = issue({ number: 2, body: "## Blocked by\n- #99\n" });
    const c = issue({ number: 3, labels: ["ready-for-agent", "mode:tdd"], body: "## Blocked by\n- #98\n" });

    const plan = await admit([a, b, c], world({ isDependencySatisfied }));

    // Cache: #99 resolved exactly once despite two issues depending on it.
    expect(calls.filter((n) => n === 99)).toHaveLength(1);
    // Laziness: #98 is never resolved — issue C is dropped before the blocked-by test.
    expect(calls).not.toContain(98);
    expect(numbers(plan.picked).sort()).toEqual([1, 2]);
    expect(plan.excluded).toEqual([{ issue: c, reason: "not-afk" }]);
  });
});

describe("admit — ordering and slot fill", () => {
  const at = (n: number, createdAt: string, labels: string[] = []): Issue =>
    issue({ number: n, labels: ["ready-for-agent", "afk", "mode:tdd", ...labels], createdAt });

  it("orders FIFO by issue age — oldest first", async () => {
    const issues = [
      at(3, "2026-03-01T00:00:00Z"),
      at(1, "2026-01-01T00:00:00Z"),
      at(2, "2026-02-01T00:00:00Z"),
    ];
    const plan = await admit(issues, world());
    expect(numbers(plan.picked)).toEqual([1, 2, 3]);
  });

  it("breaks same-age ties by priority label, highest priority first", async () => {
    const t = "2026-01-01T00:00:00Z";
    const issues = [at(1, t), at(2, t, ["priority/high"]), at(3, t, ["priority/low"])];
    const plan = await admit(issues, world({ priorityLabels: ["priority/high", "priority/low"] }));
    expect(numbers(plan.picked)).toEqual([2, 3, 1]);
  });

  it("keeps age primary over priority", async () => {
    const issues = [at(1, "2026-01-01T00:00:00Z"), at(2, "2026-02-01T00:00:00Z", ["priority/high"])];
    const plan = await admit(issues, world({ priorityLabels: ["priority/high"] }));
    expect(numbers(plan.picked)).toEqual([1, 2]);
  });

  it("falls back to issue number for a total tie", async () => {
    const t = "2026-01-01T00:00:00Z";
    const plan = await admit([at(5, t), at(2, t)], world());
    expect(numbers(plan.picked)).toEqual([2, 5]);
  });

  it("takes only as many as there are open slots, in order", async () => {
    const issues = [
      at(1, "2026-01-01T00:00:00Z"),
      at(2, "2026-02-01T00:00:00Z"),
      at(3, "2026-03-01T00:00:00Z"),
    ];
    const plan = await admit(issues, world({ openSlots: 2 }));
    expect(numbers(plan.picked)).toEqual([1, 2]);
  });

  it("picks nothing when there are no open slots", async () => {
    const iss = at(1, "2026-01-01T00:00:00Z");
    const plan = await admit([iss], world({ openSlots: 0 }));
    expect(plan.picked).toEqual([]);
    // An eligible-but-unslotted issue is not an exclusion: it passed the gate and
    // stays in the uncapped `eligible` queue (the backlog the web control plane shows waiting).
    expect(plan.excluded).toEqual([]);
    expect(plan.eligible).toEqual([{ issue: iss, mode: "tdd" }]);
  });

  it("picks all candidates when slots exceed them", async () => {
    const plan = await admit([at(1, "2026-01-01T00:00:00Z")], world({ openSlots: 5 }));
    expect(plan.picked).toHaveLength(1);
  });

  it("never exceeds the open-slot cap even with more eligible issues", async () => {
    const issues = Array.from({ length: 10 }, (_, i) =>
      at(i + 1, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
    );
    const plan = await admit(issues, world({ openSlots: 3 }));
    expect(numbers(plan.picked)).toEqual([1, 2, 3]);
  });
});

describe("admit — the no-provider wait (ADR-0037 P2.3)", () => {
  const at = (n: number, createdAt: string): Issue =>
    issue({ number: n, labels: ["ready-for-agent", "afk", "mode:tdd"], createdAt });

  it("excludes every otherwise-eligible issue with reason no-provider when no pool has headroom (AC1)", async () => {
    const a = at(1, "2026-01-01T00:00:00Z");
    const b = at(2, "2026-02-01T00:00:00Z");
    const plan = await admit([a, b], world({ hasImplProviderHeadroom: () => false }));
    // A wait, not a stuck: nothing launches and nothing is left in the eligible queue;
    // each issue is excluded with reason `no-provider` (it keeps `ready-for-agent`).
    expect(plan.picked).toEqual([]);
    expect(plan.eligible).toEqual([]);
    expect(plan.excluded).toEqual([
      { issue: a, reason: "no-provider" },
      { issue: b, reason: "no-provider" },
    ]);
  });

  it("admits the issue once headroom returns (AC1)", async () => {
    const iss = at(1, "2026-01-01T00:00:00Z");
    const plan = await admit([iss], world({ hasImplProviderHeadroom: () => true }));
    expect(plan.picked).toEqual([{ issue: iss, mode: "tdd" }]);
    expect(plan.excluded).toEqual([]);
  });

  it("never reports no-provider for a gate-failing issue — it carries its real gate reason (AC2)", async () => {
    // A no-mode issue is excluded at the gate, never reclassified as a provider wait,
    // even when no pool has headroom: the no-provider check only ever covers the
    // otherwise-eligible queue.
    const unmoded = issue({ labels: ["ready-for-agent", "afk"] });
    const plan = await admit([unmoded], world({ hasImplProviderHeadroom: () => false }));
    expect(plan.excluded).toEqual([{ issue: unmoded, reason: "no-mode" }]);
  });

  it("does not probe provider headroom when nothing is eligible (lazy)", async () => {
    let probes = 0;
    const closed = issue({ state: "CLOSED" });
    await admit(
      [closed],
      world({
        hasImplProviderHeadroom: () => {
          probes += 1;
          return false;
        },
      }),
    );
    expect(probes).toBe(0);
  });

  it("excludes with no-provider regardless of open slots — the pool, not capacity, is the gate", async () => {
    const iss = at(1, "2026-01-01T00:00:00Z");
    const plan = await admit([iss], world({ openSlots: 10, hasImplProviderHeadroom: () => false }));
    expect(plan.picked).toEqual([]);
    expect(plan.excluded).toEqual([{ issue: iss, reason: "no-provider" }]);
  });
});
