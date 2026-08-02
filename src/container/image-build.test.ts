import { describe, expect, it, vi } from "vitest";
import {
  buildImageBuildArgs,
  computeDepsCacheKey,
  createTargetImageResolver,
  ensureTargetImage,
  resolveImageBuildInput,
  targetImageRef,
  type EnsuredImage,
  type ImageBuilderDeps,
  type ManifestSources,
  type TargetImageBuildInput,
} from "./image-build";
import type { AgentContract } from "./agent-contract";
import { buildDockerRunArgs } from "./docker-runner";
import type { ContainerDispatch } from "./assignment";
import { TargetCloneAnomalyError, TargetCloneSynchronizer } from "../executor/clone-sync";
import { FakeTargetClone } from "../testing/fake-clone";

const contract: AgentContract = {
  build: "dotnet build",
  test: "dotnet test",
  restore: "dotnet restore",
  depManifests: ["Directory.Packages.props", "**/*.csproj"],
  baseBranch: "master",
};

function input(overrides: Partial<TargetImageBuildInput> = {}): TargetImageBuildInput {
  return {
    targetRepo: "acme/example-monorepo",
    contract,
    dockerfile: ".ralph/agent.Dockerfile",
    contextDir: "/clone",
    dockerfileContents: "FROM ralph/agent-base:1.0.0\nRUN install-dotnet\n",
    manifestContents: ["<Project>pkgs</Project>", "<Project>api</Project>"],
    ...overrides,
  };
}

describe("L2 deps cache key (ADR-0038 / issue #190)", () => {
  it("is deterministic for identical inputs", () => {
    expect(computeDepsCacheKey(input())).toBe(computeDepsCacheKey(input()));
  });

  it("changes when a declared depManifest's contents change (the L2 rebuild trigger)", () => {
    const before = computeDepsCacheKey(input());
    const after = computeDepsCacheKey(
      input({ manifestContents: ["<Project>pkgs</Project>", "<Project>api+new-pkg</Project>"] }),
    );
    expect(after).not.toBe(before);
  });

  it("changes when the toolchain (Dockerfile, incl. its FROM base) changes", () => {
    const before = computeDepsCacheKey(input());
    const after = computeDepsCacheKey(
      input({ dockerfileContents: "FROM ralph/agent-base:2.0.0\nRUN install-dotnet\n" }),
    );
    expect(after).not.toBe(before);
  });

  it("does not collide when the same content moves between manifests (order/identity matters)", () => {
    const a = computeDepsCacheKey(input({ manifestContents: ["aa", "bb"] }));
    const b = computeDepsCacheKey(input({ manifestContents: ["bb", "aa"] }));
    expect(a).not.toBe(b);
  });
});

describe("targetImageRef", () => {
  it("namespaces the image by the target slug and tags it with the cache key", () => {
    const ref = targetImageRef("acme/example-monorepo", "abc123");
    expect(ref).toBe("ralph/agent/acme-example-monorepo:abc123");
  });
});

describe("buildImageBuildArgs", () => {
  it("builds a `docker build` argv from the .ralph/agent.Dockerfile against the clone context", () => {
    const tag = targetImageRef(contract.baseBranch, "key"); // shape only
    const args = buildImageBuildArgs(input(), "ralph/agent/x:key");
    expect(args[0]).toBe("build");
    expect(args).toContain("--tag");
    expect(args).toContain("ralph/agent/x:key");
    expect(args).toContain("--file");
    expect(args).toContain("/clone/.ralph/agent.Dockerfile");
    // the build context (target clone) is the final positional
    expect(args[args.length - 1]).toBe("/clone");
    void tag;
  });

  it("anchors --file to the build context, never the daemon's cwd (the wrong-Dockerfile regression)", () => {
    // docker resolves a relative --file against the CLI's cwd (the daemon checkout), which
    // built every target with the daemon's OWN .ralph/agent.Dockerfile. The argv must carry
    // the context-anchored path so the built toolchain is the target's.
    const args = buildImageBuildArgs(input({ contextDir: "/srv/clones/example-monorepo" }), "ralph/agent/x:key");
    const fileFlag = args.indexOf("--file");
    expect(args[fileFlag + 1]).toBe("/srv/clones/example-monorepo/.ralph/agent.Dockerfile");
  });
});

