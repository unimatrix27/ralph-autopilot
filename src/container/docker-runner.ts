/**
 * The real {@link DockerCliRunner} (ADR-0038 / issue #185, AC2): the daemon's `docker run`
 * implementation of the {@link DockerRunner} port for the container model. It launches a
 * target's per-run image with the {@link ContainerDispatch} pushed in, the agent's credentials
 * mounted, and the container's stdio bridged to a {@link LocalPipeTransport} — and `docker
 * kill`s it on abort.
 *
 * Two layers, mirroring the rest of `src/container`: a **pure argv builder**
 * ({@link buildDockerRunArgs}) that is exhaustively unit-tested, and the thin process/stdio
 * glue ({@link DockerCliRunner}) that shells `docker` — infra that is smoke-tested against a real
 * docker at onboarding (epic #182, slice "no real images/containers in CI"), not in the unit
 * suite. **Credential isolation is an explicit non-goal** (ADR-0038): the container holds the
 * agent's own creds by design, and the dedicated-box rule (OPERATING.md §2) stays.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { ContainerDispatch, ContainerRoute } from "./assignment";
import type { ContainerSweeper, DockerRunner, RunningContainer } from "./container-execution";
import { LocalPipeTransport } from "./transport";

/** Where credentials land *inside* the container — the `ralph/agent-base` (L0) home convention. */
const CONTAINER_HOME = "/home/ralph";
/**
 * Where a codex (openai) account's `CODEX_HOME` is mounted *inside* the container — the fixed path
 * the in-container Codex backend reads its ChatGPT-subscription `auth.json` from (issue #220). The
 * selected account's host `codexHome` mounts here, so the in-container runner uses this path, never
 * the host path.
 */
export const CONTAINER_CODEX_HOME = `${CONTAINER_HOME}/.codex`;
/** The env var the in-container runner reads its dispatch from (its only "what to do" input). */
export const DISPATCH_ENV_VAR = "RALPH_CONTAINER_DISPATCH";
/** The env var naming the `owner/repo` the in-container runner clones/pushes (`ralph-runner.ts`). */
export const TARGET_REPO_ENV_VAR = "RALPH_TARGET_REPO";
/** The env var pointing the runner at the mounted daemon config it resolves its target from. */
export const CONFIG_PATH_ENV_VAR = "RALPH_CONFIG_PATH";
/**
 * The env var naming the resolved route's provider kind (`claude` / `zai` / `openai`), so the
 * in-container runner instantiates the matching {@link import("../providers/backend").SessionBackend}
 * (ADR-0037 / issue #220) — no box-default fallback.
 */
export const PROVIDER_ENV_VAR = "RALPH_PROVIDER";
/** The env var naming the resolved route's model override; absent → the provider's default model. */
export const MODEL_ENV_VAR = "RALPH_MODEL";
/**
 * The env var holding the **name** of the env var that carries the z.ai API key (issue #220). The
 * key value is forwarded by name via `-e <authTokenEnv>` (the secret never enters argv); this tells
 * the in-container runner which var to read it from, since per-account keys vary by route.
 */
export const ZAI_TOKEN_ENV_NAME_VAR = "RALPH_ZAI_TOKEN_ENV";
/** Where the daemon config is bind-mounted (`:ro`) inside the container for the runner to read. */
const CONTAINER_CONFIG_PATH = `${CONTAINER_HOME}/ralph-config.yaml`;
/**
 * The name prefix every ralph-managed run container carries (`--name`). It is the orphan
 * sweeper's only handle on the container fleet: `docker ps --filter name=<prefix>` enumerates
 * exactly the containers this daemon launches, and any one whose run is no longer live is killed.
 */
export const CONTAINER_NAME_PREFIX = "ralph-";
/**
 * The docker label key that namespaces a run container to **its own target repo** (issue #256).
 * Every launched container carries `--label ralph.repo=<targetRepo>`, and the orphan sweep filters
 * `docker ps` on it — so a multi-target box's per-repo sweeps only ever enumerate (and therefore
 * only ever kill) their **own** containers. The {@link CONTAINER_NAME_PREFIX} is global across
 * targets; the label is what isolates one repo's fleet from another's. A label, not a repo-namespaced
 * name, is the scoping handle so the name stays the run's unchanged kill handle (abort/wall-clock).
 */
