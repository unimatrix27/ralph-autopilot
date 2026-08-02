/**
 * An in-memory stand-in for a target's long-lived git clone (issue #50), backing the tests of
 * {@link import("../executor/clone-sync").TargetCloneSynchronizer} and of the content-keyed image
 * resolver that reads out of it.
 *
 * It models the two things the real bug turned on and nothing else: a **checked-out tree** that
 * can sit arbitrarily far behind `origin/<base>`, and a **remote-tracking ref** that only moves
 * when someone fetches. `sources()` reads the *checked-out* tree, so a test can prove that a
 * remote-only Dockerfile bump is invisible until the clone is actually fast-forwarded — the exact
 * staleness that kept dispatching the old content key.
 *
 * Only the git surface `clone-sync.ts` is allowed to use is implemented; anything else throws, so
 * a test that accidentally grows a mutating git call fails loudly rather than silently passing.
 */

import type { ManifestSources } from "../container/image-build";

/** One commit in the fake's linear base-branch history: a sha plus the whole tree at that sha. */
export interface FakeCommit {
  sha: string;
  files: Record<string, string>;
}

export interface FakeTargetCloneOptions {
  /** The base branch the clone tracks (`master`/`main`). */
  baseBranch?: string;
  /** Linear history of `origin/<baseBranch>`, oldest first. At least one commit. */
  history: FakeCommit[];
  /** Which commit the working tree is checked out at. Defaults to the newest. */
  checkedOutAt?: string;
  /**
   * Which commit `refs/remotes/origin/<base>` points at *before any fetch* — the stale
   * remote-tracking ref a cold daemon starts with. Defaults to {@link checkedOutAt}.
   */
  fetchedAt?: string;
  /** The checked-out branch, or `null` for a detached HEAD. Defaults to {@link baseBranch}. */
  branch?: string | null;
  /** Tracked paths reported as locally modified by `git status --porcelain`. */
  dirtyPaths?: string[];
  /** A commit reachable only locally (a diverged clone): its tree, keyed by sha. */
  localOnly?: FakeCommit;
}

/** A fake `git -C <clone>` port plus the manifest reads that see whatever it left checked out. */
export class FakeTargetClone {
  readonly baseBranch: string;
  /** Every git argv this clone was asked to run, in order — the audit trail assertions read. */
  readonly calls: string[][] = [];
  /** Set when a test wants to observe/interleave around a git call (concurrency assertions). */
  beforeGit: ((args: string[]) => Promise<void>) | null = null;

  private readonly history: FakeCommit[];
  private readonly trees = new Map<string, Record<string, string>>();
  private readonly branch: string | null;
  private readonly dirtyPaths: string[];
  /** The commit `origin/<base>` actually points at — what a fetch would bring in. */
  private originSha: string;
  /** The commit the local remote-tracking ref knows about (moves only on fetch). */
  private fetchedSha: string;
  /** The commit the working tree is checked out at — what {@link sources} reads. */
  private headSha: string;

  constructor(options: FakeTargetCloneOptions) {
    const newest = options.history[options.history.length - 1];
    if (!newest) {
      throw new Error("FakeTargetClone needs at least one commit of history");
    }
    this.baseBranch = options.baseBranch ?? "master";
    this.history = [...options.history];
    for (const commit of this.history) {
      this.trees.set(commit.sha, commit.files);
    }
    if (options.localOnly) {
      this.trees.set(options.localOnly.sha, options.localOnly.files);
    }
    this.originSha = newest.sha;
    this.headSha = options.checkedOutAt ?? newest.sha;
    this.fetchedSha = options.fetchedAt ?? this.headSha;
    this.branch = options.branch === undefined ? this.baseBranch : options.branch;
    this.dirtyPaths = options.dirtyPaths ?? [];
  }

  /** The commit the working tree currently sits at — the tree every content read sees. */
  get head(): string {
    return this.headSha;
  }

  /** The commit `origin/<base>` points at (moves only when a test advances it). */
  get origin(): string {
    return this.originSha;
  }

  /** Land a new commit on origin, exactly as a merged PR would — the clone stays untouched. */
  pushToOrigin(commit: FakeCommit): void {
    this.history.push(commit);
    this.trees.set(commit.sha, commit.files);
    this.originSha = commit.sha;
  }

  /** The file contents at a given commit (the fixture's own view; not a git call). */
  filesAt(sha: string): Record<string, string> {
    const tree = this.trees.get(sha);
    if (!tree) {
      throw new Error(`FakeTargetClone: unknown commit ${sha}`);
    }
    return tree;
  }

  /** The `git -C <clone> …` port `clone-sync.ts` drives. Rejects anything outside its surface. */
  readonly git = async (args: string[]): Promise<string> => {
    this.calls.push([...args]);
    if (this.beforeGit) {
      await this.beforeGit(args);
    }
    return this.dispatch(args);
  };

  /**
   * Manifest reads rooted at the **checked-out** tree — so a remote-only change is invisible
   * until a fast-forward moves HEAD, which is the whole point of the fixture.
   */
  sources(): ManifestSources {
    const globOne = (pattern: string, paths: string[]): string[] => {
      if (!pattern.includes("*")) {
        return paths.includes(pattern) ? [pattern] : [];
      }
      const prefix = pattern.slice(0, pattern.indexOf("*"));
      const suffix = pattern.slice(pattern.lastIndexOf("*") + 1);
      return paths.filter((p) => p.startsWith(prefix) && p.endsWith(suffix));
    };
    return {
      glob: (pattern) => globOne(pattern, Object.keys(this.filesAt(this.headSha))),
      readFile: (relPath) => this.filesAt(this.headSha)[relPath] ?? "",
    };
  }

  private dispatch(args: string[]): string {
    const [command, ...rest] = args;
    switch (command) {
      case "fetch":
        this.fetchedSha = this.originSha;
        return "";
      case "symbolic-ref":
        if (this.branch === null) {
          throw new Error("fatal: ref HEAD is not a symbolic ref");
        }
        return `${this.branch}\n`;
      case "status":
        return this.dirtyPaths.map((p) => ` M ${p}`).join("\n");
      case "rev-parse":
        return `${this.resolveRef(rest[rest.length - 1] ?? "HEAD")}\n`;
      case "merge-base": {
        const [ancestor, descendant] = [rest[rest.length - 2] ?? "", rest[rest.length - 1] ?? ""];
        if (!this.isAncestor(ancestor, descendant)) {
          throw new Error("exit status 1");
        }
        return "";
      }
      case "merge": {
        const target = this.resolveRef(rest[rest.length - 1] ?? "");
        if (!this.isAncestor(this.headSha, target)) {
          throw new Error("fatal: Not possible to fast-forward, aborting.");
        }
        this.headSha = target;
        return "";
      }
      default:
        throw new Error(`FakeTargetClone: unsupported git command \`git ${args.join(" ")}\``);
    }
  }

  private resolveRef(ref: string): string {
    if (ref === "HEAD") {
      return this.headSha;
    }
    if (ref === `refs/remotes/origin/${this.baseBranch}` || ref === `origin/${this.baseBranch}`) {
      return this.fetchedSha;
    }
    if (this.trees.has(ref)) {
      return ref;
    }
    throw new Error(`fatal: ambiguous argument '${ref}': unknown revision`);
  }

  /** Ancestry over the linear origin history; a local-only commit is on no line at all. */
  private isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) {
      return true;
    }
    const a = this.history.findIndex((c) => c.sha === ancestor);
    const d = this.history.findIndex((c) => c.sha === descendant);
    return a >= 0 && d >= 0 && a <= d;
  }
}
