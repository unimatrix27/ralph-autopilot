/**
 * Keeping a target's **base checkout** current before anything reads content out of it
 * (issue #50).
 *
 * `worktree.ts` owns the per-issue worktrees forked off the clone; this module owns the clone
 * *root itself* — the long-lived checkout `paths.targetClone` points at, which is also the
 * `docker build` context the content-keyed agent image is resolved from (`image-build.ts`).
 *
 * The two are not the same tree, and that is exactly what broke: every worktree forks
 * `origin/<base>` after a fetch, so issue worktrees are always current, while the clone's own
 * checked-out branch is never advanced by anything and drifts arbitrarily far behind. The image
 * resolver reads `.ralph/agent.Dockerfile` + `.ralph/agent.yaml` from that drifting tree, so a
 * merged base-pin bump stayed invisible: new dispatches kept keying on — and running — the old
 * image long after origin carried the new one, and the stale in-container parser then rejected
 * output the new host prompt emitted.
 *
 * The fix is narrow on purpose. The daemon does **not** own the target repo's content, so the
 * only write it may make to this clone is a **fast-forward of the base branch onto the ref it
 * just fetched** — the one operation that cannot destroy anything. Everything else is refused
 * and surfaced:
 *
 *  - **dirty** — someone (or something) edited the clone; a fast-forward could silently absorb
 *    or clobber it, and its content is already not what the repo says. Refuse.
 *  - **off base** — a detached HEAD or another branch: fast-forwarding it would not even be the
 *    base checkout the resolver means to read. Refuse.
 *  - **diverged** — local commits that are not on origin (or a rewritten base). There is no
 *    fast-forward, and the daemon must never rewind or force. Refuse.
 *
 * These are host-scoped conditions with no issue behind them, so they are surfaced through the
 * anomaly log/journal ({@link TargetCloneSyncDeps.onAnomaly}) rather than the issue-scoped
 * `daemon-anomaly` classifier (`daemon/completeness.ts`), and each one names the operator action
 * it needs — the same contract `daemon/anomaly-action.ts` holds itself to. The dispatch that
 * asked for the sync fails loud rather than falling back to reading the stale tree (ADR-0008's
 * no-silent-fallback discipline): a wrong image is worse than no image.
 *
 * Serialization is structural, not advisory. One {@link TargetCloneGate} per clone is shared by
 * the synchronizer *and* the worktree manager's fetch/`worktree add` preparation, so the base
 * fast-forward can never interleave with another dispatch's worktree creation or with a second
 * dispatch's own read, and {@link TargetCloneSynchronizer.withSyncedClone} holds the clone for
 * the whole read+build that follows the sync. Concurrent dispatches therefore coalesce onto one
 * refresh instead of racing the same working tree.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Why the daemon refused to refresh a target clone. Each is a *precise* condition with its own
 * operator action — "the clone is broken" would tell an operator nothing they could act on.
 */
export type CloneSyncAnomaly =
  | "target-clone-dirty"
  | "target-clone-off-base"
  | "target-clone-diverged"
  | "target-clone-ff-refused";

/**
 * Every {@link CloneSyncAnomaly}, in declaration order — the vocabulary the tests iterate so
 * {@link cloneSyncOperatorAction}'s totality is proven over data, not merely over the type.
 */
export const CLONE_SYNC_ANOMALIES: readonly CloneSyncAnomaly[] = [
  "target-clone-dirty",
  "target-clone-off-base",
  "target-clone-diverged",
  "target-clone-ff-refused",
];

/**
 * The **entire** git surface the clone refresh is permitted to use: four read-only inspections,
 * the fetch, and the fast-forward merge. The allowlist is enforced at the port
 * ({@link assertCloneSafeGit}), not merely asserted in a test, so "no autonomous target-repo
 * edits" is a property of the code rather than a convention someone can drift off.
 */
export const CLONE_SYNC_GIT_COMMANDS: readonly string[] = [
  "fetch",
  "symbolic-ref",
  "status",
  "rev-parse",
  "merge-base",
  "merge",
];

/**
 * Reject any git invocation outside {@link CLONE_SYNC_GIT_COMMANDS}, and any `merge` that is not
 * `--ff-only`. A programming error here would be a daemon writing to a repo it does not own, so
 * it fails closed and loudly rather than being caught by review.
 */