export const REPO_LABEL_KEY = "ralph.repo";
/**
 * The docker label key carrying a run container's **branch** (issue #259). Every launched container
 * is stamped `--label ralph.branch=<branch>`, and the orphan sweep spares a live run by matching
 * this label against its set of live branches — NOT by recomputing the container's name. Container
 * names are now per-dispatch unique ({@link uniqueContainerName}), so a live run's name no longer
 * equals {@link containerNameForBranch}(branch); the branch label is the only sound live-run handle
 * left. This decouples the sweep from the name, which is what lets the name vary per dispatch.
 */
export const BRANCH_LABEL_KEY = "ralph.branch";
/**
 * Default graceful period (seconds) the `docker stop -t` backstop gives the container to wind
 * down on SIGTERM before Docker SIGKILLs it (ADR-0038's graceful-then-hard "`docker kill
 * --stop-timeout`"). Overridable per target via {@link DockerRunnerConfig.stopTimeoutSeconds}.
 */
export const DEFAULT_STOP_TIMEOUT_SECONDS = 10;

/** Host-side credential sources mounted/forwarded into every run container (ADR-0038 user story 20). */
export interface ContainerCredentialMounts {
  /** Host path to the Claude OAuth config dir → mounted read-only at the container's `~/.claude`. */
  claudeConfigDir?: string;
  /** Host path to the Codex `CODEX_HOME` (holds `auth.json`) → mounted read-only at `~/.codex`. */
  codexHome?: string;
  /** Name of the daemon env var holding the GitHub token; forwarded into the container by name. */
  githubTokenEnv?: string;
  /** Name of the daemon env var holding the z.ai key; forwarded into the container by name. */
  zaiTokenEnv?: string;
  /**
   * Names of daemon env vars forwarded by name into **every** container regardless of its own
   * route (issue #270). The in-container runner `loadConfig`-validates the FULL mounted daemon
   * config at startup (`ralph-runner.ts`), which requires every configured z.ai account's key
   * env var to be present — even in a claude/codex container that never uses the key. Without
   * this, any `types.* → zai` route in the config kills every non-zai container at config load
   * ("runner exited without a result frame" → `review-maxed`). Route-agnostic by design, so it
   * survives the per-run credential swap like `githubTokenEnv` does.
   */
  alwaysForwardEnv?: string[];
}

/** Construction config for {@link DockerRunner} (per target; supplied by the composition root). */
export interface DockerRunnerConfig {
  /**
   * The per-target agent image (L1/L2 — toolchain + baked deps) to run (ADR-0038). Used as-is
   * when {@link resolveImage} is absent (e.g. an operator `RALPH_AGENT_IMAGE` pin). When
   * {@link resolveImage} is present it is resolved per dispatch and this static value is ignored.
   */
  image: string;
  /**
   * Resolve the image to run, **per dispatch** (issue #190 completion). When set, `start` awaits
   * it instead of using the static {@link image}: the daemon ENSURES the content-keyed per-target
   * image (build-on-cache-miss, keyed on the contract's `depManifests`) and returns its exact tag,
   * so the tag the daemon **runs** is the tag it **built** — no run/build-tag drift. Absent → the
   * static {@link image} is used (operator-pinned, no build).
   */
  resolveImage?: () => Promise<string>;
  /**
   * The `owner/repo` this container works, forwarded as `RALPH_TARGET_REPO` — the runner's
   * `ralph-runner.ts` requires it to know which repo to clone/push, and fails fast without it.
   */
  targetRepo?: string;
  /**
   * Absolute host path to the daemon config; bind-mounted `:ro` into the container and pointed at
   * by `RALPH_CONFIG_PATH`, so the runner can `loadConfig` + resolve its target. Required for a
   * real run (the runner fails without a resolvable target); absent only in argv unit tests.
   */
  configPath?: string;
  /** The agent's credentials, mounted/forwarded so it can call the LLM and push to GitHub. */
  credentials: ContainerCredentialMounts;
  /** Extra `docker run` args (resource limits, network, …), inserted before the image. */
  extraArgs?: string[];
  /**
   * Graceful period (seconds) the abort/wall-clock kill backstop gives the container to wind
   * down on SIGTERM before Docker SIGKILLs it — the graceful-then-hard `docker stop -t`
   * (ADR-0038). Defaults to {@link DEFAULT_STOP_TIMEOUT_SECONDS}.
   */
  stopTimeoutSeconds?: number;
}

