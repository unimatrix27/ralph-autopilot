import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitWorktreeManager } from "./worktree";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

describe("GitWorktreeManager", () => {
  let clone: string;
  let wtRoot: string;

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), "ralph-wt-"));
    clone = join(base, "clone");
    wtRoot = join(base, "wt");
    execFileSync("git", ["init", "-b", "master", clone]);
    git(clone, "config", "user.email", "test@example.com");
    git(clone, "config", "user.name", "Test");
    writeFileSync(join(clone, "README.md"), "base\n");
    git(clone, "add", "README.md");
    git(clone, "commit", "-m", "initial");
  });

  afterEach(() => {
    // best-effort; temp dirs are reaped by the OS
  });

  it("creates an isolated worktree on a ralph branch", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot);
    const path = await mgr.create("ralph/2-foo", "2-foo");

    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(path, "README.md"))).toBe(true);
    const branch = git(path, "rev-parse", "--abbrev-ref", "HEAD").trim();
    expect(branch).toBe("ralph/2-foo");
  });

  it("keeps parallel worktrees from contaminating each other", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot);
    const a = await mgr.create("ralph/1-a", "1-a");
    const b = await mgr.create("ralph/2-b", "2-b");

    writeFileSync(join(a, "only-in-a.txt"), "secret a\n");
    writeFileSync(join(b, "only-in-b.txt"), "secret b\n");

    expect(existsSync(join(b, "only-in-a.txt"))).toBe(false);
    expect(existsSync(join(a, "only-in-b.txt"))).toBe(false);
    expect(readFileSync(join(a, "only-in-a.txt"), "utf8")).toBe("secret a\n");
  });

  it("removes a worktree cleanly afterwards", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot);
    const path = await mgr.create("ralph/3-c", "3-c");
    expect(existsSync(path)).toBe(true);

    await mgr.remove(path);

    expect(existsSync(path)).toBe(false);
    const list = git(clone, "worktree", "list");
    expect(list).not.toContain(path);
  });

  it("resets a pre-existing local branch on a fresh create instead of failing (#28, AC1)", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot);

    // A prior run created the branch, committed work, then tore its worktree down
    // — the local branch survives in the clone (the claim-loop trigger).
    const first = await mgr.create("ralph/28-redo", "28-redo");
    writeFileSync(join(first, "stale.txt"), "prior run work\n");
    git(first, "add", "stale.txt");
    git(first, "commit", "-m", "prior run work");
    await mgr.remove(first);
    expect(git(clone, "branch", "--list", "ralph/28-redo")).toContain("ralph/28-redo");

    // Fresh re-pickup must succeed (branch reset to base), not throw "already exists".
    const redo = await mgr.create("ralph/28-redo", "28-redo");
    expect(existsSync(redo)).toBe(true);
    expect(git(redo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("ralph/28-redo");
    // Reset to base: the prior run's commit is gone (a redo, not a resume).
    expect(existsSync(join(redo, "stale.txt"))).toBe(false);
  });

  it("recreates the worktree when a stale directory survived at its path (#28, AC1)", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot);

    // A claim rollback whose worktree-remove failed leaves the directory (and its
    // admin registration) behind; a fresh create at the same deterministic path
    // must still succeed.
    const first = await mgr.create("ralph/29-leak", "29-leak");
    expect(existsSync(first)).toBe(true);

    const redo = await mgr.create("ralph/29-leak", "29-leak");
    expect(redo).toBe(first);
    expect(git(redo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("ralph/29-leak");
  });

  it("prunes orphaned ralph/* branches and worktrees, keeping live ones (#28, AC2)", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot);

    const live = await mgr.create("ralph/1-live", "1-live");
    const orphanWt = await mgr.create("ralph/2-orphan", "2-orphan");
    const branchOnly = await mgr.create("ralph/3-gone", "3-gone");
    // ralph/3-gone's worktree is torn down; its local branch survives as an orphan.
    await mgr.remove(branchOnly);

    const pruned = await mgr.pruneOrphans(new Set(["ralph/1-live"]));

    expect(pruned.sort()).toEqual(["ralph/2-orphan", "ralph/3-gone"]);
    // The live branch and its worktree are untouched.
    expect(existsSync(live)).toBe(true);
    expect(git(clone, "branch", "--list", "ralph/1-live")).toContain("ralph/1-live");
    // Both orphans (registered worktree + branch-only) are gone.
    expect(existsSync(orphanWt)).toBe(false);
    expect(git(clone, "branch", "--list", "ralph/2-orphan").trim()).toBe("");
    expect(git(clone, "branch", "--list", "ralph/3-gone").trim()).toBe("");
  });

  it("lists only the worktrees under its root, never the main clone (orphan GC)", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot);
    const a = await mgr.create("ralph/1-a", "1-a");
    const b = await mgr.create("ralph/2-b", "2-b");

    const listed = await mgr.list();
    expect(listed.sort()).toEqual([a, b].sort());
    // The main clone (the daemon's target repo) is never a GC candidate.
    expect(listed).not.toContain(clone);

    await mgr.remove(a);
    expect(await mgr.list()).toEqual([b]);
  });
});