export function assertCloneSafeGit(args: readonly string[]): void {
  const command = args[0] ?? "";
  if (!CLONE_SYNC_GIT_COMMANDS.includes(command)) {
    throw new Error(
      `git \`${command}\` is not permitted on a target clone: the daemon only fetches and ` +
        `fast-forwards it (permitted: ${CLONE_SYNC_GIT_COMMANDS.join(", ")})`,
    );
  }
  if (command === "merge" && !args.includes("--ff-only")) {
    throw new Error("a target-clone merge must be --ff-only: the daemon never rewrites target history");
  }
}

/** The observed state of a target clone's base checkout, read after the fetch. */
export interface CloneBaseState {
  /** The checked-out branch, or `null` when HEAD is detached. */
  branch: string | null;
  /** Whether any *tracked* path carries uncommitted changes. */
  dirty: boolean;
  /** The commit HEAD sits at. */
  localSha: string;
  /** The commit `origin/<baseBranch>` points at, as of the fetch. */
  remoteSha: string;
  /** Whether {@link localSha} is an ancestor of {@link remoteSha} (a fast-forward exists). */
  fastForwardable: boolean;
}

/** What to do about a {@link CloneBaseState} — the pure decision, exhaustively unit-tested. */
export type CloneSyncPlan =
  | { kind: "current" }
  | { kind: "fast-forward" }
  | { kind: "anomaly"; reason: CloneSyncAnomaly };

/**
 * Decide how to bring a clone's base checkout onto `origin/<baseBranch>`. Pure and total.
 *
 * The refusals are checked first and in danger order: a dirty tree is refused even when it is
 * already current, because "the clone has edits" means the content the resolver would read is
 * not the content the repo declares — which is the failure mode this whole module exists to
 * prevent, not merely a risk to the merge. `target-clone-ff-refused` is not reachable from here;
 * it is git's own refusal at the edge (see {@link TargetCloneSynchronizer}).
 */
export function planCloneSync(state: CloneBaseState, baseBranch: string): CloneSyncPlan {
  if (state.dirty) {
    return { kind: "anomaly", reason: "target-clone-dirty" };
  }
  if (state.branch !== baseBranch) {
    return { kind: "anomaly", reason: "target-clone-off-base" };
  }
  if (state.localSha === state.remoteSha) {
    return { kind: "current" };
  }
  if (state.fastForwardable) {
    return { kind: "fast-forward" };
  }
  return { kind: "anomaly", reason: "target-clone-diverged" };
}

/** Where the anomaly happened — folded into the operator action so the text is actionable as-is. */
export interface CloneSyncContext {
  cloneDir: string;
  baseBranch: string;
}

/**
 * The concrete operator action for one clone anomaly. **Total** by construction (the `switch` is
 * exhaustive with a `never` guard), imperative, and concrete: it names the very clone and branch
 * to go and look at, mirroring `daemon/anomaly-action.ts`'s contract for the issue-scoped
 * anomalies. An operator reading this at 3am should be able to paste it.
 */
