/**
 * Production wiring of the multi-repo daemon (ADR-0020): for each configured target
 * repo, build the `gh`-backed GitHub client, the git worktree manager over that
 * target's clone, the SDK agent runners, the review loop, the executor, and a
 * per-repo reconciler — all sharing ONE global agent budget and ONE SQLite store.
 * The {@link Orchestrator} then runs reconcile ticks across every repo until aborted.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { GhCliClient } from "../github/gh-cli";
import type { GitHubClient } from "../github/types";
import { detectDefaultBranch, GitWorktreeManager } from "../executor/worktree";
import { type AgentRunner } from "../executor/agent";
import { ContainerAgentRunner } from "../container/container-agent-runner";
import { ContainerFixAgentRunner, ContainerReviewAgentRunner } from "../container/container-review-fix-runner";
import type { RecordRateLimitSignal } from "../container/record-rate-limit";
import {
  DockerCliRunner,
  type ContainerCredentialMounts,
  type DockerRunnerConfig,
} from "../container/docker-runner";
import {
  createTargetImageResolver,
  DockerCliImageBuilder,
  fsManifestSources,
  targetImageRef,
} from "../container/image-build";
import { DEFAULT_AGENT_CONTRACT_PATH, loadAgentContract } from "../container/agent-contract";
import { soonestReset, type Subscription } from "../core/usage";
import { Executor } from "../executor/executor";
import { RunAbortRegistry } from "../executor/run-abort-registry";
import { ReviewLoop } from "../review/review-loop";
import { AGENT_TYPES, providerForAgentType } from "../providers/select";
import type { RouteWorld, RoutingSource } from "../providers/resolve";
import { EscalationCheckpointer } from "../hitl/escalation-checkpoint";
import type { Logger } from "../log/logger";
import type { Account, RalphConfig, TargetConfig } from "../config/schema";
import { groupAccountsByProvider, resolveAccountPool, resolveTargets } from "../config/load";
import { RoutingStore } from "../config/routing-store";
import type { Store } from "../store/store";
import { Reconciler, type ReconcileBudget } from "./reconciler";
import { Orchestrator, type DaemonRunOutcome } from "./orchestrator";
import { GitUpdateChecker } from "./self-update";
import { UsageMeter } from "./usage-meter";
import { startWebControlPlane } from "../web/control-plane";
import { CompositeNotificationDispatcher, NotificationSink, type NotificationDispatchPort } from "../notify/sink";
import { NotificationDispatcher } from "../notify/dispatch";
import {
  resolveVapidIdentity,
  WebPushDispatcher,
  type WebPushSubscription,
  type VapidIdentity,
} from "../notify/webpush";
import { createLiveFeedPort } from "../store/live-feed";
import { createDaemonHealthPort } from "../store/daemon-health";

export interface DaemonDeps {
  config: RalphConfig;
  store: Store;
  logger: Logger;
  /**
   * Absolute path to the daemon config file, bind-mounted into `container`-mode run containers so
   * the in-container runner can resolve its target (ADR-0038). Set by `bin/ralph-daemon.ts`;
   * optional only for tests that build the orchestrator directly and never launch a real container.
   */
  configPath?: string;
  /**
   * Override the GitHub client per target (tests); defaults to the `gh`-backed
   * client scoped to the target's repo. Takes the resolved target so a test can
   * return a distinct fake per repo.
   */
  githubFor?: (target: TargetConfig) => GitHubClient;
  /**
   * The daemon's graceful-drain signal, threaded to each {@link Executor} so a session
   * killed by the terminal SIGINT during a drain is left resumable rather than
   * terminalized to `agent-stuck` (issue #131 / ADR-0033 — the Codex CLI shares the
   * daemon's process group). {@link runDaemon} wires it from {@link ShutdownSignals.drain};
   * absent (e.g. a test building the orchestrator directly) → the pre-#131 behaviour.
   */
  drain?: AbortSignal;
}

/** The two shutdown triggers the daemon reacts to (issue #35). */
export interface ShutdownSignals {
  /** First SIGTERM/SIGINT (or `ralph-daemon --drain`): begin a graceful drain. */
  drain: AbortSignal;
  /** A second signal: force an immediate stop, abandoning in-flight runs. */
  force: AbortSignal;
}

/**
 * Ensure a target's local clone exists before the worktree manager forks from it.
 * On a fresh box (or after the slug-derived path changed) the clone may be absent;
 * clone it with `gh` (the box already carries the scoped GitHub auth). Fatal if the
 * clone fails — a target with no clone cannot be worked.
 */
