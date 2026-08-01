import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CLONE_SYNC_ANOMALIES,
  CLONE_SYNC_GIT_COMMANDS,
  TargetCloneAnomalyError,
  TargetCloneGate,
  TargetCloneSynchronizer,
  assertCloneSafeGit,
  cloneSyncOperatorAction,
  planCloneSync,
  type CloneBaseState,
  type CloneSyncAnomaly,
} from "./clone-sync";
import { GitWorktreeManager } from "./worktree";
import { FakeTargetClone } from "../testing/fake-clone";

const BASE = "master";

function state(overrides: Partial<CloneBaseState> = {}): CloneBaseState {
  return {
    branch: BASE,
    dirty: false,
    localSha: "aaa",
    remoteSha: "aaa",
    fastForwardable: true,
    ...overrides,
  };
}

describe("planCloneSync — the pure decision (issue #50)", () => {
  it("is a no-op when the clean base checkout already matches origin", () => {
    expect(planCloneSync(state(), BASE)).toEqual({ kind: "current" });
  });

  it("fast-forwards a clean base checkout that is behind origin", () => {
    expect(planCloneSync(state({ localSha: "old", remoteSha: "new" }), BASE)).toEqual({
      kind: "fast-forward",
    });
  });

  it("refuses a dirty clone — never overwrite local work, surface it instead", () => {
    expect(planCloneSync(state({ dirty: true, localSha: "old", remoteSha: "new" }), BASE)).toEqual({
      kind: "anomaly",
      reason: "target-clone-dirty",
    });
  });

  it("refuses a dirty clone even when it is already current (something edited the clone)", () => {
    expect(planCloneSync(state({ dirty: true }), BASE)).toEqual({
      kind: "anomaly",
      reason: "target-clone-dirty",
    });
  });

  it("refuses a detached HEAD", () => {
    expect(planCloneSync(state({ branch: null, localSha: "old", remoteSha: "new" }), BASE)).toEqual({
      kind: "anomaly",
      reason: "target-clone-off-base",
    });
  });

  it("refuses a clone parked on some other branch", () => {
    expect(planCloneSync(state({ branch: "wip", localSha: "old", remoteSha: "new" }), BASE)).toEqual({
      kind: "anomaly",
      reason: "target-clone-off-base",
    });
  });

  it("refuses a diverged clone (local is not an ancestor of origin)", () => {
    expect(
      planCloneSync(state({ localSha: "local", remoteSha: "new", fastForwardable: false }), BASE),
    ).toEqual({ kind: "anomaly", reason: "target-clone-diverged" });
  });

  it("refuses a clone carrying local commits ahead of origin (an autonomous edit)", () => {
    // Local descends from origin, so no fast-forward exists — the daemon must never rewind it.
    expect(
      planCloneSync(state({ localSha: "ahead", remoteSha: "old", fastForwardable: false }), BASE),
    ).toEqual({ kind: "anomaly", reason: "target-clone-diverged" });
  });
});

describe("cloneSyncOperatorAction", () => {
  it("names a concrete, imperative operator action for every anomaly reason", () => {
    for (const reason of CLONE_SYNC_ANOMALIES) {
      const action = cloneSyncOperatorAction(reason, { cloneDir: "/srv/clone", baseBranch: BASE });
      expect(action.length).toBeGreaterThan(0);
      // concrete: it points at the actual clone the operator must go and look at
      expect(action).toContain("/srv/clone");
    }
  });
});

describe("the git surface the sync is allowed to use (no autonomous target-repo edits)", () => {
  it("rejects every repo-mutating git command", () => {
    for (const command of ["push", "commit", "add", "tag", "checkout", "reset", "rebase", "clean"]) {
      expect(() => assertCloneSafeGit([command, "whatever"])).toThrow(/not permitted/i);
    }
  });

  it("rejects a merge that is not fast-forward-only", () => {
    expect(() => assertCloneSafeGit(["merge", "origin/master"])).toThrow(/--ff-only/);
    expect(() => assertCloneSafeGit(["merge", "--ff-only", "origin/master"])).not.toThrow();
  });

  it("allows only read-only inspection plus the fetch and the fast-forward", () => {
    expect([...CLONE_SYNC_GIT_COMMANDS].sort()).toEqual(
      ["fetch", "merge", "merge-base", "rev-parse", "status", "symbolic-ref"].sort(),
    );
  });
});

