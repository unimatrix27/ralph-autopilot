/**
 * Daemon self-update detection (issue #30). The daemon cannot cleanly
 * `exec`-replace itself, so the concern is split (DESIGN §11, ADR-0018):
 *
 *  - the *daemon* detects that its own repo is behind, gracefully drains, and
 *    exits with {@link RESTART_EXIT_CODE};
 *  - the *supervisor* (ops/ralph-supervisor.sh) pulls + builds + relaunches,
 *    owning the build-gate and rollback.
 *
 * This module owns the detection half: `git fetch` the daemon's own clone and
 * compare local HEAD to `origin/<branch>`. All git-CLI knowledge for self-update
 * lives here, mirroring how worktree.ts owns the worktree git invocations.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Logger } from "../log/logger";

const execFileAsync = promisify(execFile);

/**
 * The shared quarantine record (operator ruling, ADR-0018). On a build-gate or
 * health-check failure the supervisor writes the failed remote sha here, relative
 * to the daemon's repo; the daemon's update checker reads it to suppress the drain
 * for a known-bad remote HEAD. Keep this path in sync with the supervisor's
 * `RALPH_QUARANTINE_FILE` default (`$REPO_DIR/.ralph/quarantine`).
 */
export const QUARANTINE_RELATIVE_PATH = join(".ralph", "quarantine");

/**
 * The exit code the daemon uses to ask its supervisor to pull + build + relaunch
 * (EX_TEMPFAIL, 75 — a distinctive "restart me", not a generic crash). The
 * supervisor script hardcodes the same value; keep them in sync.
 */
export const RESTART_EXIT_CODE = 75;

/** The result of one update check. */
export interface UpdateStatus {
  /** True iff `origin/<branch>` has commits the local HEAD does not. */
  behind: boolean;
  /** How many commits local HEAD is behind `origin/<branch>` (0 when up to date). */
  behindBy: number;
  /** Local HEAD commit sha. */
  localHead: string;
  /** `origin/<branch>` commit sha after the fetch. */
  remoteHead: string;
  /** The tracked branch, echoed back for logging. */
  branch: string;
  /**
   * Set to the quarantined sha when `origin/<branch>` points at a remote HEAD the
   * supervisor has marked as build/health-failing: `behind` is forced false so the
   * daemon does not re-drain for a commit known to fail (operator ruling). Undefined
   * when nothing is suppressed.
   */
  quarantinedHead?: string;
}

/** Detects whether the daemon's own repo is behind its tracked branch. */
export interface UpdateChecker {
  /** Fetch and report whether `origin/<branch>` is ahead of the local HEAD. */
  check(): Promise<UpdateStatus>;
}

export interface GitUpdateCheckerOptions {
  logger?: Logger;
  /**
   * Path to the shared quarantine record. Defaults to
   * `<repoDir>/.ralph/quarantine` — the supervisor's `RALPH_QUARANTINE_FILE`
   * default. Override only in tests.
   */
  quarantineFile?: string;
}

/**
 * `git`-backed {@link UpdateChecker}: fetches `origin/<branch>` in `repoDir` then
 * compares. "Behind" is `git rev-list --count HEAD..origin/<branch> > 0`, so a
 * local-only commit (ahead) does not count as behind — only commits the daemon is
 * missing trigger a restart.
 *
 * It also honours the shared quarantine record the supervisor writes on a
 * build/health failure (operator ruling, ADR-0018): if `origin/<branch>` equals the
 * quarantined sha, the commit is known to fail the build-gate, so `behind` is forced
 * false (no drain) — without this the daemon, running on last-good code, would
 * re-detect 'behind' and re-drain every cycle, thrashing the box forever. Once
 * origin advances past the quarantined sha (a fix was pushed) the stale record is
 * cleared and normal detection resumes.
 */
export class GitUpdateChecker implements UpdateChecker {
  private readonly quarantineFile: string;

  constructor(
    private readonly repoDir: string,
    private readonly branch: string,
    private readonly opts: GitUpdateCheckerOptions = {},
  ) {
    this.quarantineFile = opts.quarantineFile ?? join(repoDir, QUARANTINE_RELATIVE_PATH);
  }

  private async git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", ["-C", this.repoDir, ...args]);
    return stdout.trim();
  }

  /** The quarantined sha, or null if there is no (readable) quarantine record. */
  private readQuarantine(): string | null {
    if (!existsSync(this.quarantineFile)) {
      return null;
    }
    try {
      const sha = readFileSync(this.quarantineFile, "utf8").trim();
      return sha.length > 0 ? sha : null;
    } catch {
      return null; // unreadable record fails safe: behave as if not quarantined
    }
  }

  /** Delete a stale quarantine record (origin has advanced past it). */
  private clearQuarantine(): void {
    try {
      rmSync(this.quarantineFile, { force: true });
    } catch {
      // best-effort: a clear failure only means one extra drain attempt later.
    }
  }

  async check(): Promise<UpdateStatus> {
    await this.git("fetch", "origin", this.branch);
    const localHead = await this.git("rev-parse", "HEAD");
    const remoteHead = await this.git("rev-parse", `origin/${this.branch}`);
    let behindBy = Number.parseInt(
      (await this.git("rev-list", "--count", `HEAD..origin/${this.branch}`)) || "0",
      10,
    );

    // Quarantine gate: a remote HEAD the supervisor marked build/health-failing is
    // treated as not-behind so the daemon stops re-draining for it. Origin moving
    // off that sha means a fix landed → drop the stale record and adopt it.
    let quarantinedHead: string | undefined;
    const quarantined = this.readQuarantine();
    if (quarantined) {
      if (remoteHead === quarantined) {
        quarantinedHead = quarantined;
        behindBy = 0;
      } else {
        this.clearQuarantine();
      }
    }

    const status: UpdateStatus = {
      behind: behindBy > 0,
      behindBy,
      localHead,
      remoteHead,
      branch: this.branch,
      ...(quarantinedHead ? { quarantinedHead } : {}),
    };
    this.opts.logger?.debug("self-update.checked", { ...status });
    return status;
  }
}
