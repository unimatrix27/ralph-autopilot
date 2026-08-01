import { describe, expect, it } from "vitest";
import type { Run } from "../store/types";
import { MasterLease } from "./lease";
import { selectMasterTask, type MasterQueueWorld } from "./queue";

function run(issueNumber: number, updatedAt: string): Run {
  return {
    id: issueNumber,
    repo: "o/r",
    issueNumber,
    mode: "tdd",
    tier: 1,
    status: "master-triage",
    branch: `ralph/${issueNumber}`,
    worktreePath: `/w/${issueNumber}`,
    prNumber: 100 + issueNumber,
    issueTitle: `issue ${issueNumber}`,
    runnerPushedSha: null,
    createdAt: updatedAt,
    updatedAt,
  };
}

function world(over: Partial<MasterQueueWorld> = {}): MasterQueueWorld {
  return {
    queued: [],
    isBusy: () => false,
    hasCapacity: () => true,
    masterLeaseHeld: () => false,
    ...over,
  };
}

describe("master queue selection (ADR-0041)", () => {
  it("selects the oldest queued escalation", () => {
    const older = run(1, "2026-08-01T09:00:00Z");
    const newer = run(2, "2026-08-01T10:00:00Z");
    expect(selectMasterTask(world({ queued: [older, newer] }))).toEqual({ run: older });
  });

  it("selects nothing when the queue is empty", () => {
    expect(selectMasterTask(world())).toEqual({ skip: "empty" });
  });

  it("globally serializes — a second queued master waits while the lease is held", () => {
    const selection = selectMasterTask(world({ queued: [run(1, "t"), run(2, "t")], masterLeaseHeld: () => true }));
    expect(selection).toEqual({ skip: "lease-held" });
  });

  it("respects the ordinary global cap — never launches above it", () => {
    expect(selectMasterTask(world({ queued: [run(1, "t")], hasCapacity: () => false }))).toEqual({
      skip: "no-capacity",
    });
  });

  it("skips a queued run that already holds a slot", () => {
    const a = run(1, "t");
    const b = run(2, "t");
    expect(selectMasterTask(world({ queued: [a, b], isBusy: (n) => n === 1 }))).toEqual({ run: b });
    expect(selectMasterTask(world({ queued: [a], isBusy: () => true }))).toEqual({ skip: "all-busy" });
  });
});

describe("global master lease (ADR-0041)", () => {
  it("admits one holder and refuses the rest", () => {
    const lease = new MasterLease();
    const first = lease.acquire("o/r#1");
    expect(first).not.toBeNull();
    expect(lease.isHeld()).toBe(true);
    expect(lease.heldBy()).toBe("o/r#1");
    expect(lease.acquire("o/r#2")).toBeNull();
    // Cross-repo too: the lease is process-wide, not per-repo.
    expect(lease.acquire("other/repo#5")).toBeNull();
  });

  it("frees on release and re-admits the next holder", () => {
    const lease = new MasterLease();
    const first = lease.acquire("a")!;
    first.release();
    expect(lease.isHeld()).toBe(false);
    const second = lease.acquire("b");
    expect(second).not.toBeNull();
    // A double release from the stale holder must not steal the lease from `b`.
    first.release();
    expect(lease.heldBy()).toBe("b");
  });

  it("refuses to re-acquire for the same key while held", () => {
    const lease = new MasterLease();
    expect(lease.acquire("a")).not.toBeNull();
    expect(lease.acquire("a")).toBeNull();
  });
});