function clone(overrides: Partial<ConstructorParameters<typeof FakeTargetClone>[0]> = {}): FakeTargetClone {
  return new FakeTargetClone({
    baseBranch: BASE,
    history: [
      { sha: "c1", files: { ".ralph/agent.Dockerfile": "FROM ralph/agent-base:0.0.6\n" } },
      { sha: "c2", files: { ".ralph/agent.Dockerfile": "FROM ralph/agent-base:0.0.7\n" } },
    ],
    checkedOutAt: "c1",
    fetchedAt: "c1",
    ...overrides,
  });
}

function synchronizer(
  fake: FakeTargetClone,
  extra: { onAnomaly?: (a: { reason: CloneSyncAnomaly }) => void; gate?: TargetCloneGate } = {},
): TargetCloneSynchronizer {
  return new TargetCloneSynchronizer({
    cloneDir: "/srv/clone",
    baseBranch: BASE,
    git: fake.git,
    ...extra,
  });
}

describe("TargetCloneSynchronizer — fast-forward-only refresh (issue #50)", () => {
  it("fetches and fast-forwards a stale base checkout onto origin", async () => {
    const fake = clone();
    const result = await synchronizer(fake).sync();

    expect(result).toEqual({ kind: "fast-forward", previousHead: "c1", head: "c2" });
    expect(fake.head).toBe("c2");
    // the fetch precedes the fast-forward: the ref it merges must be the freshly-fetched one
    const commands = fake.calls.map((c) => c[0]);
    expect(commands.indexOf("fetch")).toBeLessThan(commands.indexOf("merge"));
    expect(fake.calls.find((c) => c[0] === "merge")).toContain("--ff-only");
  });

  it("is a no-op when the clone is already current — no merge is issued", async () => {
    const fake = clone({ checkedOutAt: "c2", fetchedAt: "c2" });
    const result = await synchronizer(fake).sync();

    expect(result).toEqual({ kind: "current", previousHead: "c2", head: "c2" });
    expect(fake.calls.some((c) => c[0] === "merge")).toBe(false);
  });

  it("still fetches before deciding, so an unfetched bump is seen (not read off a stale ref)", async () => {
    // The clone and its remote-tracking ref both sit at c1; origin has already moved to c2.
    const fake = clone({ checkedOutAt: "c1", fetchedAt: "c1" });
    await synchronizer(fake).sync();
    expect(fake.head).toBe("c2");
  });

  it("never touches a dirty clone: it throws a precise anomaly and issues no merge", async () => {
    const fake = clone({ dirtyPaths: ["src/Api.cs"] });
    const onAnomaly = vi.fn();
    const sync = synchronizer(fake, { onAnomaly });

    await expect(sync.sync()).rejects.toBeInstanceOf(TargetCloneAnomalyError);
    expect(fake.head).toBe("c1"); // untouched
    expect(fake.calls.some((c) => c[0] === "merge")).toBe(false);
    expect(onAnomaly).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "target-clone-dirty", cloneDir: "/srv/clone" }),
    );
    // the surfaced anomaly names what the operator must do
    expect(onAnomaly.mock.calls[0]![0].action).toContain("/srv/clone");
  });

  it("never touches a diverged clone: it throws a precise anomaly and issues no merge", async () => {
    const fake = clone({
      checkedOutAt: "local-only",
      fetchedAt: "c1",
      localOnly: { sha: "local-only", files: { ".ralph/agent.Dockerfile": "FROM ralph/agent-base:9\n" } },
    });
    const onAnomaly = vi.fn();

    await expect(synchronizer(fake, { onAnomaly }).sync()).rejects.toMatchObject({
      reason: "target-clone-diverged",
    });
    expect(fake.head).toBe("local-only");
    expect(fake.calls.some((c) => c[0] === "merge")).toBe(false);
    expect(onAnomaly).toHaveBeenCalledOnce();
  });

  it("never touches a clone parked off the base branch", async () => {
    const fake = clone({ branch: "operator-poking" });
    await expect(synchronizer(fake).sync()).rejects.toMatchObject({ reason: "target-clone-off-base" });
    expect(fake.head).toBe("c1");
  });

  it("surfaces a git-refused fast-forward rather than forcing it", async () => {
    const fake = clone();
    // git can still refuse (e.g. an untracked file in the way); the daemon must not escalate to force.
    const git = async (args: string[]): Promise<string> => {
      if (args[0] === "merge") {
        throw new Error("error: Your local changes would be overwritten by merge.");
      }
      return fake.git(args);
    };
    const sync = new TargetCloneSynchronizer({ cloneDir: "/srv/clone", baseBranch: BASE, git });
    await expect(sync.sync()).rejects.toMatchObject({ reason: "target-clone-ff-refused" });
  });

  it("makes no autonomous edit to the target repo — no push, commit, add or tag, ever", async () => {
    const fake = clone();
    await synchronizer(fake).sync();
    const issued = new Set(fake.calls.map((c) => c[0]!));
    for (const forbidden of ["push", "commit", "add", "tag", "checkout", "reset"]) {
      expect(issued.has(forbidden)).toBe(false);
    }
    // and every command it DID issue is on the allowlist
    for (const command of issued) {
      expect(CLONE_SYNC_GIT_COMMANDS).toContain(command);
    }
  });
});

