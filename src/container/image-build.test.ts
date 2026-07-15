import { describe, expect, it, vi } from "vitest";
import {
  buildImageBuildArgs,
  computeDepsCacheKey,
  createTargetImageResolver,
  ensureTargetImage,
  resolveImageBuildInput,
  targetImageRef,
  type EnsuredImage,
  type ManifestSources,
  type TargetImageBuildInput,
} from "./image-build";
import type { AgentContract } from "./agent-contract";
import { buildDockerRunArgs } from "./docker-runner";
import type { ContainerDispatch } from "./assignment";

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