describe("ensureTargetImage", () => {
  it("builds the per-target image when it is not already present", async () => {
    const dockerBuild = vi.fn(async () => {});
    const result = await ensureTargetImage(input(), {
      imageExists: async () => false,
      dockerBuild,
    });
    expect(result.built).toBe(true);
    expect(dockerBuild).toHaveBeenCalledOnce();
    // it builds the very tag it reports (and that tag carries the cache key)
    expect(dockerBuild.mock.calls[0]![0]).toContain(result.imageTag);
    expect(result.imageTag).toContain(result.depsCacheKey);
  });

  it("skips the build when the keyed image already exists (L2 cache hit)", async () => {
    const dockerBuild = vi.fn(async () => {});
    const result = await ensureTargetImage(input(), {
      imageExists: async () => true,
      dockerBuild,
    });
    expect(result.built).toBe(false);
    expect(dockerBuild).not.toHaveBeenCalled();
  });

  it("rebuilds after a depManifest change because its new contents key a new, absent image", async () => {
    // The cache is keyed on manifest contents: the "before" image exists, the "after" one does not.
    const before = ensureTargetImage(input(), { imageExists: async () => true, dockerBuild: async () => {} });
    const after = ensureTargetImage(
      input({ manifestContents: ["<Project>pkgs</Project>", "<Project>api+changed</Project>"] }),
      // the changed-content tag has never been built, so it is absent → rebuild
      { imageExists: async () => false, dockerBuild: async () => {} },
    );
    const [b, a] = await Promise.all([before, after]);
    expect(b.imageTag).not.toBe(a.imageTag);
    expect(b.built).toBe(false);
    expect(a.built).toBe(true);
  });
});

describe("resolveImageBuildInput", () => {
  function sources(files: Record<string, string>): ManifestSources {
    return {
      glob: (pattern) => {
        if (pattern.includes("*")) {
          const prefix = pattern.slice(0, pattern.indexOf("*"));
          const suffix = pattern.slice(pattern.lastIndexOf("*") + 1);
          return Object.keys(files).filter((p) => p.startsWith(prefix) && p.endsWith(suffix));
        }
        return files[pattern] !== undefined ? [pattern] : [];
      },
      readFile: (p) => files[p] ?? "",
    };
  }

  it("reads the Dockerfile + resolves each declared depManifest's contents in declared order", () => {
    const built = resolveImageBuildInput(
      { targetRepo: "a/b", contract, dockerfile: ".ralph/agent.Dockerfile", contextDir: "/clone" },
      sources({
        ".ralph/agent.Dockerfile": "FROM ralph/agent-base:1\n",
        "Directory.Packages.props": "<props/>",
        "src/Api.csproj": "<api/>",
        "src/Web.csproj": "<web/>",
      }),
    );
    expect(built.targetRepo).toBe("a/b");
    expect(built.dockerfileContents).toBe("FROM ralph/agent-base:1\n");
    // one combined entry per DECLARED manifest glob, aligned with contract.depManifests
    expect(built.manifestContents).toHaveLength(contract.depManifests.length);
    expect(built.manifestContents[0]).toContain("<props/>");
    // the "**/*.csproj" glob folds every matched file's contents
    expect(built.manifestContents[1]).toContain("<api/>");
    expect(built.manifestContents[1]).toContain("<web/>");
  });

  it("produces a stable key regardless of glob match order (matches are sorted)", () => {
    const a = resolveImageBuildInput(
      { targetRepo: "a/b", contract, dockerfile: "D", contextDir: "/c" },
      {
        glob: (p) => (p.includes("*") ? ["src/Z.csproj", "src/A.csproj"] : [p]),
        readFile: (f) => f,
      },
    );
    const b = resolveImageBuildInput(
      { targetRepo: "a/b", contract, dockerfile: "D", contextDir: "/c" },
      {
        glob: (p) => (p.includes("*") ? ["src/A.csproj", "src/Z.csproj"] : [p]),
        readFile: (f) => f,
      },
    );
    expect(computeDepsCacheKey(a)).toBe(computeDepsCacheKey(b));
  });
});