describe("GitWorktreeManager checkpoint + attach (resume path)", () => {
  let clone: string;
  let wtRoot: string;

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), "ralph-wt-resume-"));
    const origin = join(base, "origin.git");
    clone = join(base, "clone");
    wtRoot = join(base, "wt");
    execFileSync("git", ["init", "--bare", "-b", "master", origin]);
    execFileSync("git", ["clone", origin, clone]);
    git(clone, "config", "user.email", "test@example.com");
    git(clone, "config", "user.name", "Test");
    writeFileSync(join(clone, "README.md"), "base\n");
    git(clone, "add", "README.md");
    git(clone, "commit", "-m", "initial");
    git(clone, "push", "origin", "master");
  });

  it("commits and pushes WIP, then re-attaches the same branch on resume", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot);

    // Impl agent works on a new branch, leaves uncommitted WIP, then escalates.
    const path = await mgr.create("ralph/4-hitl", "4-hitl");
    writeFileSync(join(path, "wip.txt"), "in-progress work\n");
    await mgr.checkpointWip(path, "ralph/4-hitl");

    // The branch (with the WIP commit) is now durable on origin.
    const remoteBranches = git(clone, "ls-remote", "--heads", "origin");
    expect(remoteBranches).toContain("ralph/4-hitl");

    // Slot frees: the worktree is torn down.
    await mgr.remove(path);
    expect(existsSync(path)).toBe(false);

    // Resume: re-attach the existing branch — the WIP is still there.
    const resumed = await mgr.attach("ralph/4-hitl", "4-hitl-resumed");
    expect(git(resumed, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("ralph/4-hitl");
    expect(readFileSync(join(resumed, "wip.txt"), "utf8")).toBe("in-progress work\n");
  });

  // #241 data-loss guard: if rebasing onto base leaves the branch with no net diff
  // (its work was absorbed into base, or it was wrongly recreated from base), the
  // harness must REFUSE the force-push rather than wipe the branch to a
  // base-equivalent state. The work on origin stays intact; the run surfaces.
  it("refuses to force-push when the rebase leaves no net diff vs base (#241)", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot);
    const path = await mgr.create("ralph/241-wipe", "241-wipe");

    // The branch adds feature.txt and pushes it (real work on origin).
    writeFileSync(join(path, "feature.txt"), "the work\n");
    git(path, "add", "feature.txt");
    git(path, "commit", "-m", "feat: the work");
    git(path, "push", "-u", "origin", "ralph/241-wipe");

    // Base then advances with the IDENTICAL change (the work got absorbed into base),
    // so rebasing the branch onto base drops its now-empty commit → no net diff.
    writeFileSync(join(clone, "feature.txt"), "the work\n");
    git(clone, "add", "feature.txt");
    git(clone, "commit", "-m", "feat: same work on base");
    git(clone, "push", "origin", "master");

    await expect(mgr.rebaseOntoBase(path, "ralph/241-wipe", "master")).rejects.toThrow(
      /refusing to force-push|no net diff/,
    );

    // The original work is still on origin — the guard did not wipe it.
    const remoteHead = git(clone, "ls-remote", "origin", "ralph/241-wipe");
    expect(remoteHead).toContain("ralph/241-wipe");
  });

  it("re-attaches over a worktree that survived a crash (startup recovery, #8)", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot);

    // Impl agent pushes its branch, then the daemon crashes — teardown never ran,
    // so the worktree dir is still registered at its path.
    const path = await mgr.create("ralph/9-crash", "9-crash");
    writeFileSync(join(path, "wip.txt"), "in-progress work\n");
    await mgr.checkpointWip(path, "ralph/9-crash");
    expect(existsSync(path)).toBe(true);

    // Recovery re-attaches at the SAME (deterministic) dir name — must not throw
    // on the occupied path / already-checked-out branch.
    const resumed = await mgr.attach("ralph/9-crash", "9-crash");
    expect(resumed).toBe(path);
    expect(git(resumed, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("ralph/9-crash");
    expect(readFileSync(join(resumed, "wip.txt"), "utf8")).toBe("in-progress work\n");
  });

  it("checkpointWip with a clean tree just pushes the branch", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot);
    const path = await mgr.create("ralph/5-clean", "5-clean");
    // No local changes — commit must be skipped, push must still publish the branch.
    await mgr.checkpointWip(path, "ralph/5-clean");
    expect(git(clone, "ls-remote", "--heads", "origin")).toContain("ralph/5-clean");
  });

  it("clears a stale remote ralph branch on a fresh create so the redo can push (#28, AC1)", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot, { baseBranch: "master" });

    // A prior run pushed this branch to origin; both the local branch and the
    // remote ref survive into the re-pickup.
    const first = await mgr.create("ralph/28-remote", "28-remote");
    writeFileSync(join(first, "old.txt"), "old run\n");
    git(first, "add", "old.txt");
    git(first, "commit", "-m", "old run");
    git(first, "push", "-u", "origin", "ralph/28-remote");
    await mgr.remove(first);
    expect(git(clone, "ls-remote", "--heads", "origin", "ralph/28-remote")).toContain(
      "ralph/28-remote",
    );

    // Fresh create succeeds and drops the diverged remote branch, so the new run
    // can push cleanly (a stale remote ref would reject its non-fast-forward push).
    const redo = await mgr.create("ralph/28-remote", "28-remote");
    expect(git(clone, "ls-remote", "--heads", "origin", "ralph/28-remote").trim()).toBe("");

    writeFileSync(join(redo, "new.txt"), "new run\n");
    git(redo, "add", "new.txt");
    git(redo, "commit", "-m", "new run");
    // No throw: the remote branch was cleared, so this is a clean first push.
    git(redo, "push", "-u", "origin", "ralph/28-remote");
    expect(git(clone, "ls-remote", "--heads", "origin", "ralph/28-remote")).toContain(
      "ralph/28-remote",
    );
  });
});

