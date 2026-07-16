/**
 * Per-issue git worktrees (CONTEXT: worktree). Each in-flight issue gets its own
 * worktree on a `ralph/<n>-<slug>` branch, sharing the target clone's object
 * store (ADR-0002). One agent, one worktree; isolated working tree, cheap to
 * create and tear down.
 */

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Resolve the clone's remote default branch (`main`/`master`) so new worktrees
 * fork the latest default branch. Falls back to `main` if the symbolic ref is
 * unset (e.g. a clone made without `origin/HEAD`). Co-located with the other git
 * invocations (rather than in the daemon's composition root) so all git-CLI
 * knowledge lives in one module; synchronous because its sole caller,
 * `createReconciler`, is synchronous.
 */
export function detectDefaultBranch(cloneDir: string): string {
  try {
    const ref = execFileSync(
      "git",
      ["-C", cloneDir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      { encoding: "utf8" },
    ).trim();
    const branch = ref.replace(/^origin\//, "");
    return branch || "main";
  } catch {
    return "main";
  }
}

/**
 * The result of rebasing a worktree's branch onto its base (issue #41):
 * - `clean`    — the rebase applied with no conflicts; `moved` is true iff the
 *                branch tip changed (base had advanced), meaning CI must be
 *                re-awaited and the branch was force-pushed;
 * - `conflict` — the rebase stopped on conflicts in `files`; the rebase is then
 *                aborted (the resolution is owned out-of-tree by the container
 *                fix agent + runner push, #273), reporting the conflicted paths.
 *                `baseSha` is `origin/<base>` at conflict-detection time — the base the
 *                container fix agent will rebase onto (its own fetch happens strictly
 *                *after* dispatch, so its base is this SHA or newer). Post-fix
 *                verification checks the branch integrated THIS base, not origin's
 *                current base, so a sibling PR merging inside the fix window does not
 *                falsely fail a perfectly-landed resolution (#20).
 */
export type RebaseResult =
  | { kind: "clean"; moved: boolean }
  | { kind: "conflict"; files: string[]; baseSha: string };

/** The worktree operations the executor depends on. */
export interface WorktreeManager {
  /** Create a worktree on a *new* `branch` at `<root>/<dirName>`; resolve its absolute path. */
  create(branch: string, dirName: string): Promise<string>;
  /**
   * Attach a worktree to an *existing* `branch` at `<root>/<dirName>` — the
   * resume path (CONTEXT: resume, not restart). The WIP branch already exists in
   * GitHub from the checkpoint; this checks it out fresh rather than starting a
   * clean tree.
   */
  attach(branch: string, dirName: string): Promise<string>;
  /**
   * Commit any uncommitted WIP on `branch` and push it, so the work is durable in
   * GitHub before a pause (escalate). A no-op when the tree is already clean.
   */
  checkpointWip(worktreePath: string, branch: string): Promise<void>;
  /**
   * Bring `branch` current with `origin/<baseBranch>` by fetching and rebasing in
   * the worktree, force-pushing if the branch moved (issue #41). The local ref is
   * first fast-forwarded to `origin/<branch>` — under the container model the
   * pushed branch, not the harness-side worktree, carries the work (#255). A clean rebase
   * resolves to {@link RebaseResult} `clean`; conflicts stop the rebase, report the
   * conflicted files, and **abort** (returning the worktree to its pre-rebase state). The
   * resolution itself happens out-of-tree: the container fix agent redoes the rebase in its
   * own clone and the runner force-pushes it (#273) — a daemon-side in-progress rebase would
   * be cruft the container never sees, so it is never left behind. This is what lets
   * high-concurrency runs self-heal the parallel-edit conflict pileup.
   */
  rebaseOntoBase(worktreePath: string, branch: string, baseBranch: string): Promise<RebaseResult>;
  /**
   * Verify a rebase-conflict resolution actually **landed on origin** (issue #273). After the
   * container fix agent redoes the rebase in its clone and the runner force-pushes the result,
   * fetch and confirm `origin/<branch>` now contains `dispatchBaseSha` as an ancestor (the rebase
   * fully integrated the base the fix was HANDED, so no conflict can remain against it) AND still
   * carries its net work (not wiped to a base-equivalent state, #241). `dispatchBaseSha` is the
   * base SHA the conflict was detected against ({@link RebaseResult} `conflict.baseSha`), NOT
   * origin's current base: verifying against a moving current base races a sibling PR that merges
   * into base inside the fix window and would misfire a "push landed nothing" heal-card on a
   * resolution that landed perfectly (#20). The dispatch base is monotonic — a container that
   * fetched an even newer base still contains it — so a correct resolution always passes while the
   * real #273 failures (silent no-op push, still-forked-off-old-base, base-equivalent wipe) still
   * fail loud. The daemon must NOT assume the resolution landed: the daemon-side rebase was aborted
   * and the resolution happened out-of-tree. Returns `true` only when origin genuinely integrated
   * the dispatch base and kept the work.
   */
  verifyBranchRebasedOntoBase(
    worktreePath: string,
    branch: string,
    baseBranch: string,
    dispatchBaseSha: string,
  ): Promise<boolean>;
  /**
   * Hard-reset the worktree's local `branch` ref to `origin/<branch>` — adopt the runner-pushed
   * state as authoritative (issue #20). After a rebase-conflict resolution the container force-pushes
   * rewritten history to `origin/<branch>`, leaving the daemon worktree's local ref on the
   * pre-resolution history, which *diverges* from origin (neither is an ancestor of the other). A
   * plain fast-forward sync ({@link rebaseOntoBase}'s internal sync) refuses that divergence loudly to
   * avoid clobbering origin. This is called only AFTER {@link verifyBranchRebasedOntoBase} confirms
   * origin/<branch> is the good resolved state, so adopting it is safe — and lets the caller re-rebase
   * the branch against a base that advanced again inside the fix window (#20) instead of stalling.
   */
  adoptOriginBranch(worktreePath: string, branch: string): Promise<void>;
  /**
   * Hash the branch's *net diff vs base* — `git diff origin/<baseBranch>...HEAD`
   * (three-dot: the merge-base of base and HEAD against HEAD, i.e. exactly what the
   * branch adds on top of base). Captured before and after a rebase, two equal
   * hashes mean the rebase was a pure fast-forward replay that left the merged
   * result identical (base advanced only in files this branch did not touch), so it
   * cannot have changed what review would see — the integration flow re-gates CI but
   * skips re-review (issue #65). A changed hash (conflict resolution, or base changes
   * that altered the merged result) re-reviews. Resolves `null` when the diff cannot
   * be computed, so the caller falls back to the conservative re-review path.
   */
  branchDiffHash(worktreePath: string, baseBranch: string): Promise<string | null>;
  /** Remove the worktree at `path` and free its administrative files. */
  remove(path: string): Promise<void>;
  /**
   * Prune every `ralph/*` worktree and local branch whose branch is NOT in
   * `keep` — orphans of runs that are gone (issue #28, AC2). Run at startup
   * after run rows are reconciled, so a survivor of a vanished run cannot collide
   * with a fresh `worktree add`. Best-effort per branch (one failure does not
   * abort the sweep); resolves the pruned branch names for logging.
   */
  pruneOrphans(keep: ReadonlySet<string>): Promise<string[]>;
  /**
   * Absolute paths of every per-issue worktree this manager currently tracks
   * (under the worktree root, excluding the main clone). Backs the orphan-worktree
   * GC (issue #27): a tracked worktree no live run/agent references is pruned.
   */
  list(): Promise<string[]>;
}

export interface GitWorktreeOptions {
  /**
   * Ref new worktree branches are based on. Defaults to the clone's HEAD; the
   * daemon points this at the up-to-date default branch (e.g. `origin/master`).
   */
  baseRef?: string;
  /**
   * Remote default branch (e.g. `main`/`master`). When set, `create` fetches it
   * first and bases the new worktree on `origin/<baseBranch>`, so every run forks
   * the *latest* default branch. Without this the clone goes stale after each
   * merge and the next worktree forks an old commit, guaranteeing merge conflicts
   * (the parallel-edit pileup). Complements the rebase-aware merge in #41.
   */
  baseBranch?: string;
}

export class GitWorktreeManager implements WorktreeManager {
  private readonly cloneDir: string;
  private readonly worktreeRoot: string;
  private readonly baseRef?: string;
  private readonly baseBranch?: string;

  constructor(cloneDir: string, worktreeRoot: string, options: GitWorktreeOptions = {}) {
    this.cloneDir = resolve(cloneDir);
    this.worktreeRoot = resolve(worktreeRoot);
    this.baseRef = options.baseRef;
    this.baseBranch = options.baseBranch;
  }

  private git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync("git", ["-C", this.cloneDir, ...args]);
  }

  async create(branch: string, dirName: string): Promise<string> {
    mkdirSync(this.worktreeRoot, { recursive: true });
    const path = resolve(this.worktreeRoot, dirName);
    // Fork the latest default branch: fetch it, then base the worktree on the
    // freshly-updated remote ref. Otherwise the clone keeps a stale HEAD after a
    // merge and the next run forks old code (see GitWorktreeOptions.baseBranch).
    let baseRef = this.baseRef;
    if (this.baseBranch) {
      await this.git(["fetch", "origin", this.baseBranch]);
      baseRef = `origin/${this.baseBranch}`;
    }
    // Idempotency w.r.t. a pre-existing `ralph/<n>-<slug>` (issue #28). A fresh
    // run is a *redo*: clear any survivor of the prior run — a worktree still
    // registered at this path, the local branch, the diverged remote branch —
    // before re-creating it. Otherwise `worktree add -b` fails ("a branch named
    // '…' already exists"), the claim fails every tick, and both slots burn on
    // the failing claim while the issue never progresses. The resume path keeps
    // the branch and goes through `attach`, never here.
    await this.clearStaleBranch(branch, path);
    // `-B` resets the branch to `baseRef` if it still exists rather than failing
    // like `-b` — the branch is being redone from the latest base.
    const args = ["worktree", "add", "-B", branch, path];
    if (baseRef) {
      args.push(baseRef);
    }
    await this.git(args);
    return path;
  }

  /**
   * Clear every survivor of a prior run on `branch` so a fresh worktree can take
   * it: the worktree (and any leftover directory) at `path`, plus the stale
   * remote branch. The local branch itself is reset in place by `worktree add
   * -B`, so it needs no separate delete. All steps are best-effort — the common
   * case is nothing to clear.
   */
  private async clearStaleBranch(branch: string, path: string): Promise<void> {
    await this.resetWorktreePath(path);
    // A diverged remote branch would reject the redo's (non-force) push, so it
    // could never open its PR. Drop it; the daemon owns this ref. Usually absent
    // (push errors "remote ref does not exist"), so the failure is swallowed.
    await this.git(["push", "origin", "--delete", branch]).catch(() => {});
  }

  /**
   * Free a worktree path: drop the git registration, optionally delete any
   * leftover directory, and prune dangling admin entries — so `worktree add` at
   * `path` succeeds whether the path is a live worktree, a half-removed one, or a
   * bare directory left by a failed teardown. All steps are best-effort.
   *
   * `removeDir` defaults to true (the full reset). `attach` passes false: it must
   * NOT delete a pre-existing directory at the path, so a leftover non-registered
   * directory still makes the subsequent `worktree add` fail there — preserving
   * attach's prior recovery behaviour rather than silently widening it.
   */
  private async resetWorktreePath(path: string, removeDir = true): Promise<void> {
    await this.git(["worktree", "remove", "--force", path]).catch(() => {});
    if (removeDir) {
      rmSync(path, { recursive: true, force: true });
    }
    await this.git(["worktree", "prune"]).catch(() => {});
  }

  async attach(branch: string, dirName: string): Promise<string> {
    mkdirSync(this.worktreeRoot, { recursive: true });
    const path = resolve(this.worktreeRoot, dirName);
    // A crash leaves the prior worktree registered at this path (teardown never
    // ran), and `worktree add` refuses an occupied path or an already-checked-out
    // branch. Clear any stale registration first so re-attach is idempotent — the
    // branch's WIP is durable on origin, so a fresh checkout loses nothing. This
    // is what makes startup recovery (issue #8) re-attach a survived worktree.
    // `removeDir: false` — keep the directory; attach recovers a stale
    // *registration*, not a leftover directory (see resetWorktreePath).
    await this.resetWorktreePath(path, false);
    // Make sure the local ref tracks the latest pushed WIP, then check it out.
    await this.git(["fetch", "origin", branch]).catch(() => {});
    await this.git(["worktree", "add", path, branch]);
    return path;
  }

  async checkpointWip(worktreePath: string, branch: string): Promise<void> {
    const inWorktree = (args: string[]): Promise<{ stdout: string; stderr: string }> =>
      execFileAsync("git", ["-C", resolve(worktreePath), ...args]);
    const { stdout } = await inWorktree(["status", "--porcelain"]);
    if (stdout.trim().length > 0) {
      await inWorktree(["add", "-A"]);
      await inWorktree(["commit", "-m", "wip: checkpoint before escalation"]);
    }
    // Push whatever is on the branch (committed WIP) so it is durable in GitHub.
    await inWorktree(["push", "-u", "origin", branch]);
  }

  /**
   * Fast-forward the worktree's local `branch` ref to `origin/<branch>` when the
   * pushed work is ahead of it. Under the container execution model every agent
   * commit lands on origin only — the harness-side worktree's local ref stays
   * wherever `create` forked it (base). Rebasing that stale, commit-less ref is
   * what made the #241 no-net-diff guard fire false-positives whenever base moved
   * during a run (#255): the empty local branch fast-forwards onto the new base,
   * `moved=true`, three-dot diff empty → refuse → agent-stuck. Syncing first makes
   * the harness-side rebase operate on the branch's true (pushed) state.
   *
   * Fast-forward ONLY: a local ref ahead of origin keeps its extra commits (the
   * subsequent force-push lands them). A diverged local/origin pair refuses loudly —
   * the fetch below updates the remote-tracking ref, which would otherwise arm
   * `--force-with-lease` to clobber origin's unique commits. (The read-only net-diff
   * hash path no longer touches the local ref — it hashes `origin/<branch>` directly,
   * see {@link branchDiffHash}, so it is immune to the rewritten-history divergence a
   * container conflict resolution leaves behind, #273.)
   */
  private async syncBranchToOrigin(
    worktreePath: string,
    branch: string,
  ): Promise<void> {
    const inWorktree = (args: string[]): Promise<{ stdout: string; stderr: string }> =>
      execFileAsync("git", ["-C", resolve(worktreePath), ...args]);

    // The branch may never have been pushed (impl failed pre-push) — nothing to sync.
    const fetched = await inWorktree(["fetch", "origin", branch]).then(
      () => true,
      () => false,
    );
    if (!fetched) return;

    const head = (await inWorktree(["rev-parse", "HEAD"])).stdout.trim();
    const remote = (await inWorktree(["rev-parse", `origin/${branch}`])).stdout.trim();
    if (head === remote) return;

    const isAncestor = (anc: string, desc: string): Promise<boolean> =>
      inWorktree(["merge-base", "--is-ancestor", anc, desc]).then(
        () => true,
        () => false,
      );
    if (await isAncestor(head, `origin/${branch}`)) {
      await inWorktree(["reset", "--hard", `origin/${branch}`]);
      return;
    }
    if (await isAncestor(`origin/${branch}`, head)) return; // local ahead: keep it
    throw new Error(
      `refusing to operate on ${branch}: local worktree and origin/${branch} have diverged ` +
        `(neither is an ancestor of the other) — resolve manually so no side is clobbered (#255).`,
    );
  }

  /**
   * The single definition of the #241 "no net diff vs base" DATA-LOSS invariant: does `tipRef`
   * carry any NET work over `baseRef` (a non-empty three-dot diff)? A force-push of a branch with
   * NO net diff would establish a base-equivalent branch, silently discarding whatever work the
   * remote still carries (the wipe observed in #241, where a branch was wrongly recreated from base
   * then force-pushed). `--quiet` exits 0 when the two trees are identical (no net diff) and
   * non-zero when they differ, so the verdict is exit-code pure.
   *
   * Both daemon-side rebase paths gate on this one predicate — {@link rebaseOntoBase} (throws
   * before its force-push) and {@link verifyBranchRebasedOntoBase} (folds it into a pass/fail
   * verdict) — so a future tightening of this load-bearing guard lands in exactly one place rather
   * than leaving a wipe-path open in a divergent copy. A second, deliberately-SEPARATE copy lives in
   * the container runner (`pushResolvedRebase`, in-container-session.ts): it runs in a different
   * process (`spawnSync` in the fix clone, not this worktree) and so cannot call this method — it is
   * defense-in-depth. Keep the two spellings of the invariant semantically in lock-step.
   */
  private hasNetDiffVsBase(
    inWorktree: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
    baseRef: string,
    tipRef: string,
  ): Promise<boolean> {
    return inWorktree(["diff", "--quiet", `${baseRef}...${tipRef}`]).then(
      () => false, // exit 0: base and tip are identical → NO net diff (a force-push would wipe to base)
      () => true, // any non-zero exit from --quiet: there IS a net diff
    );
  }

  async rebaseOntoBase(
    worktreePath: string,
    branch: string,
    baseBranch: string,
  ): Promise<RebaseResult> {
    const inWorktree = (args: string[]): Promise<{ stdout: string; stderr: string }> =>
      execFileAsync("git", ["-C", resolve(worktreePath), ...args]);

    // Rebase the branch's true state, not the possibly-stale local ref (#255).
    await this.syncBranchToOrigin(worktreePath, branch);
    await inWorktree(["fetch", "origin", baseBranch]);
    // Snapshot the base the rebase is being attempted against — on a conflict this is the base the
    // container fix agent will rebase onto, and the fixed anchor its resolution is verified against
    // (#20). Captured after the fetch, before the rebase, so it is exactly what the daemon saw.
    const baseSha = (await inWorktree(["rev-parse", `origin/${baseBranch}`])).stdout.trim();
    const before = (await inWorktree(["rev-parse", "HEAD"])).stdout.trim();
    try {
      await inWorktree(["rebase", `origin/${baseBranch}`]);
    } catch {
      // Conflicts: report the conflicted paths from the unmerged index, then ABORT the
      // rebase. The resolution is owned out-of-tree — the container fix agent redoes the
      // rebase in its own fresh clone and the runner force-pushes it (#273) — so a
      // daemon-side in-progress rebase would be cruft that the container never sees and
      // that a later harness-side push would land as a silent no-op. Aborting returns this
      // worktree to its pre-rebase state (clean, on the branch), ready for the post-fix
      // verification ({@link verifyBranchRebasedOntoBase}).
      const { stdout } = await inWorktree(["diff", "--name-only", "--diff-filter=U"]);
      const files = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      await inWorktree(["rebase", "--abort"]).catch(() => {});
      return { kind: "conflict", files, baseSha };
    }
    const after = (await inWorktree(["rev-parse", "HEAD"])).stdout.trim();
    const moved = before !== after;
    if (moved) {
      // #241 data-loss guard: never force-push a branch with NO net diff vs base.
      // Such a push would establish a base-equivalent branch, silently discarding any
      // work the remote still carries (the wipe observed in #241, where a branch was
      // wrongly recreated from base then force-pushed). An empty branch has nothing to
      // merge anyway, so refusing is always safe — it converts a silent wipe into a
      // surfaced failure (the run terminalizes to agent-stuck, work intact on origin).
      if (!(await this.hasNetDiffVsBase(inWorktree, `origin/${baseBranch}`, "HEAD"))) {
        throw new Error(
          `refusing to force-push ${branch}: rebased onto origin/${baseBranch} leaves no net diff ` +
            `(would wipe the branch to base — #241). Resolve manually; work on origin is untouched.`,
        );
      }
      // Rewriting history on a rebase needs a force-push (the harness owns it).
      await this.pushRebasedBranch(worktreePath, branch);
    }
    return { kind: "clean", moved };
  }

  async branchDiffHash(worktreePath: string, baseBranch: string): Promise<string | null> {
    const inWorktree = (args: string[]): Promise<{ stdout: string; stderr: string }> =>
      execFileAsync("git", ["-C", resolve(worktreePath), ...args]);
    try {
      // Hash the branch's state on ORIGIN, not the harness-side worktree's local ref. Under the
      // container model the pushed branch is what review/merge sees: agent commits land on origin
      // only (#255), and a rebase-conflict resolution lands there too (the runner force-pushes it,
      // #273) — which leaves the local ref diverged from origin by rewritten history. Hashing the
      // stale local would compare the pre-rebase state and wrongly report "net diff unchanged",
      // skipping the #65 re-review a conflict resolution must get. The checked-out branch names
      // origin/<branch>; fetch both refs and hash the three-dot diff against current base.
      // `--binary` so binary blobs are diffed by content, not elided to a "Binary files differ"
      // line that could hide a change.
      const branch = (await inWorktree(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
      if (branch === "HEAD") return null; // detached (no branch checked out) → cannot name origin/<branch>
      await inWorktree(["fetch", "origin", baseBranch, branch]);
      const { stdout } = await inWorktree(["diff", "--binary", `origin/${baseBranch}...origin/${branch}`]);
      return createHash("sha256").update(stdout).digest("hex");
    } catch {
      // Diff unavailable (e.g. a ref could not be fetched) → null; the caller falls back to the
      // conservative re-review path rather than skipping it blind.
      return null;
    }
  }

  async verifyBranchRebasedOntoBase(
    worktreePath: string,
    branch: string,
    baseBranch: string,
    dispatchBaseSha: string,
  ): Promise<boolean> {
    const inWorktree = (args: string[]): Promise<{ stdout: string; stderr: string }> =>
      execFileAsync("git", ["-C", resolve(worktreePath), ...args]);
    try {
      // Read origin's CURRENT state for the branch — the resolution landed on origin (the
      // container force-pushed it), so the verdict comes from the remote-tracking ref, not this
      // (stale, pre-rebase) worktree's local ref. Fetch base too so `dispatchBaseSha` is present in
      // the object store even after a GC. A fetch failure → conservative false (the caller fails
      // loud rather than assuming the resolution landed).
      await inWorktree(["fetch", "origin", baseBranch, branch]);
      const remoteBranch = (await inWorktree(["rev-parse", `origin/${branch}`])).stdout.trim();
      if (!remoteBranch || !dispatchBaseSha) return false;

      // (1) The branch must contain the DISPATCH base as an ancestor — the base the fix was HANDED
      // and rebased onto, NOT origin's (possibly-advanced) current base. Checking current base races
      // a sibling PR that merged into base inside the fix window (#20): a resolution that landed
      // perfectly on its dispatch base would fail the check and misfire a "push landed nothing"
      // heal-card. The dispatch base is monotonic — a container that fetched an even newer base still
      // contains it — so a correct resolution always passes; the real #273 not-landed failures
      // (silent no-op push, still-forked-off-old-base) still fail, as origin/<branch> would not
      // contain the dispatch base.
      const baseIsAncestor = await inWorktree([
        "merge-base",
        "--is-ancestor",
        dispatchBaseSha,
        remoteBranch,
      ]).then(
        () => true,
        () => false,
      );
      if (!baseIsAncestor) return false;

      // (2) #241 ride-along: the branch must still carry net work over the dispatch base (a non-empty
      // three-dot diff). A base-equivalent wipe would pass (1) yet silently discard the reviewed work,
      // so the same no-net-diff invariant ({@link hasNetDiffVsBase}) is enforced here too, on the
      // dispatch base. Both are already-resolved SHAs, so the diff cannot fail for a missing ref — a
      // fetch/rev-parse failure was handled above; anything else falls through to the catch.
      return await this.hasNetDiffVsBase(inWorktree, dispatchBaseSha, remoteBranch);
    } catch {
      // Any git failure (fetch refused, ref gone) → conservative false; the caller surfaces it
      // rather than proceeding to a merge that cannot land (#273).
      return false;
    }
  }

  async adoptOriginBranch(worktreePath: string, branch: string): Promise<void> {
    const inWorktree = (args: string[]): Promise<{ stdout: string; stderr: string }> =>
      execFileAsync("git", ["-C", resolve(worktreePath), ...args]);
    // Fetch the runner-pushed resolution, then hard-reset the worktree's local branch to it. The
    // local ref held the pre-resolution history (which diverges from the rewritten origin), so this
    // adopts origin as authoritative — safe because verification already confirmed origin/<branch> is
    // the good resolved state (#20). The subsequent rebaseOntoBase then sees head == origin/<branch>
    // and its fast-forward-only sync is a no-op, so a base that advanced again can be re-rebased.
    await inWorktree(["fetch", "origin", branch]);
    await inWorktree(["reset", "--hard", `origin/${branch}`]);
  }

  /**
   * Force-push a branch whose history was rewritten by a rebase, with `--force-with-lease`. The
   * harness owns this push: the git-guardrails hook (DESIGN §8) blocks force-push on every agent
   * session, so a conflict-resolving fix agent finishes the rebase but the harness — running git
   * directly, outside a guarded session — lands the rewritten history. Private: its sole caller is
   * {@link rebaseOntoBase} on the clean-rebase path. The rebase-*conflict* path no longer
   * force-pushes from the daemon worktree — the container runner owns that push end-to-end (#273),
   * and {@link verifyBranchRebasedOntoBase} confirms it landed — so this is no longer an
   * inter-collaborator port on {@link WorktreeManager}, and the type system now enforces that the
   * daemon never force-pushes a rebase directly.
   */
  private async pushRebasedBranch(worktreePath: string, branch: string): Promise<void> {
    // The rebase rewrote history, so a plain push is rejected as non-fast-forward;
    // `--force-with-lease` refuses to clobber a concurrent push to the same branch.
    await execFileAsync("git", ["-C", resolve(worktreePath), "push", "--force-with-lease", "origin", branch]);
  }

  async remove(path: string): Promise<void> {
    await this.git(["worktree", "remove", resolve(path), "--force"]);
    // Drop any stale administrative entry left if the directory was moved.
    await this.git(["worktree", "prune"]);
  }

  async pruneOrphans(keep: ReadonlySet<string>): Promise<string[]> {
    // Remove worktrees on orphaned `ralph/*` branches first, so the branch is
    // free to delete (a checked-out branch refuses `branch -D`).
    for (const wt of await this.listRalphWorktrees()) {
      if (!keep.has(wt.branch)) {
        await this.resetWorktreePath(wt.path);
      }
    }
    // Then delete the orphaned local `ralph/*` branches themselves — the leftover
    // a fresh `worktree add` would collide with (issue #28).
    const pruned: string[] = [];
    for (const branch of await this.listRalphBranches()) {
      if (keep.has(branch)) {
        continue;
      }
      await this.git(["branch", "-D", branch]).catch(() => {});
      pruned.push(branch);
    }
    return pruned;
  }

  async list(): Promise<string[]> {
    // `git worktree list --porcelain` emits a `worktree <abs-path>` line per
    // worktree (the main clone first). Keep only those under our worktree root so
    // the GC never touches the clone or a worktree some other tool created.
    const { stdout } = await this.git(["worktree", "list", "--porcelain"]);
    const root = this.worktreeRoot;
    const paths: string[] = [];
    for (const line of stdout.split("\n")) {
      if (!line.startsWith("worktree ")) {
        continue;
      }
      const path = resolve(line.slice("worktree ".length).trim());
      if (path !== root && path.startsWith(root + "/")) {
        paths.push(path);
      }
    }
    return paths;
  }

  /** Registered worktrees checked out on a `ralph/*` branch, with their paths. */
  private async listRalphWorktrees(): Promise<Array<{ path: string; branch: string }>> {
    const { stdout } = await this.git(["worktree", "list", "--porcelain"]).catch(() => ({
      stdout: "",
      stderr: "",
    }));
    const out: Array<{ path: string; branch: string }> = [];
    // Porcelain output is blank-line-separated blocks of `worktree <path>` /
    // `HEAD <sha>` / `branch refs/heads/<name>` lines.
    for (const block of stdout.split(/\n\n+/)) {
      const lines = block.split("\n");
      const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
      const ref = lines.find((l) => l.startsWith("branch "))?.slice("branch ".length);
      const branch = ref?.replace(/^refs\/heads\//, "");
      if (path && branch && branch.startsWith("ralph/")) {
        out.push({ path, branch });
      }
    }
    return out;
  }

  /** Local branch names under `ralph/`. */
  private async listRalphBranches(): Promise<string[]> {
    const { stdout } = await this.git([
      "branch",
      "--list",
      "ralph/*",
      "--format=%(refname:short)",
    ]).catch(() => ({ stdout: "", stderr: "" }));
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }
}