describe("createTargetImageResolver — per-dispatch ensure→run-tag wiring (issue #190 completion)", () => {
  const fileSources = (files: Record<string, string>): ManifestSources => ({
    glob: (pattern) => {
      if (pattern.includes("*")) {
        const prefix = pattern.slice(0, pattern.indexOf("*"));
        const suffix = pattern.slice(pattern.lastIndexOf("*") + 1);
        return Object.keys(files).filter((p) => p.startsWith(prefix) && p.endsWith(suffix));
      }
      return files[pattern] !== undefined ? [pattern] : [];
    },
    readFile: (p) => files[p] ?? "",
  });
  const files: Record<string, string> = {
    ".ralph/agent.Dockerfile": "FROM ralph/agent-base:1\n",
    "Directory.Packages.props": "<props/>",
    "src/Api.csproj": "<api/>",
  };

  it("builds on a cache miss and returns the very tag it built (run-tag == build-tag)", async () => {
    const dockerBuild = vi.fn(async () => {});
    const ensured: EnsuredImage[] = [];
    const resolve = createTargetImageResolver({
      targetRepo: "acme/example-monorepo",
      contextDir: "/clone",
      loadContract: () => contract,
      sources: fileSources(files),
      builder: { imageExists: async () => false, dockerBuild },
      onEnsured: (e) => ensured.push(e),
    });

    const tag = await resolve();

    expect(dockerBuild).toHaveBeenCalledOnce();
    // the resolver returns exactly the tag passed to `docker build` — the divergence is closed
    expect(dockerBuild.mock.calls[0]![0]).toContain(tag);
    expect(tag).toMatch(/^ralph\/agent\/acme-example-monorepo:/);
    expect(ensured).toEqual([{ imageTag: tag, depsCacheKey: expect.any(String), built: true }]);
  });

  it("skips the build on a cache hit and still returns the run tag", async () => {
    const dockerBuild = vi.fn(async () => {});
    const resolve = createTargetImageResolver({
      targetRepo: "a/b",
      contextDir: "/clone",
      loadContract: () => contract,
      sources: fileSources(files),
      builder: { imageExists: async () => true, dockerBuild },
    });

    const tag = await resolve();

    expect(dockerBuild).not.toHaveBeenCalled();
    expect(tag).toMatch(/^ralph\/agent\/a-b:/);
  });

  it("re-reads the contract/manifests each call, so a changed manifest re-keys the image (rebuild)", async () => {
    let propsContent = "<props/>";
    const resolve = createTargetImageResolver({
      targetRepo: "a/b",
      contextDir: "/clone",
      loadContract: () => contract,
      sources: {
        // "**/*.csproj" → none here; "Directory.Packages.props" → its (mutating) content.
        glob: (pattern) => (pattern.includes("*") ? [] : [pattern]),
        readFile: (p) => (p === "Directory.Packages.props" ? propsContent : "FROM ralph/agent-base:1\n"),
      },
      builder: { imageExists: async () => false, dockerBuild: async () => {} },
    });

    const first = await resolve();
    propsContent = "<props>bumped</props>";
    const second = await resolve();

    expect(second).not.toBe(first); // a manifest change keys a new, absent tag → a rebuild
  });
});