describe("GitWorktreeManager rebaseOntoBase (rebase-aware merge, #41)", () => {
  let origin: string;
  let clone: string;
  let wtRoot: string;

  /** Make a commit on `master` in a throwaway clone and push it, advancing origin. */
  function advanceBase(file: string, contents: string): void {
    const other = join(mkdtempSync(join(tmpdir(), "ralph-base-")), "c");
    execFileSync("git", ["clone", origin, other]);
    git(other, "config", "user.email", "base@example.com");
    git(other, "config", "user.name", "Base");
    writeFileSync(join(other, file), contents);
    git(other, "add", file);
    git(other, "commit", "-m", `base: ${file}`);
    git(other, "push", "origin", "master");
  }

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), "ralph-wt-rebase-"));
    origin = join(base, "origin.git");
    clone = join(base, "clone");
    wtRoot = join(base, "wt");
    execFileSync("git", ["init", "--bare", "-b", "master", origin]);
    execFileSync("git", ["clone", origin, clone]);
    git(clone, "config", "user.email", "test@example.com");
    git(clone, "config", "user.name", "Test");
    writeFileSync(join(clone, "README.md"), "base\n");
    git(clone, "add", "README.md");
    git(clone, "commit", "-m", "initial");
    git(clone, "push", "origin", "master");
  });

  it("is a clean no-op (moved=false) when the base has not advanced", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot);
    const path = await mgr.create("ralph/6-noop", "6-noop");
    writeFileSync(join(path, "feature.txt"), "work\n");
    git(path, "add", "feature.txt");
    git(path, "commit", "-m", "feature");

    const result = await mgr.rebaseOntoBase(path, "ralph/6-noop", "master");
    expect(result).toEqual({ kind: "clean", moved: false });
  });

  it("rebases cleanly (moved=true) and force-pushes when the base advanced on a different file", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot);
    const path = await mgr.create("ralph/7-clean", "7-clean");
    writeFileSync(join(path, "feature.txt"), "work\n");
    git(path, "add", "feature.txt");
    git(path, "commit", "-m", "feature");
    git(path, "push", "-u", "origin", "ralph/7-clean");

    // Base moves on an unrelated file → a clean rebase that moves the branch tip.
    advanceBase("other.txt", "base change\n");

    const result = await mgr.rebaseOntoBase(path, "ralph/7-clean", "master");
    expect(result).toEqual({ kind: "clean", moved: true });
    // The rebased branch now contains the base's commit and was force-pushed.
    expect(existsSync(join(path, "other.txt"))).toBe(true);
    const remoteTip = git(clone, "ls-remote", "origin", "ralph/7-clean").trim();
    const localTip = git(path, "rev-parse", "HEAD").trim();
    expect(remoteTip).toContain(localTip);
  });

  it("reports the conflicted files when base and branch edit the same lines", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot);
    const path = await mgr.create("ralph/8-conflict", "8-conflict");
    writeFileSync(join(path, "shared.txt"), "branch version\n");
    git(path, "add", "shared.txt");
    git(path, "commit", "-m", "branch edit");

    // Base adds the same file with different contents → a rebase conflict.
    advanceBase("shared.txt", "base version\n");

    const result = await mgr.rebaseOntoBase(path, "ralph/8-conflict", "master");
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") {
      expect(result.files).toContain("shared.txt");
    }
  });

  // #273: under the container model the daemon-side rebase is never left in progress — the
  // container fix agent redoes the rebase in its own clone and the runner force-pushes it, so a
  // daemon-side in-progress rebase would be cruft the container never sees (and a later harness
  // push would land as a silent no-op). rebaseOntoBase must ABORT after detecting a conflict,
  // leaving this worktree clean and on its branch.
  it("aborts the rebase after detecting a conflict — the worktree is left clean, on the branch (#273)", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot);
    const path = await mgr.create("ralph/273-abort", "273-abort");
    writeFileSync(join(path, "shared.txt"), "branch version\n");
    git(path, "add", "shared.txt");
    git(path, "commit", "-m", "branch edit");
    git(path, "push", "-u", "origin", "ralph/273-abort");

    advanceBase("shared.txt", "base version\n");

    const result = await mgr.rebaseOntoBase(path, "ralph/273-abort", "master");
    expect(result.kind).toBe("conflict");

    // No in-progress rebase: HEAD is on the branch (not detached mid-rebase), the tree is clean,
    // and `git status` reports no rebase in progress — the abort returned it to the pre-rebase state.
    expect(git(path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("ralph/273-abort");
    expect(git(path, "status", "--porcelain")).toBe("");
    expect(git(path, "status")).not.toContain("rebase in progress");
  });
});

