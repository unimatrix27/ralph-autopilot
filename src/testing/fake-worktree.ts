/**
 * In-memory {@link WorktreeManager} for tests that exercise orchestration rather
 * than real git. Records every create and remove so a test can assert a
 * worktree was cleaned up afterwards. (Real-git isolation/cleanup is covered by
 * `worktree.test.ts`.)
 */

import { posix } from "node:path";
import type { RebaseResult, WorktreeManager } from "../executor/worktree";

export class FakeWorktreeManager implements WorktreeManager {
  readonly created: Array<{ branch: string; dirName: string; path: string }> = [];
  readonly attached: Array<{ branch: string; dirName: string; path: string }> = [];
  readonly checkpointed: Array<{ worktreePath: string; branch: string }> = [];
  readonly removed: string[] = [];
  /** Audit trail of rebase calls, for assertions. */
  readonly rebased: Array<{ worktreePath: string; branch: string; baseBranch: string }> = [];
  /** Audit trail of {@link verifyBranchRebasedOntoBase} calls, for assertions. */
  readonly rebaseVerifyCalls: Array<{
    worktreePath: string;
    branch: string;
    baseBranch: string;
    /** The dispatch-time base SHA the resolution is verified against (#20). */
    dispatchBaseSha: string;
  }> = [];
  /** Audit trail of {@link adoptOriginBranch} calls, for assertions. */
  readonly adopted: Array<{ worktreePath: string; branch: string }> = [];
  /** Audit trail of {@link branchDiffHash} calls, for assertions. */
  readonly branchDiffHashCalls: Array<{ worktreePath: string; baseBranch: string }> = [];
  /** Local `ralph/*` branches the clone would report; pruned against the keep-set. */
  existingBranches: string[] = [];
  /** The keep-set passed to each {@link pruneOrphans} call, for assertions. */
  readonly pruneCalls: Array<ReadonlySet<string>> = [];
  /** Branch names pruned across all {@link pruneOrphans} calls, for assertions. */
  readonly prunedBranches: string[] = [];
  /** Scripted rebase results, consumed in order; the default is a clean no-op rebase. */
  private readonly rebaseResults: RebaseResult[] = [];
  /** Scripted {@link verifyBranchRebasedOntoBase} results, consumed in order; default `true`. */
  private readonly rebaseVerifyResults: boolean[] = [];
  /** Scripted {@link branchDiffHash} results, consumed in order; default `null` (unavailable). */
  private readonly branchDiffHashes: Array<string | null> = [];
  private readonly root: string;

  constructor(root = "/fake-wt") {
    this.root = root;
  }

  /** Queue rebase results returned (in order) by {@link rebaseOntoBase}. */
  scriptRebase(...results: RebaseResult[]): void {
    this.rebaseResults.push(...results);
  }

  /**
   * Queue verdicts returned (in order) by {@link verifyBranchRebasedOntoBase}. `true` (the
   * default when the queue empties) models a rebase-conflict resolution that landed on origin;
   * `false` models one that did not (the daemon must fail loud, #273).
   */
  scriptRebaseVerify(...landed: boolean[]): void {
    this.rebaseVerifyResults.push(...landed);
  }

  /**
   * Queue net-diff hashes returned (in order) by {@link branchDiffHash}. The
   * integration flow captures one before the rebase and one after, so a pair of
   * equal hashes models a pure fast-forward replay and a differing pair models a
   * semantics-changing rebase. `null` models the diff being unavailable. The
   * default (queue empty) is `null` — conservative re-review (issue #65).
   */
  scriptBranchDiffHash(...hashes: Array<string | null>): void {
    this.branchDiffHashes.push(...hashes);
  }

  async create(branch: string, dirName: string): Promise<string> {
    const path = posix.join(this.root, dirName);
    this.created.push({ branch, dirName, path });
    return path;
  }

  async attach(branch: string, dirName: string): Promise<string> {
    const path = posix.join(this.root, dirName);
    this.attached.push({ branch, dirName, path });
    return path;
  }

  async checkpointWip(worktreePath: string, branch: string): Promise<void> {
    this.checkpointed.push({ worktreePath, branch });
  }

  async rebaseOntoBase(
    worktreePath: string,
    branch: string,
    baseBranch: string,
  ): Promise<RebaseResult> {
    this.rebased.push({ worktreePath, branch, baseBranch });
    return this.rebaseResults.shift() ?? { kind: "clean", moved: false };
  }

  async verifyBranchRebasedOntoBase(
    worktreePath: string,
    branch: string,
    baseBranch: string,
    dispatchBaseSha: string,
  ): Promise<boolean> {
    this.rebaseVerifyCalls.push({ worktreePath, branch, baseBranch, dispatchBaseSha });
    return this.rebaseVerifyResults.length > 0 ? this.rebaseVerifyResults.shift()! : true;
  }

  async adoptOriginBranch(worktreePath: string, branch: string): Promise<void> {
    this.adopted.push({ worktreePath, branch });
  }

  async branchDiffHash(worktreePath: string, baseBranch: string): Promise<string | null> {
    this.branchDiffHashCalls.push({ worktreePath, baseBranch });
    return this.branchDiffHashes.length > 0 ? this.branchDiffHashes.shift()! : null;
  }

  async remove(path: string): Promise<void> {
    this.removed.push(path);
  }

  async pruneOrphans(keep: ReadonlySet<string>): Promise<string[]> {
    this.pruneCalls.push(keep);
    const pruned = this.existingBranches.filter((b) => !keep.has(b));
    this.existingBranches = this.existingBranches.filter((b) => keep.has(b));
    this.prunedBranches.push(...pruned);
    return pruned;
  }

  /**
   * Every worktree still "on disk": created or attached, minus those removed.
   * Models `git worktree list` for the orphan-worktree GC (issue #27). A path
   * created/attached more times than removed is still present.
   */
  async list(): Promise<string[]> {
    const live = new Map<string, number>();
    for (const { path } of [...this.created, ...this.attached]) {
      live.set(path, (live.get(path) ?? 0) + 1);
    }
    for (const path of this.removed) {
      const n = live.get(path);
      if (n !== undefined) {
        if (n <= 1) {
          live.delete(path);
        } else {
          live.set(path, n - 1);
        }
      }
    }
    return [...live.keys()];
  }
}
