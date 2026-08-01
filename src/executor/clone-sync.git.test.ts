/**
 * Real-git acceptance of the target-clone refresh (issue #50). The unit suite in
 * `clone-sync.test.ts` proves the decision and the coalescing over a fake git; this file proves
 * the **argv actually work against git** — the regression it exists to prevent was precisely a
 * "the real thing did not do what we assumed" bug, so the production edge is exercised end to end
 * against a throwaway origin: a clone left 2 commits behind is fast-forwarded, and the freshly
 * checked-out file content is what a content-keyed image resolve would then read.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { TargetCloneSynchronizer, cloneGitCli } from "./clone-sync";
import { createTargetImageResolver, fsManifestSources } from "../container/image-build";
import type { AgentContract } from "../container/agent-contract";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

const DOCKERFILE = ".ralph/agent.Dockerfile";

describe("TargetCloneSynchronizer against real git (issue #50)", () => {
  let origin: string;
  let clone: string;

  /** Land a commit on origin's master, exactly as a merged PR would. */
  function landOnOrigin(dockerfile: string): void {
    writeFileSync(join(origin, DOCKERFILE), dockerfile);
    git(origin, "add", "-A");
    git(origin, "commit", "-m", "bump agent base");
  }

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), "ralph-clone-sync-git-"));
    origin = join(base, "origin");
    clone = join(base, "clone");
    execFileSync("git", ["init", "-b", "master", origin]);
    git(origin, "config", "user.email", "test@example.com");
    git(origin, "config", "user.name", "Test");
    mkdirSync(join(origin, ".ralph"), { recursive: true });
    writeFileSync(join(origin, DOCKERFILE), "FROM ralph/agent-base:0.0.6\n");
    writeFileSync(join(origin, "package-lock.json"), '{"v":1}\n');
    git(origin, "add", "-A");
    git(origin, "commit", "-m", "initial");
    execFileSync("git", ["clone", origin, clone]);
    git(clone, "config", "user.email", "test@example.com");
    git(clone, "config", "user.name", "Test");
  });

  function synchronizer(): TargetCloneSynchronizer {
    return new TargetCloneSynchronizer({
      cloneDir: clone,
      baseBranch: "master",
      git: cloneGitCli(clone),
    });
  }

  it("fast-forwards a clone left behind origin, and the checkout really carries the new content", async () => {
    landOnOrigin("FROM ralph/agent-base:0.0.7\n");
    landOnOrigin("FROM ralph/agent-base:0.0.8\n");
    // the clone is untouched and still on the initial commit — exactly the observed regression
    expect(readFileSync(join(clone, DOCKERFILE), "utf8")).toBe("FROM ralph/agent-base:0.0.6\n");

    const result = await synchronizer().sync();

    expect(result.kind).toBe("fast-forward");
    expect(result.head).toBe(git(origin, "rev-parse", "HEAD").trim());
    expect(readFileSync(join(clone, DOCKERFILE), "utf8")).toBe("FROM ralph/agent-base:0.0.8\n");
  });

  it("reports `current` (and issues no merge) on an already-current clone", async () => {
    const result = await synchronizer().sync();
    expect(result).toEqual({
      kind: "current",
      head: git(clone, "rev-parse", "HEAD").trim(),
      previousHead: git(clone, "rev-parse", "HEAD").trim(),
    });
  });

  it("refuses a dirty clone and leaves the local edit exactly as it found it", async () => {
    landOnOrigin("FROM ralph/agent-base:0.0.7\n");
    writeFileSync(join(clone, "package-lock.json"), '{"v":"hand-edited"}\n');

    await expect(synchronizer().sync()).rejects.toMatchObject({ reason: "target-clone-dirty" });

    expect(readFileSync(join(clone, "package-lock.json"), "utf8")).toBe('{"v":"hand-edited"}\n');
    expect(readFileSync(join(clone, DOCKERFILE), "utf8")).toBe("FROM ralph/agent-base:0.0.6\n");
  });

  it("refuses a diverged clone rather than rewinding its local commit", async () => {
    landOnOrigin("FROM ralph/agent-base:0.0.7\n");
    writeFileSync(join(clone, "local.txt"), "local work\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-m", "local-only");
    const localHead = git(clone, "rev-parse", "HEAD").trim();

    await expect(synchronizer().sync()).rejects.toMatchObject({ reason: "target-clone-diverged" });

    expect(git(clone, "rev-parse", "HEAD").trim()).toBe(localHead);
  });

  it("refuses a detached HEAD", async () => {
    git(clone, "checkout", "--detach", "HEAD");
    await expect(synchronizer().sync()).rejects.toMatchObject({ reason: "target-clone-off-base" });
  });

  it("re-keys the real image resolver off the refreshed clone, with no operator intervention", async () => {
    const contract: AgentContract = {
      build: "npm run build",
      test: "npm test",
      restore: "npm ci",
      depManifests: ["package-lock.json"],
      baseBranch: "master",
    };
    const built: string[] = [];
    const sync = synchronizer();
    const resolve = createTargetImageResolver({
      targetRepo: "acme/pancake",
      contextDir: clone,
      loadContract: () => contract,
      sources: fsManifestSources(clone),
      withSyncedClone: (read) => sync.withSyncedClone(read),
      builder: { imageExists: async () => false, dockerBuild: async (args) => void built.push(args.join(" ")) },
    });

    const before = await resolve();

    // A base-pin bump merges into the target while the daemon keeps running. Nobody touches the
    // clone; the very next dispatch must key on — and build — the NEW toolchain.
    landOnOrigin("FROM ralph/agent-base:0.0.7\n");
    const after = await resolve();

    expect(after).not.toBe(before);
    expect(readFileSync(join(clone, DOCKERFILE), "utf8")).toBe("FROM ralph/agent-base:0.0.7\n");
    // and the build really pointed at the target's own (still exactly pinned) Dockerfile
    expect(built[built.length - 1]).toContain(join(clone, DOCKERFILE));
    // the daemon made no commit of its own: the clone is exactly origin
    expect(git(clone, "rev-parse", "HEAD").trim()).toBe(git(origin, "rev-parse", "HEAD").trim());
    expect(git(clone, "status", "--porcelain").trim()).toBe("");
  });
});