function ensureTargetClone(repo: string, cloneDir: string, logger: Logger): void {
  if (existsSync(cloneDir)) {
    return;
  }
  logger.info("daemon.target-clone", { repo, cloneDir });
  try {
    execFileSync("gh", ["repo", "clone", repo, cloneDir], { stdio: "inherit" });
  } catch (err) {
    throw new Error(`failed to clone target repo ${repo} into ${cloneDir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Expand a leading `~` to the box home dir so `CLAUDE_CONFIG_DIR` is absolute. */
function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1).replace(/^[/\\]/, "")) : p;
}

/** The pool's claude slice, narrowed to the claude account shape (the OAuth meter's source). */
function claudeAccountsOf(pool: Account[]): Extract<Account, { provider: "claude" }>[] {
  return pool.filter((a): a is Extract<Account, { provider: "claude" }> => a.provider === "claude");
}

/**
 * Resolve the Claude OAuth logins backing the ADR-0028 usage meter from the resolved account
 * pool's **claude slice** (ADR-0037 P2.2) — the union of the legacy `usageLimit.subscriptions`
 * fold and any explicit `accounts:` claude entries (both folded into the pool by
 * {@link resolveAccountPool}). Sourcing from the pool — not `usageLimit.subscriptions` alone —
 * is what makes the pool the single credential source for claude too: a login listed only under
 * `accounts:` reaches the meter (with its per-login `configDir` and ADR-0028 rotation) instead of
 * being silently dropped to the box-default login (the ADR-0008 no-silent-fallback discipline).
 *
 * Each account's `configDir` is expanded (`~`) and validated to carry a credential
 * (`<dir>/.credentials.json`, written by `claude login`). A configured-but-unauthenticated store
 * is **skipped with a loud warning** — degrading to whichever logins ARE live — rather than
 * failing every session on it; but if claude accounts were configured and NONE are valid, that is
 * an operator error worth halting on. No claude accounts → an empty list (the meter falls back to
 * the single box-default login: exactly the ADR-0023 behaviour).
 */
function resolveClaudeSubscriptions(
  claudeAccounts: ReadonlyArray<Extract<Account, { provider: "claude" }>>,
  logger: Logger,
): Subscription[] {
  const resolved: Subscription[] = [];
  for (const account of claudeAccounts) {
    const configDir = expandHome(account.configDir);
    if (!existsSync(join(configDir, ".credentials.json"))) {
      logger.warn("usage.subscription-skipped", {
        id: account.id,
        configDir,
        reason: "no .credentials.json — run `CLAUDE_CONFIG_DIR=<dir> claude` then /login",
      });
      continue;
    }
    resolved.push({ id: account.id, configDir });
  }
  if (claudeAccounts.length > 0 && resolved.length === 0) {
    throw new Error(
      "claude accounts configured (usageLimit.subscriptions / accounts:) but none have a valid login (.credentials.json); log in to each store or remove the entries",
    );
  }
  return resolved;
}

/**
 * The assembled daemon: the {@link Orchestrator} that runs the loop, plus the shared
 * {@link UsageMeter} exposed for read-only surfacing (the web Health view, ADR-0028/issue
 * #116) — the meter is owned here, so handing back a read handle keeps the reconcile loop
 * the meter's only writer.
 */
export interface AssembledDaemon {
  orchestrator: Orchestrator;
  /** The shared usage meter, for read-only diagnostics (never mutated outside the loop). */
  usageMeter: UsageMeter;
  /** Canonical resolved target metadata shared by reconcilers and the web edge. */
  targets: TargetConfig[];
  /**
   * The runtime routing overlay (ADR-0037 P4.1, issue #166) — the live source every reconciler +
   * executor reads route resolution through, and the port the web control plane reads/writes. Owned
   * here so the daemon and the web edge share one overlay (an edit is reflected on the next dispatch).
   */
  routingStore: RoutingStore;
}

/**
 * The daemon-wide route-resolution **headroom port** (ADR-0037 P2.2) — the seam route
 * resolution consults at every agent start for "which account backs this provider now":
 *
 * - **claude**: the shared ADR-0028 OAuth {@link UsageMeter} is the account authority — it
 *   rotates among logins and fails over to one with headroom. `acquire` always hands back the
 *   active login (even a gated one), exactly as the pre-P2.2 active-login acquire did:
 *   the whole-daemon usage *pause* stays the reconciler's admission gate, so a started session
 *   always resolves a claude account. The box-default login maps to an empty `configDir`.
 * - **zai / openai**: the resolved {@link Account} pool is the credential authority; hand back
 *   that provider's first pool account (load-time validation guarantees a selected provider has
 *   one). Per-account metered rotation + a per-pool `no-provider` admission wait is slice 5; the
 *   reconciler's existing z.ai cooldown gate keeps gating new work this slice.
 *
 * `repo` is accepted (the ADR keys everything by repo for per-repo deviation) but ignored in
 * v1 — the pool is daemon-wide and the per-repo patch is empty.
 */
export function buildRouteWorld(usageMeter: UsageMeter, pool: Account[], admitBelowPercent: number): RouteWorld {
  const byProvider = groupAccountsByProvider(pool);
  return {
    acquireAccount: (_repo, provider) => {
      if (provider === "claude") {
        const token = usageMeter.acquire(admitBelowPercent);
        return { id: token.id, provider: "claude", configDir: token.configDir ?? "" };
      }
      return byProvider.get(provider)?.[0] ?? null;
    },
  };
}

/**
 * The approximate instant the `impl` provider pool is expected to regain headroom (ADR-0037 P3.2,
 * issue #165) — the "resets ~HH:MM" ETA the no-provider backlog wait shows. In v1 the only metered
 * impl provider is claude (zai/openai hand back their pool account un-metered in {@link
 * buildRouteWorld}), so the soonest reset across the claude logins' gating windows / cooldowns is
 * the honest ETA: the pool regains headroom as soon as the **earliest** login frees. Returns null
 * when no login carries a known future reset, so the wait still renders without an ETA. Pure given
 * the meter snapshot + clock.
 */
export function implProviderResetsAt(usageMeter: UsageMeter, admitBelowPercent: number, nowMs: number): string | null {
  const states = Object.values(usageMeter.snapshot().states);
  const resets = states.map((s) => soonestReset(s, nowMs, admitBelowPercent)).filter((n): n is number => n !== null);
  return resets.length > 0 ? new Date(Math.min(...resets)).toISOString() : null;
}

/**
 * The daemon-side fold of a container-reported per-account rate-limit signal into the right meter
 * (ADR-0037 account meter / ADR-0038 best-effort pipe, issue #228). In container-only execution the
 * 429 / usage-window signal is observed *inside* the container and relayed back as telemetry; this
 * replaces the retired in-process feed that used to call the meter the instant the session saw it.
 * The fold routes by provider so a quota never crosses pools (ADR-0034):
 *
 *   - **claude** → the shared ADR-0028 OAuth {@link UsageMeter}, keyed by the **dispatched account
 *     id** (`record(signal, accountId)`), so a `rejected` trips *that* login's cooldown and the next
 *     `resolveRoute` falls through to a login with headroom — `no-provider` defers only when EVERY
 *     claude login is exhausted (ADR-0028 invariant). A missing account id (a route-less dispatch)
 *     no-ops rather than tripping the wrong login.
 *   - **z.ai** → the separate single-pool z.ai cooldown meter (keyed `"zai"`), folded with the
 *     active token, never the Claude plan window.
 *   - **openai** (Codex) has no usage meter today, so its signal is dropped (best-effort).
 *
 * Exported so the fold is unit-testable against real meters without standing up the orchestrator.
 */
export function buildRateLimitRecorder(
  usageMeter: UsageMeter,
  providerUsageMeter: UsageMeter,
): RecordRateLimitSignal {
  return (provider, accountId, signal) => {
    if (provider === "claude") {
      if (accountId) {
        usageMeter.record(signal, accountId);
      }
    } else if (provider === "zai") {
      providerUsageMeter.record(signal);
    }
    // openai: no usage meter — the signal is dropped (best-effort, ADR-0038).
  };
}

/**
 * Build the daemon-wide Claude OAuth usage meter (ADR-0028) and the route-resolution headroom
 * port (ADR-0037 P2.2) over the resolved account {@link Account} pool. The meter is sourced from
 * the pool's **claude slice** (`usageLimit.subscriptions` ∪ explicit `accounts:` claude entries),
 * so the pool is the single credential source for claude too: a login listed only under
 * `accounts:` routes to its own `configDir` rather than silently falling back to the box-default
 * login (ADR-0008 no-silent-fallback). The same meter is the reconciler's admission gate and the
 * sink that streamed claude rate-limit signals fold into. Exported so the real claude-from-pool
 * wiring is unit-testable without standing up the whole orchestrator.
 */
export function buildUsageRouting(
  config: RalphConfig,
  logger: Logger,
): { usageMeter: UsageMeter; routeWorld: RouteWorld } {
  // The resolved ACCOUNT POOL is the single credential source for ALL providers: explicit
  // `accounts:` plus the back-compat slices folded from `usageLimit.subscriptions` (claude),
  // `providers.openai.codexHome`, and `providers.zai.authTokenEnv`.
  const pool = resolveAccountPool(config);

  // One shared Claude usage meter (ADR-0020: a single OAuth plan budget across all repos),
  // sourced from the pool's claude slice. Every impl agent runner feeds it streamed plan
  // rate-limit signals; every reconciler reads its gate before admitting new work, so a hit
  // limit pauses the whole daemon (not one repo) and self-heals when the window resets. With
  // two+ claude logins it holds one state per login and routes new sessions to whichever has
  // headroom (ADR-0028); with none it is the single-login meter, byte-for-byte ADR-0023.
  const subscriptions = resolveClaudeSubscriptions(claudeAccountsOf(pool), logger);
  const usageMeter = new UsageMeter({
    tokens: subscriptions.length > 0 ? subscriptions : undefined,
    rotateEveryMs: config.usageLimit.rotateEveryMinutes != null ? config.usageLimit.rotateEveryMinutes * 60_000 : null,
    onActiveChange: ({ from, to }) => logger.info("usage.token-flip", { from, to }),
  });
  if (subscriptions.length > 0) {
    logger.info("usage.subscriptions", {
      ids: subscriptions.map((s) => s.id),
      rotateEveryMinutes: config.usageLimit.rotateEveryMinutes ?? null,
    });
  }
  // Route resolution at every agent start reads this daemon-wide headroom port; claude account
  // choice flows through the shared OAuth `usageMeter` (itself now sourced from the pool's claude
  // slice, ADR-0028 rotation), while z.ai/openai hand back their pool account.
  const routeWorld = buildRouteWorld(usageMeter, pool, config.usageLimit.admitBelowPercent);
  return { usageMeter, routeWorld };
}

/**
 * The `docker run` config for a `container` target (ADR-0038 / issues #185, #190). Credential
 * mounts are env-sourced (the cred env names match the auth-wiring runbook: Claude OAuth dir,
 * `CODEX_HOME`, `GH_TOKEN`, the z.ai key var).
 *
 * These credentials are now the **box-default fallback** (ADR-0037 / issue #220): every real
 * dispatch carries a resolved `route`, so {@link buildDockerRunArgs} mounts the *selected* account's
 * cred (claude `configDir`, codex `codexHome`, z.ai `authTokenEnv`) per run instead. The static
 * `claudeConfigDir` here still backs a box-default claude login (empty `configDir`), and
 * `githubTokenEnv` is shared across every run (per-box, not per-account); the codex/z.ai entries are
 * only used by a route-less dispatch (argv tests / a routing-agnostic setup).
 *
 * The **image** is resolved per dispatch (issue #190 completion): unless an operator pins
 * `RALPH_AGENT_IMAGE`, the daemon ENSURES the content-keyed per-target image before each run —
 * build-on-cache-miss from the target clone's `.ralph/agent.Dockerfile`, keyed on the contract's
 * `depManifests` — and runs exactly that tag (`{@link targetImageRef}`), so the tag the daemon
 * runs is the tag it built (no run/build-tag drift) and a manifest change rebuilds the deps layer.
 */
function containerDockerConfig(
  target: TargetConfig,
  logger: Logger,
  configPath: string | undefined,
  alwaysForwardEnv: string[],
): DockerRunnerConfig {
  const credentials: ContainerCredentialMounts = {
    claudeConfigDir: process.env.RALPH_CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    codexHome: process.env.CODEX_HOME,
    githubTokenEnv: process.env.GH_TOKEN ? "GH_TOKEN" : undefined,
    zaiTokenEnv: process.env.RALPH_ZAI_TOKEN_ENV,
    alwaysForwardEnv,
  };
  // The runner needs to know which repo it works and where to read the daemon config from
  // (`ralph-runner.ts` fails fast without `RALPH_TARGET_REPO`/a resolvable target).
  const runnerWiring = { targetRepo: target.targetRepo, configPath };

  // Operator-pinned image: run it as-is, no per-target build (the operator owns the lifecycle).
  const pinned = process.env.RALPH_AGENT_IMAGE;
  if (pinned) {
    return { image: pinned, credentials, ...runnerWiring };
  }

  // Default: ensure (build-on-cache-miss) the content-keyed per-target image before each dispatch,
  // and run exactly the tag it produced. The contract is re-read per resolve so a `.ralph/agent.*`
  // edit (or a merged dep bump) is picked up on the next run, not only on a daemon restart.
  const contextDir = target.paths.targetClone;
  const resolveImage = createTargetImageResolver({
    targetRepo: target.targetRepo,
    contextDir,
    loadContract: () => loadAgentContract(join(contextDir, DEFAULT_AGENT_CONTRACT_PATH)),
    sources: fsManifestSources(contextDir),
    builder: new DockerCliImageBuilder(),
    onEnsured: (ensured) =>
      logger.info("daemon.container-image", {
        repo: target.targetRepo,
        image: ensured.imageTag,
        built: ensured.built,
      }),
  });
  // `image` is unused while `resolveImage` is set (start() prefers the resolver); keep a
  // descriptive, never-built tag so a stray run without the resolver fails loud, not silently wrong.
  return { image: targetImageRef(target.targetRepo, "unbuilt"), resolveImage, credentials, ...runnerWiring };
}

/** Assemble the {@link Orchestrator} with one production reconciler per target. */
export function createOrchestrator(deps: DaemonDeps): AssembledDaemon {
  const { config, store, logger } = deps;
  const targets = resolveTargets(config);
  const cap = config.scheduler.maxConcurrentAgents;

  // The shared global BUILD budget (ADR-0020): every reconciler reads the SAME view,
  // which sums in-flight BUILD runs across ALL repos against the one cap. The merge
  // lease is free per-repo concurrency (ADR-0017), so it is NOT counted here. Closes
  // over the `reconcilers` array, fully populated below before any tick runs.
  const reconcilers: Reconciler[] = [];
  const globalBuild = (): number => reconcilers.reduce((n, r) => n + r.inFlightCount(), 0);
  const budget: ReconcileBudget = {
    available: () => Math.max(0, cap - globalBuild()),
    hasCapacity: () => globalBuild() < cap,
  };

  // ONE shared runId → AbortController registry (issue #118): every executor registers each
  // live session's controller here (keyed by run id, globally unique), while the orchestrator
  // receives only its abort-only port for DaemonControl.killRun — so a web-driven kill tears
  // down a specific run without exposing register/release outside executor wiring. The
  // reconciler's orphan sweep kills through the same registry via the executor.
  const abortRegistry = new RunAbortRegistry();

  // The shared Claude usage meter (ADR-0028) + the route-resolution headroom port (ADR-0037
  // P2.2), both built over the resolved account pool. The meter is sourced from the pool's
  // CLAUDE SLICE (`usageLimit.subscriptions` ∪ explicit `accounts:` claude entries), so a login
  // listed only under `accounts:` routes to its own configDir instead of the box default. The
  // reconciler reads the meter's gate to admit new work; impl runners fold rate-limit signals in.
  const { usageMeter, routeWorld } = buildUsageRouting(config, logger);
  // The separate z.ai cooldown meter (keyed "zai", ADR-0034): GLM rate-limit signals fold here,
  // never into the Claude plan window; the reconciler's admission gate reads it.
  const providerUsageMeter = new UsageMeter({ tokens: [{ id: "zai" }] });
  // The best-effort fold of a container-reported rate-limit signal into the right per-account meter
  // (ADR-0037/0038, issue #228) — claude → the OAuth meter by account id, z.ai → the cooldown meter,
  // never cross-fed. Replaces the retired in-process feed; every container runner relays through it.
  const recordRateLimit = buildRateLimitRecorder(usageMeter, providerUsageMeter);

  // Every configured z.ai account's key env-var name, forwarded into EVERY container regardless
  // of its route (issue #270): the in-container runner loadConfig-validates the FULL mounted
  // config at startup, so any `types.* → zai` route makes these vars a startup requirement for
  // every container — a claude/codex run missing them dies at config load, never emitting a
  // result frame, and the review loop maxes the run out. Pool-sourced so it matches exactly the
  // set `load.ts` validates. Startup-fixed like the pool itself (the routing overlay swaps
  // routes at runtime, but only among these accounts).
  const zaiKeyEnvNames = [
    ...new Set(resolveAccountPool(config).flatMap((a) => (a.provider === "zai" ? [a.authTokenEnv] : []))),
  ];

  // The runtime routing overlay (ADR-0037 P4.1, issue #166): one daemon-wide store seeded from the
  // loaded config. It is the live source every per-target `routing` thunk reads, so a web routing
  // edit takes effect on the next dispatch with no restart, and writes through to `config.yaml`
  // (gitignored → survives the self-update reset). The web control plane reads/writes it through a
  // port; the reconciler + executors only read it via the thunk below.
  const routingStore = new RoutingStore({ config, targets, configPath: deps.configPath, logger });

  for (const target of targets) {
    ensureTargetClone(target.targetRepo, target.paths.targetClone, logger);
    const github = deps.githubFor ? deps.githubFor(target) : new GhCliClient(target.targetRepo, { logger });
    const scopedStore = store.forRepo(target.targetRepo);
    const baseBranch = detectDefaultBranch(target.paths.targetClone);
    const worktrees = new GitWorktreeManager(target.paths.targetClone, target.paths.worktreeRoot, {
      baseBranch,
    });
    // Distinguishability (issue #149): log each agent type's most-preferred configured route
    // (the preference-list head) so a GLM/Codex session is identifiable in the structured log,
    // never read as "claude". The CONCRETE provider·model·account is now resolved per agent
    // start (resolve-at-call); recording the resolved route per phase is a later ADR-0037 slice.
    for (const type of AGENT_TYPES) {
      const head = providerForAgentType(target.agent, type);
      logger.info("daemon.agent-provider", {
        target: target.targetRepo,
        type,
        provider: head.provider,
        model: head.modelOverride ?? "(provider default)",
      });
    }
    // `executionMode` is a retired, accepted-but-ignored config key (#227): the strangler is over,
    // there is nothing to switch to, and there is no rollback to in-process. Surface a one-line
    // deprecation when an operator's gitignored config still carries it, so it is not silently
    // honoured-then-ignored — the schema keeps tolerating the key only so a live daemon does not
    // wedge on restart (ADR-0010 strict-zod would otherwise reject the unknown key).
    if (target.executionMode) {
      logger.warn("config.execution-mode-deprecated", {
        target: target.targetRepo,
        value: target.executionMode,
        reason: "executionMode is deprecated and ignored; every target runs in a fresh per-target container (#227)",
      });
    }
    // Auto-mode moding (#136) used to run its SDK session in the daemon (the in-process path); with
    // that path retired (#227) there is no in-daemon classifier to wire, and containerized moding is
    // a follow-up (ADR-0038: every agent type containerizes through the one seam). Surface it loudly
    // when an operator enabled auto-mode so unmoded issues are explained, not silently dropped.
    if (target.autoMode.enabled) {
      logger.warn("moding.unavailable", {
        target: target.targetRepo,
        reason: "auto-mode moding is not yet containerized; the in-process classifier was retired (#227)",
      });
    }
    // Container-only composition root (ADR-0038 / #227): every target runs each impl, review, and
    // fix through a fresh per-target container via the drop-in container adapters — the executor,
    // the review loop's CI gate + phase machine, and the squash-merge stay byte-for-byte unchanged.
    // Route SELECTION (`resolveRoute`) still lives in the daemon and drives the reconciler's
    // no-provider admission wait below; route EXECUTION (the SDK session) lives only in the
    // container. `routing` reads the runtime overlay (ADR-0037 P4.1) live, so a web routing edit is
    // reflected on the next dispatch with no daemon restart; an in-flight container is unaffected.
    const routing: RoutingSource = routingStore.routingSourceFor(target.targetRepo);
    const docker = new DockerCliRunner(containerDockerConfig(target, logger, deps.configPath, zaiKeyEnvNames));
    const agentRunner: AgentRunner = new ContainerAgentRunner({
      docker,
      store: scopedStore,
      config: target,
      baseBranch,
      // Route resolution per run (ADR-0037 / issue #220): the daemon resolves the impl
      // `{ provider, model, account }` from the SAME live `routing` + headroom `routeWorld` the
      // reconciler's no-provider admission wait uses, mounts the selected account into the
      // container, and injects provider/model. A no-provider wait defers the run (no dispatch).
      routing,
      routeWorld,
      // Fold a container-reported rate-limit signal back into the dispatched account's meter over
      // the best-effort pipe (ADR-0037/0038, issue #228), so the next route resolution sees current
      // headroom; a dropped signal just leaves the meter staler, never a lost run.
      recordRateLimit,
      // Drain gate (issue #35): the impl/resume runner refuses fresh container dispatch once a
      // drain is signalled, while in-flight runs' review/fix containers still complete.
      drainSignal: deps.drain,
    });
    const reviewLoop = new ReviewLoop({
      store: scopedStore,
      github,
      // The review pass and each fix attempt run in a fresh container (#189), producing the same
      // worklist / verdict / FixOutcome contract the review loop's CI gate + phase machine consume.
      // Each resolves its own route per run (ADR-0037 / #220) — review and fix are capability-open.
      // `store` lets each adapter record its resolved route per phase at dispatch (ADR-0037 P3.1,
      // #164) — the same scoped store the impl runner records its impl-phase route through.
      // `recordRateLimit` folds each phase's container-reported rate-limit signal back into the
      // dispatched account's meter (#228), exactly as the impl/resume runner does above.
      reviewAgent: new ContainerReviewAgentRunner({ docker, config: target, baseBranch, routing, routeWorld, store: scopedStore, recordRateLimit }),
      fixAgent: new ContainerFixAgentRunner({ docker, config: target, baseBranch, routing, routeWorld, store: scopedStore, recordRateLimit }),
      logger,
      maxFixAttempts: target.review.maxFixAttempts,
      maxContainerRetries: target.review.maxContainerRetries,
      worktrees,
      baseBranch,
      merge: target.merge,
    });
    const escalation = new EscalationCheckpointer({ store: scopedStore, github, worktrees });
    const executor = new Executor({
      store: scopedStore,
      github,
      worktrees,
      agentRunner,
      logger,
      reviewLoop,
      escalation,
      heartbeatMs: target.agent.heartbeatSeconds * 1000,
      // On a graceful drain, a Codex session killed by the terminal SIGINT (its CLI
      // shares the daemon's process group, ADR-0033) must be left resumable, not
      // terminalized to agent-stuck — see ExecutorDeps.drainSignal.
      drainSignal: deps.drain,
      // The shared registry: this run's live session registers here so DaemonControl.killRun
      // (driven by the orchestrator over the same instance) can abort it by run id (#118).
      abortRegistry,
    });

    reconcilers.push(
      new Reconciler({
        store: scopedStore,
        github,
        executor,
        worktrees,
        // Container orphan-sweep port (ADR-0038): the same DockerCliRunner the executor dispatches
        // through, reused by the reconciler's orphan sweep to kill containers with no live run.
        containers: docker,
        logger,
        budget,
        cap,
        priorityLabels: target.priorityLabels,
        maxClaimFailures: config.scheduler.maxClaimFailures,
        maxRunLifetimeMs: config.scheduler.maxRunLifetimeSeconds * 1000,
        // The off-slot CI poller (ADR-0022 stage 1) times out a parked `awaiting-ci`
        // run on the same budget the on-slot gate uses.
        ciTimeoutMinutes: target.merge.ciTimeoutMinutes,
        targetRepo: target.targetRepo,
        reconcileIntervalSeconds: config.scheduler.reconcileIntervalSeconds,
        autoMode: target.autoMode,
        // No `modeClassifier`: auto-mode moding ran the SDK in the daemon (the in-process path,
        // retired #227); the reconciler's moding pass is an exact no-op without a classifier, and
        // containerized moding is a follow-up (ADR-0038). The `autoMode` config still flows so the
        // pass re-arms the moment a classifier is wired.
        usageMeter,
        providerUsageMeter,
        usageLimit: config.usageLimit,
        // Route resolution inputs for the no-provider admission wait (ADR-0037 P2.3): the
        // SAME live `routing` (read per agent start, so a runtime overlay is a drop-in) and
        // daemon-wide headroom `routeWorld` the executors resolve through. Each tick the
        // reconciler resolves the impl route; no headroom → the otherwise-eligible queue
        // waits as `no-provider` (kept `ready-for-agent`), re-resolved automatically next tick.
        routing,
        routeWorld,
        // The no-provider wait's reset ETA (ADR-0037 P3.2): the soonest the claude pool (the v1
        // metered impl provider) regains headroom, stamped onto the parked backlog rows.
        implProviderResetsAt: () => implProviderResetsAt(usageMeter, config.usageLimit.admitBelowPercent, Date.now()),
        // Two-tier transcript retention (ADR-0030): one shared budget, each reconciler
        // prunes its own repo's verbose transcripts oldest-first; the timeline is permanent.
        transcriptRetention: {
          budget: {
            maxAgeDays: config.transcript.retentionDays,
            ...(config.transcript.maxTotalMb != null
              ? { maxTotalBytes: config.transcript.maxTotalMb * 1024 * 1024 }
              : {}),
          },
          everyTicks: config.transcript.pruneEveryTicks,
        },
      }),
    );
  }

  // Self-update (issue #30, ADR-0018): when enabled, one checker over the daemon's
  // OWN repo so it drains + exits 75 on a new commit. Off by default — `undefined`
  // leaves self-update disabled. Independent of the targets.
  const selfUpdate = config.selfUpdate.enabled
    ? {
        checker: new GitUpdateChecker(config.selfUpdate.repoDir, config.selfUpdate.branch, { logger }),
        checkEveryTicks: config.selfUpdate.checkEveryTicks,
        drainTimeoutSeconds: config.selfUpdate.drainTimeoutSeconds,
      }
    : undefined;

  return {
    orchestrator: new Orchestrator({ reconcilers, store, logger, selfUpdate, runAbort: abortRegistry }),
    usageMeter,
    targets,
    routingStore,
  };
}

/**
 * Run the reconcile loop until a shutdown signal fires, then drain gracefully
 * (issue #35). Returns how the drain ended so the entry point can set its exit
 * status (0 only when nothing was left in flight) and surface any stalled runs.
 */
/** Handle returned by {@link startNotificationSink}; `stop()` detaches the sink. */
export interface NotificationSinkHandle {
  stop(): void;
}

/**
 * Start the out-of-app notification sink (issue #117), or return `null` if it is
 * disabled. The sink is the after-commit event stream's second subscriber (the first is
 * the live SSE feed, ADR-0029): it pages the configured ntfy/webhook endpoints when the
 * daemon needs the operator and the UI is not open — a new escalation / heal / stuck, a
 * daemon-anomaly, and a stalled daemon.
 *
 * Like the web control plane it is an isolated edge: started once here, NEVER touched by
 * the reconcile loop, and its dispatch is fire-and-forget so a slow / failing endpoint
 * can never back-pressure the tick. The stall probe reads daemon liveness off the
 * persisted snapshot (the same `lastTickAt` the Health view shows) on its own `unref`'d
 * timer, with an optional suppression hook for intentional no-tick windows such as
 * graceful drain. Never throws — a wiring fault is logged and the daemon runs on
 * un-paged.
 */
/**
 * Resolve the daemon's VAPID identity for web push (issue #119) from the configured env-var
 * NAME, or `null` when web push is disabled or the key is missing/malformed. Never throws — a
 * misconfiguration is logged and the daemon runs un-paged (the sink's best-effort contract).
 * The same identity feeds the notification sink's web-push dispatcher AND the web control
 * plane's `/api/webpush/vapid` endpoint, so a device subscribes with the very key that signs
 * its pushes.
 */
export function resolveWebPushIdentity(deps: {
  config: RalphConfig;
  logger: Logger;
  readEnv?: (name: string) => string | undefined;
}): VapidIdentity | null {
  const { config, logger } = deps;
  const webpush = config.notifications.webpush;
  if (!webpush.enabled) {
    return null;
  }
  const readEnv = deps.readEnv ?? ((name: string) => process.env[name]);
  // The config's superRefine guarantees `subject` + `privateKeyEnv` are present once `enabled`,
  // but the schema types them optional — guard defensively so a malformed config never throws here.
  if (!webpush.subject || !webpush.privateKeyEnv) {
    logger.warn("notify.webpush-misconfigured", {});
    return null;
  }
  const scalarB64 = readEnv(webpush.privateKeyEnv);
  if (!scalarB64 || scalarB64.length === 0) {
    logger.warn("notify.webpush-no-key", { env: webpush.privateKeyEnv });
    return null;
  }
  try {
    return resolveVapidIdentity({ privateKeyScalarB64url: scalarB64, subject: webpush.subject });
  } catch (err) {
    logger.warn("notify.webpush-bad-key", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export function startNotificationSink(deps: {
  config: RalphConfig;
  store: Store;
  logger: Logger;
  /** The daemon-resolved VAPID identity shared with `/api/webpush/vapid`, or `null`. */
  vapid: VapidIdentity | null;
  suppressStallProbe?: () => boolean;
}): NotificationSinkHandle | null {
  const { config, logger, store } = deps;
  if (!config.notifications.enabled) {
    logger.info("notify.disabled", {});
    return null;
  }
  const stallSeconds = config.notifications.stallSeconds;
  try {
    // The fan-out dispatchers the sink feeds: the ntfy/webhook dispatcher (always, a no-op when
    // endpoints is empty) and — when web push is configured — the web-push dispatcher (another
    // delivery target for the same escalation/anomaly/stall events, issue #119). Both are
    // fire-and-forget and isolated from each other (ADR-0029).
    const dispatchers: NotificationDispatchPort[] = [
      new NotificationDispatcher({ endpoints: config.notifications.endpoints, logger }),
    ];
    // Construct the web-push dispatcher only once we hold a real identity (feature enabled + a
    // VAPID key resolved); the local narrows `deps.vapid` to non-null so the dispatcher's boundary
    // owns the invariant rather than threading a nullable identity through the push stack.
    const webpushVapid = config.notifications.webpush.enabled ? deps.vapid : null;
    if (webpushVapid !== null) {
      dispatchers.push(
        new WebPushDispatcher({
          vapid: webpushVapid,
          subscriptions: () =>
            store.listPushSubscriptions().map(
              (sub): WebPushSubscription => ({
                endpoint: sub.endpoint,
                p256dh: sub.p256dh,
                auth: sub.auth,
              }),
            ),
          deleteSubscription: (endpoint) => store.deletePushSubscription(endpoint),
          logger,
        }),
      );
    }
    const daemonHealth = createDaemonHealthPort(store);
    const sink = new NotificationSink({
      feed: createLiveFeedPort(store),
      dispatcher: new CompositeNotificationDispatcher(dispatchers, logger),
      logger,
      // Daemon liveness = the freshest persisted tick instant (null before the first tick).
      stallProbe: () => daemonHealth.lastTickAt(),
      stallThresholdMs: stallSeconds * 1000,
      suppressStallProbe: deps.suppressStallProbe,
      // Probe at most once a minute, or faster for a sub-minute threshold.
      pollIntervalMs: Math.min(stallSeconds, 60) * 1000,
    });
    sink.start();
    logger.info("notify.sink-enabled", {
      endpoints: config.notifications.endpoints.length,
      webpush: webpushVapid !== null,
      stallSeconds,
    });
    return { stop: () => sink.stop() };
  } catch (err) {
    // A sink wiring fault must never abort the daemon (it is a best-effort edge).
    logger.warn("notify.start-failed", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function runDaemon(deps: DaemonDeps, shutdown: ShutdownSignals): Promise<DaemonRunOutcome> {
  // Thread the graceful-drain signal into the orchestrator's executors so a drain-killed
  // Codex session is left resumable, not terminalized to agent-stuck (issue #131).
  const { orchestrator, usageMeter, targets, routingStore } = createOrchestrator({ ...deps, drain: shutdown.drain });
  const intervalMs = deps.config.scheduler.reconcileIntervalSeconds * 1000;
  const drainTimeoutMs = deps.config.scheduler.drainTimeoutSeconds * 1000;
  deps.logger.info("daemon.start", {
    targets: targets.map((t) => t.targetRepo),
    maxConcurrentAgents: deps.config.scheduler.maxConcurrentAgents,
    intervalSeconds: deps.config.scheduler.reconcileIntervalSeconds,
    drainTimeoutSeconds: deps.config.scheduler.drainTimeoutSeconds,
    selfUpdate: deps.config.selfUpdate.enabled,
  });

  // Web push uses one resolved VAPID identity for both halves of ADR-0036: the browser subscribes
  // against `/api/webpush/vapid`, and the notification sink signs pushes with the same key.
  const vapid = resolveWebPushIdentity({ config: deps.config, logger: deps.logger });

  // The embedded web control plane (ADR-0029) is an isolated edge: started once
  // here and NEVER touched by the reconcile loop below. A bind failure is logged
  // and non-fatal EXCEPT `EADDRINUSE`, which `startWebControlPlane` rethrows: the
  // port is a single-daemon resource, so a collision signals a second daemon
  // (issue #240) and we must crash rather than run on headless and race. It serves the SPA + read
  // API off its own `unref`'d socket, so it neither holds the process open nor delays
  // the drain. We stop it after the loop has fully drained.
  const web = await startWebControlPlane({
    config: deps.config,
    targets,
    logger: deps.logger,
    store: deps.store,
    // A read-only handle on the shared meter (ADR-0028): the Health view surfaces its
    // dual-login utilization / cooldowns; `snapshot()` never flips the active pointer.
    usage: () => usageMeter.snapshot(),
    // Tier-2 daemon control (issue #118): the orchestrator IS the DaemonControl port — the
    // `/api/daemon/*` routes call it (drain / force-tick / kill-run) and never reach reconciler
    // internals or the executor's abort handles.
    control: orchestrator,
    // The runtime routing overlay (ADR-0037 P4.1, issue #166): the SAME store the reconcilers +
    // executors resolve routes through, so a web edit is reflected on the next dispatch with no
    // restart. `/api/routing` reads it; `/api/routing/edit` writes it (overlay + config.yaml).
    routing: routingStore,
    // The web-push VAPID identity (issue #119): resolved from the configured env-var NAME so the
    // `/api/webpush/vapid` endpoint serves the very key the notification sink signs pushes with.
    // A null identity (push disabled / misconfigured) leaves the endpoint answering `enabled:false`.
    vapid,
  });

  // The notification sink starts after startup rehydrate, so its "from head" cursor
  // excludes cold-store recovery facts for already-paused runs but still precedes the
  // first live tick. It remains an isolated edge and is stopped after the loop drains;
  // only its stall probe is paused while shutdown/self-update is intentionally draining
  // without reconcile ticks.
  let notify: NotificationSinkHandle | null = null;

  try {
    await orchestrator.startup();
    notify = startNotificationSink({
      config: deps.config,
      store: deps.store,
      logger: deps.logger,
      vapid,
      suppressStallProbe: () => shutdown.drain.aborted || orchestrator.restartForUpdateRequested(),
    });
    const outcome = await orchestrator.runForever({
      intervalMs,
      drainSignal: shutdown.drain,
      forceSignal: shutdown.force,
      drainTimeoutMs,
    });
    deps.logger.info("daemon.stop", {
      outcome: outcome.outcome,
      stillInFlight: outcome.stillInFlight,
      restartForUpdate: outcome.restartForUpdate,
    });
    return outcome;
  } finally {
    notify?.stop();
    if (web) {
      await web.stop().catch((err) => deps.logger.warn("web.stop-failed", { error: String(err) }));
    }
  }
}
