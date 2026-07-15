/**
 * Per-target agent image build + the **L2 deps-layer cache** (ADR-0038, issue #190). Each target
 * carries a `.ralph/agent.Dockerfile` (`FROM ralph/agent-base` + its L1 toolchain); the daemon
 * builds it into a per-target image whose **deps layer is cached and keyed on the declared
 * `depManifests`** (the {@link AgentContract}). Generalizes the minimal image of slice #185 into
 * real per-target images.
 *
 * Two layers, mirroring `docker-runner.ts`: a **pure core** ({@link computeDepsCacheKey},
 * {@link targetImageRef}, {@link buildImageBuildArgs}) that is exhaustively unit-tested, and a
 * thin orchestration ({@link ensureTargetImage}) over injected docker ports so **no real image
 * builds in the unit suite** — the real build's acceptance test is the onboarding smoke-test
 * (epic #182), not here.
 *
 * The cache discipline is the **content key**: the image tag carries a hash over the toolchain
 * (the Dockerfile, including its `FROM` base ref) and the *contents* of every declared
 * `depManifest`. A change to any manifest → a new key → a tag that has never been built → a cache
 * miss → a rebuild of the deps layer. An unchanged manifest set → the same tag already present →
 * the build is skipped (the L2 cache hit). So "cached, rebuilds on manifest change" falls out of
 * the deterministic key, with no mutable cache state to manage.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { globSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { AgentContract } from "./agent-contract";

const execFileAsync = promisify(execFile);

/** `owner/repo` → `owner-repo`, a registry-safe namespace segment for the per-target image. */
function slugToImageSegment(slug: string): string {
  return slug.replace(/\//g, "-");
}

/** Everything needed to plan + build one target's agent image. */
export interface TargetImageBuildInput {
  /** `owner/repo` slug; namespaces the per-target image repository. */
  targetRepo: string;
  /** The validated onboarding contract — its `depManifests` key the L2 cache. */
  contract: AgentContract;
  /** Path to the target's `.ralph/agent.Dockerfile`, relative to {@link contextDir}. */
  dockerfile: string;
  /** The `docker build` context directory (the target clone root). */
  contextDir: string;
  /**
   * The Dockerfile's contents — the L1 toolchain *and* its `FROM ralph/agent-base:<ver>` base ref.
   * Part of the cache key, so a toolchain or base-image bump rebuilds.
   */
  dockerfileContents: string;
  /**
   * The resolved contents of each declared `depManifest`, in the contract's declared order. The
   * L2 cache key hashes these, so a change to any manifest invalidates the cached deps layer.
   */
  manifestContents: string[];
}

/**
 * The L2 deps-layer cache key: a short hex digest over the toolchain (Dockerfile) and the
 * declared manifests' *path + content* pairs, in declared order. Pure + deterministic — identical
 * inputs always yield the same key; any content change yields a different one. Path is folded in
 * alongside content so the same bytes under a different manifest do not collide.
 */
export function computeDepsCacheKey(input: TargetImageBuildInput): string {
  const hash = createHash("sha256");
  // Key-schema version. v2 abandons every tag built before the `--file` fix in
  // buildImageBuildArgs: those images were built from the DAEMON's own Dockerfile (docker
  // resolves a relative `--file` against the CLI's cwd, not the context), so their contents
  // do not match the hashed Dockerfile and must never cache-hit again.
  hash.update("key-version:2\0");
  hash.update("dockerfile\0");
  hash.update(input.dockerfileContents);
  input.contract.depManifests.forEach((manifest, i) => {
    hash.update(`\0manifest\0${manifest}\0`);
    // Pair the declared manifest glob with its resolved contents; a missing entry is "" so the
    // key still moves when a manifest appears/disappears.
    hash.update(input.manifestContents[i] ?? "");
  });
  return hash.digest("hex").slice(0, 16);
}

/** The per-target image ref: `ralph/agent/<owner-repo>:<cacheKey>`. */
export function targetImageRef(targetRepo: string, cacheKey: string): string {
  return `ralph/agent/${slugToImageSegment(targetRepo)}:${cacheKey}`;
}

/**
 * Build the full `docker build …` argv (sans the `docker` argv0) for one target image. Pure: the
 * same input + tag always yields the same args, so the invocation contract is fully unit-testable.
 * Builds the target's `.ralph/agent.Dockerfile` against the clone context, tagged with the
 * content-keyed ref (the final positional is the build context).
 *
 * `--file` is resolved against {@link TargetImageBuildInput.contextDir}: docker resolves a
 * relative `--file` against the CLI's cwd (the daemon checkout), NOT the build context — left
 * relative, every target silently built the daemon's own `.ralph/agent.Dockerfile` (no target
 * toolchain baked; the example-monorepo image shipped without dotnet).
 */
export function buildImageBuildArgs(input: TargetImageBuildInput, tag: string): string[] {
  return ["build", "--tag", tag, "--file", resolve(input.contextDir, input.dockerfile), input.contextDir];
}

/** The filesystem ports {@link resolveImageBuildInput} reads through; injected so it stays testable. */
export interface ManifestSources {
  /** Resolve one `depManifest` glob (relative to the clone) → matched relative paths. */
  glob(pattern: string): string[];
  /** Read a file's UTF-8 contents (path as returned by {@link glob}, or the Dockerfile). */
  readFile(relPath: string): string;
}

/** What {@link resolveImageBuildInput} needs beyond the filesystem ports. */
export interface ImageBuildArgs {
  /** `owner/repo` slug; namespaces the per-target image. */
  targetRepo: string;
  /** The validated onboarding contract. */
  contract: AgentContract;
  /** Path to `.ralph/agent.Dockerfile`, relative to {@link contextDir}. */
  dockerfile: string;
  /** The `docker build` context directory (the target clone root). */
  contextDir: string;
}

/**
 * Resolve a {@link TargetImageBuildInput} by reading the Dockerfile and the declared manifests
 * from the clone. Each declared `depManifest` glob folds **all** its matched files'
 * `path + content`, **sorted by path** so the resulting key is independent of the order the glob
 * returns matches in. Pure over the injected {@link ManifestSources} — no direct fs — so it is
 * unit-testable; the composition root supplies real glob/read.
 */
export function resolveImageBuildInput(args: ImageBuildArgs, sources: ManifestSources): TargetImageBuildInput {
  const manifestContents = args.contract.depManifests.map((pattern) => {
    const matches = [...sources.glob(pattern)].sort();
    return matches.map((path) => `${path}\0${sources.readFile(path)}`).join("\n");
  });
  return {
    targetRepo: args.targetRepo,
    contract: args.contract,
    dockerfile: args.dockerfile,
    contextDir: args.contextDir,
    dockerfileContents: sources.readFile(args.dockerfile),
    manifestContents,
  };
}

/** The docker ports {@link ensureTargetImage} drives; faked in tests, shelled to `docker` in prod. */
export interface ImageBuilderDeps {
  /** Is an image with this exact (content-keyed) tag already present? `docker image inspect`. */
  imageExists(tag: string): Promise<boolean>;
  /** Build the image. `docker build …` with the argv from {@link buildImageBuildArgs}. */
  dockerBuild(args: string[]): Promise<void>;
}

/** The outcome of {@link ensureTargetImage}: the image to run + whether a build actually ran. */
export interface EnsuredImage {
  /** The content-keyed per-target image ref — feed this into `DockerRunnerConfig.image`. */
  imageTag: string;
  /** The L2 deps cache key the tag carries. */
  depsCacheKey: string;
  /** `true` if the image was (re)built this call; `false` on an L2 cache hit. */
  built: boolean;
}

/**
 * Ensure the per-target image exists, building it only on a cache miss. The image is keyed on the
 * toolchain + declared manifest contents ({@link computeDepsCacheKey}); if that exact tag is
 * already present the build is skipped (L2 cache hit), otherwise it is built. A changed manifest
 * keys a different, absent tag, so the deps layer rebuilds — the AC3 behaviour, end to end.
 */
export async function ensureTargetImage(
  input: TargetImageBuildInput,
  deps: ImageBuilderDeps,
): Promise<EnsuredImage> {
  const depsCacheKey = computeDepsCacheKey(input);
  const imageTag = targetImageRef(input.targetRepo, depsCacheKey);

  if (await deps.imageExists(imageTag)) {
    return { imageTag, depsCacheKey, built: false };
  }

  await deps.dockerBuild(buildImageBuildArgs(input, imageTag));
  return { imageTag, depsCacheKey, built: true };
}

/** The default path, relative to the target clone, of a target's container Dockerfile. */
export const DEFAULT_AGENT_DOCKERFILE = ".ralph/agent.Dockerfile";

/** Ports + identity {@link createTargetImageResolver} composes — all injected so it is unit-testable. */
export interface TargetImageResolverDeps {
  /** `owner/repo` slug; namespaces the per-target image. */
  targetRepo: string;
  /** The `docker build` context directory (the target clone root). */
  contextDir: string;
  /** Path to `.ralph/agent.Dockerfile`, relative to {@link contextDir}. Defaults to {@link DEFAULT_AGENT_DOCKERFILE}. */
  dockerfile?: string;
  /** Load + validate the target's `.ralph/agent.yaml` (re-read per resolve so a contract edit is picked up). */
  loadContract: () => AgentContract;
  /** Read the Dockerfile + manifests from the clone (real fs in prod; faked in tests). */
  sources: ManifestSources;
  /** Build / inspect images (real docker in prod; faked in tests). */
  builder: ImageBuilderDeps;
  /** Observe each ensure (for the daemon's log) — the resolved tag + whether a build actually ran. */
  onEnsured?: (ensured: EnsuredImage) => void;
}

/**
 * Build the **per-dispatch image resolver** the {@link import("./docker-runner").DockerCliRunner}
 * calls before each `docker run` (issue #190 completion, wiring {@link ensureTargetImage} into the
 * dispatch path). Per call: load the contract, resolve the build input from the clone, ensure the
 * content-keyed image (build only on an L2 cache miss), and return its tag — so the tag the daemon
 * runs is exactly the tag it built (the run/build-tag divergence is closed by construction). A
 * changed `depManifest` keys a new, absent tag → the deps layer rebuilds on the next dispatch.
 *
 * Pure over its injected ports (no direct fs/docker), so the wiring is unit-testable; the
 * composition root supplies the real fs/docker edges. Concurrency note: two near-simultaneous
 * dispatches that both miss the cache may both build the same tag — idempotent (same content-keyed
 * tag), just redundant; no lock is taken in this slice.
 */
export function createTargetImageResolver(deps: TargetImageResolverDeps): () => Promise<string> {
  const dockerfile = deps.dockerfile ?? DEFAULT_AGENT_DOCKERFILE;
  return async () => {
    const contract = deps.loadContract();
    const input = resolveImageBuildInput(
      { targetRepo: deps.targetRepo, contract, dockerfile, contextDir: deps.contextDir },
      deps.sources,
    );
    const ensured = await ensureTargetImage(input, deps.builder);
    deps.onEnsured?.(ensured);
    return ensured.imageTag;
  };
}

// ---- real edge adapters (infra — smoke-tested at onboarding, not in the unit suite) ----

/**
 * Real {@link ManifestSources} over a target clone: glob with `fs.globSync` and read with
 * `fs.readFileSync`, both rooted at `contextDir`. Thin fs glue, mirroring `DockerCliRunner`'s
 * process glue — exercised by the onboarding smoke-test (epic #182), not the unit suite.
 */
export function fsManifestSources(contextDir: string): ManifestSources {
  return {
    glob: (pattern) => globSync(pattern, { cwd: contextDir }),
    readFile: (relPath) => readFileSync(join(contextDir, relPath), "utf8"),
  };
}

/**
 * The production {@link ImageBuilderDeps}: `imageExists` shells `docker image inspect` (a non-zero
 * exit = absent), `dockerBuild` shells `docker build`. Thin process glue; the real build's
 * acceptance test is the onboarding smoke-test (ADR-0038), not a ralph unit test.
 */
export class DockerCliImageBuilder implements ImageBuilderDeps {
  async imageExists(tag: string): Promise<boolean> {
    try {
      await execFileAsync("docker", ["image", "inspect", tag]);
      return true;
    } catch {
      return false;
    }
  }

  async dockerBuild(args: string[]): Promise<void> {
    await execFileAsync("docker", args);
  }
}