describe("coalescing — concurrent dispatches cannot corrupt the clone (issue #50)", () => {
  it("serializes concurrent syncs: two critical sections never overlap", async () => {
    const fake = clone();
    let active = 0;
    let maxActive = 0;
    fake.beforeGit = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
    };
    const sync = synchronizer(fake);

    await Promise.all([sync.sync(), sync.sync(), sync.sync()]);

    expect(maxActive).toBe(1);
    // the batch fast-forwards exactly ONCE — the followers find the clone already current
    expect(fake.calls.filter((c) => c[0] === "merge")).toHaveLength(1);
    expect(fake.head).toBe("c2");
  });

  it("holds the clone steady for the whole read: a queued sync cannot move HEAD mid-read", async () => {
    const fake = clone();
    const sync = synchronizer(fake);
    const seen: string[] = [];
    let queued: Promise<unknown> = Promise.resolve();

    const read = sync.withSyncedClone(async () => {
      // origin moves (a sibling PR merges) and another dispatch demands a sync WHILE we read
      fake.pushToOrigin({ sha: "c3", files: { ".ralph/agent.Dockerfile": "FROM ralph/agent-base:0.0.8\n" } });
      queued = sync.sync();
      seen.push(fake.head);
      await Promise.resolve();
      seen.push(fake.head);
      return fake.head;
    });

    await expect(read).resolves.toBe("c2");
    await queued;
    seen.push(`after:${fake.head}`);
    // HEAD was stable at c2 across the whole read, and only advanced once the read released it
    expect(seen).toEqual(["c2", "c2", "after:c3"]);
  });

  it("recovers after a failing critical section — the gate is not wedged by a throw", async () => {
    const gate = new TargetCloneGate();
    await expect(gate.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(gate.run(async () => "ok")).resolves.toBe("ok");
  });

  it("shares one gate with worktree preparation, so a `worktree add` cannot race a fast-forward", async () => {
    const gate = new TargetCloneGate();
    const fake = clone();
    const sync = synchronizer(fake, { gate });
    const worktreeRoot = mkdtempSync(join(tmpdir(), "ralph-clone-sync-"));
    let active = 0;
    let maxActive = 0;
    const enter = async (): Promise<void> => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
    };
    fake.beforeGit = enter;

    const worktrees = new GitWorktreeManager("/srv/clone", worktreeRoot, { baseBranch: BASE, gate });
    // Stub the manager's git edge: the point under test is the shared gate, not real git.
    const worktreeGit = vi
      .spyOn(worktrees as unknown as { git: (args: string[]) => Promise<unknown> }, "git")
      .mockImplementation(async () => {
        await enter();
        return { stdout: "", stderr: "" };
      });

    try {
      await Promise.all([sync.sync(), worktrees.create("ralph/50-x", "50-x"), sync.sync()]);
      expect(maxActive).toBe(1);
      expect(worktreeGit).toHaveBeenCalled();
    } finally {
      rmSync(worktreeRoot, { recursive: true, force: true });
    }
  });
});