// #273: the daemon must verify a rebase-conflict resolution actually LANDED on origin rather
// than assume it (the container owns the rebase + force-push out-of-tree; a silent no-op push
// would otherwise proceed to a merge that cannot land). true iff origin/<branch> is now a clean
// descendant of origin/<base> (fully rebased — no conflict can remain) AND still carries work.
describe("GitWorktreeManager verifyBranchRebasedOntoBase (#273)", () => {
  let origin: string;
  let clone: string;
  let wtRoot: string;

  /** Make a commit on `master` in a throwaway clone and push it, advancing origin. */
  function advanceBase(file: string, contents: string): void {
    const other = join(mkdtempSync(join(tmpdir(), "ralph-base-")), "c");
    execFileSync("git", ["clone", origin, other]);
    git(other, "config", "user.email", "base@example.com");
    git(other, "config", "user.name", "Base");
    writeFileSync(join(other, file), contents);
    git(other, "add", file);
    git(other, "commit", "-m", `base: ${file}`);
    git(other, "push", "origin", "master");
  }

  /**
   * Resolve the rebase conflict the way the container does: from a SEPARATE clone, rebase the
   * branch onto the advanced base, resolve the conflict, and force-push the result to origin.
   */
  function containerResolveAndPush(branch: string, file: string, contents: string): void {
    const container = join(mkdtempSync(join(tmpdir(), "ralph-container-")), "c");
    execFileSync("git", ["clone", "--branch", branch, "--single-branch", origin, container]);
    git(container, "config", "user.email", "agent@example.com");
    git(container, "config", "user.name", "Agent");
    // A `--single-branch` clone has no origin/master tracking ref: fetch base with an explicit
    // refspec (exactly what the daemon's container cloner does for a rebase fix, #273) so the
    // rebase can target it.
    git(container, "fetch", "origin", "master:refs/remotes/origin/master");
    try {
      execFileSync("git", ["rebase", "origin/master"], { cwd: container, encoding: "utf8" });
    } catch {
      // expected: stops on the conflict
    }
    writeFileSync(join(container, file), contents);
    git(container, "add", file);
    execFileSync("git", ["rebase", "--continue"], {
      cwd: container,
      encoding: "utf8",
      env: { ...process.env, GIT_EDITOR: "true" },
    });
    git(container, "push", "--force-with-lease", "origin", branch);
  }

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), "ralph-wt-verify273-"));
    origin = join(base, "origin.git");
    clone = join(base, "clone");
    wtRoot = join(base, "wt");
    execFileSync("git", ["init", "--bare", "-b", "master", origin]);
    execFileSync("git", ["clone", origin, clone]);
    git(clone, "config", "user.email", "test@example.com");
    git(clone, "config", "user.name", "Test");
    writeFileSync(join(clone, "README.md"), "base\n");
    git(clone, "add", "README.md");
    git(clone, "commit", "-m", "initial");
    git(clone, "push", "origin", "master");
  });

  it("returns true when the container resolved + force-pushed the rebase onto the advanced base", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot);
    const path = await mgr.create("ralph/273-ok", "273-ok");
    writeFileSync(join(path, "shared.txt"), "branch version\n");
    git(path, "add", "shared.txt");
    git(path, "commit", "-m", "branch edit");
    git(path, "push", "-u", "origin", "ralph/273-ok");

    advanceBase("shared.txt", "base version\n");
    // The daemon detects + aborts; the container resolves + force-pushes the rebased branch.
    const rebase = await mgr.rebaseOntoBase(path, "ralph/273-ok", "master");
    if (rebase.kind !== "conflict") throw new Error("expected a conflict");
    containerResolveAndPush("ralph/273-ok", "shared.txt", "base version\nbranch version\n");

    // Verify against the base the fix was DISPATCHED against (carried on the conflict result, #20).
    expect(await mgr.verifyBranchRebasedOntoBase(path, "ralph/273-ok", "master", rebase.baseSha)).toBe(true);
  });

  it("returns false (fail loud) when the resolution did NOT land — origin still conflicts with base", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot);
    const path = await mgr.create("ralph/273-stale", "273-stale");
    writeFileSync(join(path, "shared.txt"), "branch version\n");
    git(path, "add", "shared.txt");
    git(path, "commit", "-m", "branch edit");
    git(path, "push", "-u", "origin", "ralph/273-stale");

    advanceBase("shared.txt", "base version\n");
    const rebase = await mgr.rebaseOntoBase(path, "ralph/273-stale", "master");
    if (rebase.kind !== "conflict") throw new Error("expected a conflict");
    // The container reported `fixed` but never actually force-pushed (a silent no-op) — origin's
    // branch still forks off the OLD base, so it does not contain the DISPATCH base. Even verifying
    // against that dispatch base (not a moved one) must fail loud — this is the real #273 failure.
    expect(await mgr.verifyBranchRebasedOntoBase(path, "ralph/273-stale", "master", rebase.baseSha)).toBe(false);
  });

  it("returns false when a wiped (base-equivalent) branch landed — the #241 no-net-diff invariant rides along", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot);
    const path = await mgr.create("ralph/273-wipe", "273-wipe");
    writeFileSync(join(path, "feature.txt"), "the work\n");
    git(path, "add", "feature.txt");
    git(path, "commit", "-m", "the work");
    git(path, "push", "-u", "origin", "ralph/273-wipe");

    advanceBase("other.txt", "base change\n");
    // The dispatch base the (bad) resolution claimed to integrate is the advanced master.
    git(clone, "fetch", "origin", "master");
    const dispatchBaseSha = git(clone, "rev-parse", "origin/master").trim();
    // A bad resolution force-pushed a base-equivalent branch (the work was wiped). It contains
    // base as an ancestor (so it "merges cleanly") but carries NO net work — must still fail loud.
    const container = join(mkdtempSync(join(tmpdir(), "ralph-wipe-")), "c");
    execFileSync("git", ["clone", origin, container]);
    git(container, "checkout", "master");
    git(container, "branch", "-f", "ralph/273-wipe", "master");
    git(container, "push", "--force", "origin", "ralph/273-wipe");

    expect(await mgr.verifyBranchRebasedOntoBase(path, "ralph/273-wipe", "master", dispatchBaseSha)).toBe(false);
  });

  it("returns true when base advanced AGAIN after the resolution landed on the dispatch base (#20)", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot);
    const path = await mgr.create("ralph/20-race", "20-race");
    writeFileSync(join(path, "shared.txt"), "branch version\n");
    git(path, "add", "shared.txt");
    git(path, "commit", "-m", "branch edit");
    git(path, "push", "-u", "origin", "ralph/20-race");

    advanceBase("shared.txt", "base version\n");
    const rebase = await mgr.rebaseOntoBase(path, "ralph/20-race", "master");
    if (rebase.kind !== "conflict") throw new Error("expected a conflict");
    // The container rebased onto the base it was handed (rebase.baseSha) and force-pushed cleanly.
    containerResolveAndPush("ralph/20-race", "shared.txt", "base version\nbranch version\n");

    // A SECOND sibling merges into base on a disjoint file, AFTER the resolution landed — origin's
    // current base is now one commit ahead of what the fix integrated.
    advanceBase("disjoint.txt", "another base change\n");

    // Verifying against the DISPATCH base still passes: the resolution did exactly what it was asked.
    // (Verifying against origin's current base — the #20 bug — would falsely fail "push landed nothing".)
    expect(await mgr.verifyBranchRebasedOntoBase(path, "ralph/20-race", "master", rebase.baseSha)).toBe(true);
  });

  it("adoptOriginBranch resets the worktree to the runner-pushed resolution so a re-rebase can proceed (#20)", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot);
    const path = await mgr.create("ralph/20-adopt", "20-adopt");
    writeFileSync(join(path, "shared.txt"), "branch version\n");
    git(path, "add", "shared.txt");
    git(path, "commit", "-m", "branch edit");
    git(path, "push", "-u", "origin", "ralph/20-adopt");

    advanceBase("shared.txt", "base version\n");
    const rebase = await mgr.rebaseOntoBase(path, "ralph/20-adopt", "master");
    expect(rebase.kind).toBe("conflict");
    // The container force-pushes rewritten history; the daemon worktree's local ref still holds the
    // pre-resolution history, which now DIVERGES from origin (a plain sync would refuse to clobber it).
    containerResolveAndPush("ralph/20-adopt", "shared.txt", "base version\nbranch version\n");

    await mgr.adoptOriginBranch(path, "ralph/20-adopt");

    // The worktree HEAD now equals origin/<branch> — the resolved history is adopted.
    expect(git(path, "rev-parse", "HEAD").trim()).toBe(git(path, "rev-parse", "origin/ralph/20-adopt").trim());
    // A subsequent rebaseOntoBase no longer refuses on divergence: base did not advance, so it is a
    // clean (unmoved) rebase — the loop can proceed to merge.
    const again = await mgr.rebaseOntoBase(path, "ralph/20-adopt", "master");
    expect(again).toEqual({ kind: "clean", moved: false });
  });
});