/**
 * Derive the **per-run** credential mounts from the resolved {@link ContainerRoute} (ADR-0037 /
 * issue #220): the selected account's own credential is mounted/forwarded, NOT one fixed
 * box-default. Pure, so the per-run mount contract is unit-testable.
 *
 *   - **claude** → the account's `configDir` mounts at `~/.claude`. A box-default login carries an
 *     empty `configDir` ({@link import("../daemon/daemon").buildRouteWorld}), which falls back to
 *     the box-default `claudeConfigDir` so a real dir always mounts.
 *   - **openai** → the account's `codexHome` mounts at `~/.codex`.
 *   - **zai** → the account's `authTokenEnv` is forwarded by name (the key value never enters argv).
 *
 * The shared `githubTokenEnv` (clone/push auth, the same for every run) is always carried through;
 * only ONE provider credential is set, so a claude run never also mounts a codex dir and vice versa
 * (the recorded `docker run` args differ per selected account — the issue #220 AC).
 */
export function credentialMountsForRoute(
  route: ContainerRoute,
  fallback: ContainerCredentialMounts,
): ContainerCredentialMounts {
  // GitHub auth is per-box, not per-account — it survives the per-run credential swap. So does
  // the route-agnostic always-forward set (issue #270): the runner's full-config validation needs
  // every configured z.ai key var present no matter which provider this run selected.
  const base: ContainerCredentialMounts = {
    ...(fallback.githubTokenEnv ? { githubTokenEnv: fallback.githubTokenEnv } : {}),
    ...(fallback.alwaysForwardEnv?.length ? { alwaysForwardEnv: fallback.alwaysForwardEnv } : {}),
  };
  const { account } = route;
  switch (account.provider) {
    case "claude":
      // An empty configDir is the box-default login → mount the box-default dir, never "".
      return { ...base, claudeConfigDir: account.configDir || fallback.claudeConfigDir };
    case "openai":
      return { ...base, codexHome: account.codexHome };
    case "zai":
      return { ...base, zaiTokenEnv: account.authTokenEnv };
  }
}

/**
 * Build the full `docker run …` argv (sans the `docker` argv0) for one dispatch. Pure: the same
 * config + dispatch + name always yields the same args, so the invocation contract is fully
 * unit-testable. The container is **ephemeral** (`--rm`), runs a PID-1 init (`--init`), keeps
 * **stdio open** for the pipe (`-i`), carries the run's **kill handle** (`--name`), receives the
 * dispatch as an env var, and mounts/forwards the agent's credentials. The image is the final
 * positional and its own runner is the entrypoint — no command override.
 *
 * `--init` is load-bearing, not cosmetic: the in-container wall-clock reaper
 * ({@link import("../executor/process-reaper").createProcessGroupReaper}) SIGKILLs the whole
 * `claude` process group on overrun. Without a PID-1 reaper the killed grandchildren become
 * un-reaped zombies and the reaper blocks; the tini `--init` shim reaps them. (Gate C finding,
 * issue #213 — `process-reaper.test.ts` times out in a bare container, passes with `--init`.)
 */
