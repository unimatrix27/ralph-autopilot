import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitUpdateChecker, RESTART_EXIT_CODE } from "./self-update";

// Deterministic, config-independent git: pass identity via env so the test does
// not depend on the operator's global git config.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Ralph Test",
  GIT_AUTHOR_EMAIL: "ralph@example.com",
  GIT_COMMITTER_NAME: "Ralph Test",
  GIT_COMMITTER_EMAIL: "ralph@example.com",
} as NodeJS.ProcessEnv;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV }).trim();
}

function commit(cwd: string, file: string, contents: string, message: string): void {
  writeFileSync(join(cwd, file), contents);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", message);
}

describe("RESTART_EXIT_CODE", () => {
  it("is a dedicated, non-zero code the supervisor keys on", () => {
    // 75 (EX_TEMPFAIL) — a distinctive code that means 'restart me for update',
    // not a generic crash. The supervisor (ops/ralph-supervisor.sh) hardcodes 75.
    expect(RESTART_EXIT_CODE).toBe(75);
  });
});

describe("GitUpdateChecker", () => {
  let base: string;
  let originDir: string;
  let localDir: string;
  let upstreamDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "ralph-selfupdate-"));
    originDir = join(base, "origin.git");
    localDir = join(base, "local");
    upstreamDir = join(base, "upstream");

    // A bare 'origin' both clones share, a 'local' the daemon runs from, and an
    // 'upstream' clone standing in for operator/auto-merge pushes.
    execFileSync("git", ["init", "--bare", "-b", "main", originDir], { env: GIT_ENV });
    execFileSync("git", ["clone", originDir, upstreamDir], { env: GIT_ENV });
    commit(upstreamDir, "README.md", "v1\n", "initial");
    git(upstreamDir, "push", "origin", "main");
    execFileSync("git", ["clone", originDir, localDir], { env: GIT_ENV });
  });

  afterEach(() => {
    execFileSync("rm", ["-rf", base]);
  });

  it("reports not-behind when local HEAD equals origin/<branch> (AC1)", async () => {
    const checker = new GitUpdateChecker(localDir, "main");
    const status = await checker.check();
    expect(status.behind).toBe(false);
    expect(status.behindBy).toBe(0);
    expect(status.localHead).toBe(status.remoteHead);
    expect(status.branch).toBe("main");
  });

  it("detects origin/<branch> ahead of local HEAD after a fetch (AC1)", async () => {
    commit(upstreamDir, "README.md", "v2\n", "second");
    commit(upstreamDir, "README.md", "v3\n", "third");
    git(upstreamDir, "push", "origin", "main");

    const checker = new GitUpdateChecker(localDir, "main");
    const status = await checker.check();
    expect(status.behind).toBe(true);
    expect(status.behindBy).toBe(2);
    expect(status.localHead).not.toBe(status.remoteHead);
  });

  it("is not fooled by local-only commits (ahead but not behind)", async () => {
    // Local has an unpushed commit; origin has not moved → not behind.
    commit(localDir, "local-only.txt", "wip\n", "local wip");
    const checker = new GitUpdateChecker(localDir, "main");
    const status = await checker.check();
    expect(status.behind).toBe(false);
    expect(status.behindBy).toBe(0);
  });

  // Quarantine (operator ruling): a build/health failure traps the daemon in an
  // endless drain→rebuild→rollback thrash because the daemon (on last-good code)
  // keeps seeing origin ahead and re-draining. The supervisor records the failed
  // remote sha to `.ralph/quarantine`; the checker treats a remote HEAD equal to
  // that sha as NOT behind (no drain), and clears the record once origin advances.
  describe("quarantine", () => {
    let quarantineFile: string;
    beforeEach(() => {
      quarantineFile = join(localDir, ".ralph", "quarantine");
      mkdirSync(join(localDir, ".ralph"), { recursive: true });
    });

    function pushNewRemoteHead(contents: string, message: string): string {
      commit(upstreamDir, "README.md", contents, message);
      git(upstreamDir, "push", "origin", "main");
      return git(upstreamDir, "rev-parse", "HEAD");
    }

    it("treats a remote HEAD equal to the quarantined sha as not-behind (no drain)", async () => {
      const badSha = pushNewRemoteHead("broken\n", "a commit that fails the build-gate");
      writeFileSync(quarantineFile, `${badSha}\n`);

      const checker = new GitUpdateChecker(localDir, "main");
      const status = await checker.check();

      // origin IS ahead by a commit, but it is the quarantined one → suppress the
      // drain so a single bad commit cannot wedge the box.
      expect(status.behind).toBe(false);
      expect(status.quarantinedHead).toBe(badSha);
      expect(status.remoteHead).toBe(badSha);
      expect(existsSync(quarantineFile)).toBe(true); // kept while origin still points at it
    });

    it("clears the quarantine and adopts the fix once origin advances past it", async () => {
      const badSha = pushNewRemoteHead("broken\n", "broken commit");
      writeFileSync(quarantineFile, `${badSha}\n`);
      const fixedSha = pushNewRemoteHead("fixed\n", "the fix that supersedes it");

      const checker = new GitUpdateChecker(localDir, "main");
      const status = await checker.check();

      // origin moved past the quarantined sha → record is stale; clear it and drain.
      expect(status.behind).toBe(true);
      expect(status.remoteHead).toBe(fixedSha);
      expect(status.quarantinedHead).toBeUndefined();
      expect(existsSync(quarantineFile)).toBe(false); // cleared
    });

    it("ignores an absent quarantine file (normal behind detection)", async () => {
      const newSha = pushNewRemoteHead("v2\n", "ordinary update, nothing quarantined");
      const checker = new GitUpdateChecker(localDir, "main");
      const status = await checker.check();
      expect(status.behind).toBe(true);
      expect(status.remoteHead).toBe(newSha);
      expect(status.quarantinedHead).toBeUndefined();
    });
  });
});