describe("GitWorktreeManager branchDiffHash (integration fast-path, #65)", () => {
  let origin: string;
  let clone: string;
  let wtRoot: string;

  /** Make a commit on `master` in a throwaway clone and push it, advancing origin. */
  function advanceBase(file: string, contents: string): void {
    const other = join(mkdtempSync(join(tmpdir(), "ralph-base-")), "c");
    execFileSync("git", ["clone", origin, other]);
    git(other, "config", "user.email", "base@example.com");
    git(other, "config", "user.name", "Base");
    writeFileSync(join(other, file), contents);
    git(other, "add", file);
    git(other, "commit", "-m", `base: ${file}`);
    git(other, "push", "origin", "master");
  }

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), "ralph-wt-diffhash-"));
    origin = join(base, "origin.git");
    clone = join(base, "clone");
    wtRoot = join(base, "wt");
    execFileSync("git", ["init", "--bare", "-b", "master", origin]);
    execFileSync("git", ["clone", origin, clone]);
    git(clone, "config", "user.email", "test@example.com");
    git(clone, "config", "user.name", "Test");
    writeFileSync(join(clone, "README.md"), "base\n");
    git(clone, "add", "README.md");
    git(clone, "commit", "-m", "initial");
    git(clone, "push", "origin", "master");
  });

  it("is unchanged by a pure fast-forward replay (base advanced on a disjoint file)", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot);
    const path = await mgr.create("ralph/65-replay", "65-replay");
    writeFileSync(join(path, "feature.txt"), "work\n");
    git(path, "add", "feature.txt");
    git(path, "commit", "-m", "feature");
    git(path, "push", "-u", "origin", "ralph/65-replay");

    const before = await mgr.branchDiffHash(path, "master");
    expect(before).not.toBeNull();

    // Base moves on an unrelated file → a clean replay; the branch's net diff vs base
    // is byte-identical before and after, so the hash is unchanged.
    advanceBase("other.txt", "base change\n");
    const rebase = await mgr.rebaseOntoBase(path, "ralph/65-replay", "master");
    expect(rebase).toEqual({ kind: "clean", moved: true });

    const after = await mgr.branchDiffHash(path, "master");
    expect(after).toBe(before);
  });

  it("changes when a conflict resolution alters the merged result", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot);
    const path = await mgr.create("ralph/65-conflict", "65-conflict");
    writeFileSync(join(path, "shared.txt"), "branch version\n");
    git(path, "add", "shared.txt");
    git(path, "commit", "-m", "branch edit");
    git(path, "push", "-u", "origin", "ralph/65-conflict");

    const before = await mgr.branchDiffHash(path, "master");
    expect(before).not.toBeNull();

    // Base edits the same file → a rebase conflict. rebaseOntoBase detects it then ABORTS
    // (the daemon worktree stays clean; the container owns the resolution out-of-tree, #273),
    // so simulate that resolution here: redo the rebase in this worktree and resolve it.
    advanceBase("shared.txt", "base version\n");
    const rebase = await mgr.rebaseOntoBase(path, "ralph/65-conflict", "master");
    expect(rebase.kind).toBe("conflict");
    git(path, "fetch", "origin", "master");
    try {
      execFileSync("git", ["rebase", "origin/master"], { cwd: path, encoding: "utf8" });
    } catch {
      // expected: the rebase stops on the shared.txt conflict
    }
    writeFileSync(join(path, "shared.txt"), "base version\nbranch version\n");
    git(path, "add", "shared.txt");
    execFileSync("git", ["rebase", "--continue"], {
      cwd: path,
      encoding: "utf8",
      env: { ...process.env, GIT_EDITOR: "true" },
    });
    // The resolution lands on origin (the container force-pushes it, #273). branchDiffHash hashes
    // origin's state, so the resolved rebase must be pushed for the hash to reflect it.
    git(path, "push", "--force-with-lease", "origin", "ralph/65-conflict");

    const after = await mgr.branchDiffHash(path, "master");
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it("changes when the base advances inside a file the branch also touched (shifted hunks)", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot);
    // The branch edits the tail of a shared file; base prepends to its head. No
    // textual conflict, but the rebase shifts the branch's hunk and the merged
    // result differs from what was reviewed → the net diff hash changes (#65).
    writeFileSync(join(clone, "shared.txt"), "line1\nline2\nline3\n");
    git(clone, "add", "shared.txt");
    git(clone, "commit", "-m", "seed shared");
    git(clone, "push", "origin", "master");

    const path = await mgr.create("ralph/65-shift", "65-shift");
    writeFileSync(join(path, "shared.txt"), "line1\nline2\nline3-edited\n");
    git(path, "add", "shared.txt");
    git(path, "commit", "-m", "branch edits tail");
    git(path, "push", "-u", "origin", "ralph/65-shift");

    const before = await mgr.branchDiffHash(path, "master");
    expect(before).not.toBeNull();

    advanceBase("shared.txt", "line0\nline1\nline2\nline3\n");
    const rebase = await mgr.rebaseOntoBase(path, "ralph/65-shift", "master");
    expect(rebase).toEqual({ kind: "clean", moved: true });

    const after = await mgr.branchDiffHash(path, "master");
    expect(after).not.toBe(before);
  });

  it("returns null when the base branch cannot be resolved (conservative fallback)", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot);
    const path = await mgr.create("ralph/65-nobranch", "65-nobranch");
    writeFileSync(join(path, "feature.txt"), "work\n");
    git(path, "add", "feature.txt");
    git(path, "commit", "-m", "feature");

    // No such base ref on origin → fetch/diff fails → null (caller re-reviews).
    expect(await mgr.branchDiffHash(path, "does-not-exist")).toBeNull();
  });
});