describe("createTargetImageResolver over a stale target clone (issue #50)", () => {
  const BASE = "master";
  const cloneContract: AgentContract = {
    build: "npm run build",
    test: "npm test",
    restore: "npm ci",
    depManifests: ["package-lock.json"],
    baseBranch: BASE,
  };
  const treeAt = (baseTag: string, lock: string): Record<string, string> => ({
    ".ralph/agent.Dockerfile": `FROM ralph/agent-base:${baseTag}\nRUN install-node\n`,
    "package-lock.json": lock,
  });

  /** A clone checked out 282 commits behind origin, exactly like the observed regression. */
  function staleClone(): FakeTargetClone {
    return new FakeTargetClone({
      baseBranch: BASE,
      history: [
        { sha: "old", files: treeAt("0.0.6", "{\"v\":1}") },
        { sha: "bumped", files: treeAt("0.0.7", "{\"v\":1}") },
      ],
      checkedOutAt: "old",
      fetchedAt: "old",
    });
  }

  function resolverFor(
    fake: FakeTargetClone,
    builder: ImageBuilderDeps,
    sync: TargetCloneSynchronizer,
  ): () => Promise<string> {
    return createTargetImageResolver({
      targetRepo: "acme/pancake",
      contextDir: "/srv/clone",
      loadContract: () => cloneContract,
      sources: fake.sources(),
      builder,
      withSyncedClone: (read) => sync.withSyncedClone(read),
    });
  }

  const alwaysBuild: ImageBuilderDeps = { imageExists: async () => false, dockerBuild: async () => {} };

  function syncFor(fake: FakeTargetClone): TargetCloneSynchronizer {
    return new TargetCloneSynchronizer({ cloneDir: "/srv/clone", baseBranch: BASE, git: fake.git });
  }

  it("a remote base-pin bump re-keys the image with no operator touching the clone (AC4)", async () => {
    const fake = staleClone();
    const staleKey = computeDepsCacheKey({
      targetRepo: "acme/pancake",
      contract: cloneContract,
      dockerfile: ".ralph/agent.Dockerfile",
      contextDir: "/srv/clone",
      dockerfileContents: fake.filesAt("old")[".ralph/agent.Dockerfile"]!,
      manifestContents: [`package-lock.json\0${fake.filesAt("old")["package-lock.json"]!}`],
    });
    const bumpedKey = computeDepsCacheKey({
      targetRepo: "acme/pancake",
      contract: cloneContract,
      dockerfile: ".ralph/agent.Dockerfile",
      contextDir: "/srv/clone",
      dockerfileContents: fake.filesAt("bumped")[".ralph/agent.Dockerfile"]!,
      manifestContents: [`package-lock.json\0${fake.filesAt("bumped")["package-lock.json"]!}`],
    });
    expect(staleKey).not.toBe(bumpedKey);

    const tag = await resolverFor(fake, alwaysBuild, syncFor(fake))();

    // the resolver refreshed the clone itself: the key it selected is the REMOTE contract's
    expect(tag).toBe(targetImageRef("acme/pancake", bumpedKey));
    expect(tag).not.toContain(staleKey);
    expect(fake.head).toBe("bumped");
  });

  it("restart and steady-state dispatch converge on the same current contract (AC5)", async () => {
    // Restart path: a cold process syncs the clone at startup, then dispatches.
    const restart = staleClone();
    const restartSync = syncFor(restart);
    await restartSync.sync();
    const restartTag = await resolverFor(restart, alwaysBuild, restartSync)();

    // Steady-state path: a long-lived daemon whose clone went stale under it dispatches.
    const steady = staleClone();
    const steadyResolve = resolverFor(steady, alwaysBuild, syncFor(steady));
    const first = await steadyResolve();
    steady.pushToOrigin({ sha: "bumped-again", files: treeAt("0.0.7", "{\"v\":2}") });
    const second = await steadyResolve();

    expect(restartTag).toBe(first);
    expect(second).not.toBe(first); // and it keeps converging as origin moves
    expect(steady.head).toBe("bumped-again");
  });

  it("refuses to build from a dirty clone — no stale image, no silent fallback (AC2)", async () => {
    const fake = new FakeTargetClone({
      baseBranch: BASE,
      history: [
        { sha: "old", files: treeAt("0.0.6", "{}") },
        { sha: "bumped", files: treeAt("0.0.7", "{}") },
      ],
      checkedOutAt: "old",
      fetchedAt: "old",
      dirtyPaths: [".ralph/agent.Dockerfile"],
    });
    const dockerBuild = vi.fn(async () => {});
    const resolve = resolverFor(fake, { imageExists: async () => false, dockerBuild }, syncFor(fake));

    await expect(resolve()).rejects.toBeInstanceOf(TargetCloneAnomalyError);
    expect(dockerBuild).not.toHaveBeenCalled();
    expect(fake.head).toBe("old");
  });

  it("keeps the base pin in the key — the refresh never floats the base tag (AC6)", async () => {
    const fake = staleClone();
    const dockerBuild = vi.fn(async () => {});
    await resolverFor(fake, { imageExists: async () => false, dockerBuild }, syncFor(fake))();

    // The Dockerfile the build reads is still the target's own, still pinned to an exact version:
    // the refresh moved the checkout, it did not rewrite the contract.
    expect(fake.filesAt(fake.head)[".ralph/agent.Dockerfile"]).toBe("FROM ralph/agent-base:0.0.7\nRUN install-node\n");
    // and no git command mutated the target repo
    for (const forbidden of ["push", "commit", "add", "tag"]) {
      expect(fake.calls.some((c) => c[0] === forbidden)).toBe(false);
    }
    expect(dockerBuild).toHaveBeenCalledOnce();
  });

  it("resolves the contract BEFORE any read, so two dispatches never read a torn tree (AC1/AC3)", async () => {
    const fake = staleClone();
    const sync = syncFor(fake);
    const readHeads: string[] = [];
    const builder: ImageBuilderDeps = {
      imageExists: async () => {
        // origin moves mid-resolve; the in-flight resolve must still see the tree it keyed on
        fake.pushToOrigin({ sha: "later", files: treeAt("0.0.8", "{}") });
        readHeads.push(fake.head);
        return false;
      },
      dockerBuild: async () => {
        readHeads.push(fake.head);
      },
    };
    const resolve = resolverFor(fake, builder, sync);

    const [a, b] = await Promise.all([resolve(), resolve()]);

    expect(readHeads).toEqual(["bumped", "bumped", "later", "later"]);
    expect(a).not.toBe(b); // the second dispatch legitimately picks up the newer contract
  });
});

describe("ContainerExecution runs against the per-target built image (AC4)", () => {
  it("feeds the built image tag into the docker run argv", async () => {
    const { imageTag } = await ensureTargetImage(input(), {
      imageExists: async () => false,
      dockerBuild: async () => {},
    });
    const dispatch: ContainerDispatch = {
      assignment: { issueNumber: 190, mode: "tdd", branch: "ralph/190-x", base: "master", prompt: "p" },
      token: { value: "t" },
    };
    const runArgs = buildDockerRunArgs({ image: imageTag, credentials: {} }, dispatch, "ralph-190");
    // the per-target built image is the image the run actually launches
    expect(runArgs[runArgs.length - 1]).toBe(imageTag);
  });
});