export function buildDockerRunArgs(
  config: DockerRunnerConfig,
  dispatch: ContainerDispatch,
  containerName: string,
): string[] {
  const args = ["run", "--rm", "--init", "-i", "--name", containerName];

  // Per-run credentials: the resolved route's selected account (ADR-0037 / issue #220) wins over
  // the static box-default `config.credentials` — so the pool steers each run onto its own login.
  // A route-less dispatch (argv tests / a routing-agnostic setup) keeps the box-default creds.
  const credentials = dispatch.route ? credentialMountsForRoute(dispatch.route, config.credentials) : config.credentials;
  const { claudeConfigDir, codexHome, githubTokenEnv, zaiTokenEnv } = credentials;
  if (claudeConfigDir) {
    // Mounted READ-WRITE, not :ro. The Claude SDK is built to share a writable `~/.claude` across
    // processes — it creates a per-session `session-env/<uuid>` dir (and refreshes the OAuth token /
    // writes transcripts) there; a `:ro` mount makes that mkdir fail with EROFS and kills the run.
    // Each session is uuid-isolated so concurrent containers don't collide, and cred isolation is an
    // explicit non-goal (ADR-0038) — the box is the blast radius. (The dir is 100s of MB of history,
    // so a per-run copy is impractical; the container writes into the box's own login, as any
    // `claude` process on the box does.)
    args.push("-v", `${claudeConfigDir}:${CONTAINER_HOME}/.claude:rw`);
  }
  if (codexHome) {
    // Read-write for the same reason: the Codex SDK writes session state under its CODEX_HOME.
    args.push("-v", `${codexHome}:${CONTAINER_HOME}/.codex:rw`);
  }
  // `-e NAME` (no `=value`) forwards the daemon's own env var into the container, so the secret
  // is read from the daemon's environment at spawn time and never embedded in argv.
  if (githubTokenEnv) {
    args.push("-e", githubTokenEnv);
  }
  if (zaiTokenEnv) {
    // Forward the key by name (the secret never enters argv) AND tell the runner which var holds
    // it — per-account z.ai keys vary by route, so the name must travel (issue #220).
    args.push("-e", zaiTokenEnv);
    args.push("-e", `${ZAI_TOKEN_ENV_NAME_VAR}=${zaiTokenEnv}`);
  }
  // Route-agnostic forwards (issue #270): the runner validates the FULL mounted config at startup,
  // so every configured z.ai key var must be present in every container — including claude/codex
  // runs that never consume it (the ZAI_TOKEN_ENV_NAME_VAR steering var above stays zai-route-only,
  // so a non-zai session never reads the key). Deduped against the route's own forwards.
  for (const name of credentials.alwaysForwardEnv ?? []) {
    if (name !== githubTokenEnv && name !== zaiTokenEnv) {
      args.push("-e", name);
    }
  }

  // Inject the resolved route's provider + model so the in-container runner instantiates the
  // matching SessionBackend + model — no box-default fallback (ADR-0037 / issue #220). The account
  // itself reaches the runner as the mounted cred (above), never as data, so it is NOT serialized
  // into the dispatch env below.
  if (dispatch.route) {
    args.push("-e", `${PROVIDER_ENV_VAR}=${dispatch.route.provider}`);
    if (dispatch.route.model !== undefined) {
      args.push("-e", `${MODEL_ENV_VAR}=${dispatch.route.model}`);
    }
  }

  // The assignment + per-run token, pushed in so the runner needs no GitHub read to begin. The
  // resolved `route` is a daemon-side concern (it drove the cred mount + provider/model env above),
  // so it is deliberately left out of the container's own dispatch JSON.
  args.push("-e", `${DISPATCH_ENV_VAR}=${JSON.stringify({ assignment: dispatch.assignment, token: dispatch.token })}`);

  // Stamp the run's branch as a label (issue #259). The orphan sweep spares a live run by matching
  // THIS label against its live-branch set, rather than recomputing the container's name — names are
  // now per-dispatch unique ({@link uniqueContainerName}), so a live run's name no longer equals
  // containerNameForBranch(branch). Unconditional: every dispatch carries a branch (unlike the
  // targetRepo-guarded repo label below), so every container the sweep enumerates is matchable.
  args.push("--label", `${BRANCH_LABEL_KEY}=${dispatch.assignment.branch}`);

  // Which repo the runner clones/pushes (it fails fast without this), and the daemon config it
  // resolves that target from — bind-mounted `:ro` and pointed at by `RALPH_CONFIG_PATH`.
  if (config.targetRepo) {
    // Namespace the container to its repo so each target's orphan sweep only enumerates — and so
    // only ever kills — its own containers, never another target's in-flight run (issue #256).
    // Guarded on `targetRepo` so the box/argv-test path (no repo) launches an unlabelled container.
    args.push("--label", `${REPO_LABEL_KEY}=${config.targetRepo}`);
    args.push("-e", `${TARGET_REPO_ENV_VAR}=${config.targetRepo}`);
  }
  if (config.configPath) {
    args.push("-v", `${config.configPath}:${CONTAINER_CONFIG_PATH}:ro`);
    args.push("-e", `${CONFIG_PATH_ENV_VAR}=${CONTAINER_CONFIG_PATH}`);
  }

  if (config.extraArgs?.length) {
    args.push(...config.extraArgs);
  }
  args.push(config.image);
  return args;
}