// Under the container execution model the agent's clone — not the harness-side
// worktree — commits and pushes the work, so the worktree's local branch ref
// stays at its fork point (base). Every harness-side rebase/diff must first
// sync to origin/<branch>, or the #241 guard fires a false positive whenever
// base moves during a run (#255).
describe("GitWorktreeManager syncs the stale local ref to origin/<branch> (#255)", () => {
  let origin: string;
  let clone: string;
  let wtRoot: string;

  /** Make a commit on `master` in a throwaway clone and push it, advancing origin. */
  function advanceBase(file: string, contents: string): void {
    const other = join(mkdtempSync(join(tmpdir(), "ralph-base-")), "c");
    execFileSync("git", ["clone", origin, other]);
    git(other, "config", "user.email", "base@example.com");
    git(other, "config", "user.name", "Base");
    writeFileSync(join(other, file), contents);
    git(other, "add", file);
    git(other, "commit", "-m", `base: ${file}`);
    git(other, "push", "origin", "master");
  }

  /**
   * Commit + push work on `branch` from a separate clone — exactly what the
   * in-container agent does. The harness worktree's local ref never sees this.
   */
  function agentPush(branch: string, file: string, contents: string): void {
    const container = join(mkdtempSync(join(tmpdir(), "ralph-container-")), "c");
    execFileSync("git", ["clone", origin, container]);
    git(container, "config", "user.email", "agent@example.com");
    git(container, "config", "user.name", "Agent");
    // Reuse the pushed branch if it exists (fix rounds), else fork it from master.
    const remote = git(container, "ls-remote", "--heads", "origin", branch).trim();
    if (remote.length > 0) {
      git(container, "checkout", branch);
    } else {
      git(container, "checkout", "-b", branch);
    }
    writeFileSync(join(container, file), contents);
    git(container, "add", file);
    git(container, "commit", "-m", `agent: ${file}`);
    git(container, "push", "-u", "origin", branch);
  }

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), "ralph-wt-sync255-"));
    origin = join(base, "origin.git");
    clone = join(base, "clone");
    wtRoot = join(base, "wt");
    execFileSync("git", ["init", "--bare", "-b", "master", origin]);
    execFileSync("git", ["clone", origin, clone]);
    git(clone, "config", "user.email", "test@example.com");
    git(clone, "config", "user.name", "Test");
    writeFileSync(join(clone, "README.md"), "base\n");
    git(clone, "add", "README.md");
    git(clone, "commit", "-m", "initial");
    git(clone, "push", "origin", "master");
  });

  it("rebases the PUSHED work when the local ref is stale at base and base advanced (the #255 false positive)", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot, { baseBranch: "master" });
    const path = await mgr.create("ralph/255-fp", "255-fp");

    // Container agent does the work; the worktree's local ref stays at base.
    agentPush("ralph/255-fp", "feature.txt", "the work\n");
    // Base then advances on a disjoint file (a sibling PR merged mid-run).
    advanceBase("other.txt", "sibling change\n");

    // Before the fix: the empty local ref fast-forwards onto base → moved=true,
    // no net diff → the #241 guard throws and the run terminalizes agent-stuck.
    const result = await mgr.rebaseOntoBase(path, "ralph/255-fp", "master");
    expect(result).toEqual({ kind: "clean", moved: true });

    // The pushed work survived the rebase and landed back on origin, on top of base.
    expect(readFileSync(join(path, "feature.txt"), "utf8")).toBe("the work\n");
    expect(existsSync(join(path, "other.txt"))).toBe(true);
    const remoteTip = git(clone, "ls-remote", "origin", "ralph/255-fp").trim();
    expect(remoteTip).toContain(git(path, "rev-parse", "HEAD").trim());
  });

  it("still refuses when the pushed work was genuinely absorbed into base (#241 stays intact)", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot, { baseBranch: "master" });
    const path = await mgr.create("ralph/255-empty", "255-empty");

    agentPush("ralph/255-empty", "feature.txt", "the work\n");
    // Base absorbs the IDENTICAL change → the rebase drops the commit → a genuine
    // no-net-diff, which must still refuse rather than wipe the branch to base.
    advanceBase("feature.txt", "the work\n");

    await expect(mgr.rebaseOntoBase(path, "ralph/255-empty", "master")).rejects.toThrow(
      /no net diff/,
    );
    expect(git(clone, "ls-remote", "origin", "ralph/255-empty")).toContain("ralph/255-empty");
  });

  it("branchDiffHash hashes the pushed work, not the stale local ref", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot, { baseBranch: "master" });
    const path = await mgr.create("ralph/255-hash", "255-hash");
    git(path, "push", "-u", "origin", "ralph/255-hash");

    // Stale local ref == base → an empty net diff hash.
    const empty = await mgr.branchDiffHash(path, "master");
    expect(empty).not.toBeNull();

    // Container agent pushes work; the local ref is still at base. The hash must
    // reflect the pushed work, otherwise the before/after comparison around a
    // rebase (issue #65) reports a spurious change and forces a full re-review.
    agentPush("ralph/255-hash", "feature.txt", "the work\n");
    const after = await mgr.branchDiffHash(path, "master");
    expect(after).not.toBeNull();
    expect(after).not.toBe(empty);
  });

  it("refuses loudly when local and origin/<branch> have truly diverged (never clobber either side)", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot, { baseBranch: "master" });
    const path = await mgr.create("ralph/255-div", "255-div");

    // Local-only commit AND a different pushed commit → neither is an ancestor.
    writeFileSync(join(path, "local.txt"), "local only\n");
    git(path, "add", "local.txt");
    git(path, "commit", "-m", "local only");
    agentPush("ralph/255-div", "remote.txt", "remote only\n");

    await expect(mgr.rebaseOntoBase(path, "ralph/255-div", "master")).rejects.toThrow(
      /diverged/,
    );
    // Origin's unique commit is untouched.
    expect(git(clone, "ls-remote", "origin", "ralph/255-div")).toContain("ralph/255-div");
  });

  // #21: a rebase-conflict self-heal rewrites history — the container fix agent redoes the
  // rebase in its clone and the runner force-pushes the result (#273), leaving the daemon
  // worktree's local ref at the pre-rebase head. That divergence can NEVER fast-forward, so on
  // resume the #255 guard would fire on the daemon's OWN legitimate push and orphan the reviewed
  // PR. When origin/<branch> is the daemon's own recorded runner push (or a descendant of it),
  // origin is verified truth by construction — hard-sync the local ref to it instead of refusing.
  it("hard-syncs the stale local ref to origin when origin is the daemon's own recorded runner push (#21)", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot, { baseBranch: "master" });
    const path = await mgr.create("ralph/21-heal", "21-heal");

    // The daemon worktree's local ref holds the pre-rebase head (a local commit).
    writeFileSync(join(path, "feature.txt"), "pre-rebase\n");
    git(path, "add", "feature.txt");
    git(path, "commit", "-m", "pre-rebase head");

    // The container rebase-conflict fix rewrites history and the runner force-pushes: origin/<branch>
    // is now a DIFFERENT commit, so local and origin have diverged (neither is an ancestor).
    agentPush("ralph/21-heal", "feature.txt", "rewritten-by-container\n");
    const trustedRemoteHead = git(clone, "ls-remote", "origin", "ralph/21-heal").trim().split(/\s+/)[0];

    // With the runner-pushed SHA supplied, the guard recognises the divergence as the daemon's own
    // write and hard-resets local to origin rather than refusing. Base did not advance → clean no-op.
    const result = await mgr.rebaseOntoBase(path, "ralph/21-heal", "master", {
      trustedRemoteHead,
    });
    expect(result).toEqual({ kind: "clean", moved: false });

    // Local now matches origin (the runner's verified push); the pre-rebase local commit is gone.
    expect(readFileSync(join(path, "feature.txt"), "utf8")).toBe("rewritten-by-container\n");
    expect(git(path, "rev-parse", "HEAD").trim()).toBe(trustedRemoteHead);
    // Origin is untouched — nothing moved, so no force-push clobbered the verified work.
    expect(git(clone, "ls-remote", "origin", "ralph/21-heal").trim().split(/\s+/)[0]).toBe(
      trustedRemoteHead,
    );
  });

  it("hard-syncs when origin is a DESCENDANT of the recorded runner push (#21)", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot, { baseBranch: "master" });
    const path = await mgr.create("ralph/21-desc", "21-desc");

    writeFileSync(join(path, "feature.txt"), "pre-rebase\n");
    git(path, "add", "feature.txt");
    git(path, "commit", "-m", "pre-rebase head");

    // The runner pushed once (recorded), then a commit was appended on top on origin, so
    // origin is a descendant of the recorded SHA (still diverged from the local pre-rebase ref).
    agentPush("ralph/21-desc", "feature.txt", "rewritten\n");
    const recorded = git(clone, "ls-remote", "origin", "ralph/21-desc").trim().split(/\s+/)[0];
    agentPush("ralph/21-desc", "more.txt", "follow-up\n");
    const originHead = git(clone, "ls-remote", "origin", "ralph/21-desc").trim().split(/\s+/)[0];
    expect(originHead).not.toBe(recorded);

    const result = await mgr.rebaseOntoBase(path, "ralph/21-desc", "master", {
      trustedRemoteHead: recorded,
    });
    expect(result).toEqual({ kind: "clean", moved: false });
    // Local hard-synced to origin's current head (the descendant), not the stale recorded SHA.
    expect(git(path, "rev-parse", "HEAD").trim()).toBe(originHead);
  });

  it("still refuses loudly when a recorded runner push does NOT match/descend the diverged origin (#21 guard intact)", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot, { baseBranch: "master" });
    const path = await mgr.create("ralph/21-hand", "21-hand");

    // A local-only commit and a different, unattributable origin rewrite (a genuine hand
    // force-push) → neither is an ancestor of the other.
    writeFileSync(join(path, "local.txt"), "local only\n");
    git(path, "add", "local.txt");
    git(path, "commit", "-m", "local only");
    const staleRecorded = git(path, "rev-parse", "HEAD").trim();
    agentPush("ralph/21-hand", "remote.txt", "remote only\n");

    // The recorded SHA is neither origin's head nor an ancestor of it — the daemon cannot attribute
    // the current divergence to its own push, so the #255 guard fires exactly as today.
    await expect(
      mgr.rebaseOntoBase(path, "ralph/21-hand", "master", { trustedRemoteHead: staleRecorded }),
    ).rejects.toThrow(/diverged/);
    expect(git(clone, "ls-remote", "origin", "ralph/21-hand")).toContain("ralph/21-hand");
  });

  it("remoteBranchHead returns origin/<branch>'s current SHA and null for an unpushed branch (#21)", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot, { baseBranch: "master" });
    const path = await mgr.create("ralph/21-head", "21-head");

    // Not pushed yet → no origin/<branch> → null.
    expect(await mgr.remoteBranchHead(path, "ralph/21-head")).toBeNull();

    agentPush("ralph/21-head", "feature.txt", "work\n");
    const head = await mgr.remoteBranchHead(path, "ralph/21-head");
    expect(head).toBe(git(clone, "ls-remote", "origin", "ralph/21-head").trim().split(/\s+/)[0]);
  });

  it("keeps a local ref that is AHEAD of origin (unpushed harness-side work is not discarded)", async () => {
    const mgr = new GitWorktreeManager(clone, wtRoot, { baseBranch: "master" });
    const path = await mgr.create("ralph/255-ahead", "255-ahead");

    // The pushed branch is an ancestor of the local ref (e.g. a resumed host-side
    // session committed on top of the pushed state without pushing yet).
    writeFileSync(join(path, "pushed.txt"), "pushed\n");
    git(path, "add", "pushed.txt");
    git(path, "commit", "-m", "pushed");
    git(path, "push", "-u", "origin", "ralph/255-ahead");
    writeFileSync(join(path, "unpushed.txt"), "unpushed\n");
    git(path, "add", "unpushed.txt");
    git(path, "commit", "-m", "unpushed");

    advanceBase("other.txt", "sibling change\n");
    const result = await mgr.rebaseOntoBase(path, "ralph/255-ahead", "master");
    expect(result).toEqual({ kind: "clean", moved: true });
    // Both commits survive; the force-push landed them on origin.
    expect(existsSync(join(path, "pushed.txt"))).toBe(true);
    expect(existsSync(join(path, "unpushed.txt"))).toBe(true);
    const remoteTip = git(clone, "ls-remote", "origin", "ralph/255-ahead").trim();
    expect(remoteTip).toContain(git(path, "rev-parse", "HEAD").trim());
  });
});