export function cloneSyncOperatorAction(reason: CloneSyncAnomaly, ctx: CloneSyncContext): string {
  const { cloneDir, baseBranch } = ctx;
  switch (reason) {
    case "target-clone-dirty":
      return (
        `The target clone at ${cloneDir} has uncommitted changes to tracked files, so the daemon ` +
        `refuses to touch it (and refuses to build an agent image from it). Inspect them with ` +
        `\`git -C ${cloneDir} status\`; the daemon never edits this clone, so they are someone ` +
        `else's. Commit them elsewhere or \`git -C ${cloneDir} checkout -- .\`, then the next ` +
        `dispatch refreshes it by itself.`
      );
    case "target-clone-off-base":
      return (
        `The target clone at ${cloneDir} is not on ${baseBranch} (detached HEAD, or parked on ` +
        `another branch), so there is no base checkout to refresh. Put it back with ` +
        `\`git -C ${cloneDir} checkout ${baseBranch}\` — this clone exists only to host worktrees ` +
        `and to be the agent image's build context, so nothing should be checked out here.`
      );
    case "target-clone-diverged":
      return (
        `The target clone at ${cloneDir} has commits that are not on origin/${baseBranch}, so no ` +
        `fast-forward exists and the daemon will not rewind or force it. Check ` +
        `\`git -C ${cloneDir} log --oneline origin/${baseBranch}..${baseBranch}\`; once the local ` +
        `commits are preserved (or confirmed junk), reset the clone onto origin with ` +
        `\`git -C ${cloneDir} reset --hard origin/${baseBranch}\`.`
      );
    case "target-clone-ff-refused":
      return (
        `git refused the fast-forward of ${baseBranch} in ${cloneDir} — usually an untracked file ` +
        `that the incoming commits would overwrite. Run \`git -C ${cloneDir} merge --ff-only ` +
        `origin/${baseBranch}\` to see git's own message, clear whatever is in the way, and the ` +
        `next dispatch refreshes it by itself.`
      );
    default: {
      // Totality guard: a new CloneSyncAnomaly without an action fails to compile here.
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/** The anomaly as it reaches the daemon's log/journal — reason, evidence, and what to do. */
export interface CloneSyncAnomalyReport extends CloneSyncContext {
  reason: CloneSyncAnomaly;
  /** Observed evidence (branch/shas, or git's own refusal message). */
  detail: string;
  /** {@link cloneSyncOperatorAction} for this reason, precomputed so every sink shows the same text. */
  action: string;
}

/**
 * Thrown when a target clone cannot be refreshed. Carries the machine-readable reason so callers
 * can distinguish "the clone needs a human" from an ordinary git failure, and the operator action
 * so the message alone is sufficient wherever it surfaces.
 */
export class TargetCloneAnomalyError extends Error {
  readonly reason: CloneSyncAnomaly;
  readonly cloneDir: string;
  readonly baseBranch: string;
  readonly detail: string;
  readonly action: string;

  constructor(report: CloneSyncAnomalyReport) {
    super(`${report.reason}: ${report.detail} — ${report.action}`);
    this.name = "TargetCloneAnomalyError";
    this.reason = report.reason;
    this.cloneDir = report.cloneDir;
    this.baseBranch = report.baseBranch;
    this.detail = report.detail;
    this.action = report.action;
  }
}

/** The outcome of a successful refresh. */
export interface CloneSyncResult {
  /** `current` — nothing to do; `fast-forward` — the base checkout was advanced onto origin. */
  kind: "current" | "fast-forward";
  /** The commit the base checkout sits at afterwards. */
  head: string;
  /** The commit it sat at before. Equal to {@link head} for `current`. */
  previousHead: string;
}

/**
 * A serializing gate over ONE clone. Every operation that touches the clone root — the base
 * refresh, `git worktree add`, the image resolver's read+build — runs through it, so no two can
 * interleave on the same working tree, index, or refs. Plain FIFO over a promise chain: a
 * rejecting critical section releases the gate exactly like a resolving one, so one failure
 * cannot wedge the target.
 */
export class TargetCloneGate {
  private tail: Promise<unknown> = Promise.resolve();

  /** Run `work` once every previously-queued critical section has finished. */
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    // Swallow on the chain only — the caller still sees the rejection through `result`.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** The `git -C <cloneDir> …` edge: resolves stdout, rejects on a non-zero exit. */
export type CloneGit = (args: string[]) => Promise<string>;

/** The real edge — thin process glue, mirroring `worktree.ts`'s own git invocations. */
export function cloneGitCli(cloneDir: string): CloneGit {
  return async (args) => (await execFileAsync("git", ["-C", cloneDir, ...args])).stdout;
}

export interface TargetCloneSyncDeps {
  /** The clone root: the worktree source AND the agent image's `docker build` context. */
  cloneDir: string;
  /** The configured base branch this clone tracks (`master`/`main`). */
  baseBranch: string;
  /** The git edge; defaults to {@link cloneGitCli} over {@link cloneDir}. Injected in tests. */
  git?: CloneGit;
  /**
   * The gate this clone is serialized on. Pass the SAME instance to the worktree manager so the
   * refresh coalesces with worktree preparation instead of racing it; omitted → a private gate
   * (still correct for a lone synchronizer, just not shared).
   */
  gate?: TargetCloneGate;
  /** Observe each successful refresh (the daemon's structured log). */
  onSynced?: (result: CloneSyncResult) => void;
  /** Surface a refusal to the anomaly log/journal. Called once per refusal, before the throw. */
  onAnomaly?: (report: CloneSyncAnomalyReport) => void;
}

/**
 * The clone refresh, wired to a real (or faked) git. Every public method takes the gate, so a
 * caller cannot forget to serialize; the private `*Unlocked` bodies are the parts that assume it
 * is already held (and must therefore never be called from outside a critical section).
 */
export class TargetCloneSynchronizer {
  readonly gate: TargetCloneGate;
  private readonly port: CloneGit;

  constructor(private readonly deps: TargetCloneSyncDeps) {
    this.gate = deps.gate ?? new TargetCloneGate();
    this.port = deps.git ?? cloneGitCli(deps.cloneDir);
  }

  /** Fetch `origin/<base>` — the clone's ONE fetch path, shared with worktree preparation. */
  fetchBase(): Promise<void> {
    return this.gate.run(() => this.fetchBaseUnlocked());
  }

  /**
   * Bring the base checkout onto `origin/<base>`, fast-forward-only. Resolves with what happened;
   * throws {@link TargetCloneAnomalyError} (having surfaced it through `onAnomaly` first) when the
   * clone is dirty, off base, diverged, or git refuses the fast-forward.
   */
  sync(): Promise<CloneSyncResult> {
    return this.gate.run(() => this.syncUnlocked());
  }

  /**
   * Refresh the clone and then run `read` **while still holding it** — the contract the image
   * resolver needs. Reading the Dockerfile, globbing the manifests, and streaming the build
   * context are separate filesystem passes; a fast-forward landing between any two of them would
   * key an image on a tree that never existed. One critical section makes that unrepresentable.
   */
  withSyncedClone<T>(read: () => Promise<T>): Promise<T> {
    return this.gate.run(async () => {
      await this.syncUnlocked();
      return read();
    });
  }

  private git(args: string[]): Promise<string> {
    assertCloneSafeGit(args);
    return this.port(args);
  }

  private async fetchBaseUnlocked(): Promise<void> {
    await this.git(["fetch", "origin", this.deps.baseBranch]);
  }

  private async syncUnlocked(): Promise<CloneSyncResult> {
    await this.fetchBaseUnlocked();
    const state = await this.readState();
    const plan = planCloneSync(state, this.deps.baseBranch);
    if (plan.kind === "anomaly") {
      throw this.anomaly(plan.reason, describeState(state, this.deps.baseBranch));
    }
    if (plan.kind === "current") {
      return this.synced({ kind: "current", head: state.localSha, previousHead: state.localSha });
    }
    try {
      await this.git(["merge", "--ff-only", this.remoteRef()]);
    } catch (err) {
      throw this.anomaly("target-clone-ff-refused", err instanceof Error ? err.message : String(err));
    }
    return this.synced({ kind: "fast-forward", head: state.remoteSha, previousHead: state.localSha });
  }

  private remoteRef(): string {
    return `refs/remotes/origin/${this.deps.baseBranch}`;
  }

  private async readState(): Promise<CloneBaseState> {
    const branch = await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"])
      .then((out) => out.trim() || null)
      // A detached HEAD makes `symbolic-ref` exit non-zero; that IS the answer, not a failure.
      .catch(() => null);
    // `--untracked-files=no`: untracked cruft is not an edit to the repo's content, and git's own
    // `--ff-only` still refuses (loudly, as `target-clone-ff-refused`) if any of it is in the way.
    const dirty = (await this.git(["status", "--porcelain", "--untracked-files=no"])).trim().length > 0;
    const localSha = (await this.git(["rev-parse", "HEAD"])).trim();
    const remoteSha = (await this.git(["rev-parse", this.remoteRef()])).trim();
    const fastForwardable = localSha === remoteSha ? true : await this.isAncestor(localSha, remoteSha);
    return { branch, dirty, localSha, remoteSha, fastForwardable };
  }

  private isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return this.git(["merge-base", "--is-ancestor", ancestor, descendant]).then(
      () => true,
      () => false,
    );
  }

  private synced(result: CloneSyncResult): CloneSyncResult {
    this.deps.onSynced?.(result);
    return result;
  }

  private anomaly(reason: CloneSyncAnomaly, detail: string): TargetCloneAnomalyError {
    const ctx = { cloneDir: this.deps.cloneDir, baseBranch: this.deps.baseBranch };
    const report: CloneSyncAnomalyReport = {
      ...ctx,
      reason,
      detail,
      action: cloneSyncOperatorAction(reason, ctx),
    };
    this.deps.onAnomaly?.(report);
    return new TargetCloneAnomalyError(report);
  }
}

/** The evidence line carried on a refusal: enough to diagnose without opening a shell. */
function describeState(state: CloneBaseState, baseBranch: string): string {
  return (
    `branch=${state.branch ?? "(detached)"} expected=${baseBranch} ` +
    `head=${state.localSha} origin=${state.remoteSha} dirty=${state.dirty}`
  );
}