/**
 * The graceful-then-hard kill argv: `docker stop -t <timeout> <name>` sends the container's
 * PID-1 (tini, via `--init`) a SIGTERM, waits up to `timeout` seconds for a clean exit, then
 * SIGKILLs the whole container — so the process tree is gone either way (ADR-0038's "abort with
 * `docker kill --stop-timeout`"; the real Docker flag for the timed graceful kill is `stop -t`).
 * Pure, so the abort/wall-clock/orphan-sweep backstop's invocation is unit-testable.
 */
export function buildStopArgs(name: string, stopTimeoutSeconds: number): string[] {
  return ["stop", "-t", String(stopTimeoutSeconds), name];
}

/**
 * The fleet-enumeration argv: `docker ps --filter name=<prefix> --format <name>\t<branch-label>`
 * lists every running ralph-managed container with its {@link BRANCH_LABEL_KEY} label — the orphan
 * sweeper's view of the live fleet. Pure; parsed by {@link parsePsContainers}. The branch label
 * rides alongside the name (issue #259) because the sweep spares a live run by its branch, and
 * names are now per-dispatch unique — they no longer encode the branch the sweep matches on.
 *
 * When `repo` is supplied it also filters on `label=ralph.repo=<repo>` ({@link REPO_LABEL_KEY}), so
 * a multi-target box's sweep enumerates **only this repo's** containers and can never reach across
 * targets (issue #256). The `name=` prefix filter is global across targets; the label is what
 * scopes the view to one repo. `repo` omitted (box/single-target/argv tests) → the prefix-only
 * fleet, unchanged.
 */
export function buildPsArgs(repo?: string): string[] {
  const args = ["ps", "--filter", `name=${CONTAINER_NAME_PREFIX}`];
  if (repo) {
    args.push("--filter", `label=${REPO_LABEL_KEY}=${repo}`);
  }
  // Each row: the container name, a tab, then its ralph.branch label — the sweep's live-run handle.
  args.push("--format", `{{.Names}}\t{{.Label "${BRANCH_LABEL_KEY}"}}`);
  return args;
}

/** One running ralph-managed container as the sweep sees it: its name and its `ralph.branch` label. */
export interface RunningContainerView {
  /** The container's docker name — its per-dispatch-unique kill handle (issue #259). */
  name: string;
  /** Its {@link BRANCH_LABEL_KEY} label, or `""` if the container carries none (then unmatchable). */
  branch: string;
}

/**
 * Parse `docker ps --format "{{.Names}}\t{{.Label \"ralph.branch\"}}"` stdout into the running
 * ralph-managed containers paired with their branch labels (issue #259). Tolerant of blank/whitespace
 * lines and re-anchors on the prefix (the `--filter name=` match is an unanchored substring), so only
 * genuinely ralph-managed containers are ever considered for sweeping. A container with no branch
 * label yields `branch: ""` — Docker emits an empty field (or the legacy `<no value>`), both of which
 * normalise to `""`, an unmatchable value, so the sweep treats such a container as an orphan.
 */
export function parsePsContainers(stdout: string): RunningContainerView[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(CONTAINER_NAME_PREFIX))
    .map((line) => {
      const tab = line.indexOf("\t");
      const name = (tab === -1 ? line : line.slice(0, tab)).trim();
      const rawBranch = tab === -1 ? "" : line.slice(tab + 1).trim();
      return { name, branch: rawBranch === "<no value>" ? "" : rawBranch };
    });
}

/** Spawn `docker` and return the child; injectable so the glue can be smoke-tested off a fake. */
export type DockerSpawn = (args: string[]) => ChildProcess;

// stdio: stdin (pipe) = daemon→runner control; stdout (pipe) = runner→daemon frames; stderr
// (pipe) = the runner's diagnostics — teed to the daemon's own stderr (preserving the old
// "folded into the daemon log" behaviour) AND captured to a bounded tail so a `docker run` that
// dies without a result frame can surface its real reason on the heal-card (issue #220). It was
// previously `inherit`, which dropped it; the tee keeps the operator-facing stream identical.
const realDockerSpawn: DockerSpawn = (args) => spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });

/** Bytes of container stderr retained for the {@link RunningContainer.failureDetail} tail. */
export const STDERR_TAIL_BYTES = 4096;

/**
 * The docker-safe **name stem** for a run's branch (`/` and friends → `-`). It is the
 * human-readable base of a container's name; {@link uniqueContainerName} appends a per-dispatch
 * discriminator to it so each dispatch is unique (issue #259). The orphan sweep no longer recomputes
 * this to spare a live run — it matches the {@link BRANCH_LABEL_KEY} label instead — so the stem and
 * the live-run handle no longer have to stay in lockstep. Still the prefix the sweep enumerates on.
 */
export function containerNameForBranch(branch: string): string {
  const safe = branch.replace(/[^a-zA-Z0-9_.-]/g, "-");
  return `${CONTAINER_NAME_PREFIX}${safe}`;
}

/**
 * A per-process token (computed once at module load) that disambiguates this process's container
 * names from those of any PRIOR process whose `--rm` containers might still be tearing down across a
 * restart (issue #259) — so a fresh process can never regenerate a name an old, lingering container
 * still holds. Base-36 of the start time: docker-name-safe (alphanumeric) and stable for the run.
 */
const PROCESS_TOKEN = Date.now().toString(36);
/** Monotonic across the process; combined with {@link PROCESS_TOKEN} it makes every name unique. */
let dispatchCounter = 0;

/**
 * A **unique** docker container name for one dispatch (issue #259). The branch
 * ({@link containerNameForBranch}) is the human-readable stem; a `<process-token>-<counter>`
 * discriminator is appended so NO two dispatches — the review and fix phases and the retry attempts
 * of the SAME branch, which the review loop fires back-to-back — ever share a name.
 *
 * A reused branch-derived name was the example-monorepo review-maxed bug: containers run `--rm`, and the
 * prior phase's container can still be removing when the next `docker run --name <same>` starts,
 * which Docker rejects with a name Conflict ("already in use") — the new run dies before emitting a
 * result frame, surfacing as `review.container-infra-failed` → `review-maxed`. A fresh name per
 * dispatch removes that collision window.
 *
 * Not pure (it advances the counter), so it lives in the side-effecting launcher — NOT in the pure
 * {@link buildDockerRunArgs}, which still takes the name it is handed. The run's kill handle is the
 * concrete name {@link DockerCliRunner.start} stores (closed over by `kill`), and the orphan sweep
 * matches by the {@link BRANCH_LABEL_KEY} label — neither recomputes this name.
 */
export function uniqueContainerName(branch: string): string {
  dispatchCounter += 1;
  return `${containerNameForBranch(branch)}-${PROCESS_TOKEN}-${dispatchCounter}`;
}

/**
 * The production {@link DockerRunner} + {@link ContainerSweeper}: `start` shells `docker run`
 * (argv from {@link buildDockerRunArgs}) and bridges the container's stdout/stdin to a
 * {@link LocalPipeTransport}; the kill backstop shells the graceful-then-hard `docker stop -t`
 * (argv from {@link buildStopArgs}) for the abort/wall-clock reap; and `sweepOrphans` enumerates
 * the live fleet (`docker ps`, {@link buildPsArgs}) and stops any container whose run is no longer
 * live. The pipe is best-effort — a child that dies surfaces as EOF on the transport, which
 * `ContainerExecution` degrades to a `failed` terminal.
 */
export class DockerCliRunner implements DockerRunner, ContainerSweeper {
  private readonly stopTimeoutSeconds: number;

  constructor(
    private readonly config: DockerRunnerConfig,
    private readonly spawnFn: DockerSpawn = realDockerSpawn,
  ) {
    this.stopTimeoutSeconds = config.stopTimeoutSeconds ?? DEFAULT_STOP_TIMEOUT_SECONDS;
  }

  async start(dispatch: ContainerDispatch): Promise<RunningContainer> {
    // A per-dispatch-unique name (issue #259): successive review/fix phases and retry attempts of
    // the same branch each get their own name, so a still-removing `--rm` container from the prior
    // phase can never Conflict with this `docker run --name`. The kill handle below closes over THIS
    // concrete name (never recomputed from the branch), so abort/wall-clock reaps the right one.
    const name = uniqueContainerName(dispatch.assignment.branch);
    // Resolve the image per dispatch (issue #190 completion): the injected `resolveImage` ENSURES
    // the content-keyed per-target image (build-on-cache-miss, ADR-0038) and returns its exact tag;
    // a static `image` (RALPH_AGENT_IMAGE pin) is run as-is. Either way the tag run == the tag built.
    const image = this.config.resolveImage ? await this.config.resolveImage() : this.config.image;
    const child = this.spawnFn(buildDockerRunArgs({ ...this.config, image }, dispatch, name));
    if (!child.stdout || !child.stdin) {
      throw new Error("docker child process is missing its stdio pipes");
    }
    // Tee stderr to the daemon's own stderr (unchanged operator-facing behaviour) AND keep a
    // bounded tail + the exit code/signal, so a no-result terminal can carry the real reason
    // (issue #220). `stderr` is null only if a fake spawn omits it — degrade to no detail.
    let stderrTail = "";
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      process.stderr.write(text);
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_BYTES);
    });
    child.on("exit", (code, signal) => {
      exit = { code, signal };
    });
    const transport = new LocalPipeTransport({ inbound: child.stdout, outbound: child.stdin });
    return {
      // `docker stop -t` SIGTERMs then (after the grace period) SIGKILLs the container, ending its
      // stdout → the daemon's receive loop unblocks at EOF.
      transport,
      kill: () => this.stopContainer(name),
      // Meaningful once the child has exited (the no-result terminal is reached at stdout EOF, which
      // the exit follows): the docker exit code/signal + the captured stderr tail.
      failureDetail: () =>
        exit === undefined
          ? undefined
          : `docker exited (code=${exit.code ?? "null"} signal=${exit.signal ?? "null"}); stderr tail: ${
              stderrTail.trim() || "<empty>"
            }`,
    };
  }

  /**
   * Kill every running ralph-managed container whose branch is NOT in `liveBranches` — the orphan
   * sweep (ADR-0038). A daemon crash or a lost run row mid-flight leaves a container running with
   * nothing to reap it; this enumerates the live fleet from Docker itself (not in-memory state, so
   * it survives a restart) and stops the strays. Returns the names it killed for the caller's log.
   *
   * The enumeration is scoped to this runner's own `config.targetRepo` via the repo label
   * ({@link REPO_LABEL_KEY}, issue #256): on a multi-target box each repo runs its own
   * reconciler/sweep with its own per-repo `liveBranches`, so without scoping repo A's sweep would
   * see repo B's containers (the global `ralph-` name prefix), find their branches absent from A's
   * live set, and kill B's in-flight runs. Filtering `docker ps` on the label makes A's sweep see
   * only A's fleet — the per-repo `liveBranches` set is then correct by construction.
   *
   * A live run is spared by its {@link BRANCH_LABEL_KEY} **label**, not by recomputing its name
   * (issue #259): names are now per-dispatch unique ({@link uniqueContainerName}), so a live run's
   * container name no longer equals `containerNameForBranch(branch)` and a name-based spare would
   * wrongly reap every in-flight container. A container with no branch label can't be matched to a
   * live run, so it is reaped (within the repo scope) like any other orphan.
   */
  async sweepOrphans(liveBranches: ReadonlySet<string>): Promise<string[]> {
    const running = parsePsContainers(await this.capture(buildPsArgs(this.config.targetRepo)));
    const orphans = running.filter((c) => !c.branch || !liveBranches.has(c.branch)).map((c) => c.name);
    for (const name of orphans) {
      await this.stopContainer(name);
    }
    return orphans;
  }

  /** Run the graceful-then-hard `docker stop -t <timeout> <name>`, swallowing spawn failures. */
  private async stopContainer(name: string): Promise<void> {
    await new Promise<void>((resolve) => {
      const killer = this.spawnFn(buildStopArgs(name, this.stopTimeoutSeconds));
      killer.on("close", () => resolve());
      killer.on("error", () => resolve());
    });
  }

  /** Run a `docker` subcommand and resolve with its captured stdout (empty string on failure). */
  private async capture(args: string[]): Promise<string> {
    return new Promise<string>((resolve) => {
      const child = this.spawnFn(args);
      let out = "";
      child.stdout?.on("data", (chunk: Buffer | string) => {
        out += chunk.toString();
      });
      child.on("close", () => resolve(out));
      child.on("error", () => resolve(out));
    });
  }
}
