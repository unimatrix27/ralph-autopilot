/**
 * The in-container halves of the runner's ports (ADR-0038 / issue #185): a git-clone
 * {@link WorkspaceCloner} and an {@link SessionHost} that hosts the impl SDK session via the
 * one session-drive primitive ({@link runReapedWallClockedSession}, ADR-0035) — running
 * *inside* the container (the in-process-in-the-daemon path is retired, #227). These are the
 * concrete implementations the {@link import("../bin/ralph-runner")} entrypoint wires; the
 * runner's orchestration over them is unit-tested in `runner.test.ts`, while these shell out
 * to `git` and the Claude SDK, so they are smoke-tested in a real container, not in CI.
 *
 * The session host runs the assignment's **pre-built prompt** directly through the primitive —
 * the container carries no `Issue` and makes no GitHub read to learn what to do (ADR-0038). The
 * agent commits/pushes/opens its PR itself, prompt-driven; the daemon reads the PR back through
 * its normal reconcile.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { query, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { runReapedWallClockedSession, loadBoxMcpServers, type EndpointOverride, type QueryFn } from "../executor/agent";
import { createProcessGroupReaper } from "../executor/process-reaper";
import { createRalphToolServer, ESCALATE_SERVER } from "../executor/escalate-tool";
import { extractJsonObject, runStructuredWithBackend } from "../executor/structured-session";
import { ClaudeSessionBackend } from "../providers/claude-backend";
import { CodexSessionBackend, type CodexClient } from "../providers/codex-backend";
import { SdkCodexClient } from "../providers/codex-client";
import type { SessionBackend } from "../providers/backend";
import type { RateLimitSignal } from "../core/usage";
import type { TranscriptSink } from "../executor/transcript-sink";
import { buildEscalationDraftPr, formatRalphQuestion, type EscalationQuestion } from "../review/escalation";
import { REVIEW_SYSTEM_APPEND } from "../review/prompts";
import { fixOutcomeSchema } from "../review/structured";
import { parseWorklist } from "../review/worklist";
import type { FixOutcome } from "../review/agents";
import type { ProviderName, TargetConfig } from "../config/schema";
import type { Assignment, SessionProfile } from "./assignment";
import { CONTAINER_CODEX_HOME, MODEL_ENV_VAR, PROVIDER_ENV_VAR, ZAI_TOKEN_ENV_NAME_VAR } from "./docker-runner";
import type { FixSessionHost, ReviewSessionHost, RunnerEscalation, RunnerEscalationInput, RunnerWorkspace, SessionHost, SessionHostInput, WorkspaceCloner } from "./runner";

/**
 * Run a git subcommand in `cwd`, returning stdout (throws with stderr on a non-zero exit).
 * One shape for every git call site, exactly like {@link RunGh}: most callers (the cloner's
 * clone/fetch/checkout, the escalation host's add/commit/push) ignore the returned string — their
 * stdout is empty and git progress rides stderr, which is piped too — while the rebase-conflict fix
 * path is the one consumer that reads it (the runner reads the net diff for the #241 guard and
 * force-pushes the resolved history; the agent session cannot, force-push is blocked, DESIGN §8).
 * Injectable for tests.
 */
export type RunGit = (args: string[], cwd?: string) => string;

const realGit: RunGit = (args, cwd) => {
  const res = spawnSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${res.stderr?.trim() || `exit ${res.status}`}`);
  }
  return res.stdout ?? "";
};

/** What a {@link createGitCloner} needs to fresh-clone the run's branch (ADR-0038 L3). */
export interface GitClonerConfig {
  /** The `owner/repo` the container works (the daemon passes it in; the runner makes no GitHub read for it). */
  repo: string;
  /** Token used to authenticate the clone/push (the GitHub PAT/OAuth token mounted into the container). */
  token: string;
  /** GitHub host (default `github.com`); overridable for GHE. */
  host?: string;
  /** Override the git runner (tests) / the temp-dir factory (tests). */
  runGit?: RunGit;
  makeWorkDir?: () => string;
}

/**
 * A {@link WorkspaceCloner} that fresh-clones into a new temp working tree — the clean, per-run
 * filesystem the freshness guarantee promises. The remote carries the token so the agent's own
 * push lands without further auth.
 *
 * The branch it clones is the run's *kind*: a **fresh impl** run clones the assignment's base and
 * forks the WIP branch on top; a **resume** (the assignment carries the operator's `answer`,
 * DESIGN §6) clones the WIP branch **directly** — the prior work is already committed there, so
 * resume continues it rather than restarting from base. Either way the result is a fresh clone,
 * never a reused tree (resume-not-restart is a fresh container + fresh session, not a rehydrated
 * one; ADR-0008 / ADR-0038).
 */
export function createGitCloner(config: GitClonerConfig): WorkspaceCloner {
  const runGit = config.runGit ?? realGit;
  const host = config.host ?? "github.com";
  const makeWorkDir = config.makeWorkDir ?? (() => mkdtempSync(join(tmpdir(), "ralph-run-")));
  const url = `https://x-access-token:${config.token}@${host}/${config.repo}.git`;
  return {
    async clone(assignment: Assignment): Promise<RunnerWorkspace> {
      const dir = makeWorkDir();
      const path = join(dir, "clone");
      // Clone the run's *existing* branch directly — no base-clone, no fork — when the code the
      // run operates on already lives on that branch: a resume (#188, the WIP branch carries the
      // prior work) or a review/fix pass (#189, the code under review is the PR's head branch; a
      // fix then pushes back to it runner-direct).
      const onExistingBranch =
        assignment.answer != null || assignment.kind === "review" || assignment.kind === "fix";
      if (onExistingBranch) {
        runGit(["clone", "--branch", assignment.branch, "--single-branch", url, path]);
        // A `--single-branch` clone only tracks the PR branch — `git fetch origin <base>` would
        // update FETCH_HEAD but NOT create `refs/remotes/origin/<base>`, so a rebase-conflict
        // fix agent could not `git rebase origin/<base>`. Pre-fetch base with an explicit refspec
        // so the agent (and the runner's post-fix #241 check) can target it (#273).
        if (assignment.kind === "fix" && assignment.rebaseConflict) {
          runGit(["fetch", "origin", `${assignment.base}:refs/remotes/origin/${assignment.base}`], path);
        }
        return { path };
      }
      runGit(["clone", "--branch", assignment.base, "--single-branch", url, path]);
      // Fork the run's WIP branch off the freshly-cloned base (create-or-reset; a redo is clean).
      runGit(["checkout", "-B", assignment.branch], path);
      return { path };
    },
  };
}

/**
 * The route the daemon resolved for this container (ADR-0037 / issue #220), read from the injected
 * env: the provider kind it runs on and the optional model override. The *account* is not data here
 * — it arrived as the mounted credential (claude `~/.claude`, codex `~/.codex`) / a forwarded token
 * env — so the route is just `{ provider, model? }`.
 */
export interface InContainerRoute {
  provider: ProviderName;
  model?: string;
}

/** The env var reader the in-container session hosts read the route + z.ai key through. */
export type EnvReader = (name: string) => string | undefined;

const KNOWN_PROVIDERS: ReadonlySet<string> = new Set<ProviderName>(["claude", "openai", "zai"]);

/**
 * Read the resolved route from the daemon-injected env ({@link PROVIDER_ENV_VAR} /
 * {@link MODEL_ENV_VAR}), ADR-0037 / issue #220. **No box-default fallback**: a missing or unknown
 * provider throws (fail loud) rather than silently running on the box-default login — the daemon
 * always injects the route it resolved, so its absence is a wiring fault, not a default to paper over.
 */
export function readContainerRoute(env: EnvReader): InContainerRoute {
  const provider = env(PROVIDER_ENV_VAR);
  if (!provider) {
    throw new Error(`${PROVIDER_ENV_VAR} is unset — the daemon must inject the resolved route (no box-default fallback)`);
  }
  if (!KNOWN_PROVIDERS.has(provider)) {
    throw new Error(`${PROVIDER_ENV_VAR}='${provider}' is not a known provider kind (claude|openai|zai)`);
  }
  const model = env(MODEL_ENV_VAR);
  return model ? { provider: provider as ProviderName, model } : { provider: provider as ProviderName };
}

/**
 * Apply the route's per-type model override (ADR-0037): swap `agent.model` so a claude session runs
 * on the resolved model. Absent model → the config is returned unchanged (the provider default).
 */
export function withModelOverride(config: TargetConfig, model: string | undefined): TargetConfig {
  return model ? { ...config, agent: { ...config.agent, model } } : config;
}

/**
 * Apply the assignment's resolved {@link SessionProfile} (issue #278): swap `agent.effort` /
 * `agent.wallClockSeconds` so the impl session runs on the complexity tier's budget — the exact
 * {@link withModelOverride} discipline (the daemon resolved, the runner applies; the runner has
 * no tier logic). Absent/empty profile → the config is returned unchanged (the mounted globals).
 */
export function withProfileOverride(config: TargetConfig, profile: SessionProfile | undefined): TargetConfig {
  if (!profile || (profile.effort === undefined && profile.wallClockSeconds === undefined)) {
    return config;
  }
  return {
    ...config,
    agent: {
      ...config.agent,
      ...(profile.effort !== undefined ? { effort: profile.effort } : {}),
      ...(profile.wallClockSeconds !== undefined ? { wallClockSeconds: profile.wallClockSeconds } : {}),
    },
  };
}

/**
 * Resolve the z.ai {@link EndpointOverride} for a z.ai route inside the container (ADR-0034 /
 * ADR-0037): the API key is read from the env var the daemon forwarded + NAMED in
 * {@link ZAI_TOKEN_ENV_NAME_VAR}; the base URL + default model are provider-KIND settings from the
 * mounted `providers.zai`. The route's model overrides the kind default. Pure given `env`, so the
 * resolution is unit-testable without the SDK. Throws (fail loud) on a missing kind block or key.
 */
export function resolveZaiEndpoint(config: TargetConfig, model: string | undefined, env: EnvReader): EndpointOverride {
  const zai = config.providers.zai;
  if (!zai) {
    throw new Error("z.ai route but providers.zai is not configured in the mounted daemon config");
  }
  const tokenVar = env(ZAI_TOKEN_ENV_NAME_VAR);
  if (!tokenVar) {
    throw new Error(`${ZAI_TOKEN_ENV_NAME_VAR} is unset — the daemon must name the z.ai key env var`);
  }
  const authToken = env(tokenVar);
  if (!authToken) {
    throw new Error(`z.ai key env var '${tokenVar}' is unset or empty in the container`);
  }
  return { baseUrl: zai.baseUrl, authToken, model: model ?? zai.model };
}

/**
 * The Claude-SDK params a `claude`/`zai` route configures (ADR-0037 / issue #220) — the single
 * domain concept 'how a claude/zai route drives a Claude-SDK session', written once so it never has
 * to move in lockstep across two call sites. A `claude` route swaps `agent.model` (the model travels
 * in config, no endpoint); a `zai` route leaves config as-is and resolves the z.ai
 * {@link EndpointOverride} (the model travels on the endpoint). Consumed by both the impl
 * {@link createImplSessionHost} session and {@link structuredBackendForRoute}, each of which has
 * already excluded `openai` before calling this (impl fails loud, structured uses the Codex backend).
 */
export function claudeRouteParams(
  config: TargetConfig,
  route: InContainerRoute,
  readEnv: EnvReader,
): { config: TargetConfig; endpoint?: EndpointOverride } {
  const sessionConfig = route.provider === "claude" ? withModelOverride(config, route.model) : config;
  const endpoint = route.provider === "zai" ? resolveZaiEndpoint(config, route.model, readEnv) : undefined;
  return endpoint ? { config: sessionConfig, endpoint } : { config: sessionConfig };
}

/** Build the in-container Codex backend (openai route): codexHome is the fixed mount path. */
function codexBackend(config: TargetConfig, model: string | undefined, clientFactory: () => CodexClient): CodexSessionBackend {
  const openai = config.providers.openai;
  if (!openai) {
    throw new Error("openai route but providers.openai is not configured in the mounted daemon config");
  }
  return new CodexSessionBackend({
    client: clientFactory(),
    wallClockSeconds: config.agent.wallClockSeconds,
    model: model ?? openai.model,
    effort: config.agent.effort,
    // The selected account's CODEX_HOME is mounted at this fixed container path, never the host one.
    codexHome: CONTAINER_CODEX_HOME,
    ...(openai.baseUrl ? { baseUrl: openai.baseUrl } : {}),
  });
}

/**
 * The injectable seams the in-container session hosts use, all defaulting to the real
 * production wiring; tests inject fakes so the route → backend selection is exercised without the SDK.
 */
export interface ContainerSessionDeps {
  /** The Claude Agent SDK `query` fn (claude / z.ai path). */
  queryFn?: QueryFn;
  /** Reads an env var (the route + the z.ai key by name). Defaults to `process.env`. */
  readEnv?: EnvReader;
  /** Builds the Codex SDK client (openai path). Defaults to {@link SdkCodexClient}. */
  codexClientFactory?: () => CodexClient;
  /**
   * Run a git subcommand returning stdout (used only by the rebase-conflict fix path, where the
   * runner — not the agent session — force-pushes the resolved history). Defaults to
   * {@link realGit} (spawnSync); tests inject a recording fake.
   */
  runGit?: RunGit;
}

const defaultEnvReader: EnvReader = (name) => process.env[name];

/**
 * Build the structured {@link SessionBackend} for a review/fix run from the resolved route
 * (ADR-0037 / issue #220): `claude` → a {@link ClaudeSessionBackend} on the mounted login (model
 * overridden); `zai` → the same backend driven against z.ai's Anthropic-compatible endpoint; `openai`
 * → a {@link CodexSessionBackend} on the mounted `CODEX_HOME`. `review`/`fix` are capability-open, so
 * any provider is reachable here.
 */
export function structuredBackendForRoute(
  config: TargetConfig,
  route: InContainerRoute,
  transcriptSink: TranscriptSink,
  deps: ContainerSessionDeps,
  onRateLimit?: (signal: RateLimitSignal) => void,
): SessionBackend {
  const readEnv = deps.readEnv ?? defaultEnvReader;
  if (route.provider === "openai") {
    // The bare Codex backend has no usage meter on the daemon side (#228), so it carries no
    // rate-limit relay — its signal would have nowhere to fold.
    return codexBackend(config, route.model, deps.codexClientFactory ?? (() => new SdkCodexClient()));
  }
  // claude → swap the model; z.ai → the model travels on the endpoint, so leave config as-is.
  const { config: sessionConfig, endpoint } = claudeRouteParams(config, route, readEnv);
  return new ClaudeSessionBackend({
    config: sessionConfig,
    available: loadBoxMcpServers(),
    reaperFactory: createProcessGroupReaper,
    queryFn: deps.queryFn ?? query,
    transcriptSink,
    // Relay each rate-limit signal a review/fix session observes back to the daemon meter (#228).
    onRateLimit,
    ...(endpoint ? { endpoint } : {}),
  });
}

/**
 * An {@link SessionHost} that hosts one impl SDK session through {@link runReapedWallClockedSession}
 * (ADR-0035, the one session-drive primitive) against the cloned workspace, using the assignment's
 * pre-built prompt and the **resolved route** (ADR-0037 / issue #220). The impl capability gate
 * guarantees `claude` or `zai` (bare `openai` cannot host the in-session `escalate`/`stuck` tools),
 * so this drives the Claude SDK directly: a `claude` route swaps `agent.model`; a `zai` route runs
 * against z.ai's Anthropic-compatible endpoint (its model travels on the endpoint). The selected
 * claude account is the credential mounted at `~/.claude` — so no `configDir` override, but **not**
 * the box-default login: the daemon mounted the chosen account there. The transcript sink is the
 * runner's transport-backed relay, so the daemon captures the conversation over the pipe.
 *
 * **Construction is total — the openai capability guard (and z.ai endpoint resolution) live in
 * `run()`, not the constructor.** {@link import("../bin/ralph-runner")} builds all three session
 * hosts eagerly in one deps literal for *every* dispatch kind, but a `review`/`fix` run never runs
 * the impl host — it runs `reviewSession`/`fixSession` (which are capability-open on openai). So
 * constructing the impl host on an openai route must not throw, or an openai-routed review/fix run
 * would crash the container before {@link runContainerRunner} ever selects the right host. The
 * guard still fires (fail loud) if an openai route is ever actually *run* through the impl host —
 * a wiring fault the `resolveRoute` capability gate already prevents for impl.
 */
export function createImplSessionHost(
  config: TargetConfig,
  route: InContainerRoute,
  deps: ContainerSessionDeps = {},
): SessionHost {
  return {
    run(input: SessionHostInput) {
      if (route.provider === "openai") {
        // Defence in depth: the capability gate inside resolveRoute already keeps impl off bare
        // openai, so a route that reaches here is a wiring fault — fail loud rather than run
        // without the tools. Deferred into run() (not construction) so building the impl host is
        // total even on an openai route the daemon meant for a review/fix run (see fn doc).
        throw new Error("impl route resolved to bare openai, which cannot host escalate/stuck (capability gate)");
      }
      const readEnv = deps.readEnv ?? defaultEnvReader;
      // The tier's session budget first (issue #278): the daemon resolved the assignment's
      // profile from the issue's complexity label; apply it over the mounted globals so the
      // wall-clock + effort below run on the tier's budget. Impl-only — review/fix hosts
      // never see a profile.
      const profiled = withProfileOverride(config, input.assignment.profile);
      // claude → the model swaps in config; zai → the model rides on the endpoint, leave config as-is.
      const { config: sessionConfig, endpoint } = claudeRouteParams(profiled, route, readEnv);
      return runReapedWallClockedSession({
        config: sessionConfig,
        available: loadBoxMcpServers(),
        worktreePath: input.workspacePath,
        reaperFactory: createProcessGroupReaper,
        queryFn: deps.queryFn ?? query,
        prompt: input.assignment.prompt,
        transcriptSink: input.transcriptSink,
        // Relay each rate-limit signal the impl session observes back to the daemon meter over the
        // pipe (ADR-0037/0038, issue #228); the runner tags it with the run's provider.
        onRateLimit: input.onRateLimit,
        ...(endpoint ? { endpoint } : {}),
        // The in-session `escalate`/`stuck` tools, now hosted *inside* the container (ADR-0038,
        // #187): same MCP server + tool shapes as the in-process runner. `escalate`'s side effect
        // (push WIP + post the comment) is wired by the runner via `input.onEscalate` so it lands
        // runner-direct; `stuck` only records the report (the daemon owns the `agent-stuck` label).
        extraServers: escalateStuckServers(input),
      });
    },
  };
}

/**
 * A {@link ReviewSessionHost} that runs one review pass *inside the container* (ADR-0038 / issue
 * #189): it drives the assignment's pre-built review prompt through the **same** provider-neutral
 * structured-output contract the in-process review uses ({@link runStructuredWithBackend} over the
 * route-selected {@link SessionBackend}, the review rubric as `systemAppend`), so the worklist it
 * returns is byte-identical regardless of provider. The backend is built from the **resolved route**
 * (ADR-0037 / issue #220) — `review` is capability-open, so claude / z.ai / openai are all reachable
 * — with the selected account mounted/forwarded by the daemon. Shells the SDK, so it is smoke-tested
 * in a real container, not in the unit suite (the runner's orchestration over it is unit-tested).
 */
export function createReviewSessionHost(
  config: TargetConfig,
  route: InContainerRoute,
  deps: ContainerSessionDeps = {},
): ReviewSessionHost {
  return {
    review(input) {
      const backend = structuredBackendForRoute(config, route, input.transcriptSink, deps, input.onRateLimit);
      return runStructuredWithBackend(
        backend,
        { prompt: input.assignment.prompt, worktreePath: input.workspacePath, systemAppend: REVIEW_SYSTEM_APPEND },
        (text) => parseWorklist(extractJsonObject(text)),
      );
    },
  };
}

/**
 * Land a rebase-conflict resolution the **runner** owns (issue #273): after the fix agent rebased
 * the branch onto base in its clone and reported `fixed`, re-fetch base (a sibling may have
 * merged again mid-session), refuse if the rebase left no net work (the #241 data-loss guard —
 * never wipe a branch to base-equivalent), then force-with-lease the rewritten history. This runs
 * as the runner — outside the agent SDK session — so the git-guardrails force-push block
 * (DESIGN §8) does not apply: the harness, not the agent, owns every rebase force-push (ADR-0014),
 * now executed from the container clone (the only place the resolved rebase exists) rather than
 * the daemon worktree. Throws on any failure so the container reports `failed` → the daemon
 * retries / maxes the phase out, never silently landing nothing.
 */
export function pushResolvedRebase(
  runGit: RunGit,
  workspacePath: string,
  branch: string,
  base: string,
): void {
  // Re-fetch base with an explicit refspec: a `--single-branch` clone has no `origin/<base>`
  // tracking ref, and the guard must compare against the CURRENT base (a mid-session merge).
  runGit(["fetch", "origin", `${base}:refs/remotes/origin/${base}`], workspacePath);
  // #241 data-loss invariant (net diff vs base MUST be non-empty before any rebase force-push):
  // never force-push a branch with NO net diff vs base — it would wipe the branch to a
  // base-equivalent state, silently discarding the reviewed work. This is a DELIBERATELY SEPARATE
  // second copy of the guard — it runs in this runner's own process (`spawnSync` in the fix clone,
  // not the daemon worktree), so it cannot call the canonical predicate
  // GitWorktreeManager.hasNetDiffVsBase; it stands as defense-in-depth. Keep the two spellings in
  // lock-step: any tightening of one must land in the other.
  const changed = runGit(["diff", "--name-only", `origin/${base}...HEAD`], workspacePath);
  if (changed.trim() === "") {
    throw new Error(
      `refusing to force-push ${branch}: the resolved rebase leaves no net diff vs origin/${base} ` +
        `(would wipe the branch to base — #241).`,
    );
  }
  runGit(["push", "--force-with-lease", "origin", branch], workspacePath);
}

/**
 * A {@link FixSessionHost} that runs one fix attempt *inside the container* (#189). It drives the
 * assignment's pre-built fix prompt through the shared structured contract over the route-selected
 * {@link SessionBackend} (ADR-0037 / issue #220; `fix` is capability-open); the agent applies the
 * gating items, keeps build+test green, and **pushes runner-direct** (prompt-driven, exactly as
 * in-process), then this maps the structured output to a {@link FixOutcome} — `fixed` (it pushed)
 * or `escalate` (a risky structural change it refused to apply blind). A rebase-conflict fix is
 * the exception: the agent cannot force-push the rewritten history (git-guardrails, DESIGN §8),
 * so the runner lands it via {@link pushResolvedRebase} once the agent reports `fixed` (#273).
 * Smoke-tested in a real container.
 */
export function createFixSessionHost(
  config: TargetConfig,
  route: InContainerRoute,
  deps: ContainerSessionDeps = {},
): FixSessionHost {
  return {
    async fix(input): Promise<FixOutcome> {
      const backend = structuredBackendForRoute(config, route, input.transcriptSink, deps, input.onRateLimit);
      const parsed = await runStructuredWithBackend(
        backend,
        { prompt: input.assignment.prompt, worktreePath: input.workspacePath, systemAppend: REVIEW_SYSTEM_APPEND },
        (text) => fixOutcomeSchema.parse(extractJsonObject(text)),
      );
      // A rebase-conflict fix is owned end-to-end by the runner: the agent rebased + resolved in
      // this clone but could not push (force-push is blocked in agent sessions), so land the
      // rewritten history now. The daemon verifies it actually landed on origin (#273).
      if (parsed.outcome === "fixed" && input.assignment.rebaseConflict) {
        pushResolvedRebase(
          deps.runGit ?? realGit,
          input.workspacePath,
          input.assignment.branch,
          input.assignment.base,
        );
      }
      return parsed.outcome === "fixed" ? { kind: "fixed" } : { kind: "escalate", question: parsed.question };
    },
  };
}

/** Build the `ralph` MCP server carrying `stuck` (always) + `escalate` (when a publisher is wired). */
function escalateStuckServers(input: SessionHostInput): Record<string, McpServerConfig> {
  // Same canonical server the in-process agent builds (issue #187): one source of the server
  // identity + the single `any` tool element, so the two escalate/stuck wirings cannot drift.
  return {
    [ESCALATE_SERVER]: createRalphToolServer({
      onStuck: (report) => input.onStuck?.(report),
      onEscalate: input.onEscalate,
    }),
  };
}

/** What {@link createRunnerEscalation} needs to land an escalation on GitHub from inside the container. */
export interface RunnerEscalationConfig {
  /** The `owner/repo` the container works. */
  repo: string;
  /** The GitHub token mounted into the container (clone/push/comment auth). */
  token: string;
  /** GitHub host (default `github.com`); overridable for GHE. */
  host?: string;
  /** Override the git runner (tests). */
  runGit?: RunGit;
  /** Override the `gh` runner (tests); returns the command's stdout. */
  runGh?: RunGh;
}

/** Run a `gh` subcommand, returning stdout; throws with stderr on a non-zero exit. */
export type RunGh = (args: string[], cwd?: string) => string;

const realGh: RunGh = (args, cwd) => {
  const res = spawnSync("gh", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`gh ${args[0]} failed: ${res.stderr?.trim() || `exit ${res.status}`}`);
  }
  return res.stdout ?? "";
};

/**
 * A {@link RunnerEscalation} that lands an escalation **runner-direct** from inside the container
 * (ADR-0038 boundary split / issue #187): it pushes the run's WIP branch, opens (or reuses) a
 * draft PR as the checkpoint, and posts the structured `ralph-question` comment — all straight to
 * GitHub via the container's own mounted `git`/`gh`, so a blocked agent's question survives a dead
 * pipe. Returns the posted comment's id (+ the draft PR) for the runner to relay. The comment id is
 * read from `gh api` JSON so the daemon can index the open question without re-posting.
 *
 * Smoke-tested in a real container (it shells `git`/`gh`), not in the unit suite — the runner's
 * orchestration over this port is unit-tested against a fake (`runner.test.ts`).
 */
export function createRunnerEscalation(config: RunnerEscalationConfig): RunnerEscalation {
  const runGit = config.runGit ?? realGit;
  const runGh = config.runGh ?? realGh;
  const host = config.host ?? "github.com";
  return {
    async publish(input: RunnerEscalationInput): Promise<{ commentId: number; prNumber?: number }> {
      const { assignment, question, workspacePath } = input;
      // 1. Make the WIP durable: commit anything outstanding, then push the branch.
      runGit(["add", "-A"], workspacePath);
      // An empty commit is fine — the push is what makes the checkpoint durable for resume (#188).
      runGit(["commit", "-m", `[WIP] #${assignment.issueNumber} checkpoint (escalation)`, "--allow-empty"], workspacePath);
      runGit(["push", "--set-upstream", "origin", assignment.branch], workspacePath);

      // 2. Open (or reuse) a draft PR as the visible checkpoint.
      const prNumber = ensureDraftPr(runGh, config.repo, host, assignment, question);

      // 3. Post the structured ralph-question comment and read its id back from the API.
      const body = formatRalphQuestion(question);
      const out = runGh([
        "api",
        `repos/${config.repo}/issues/${assignment.issueNumber}/comments`,
        "-f",
        `body=${body}`,
        "--jq",
        ".id",
      ]);
      const commentId = Number(out.trim());
      if (!Number.isFinite(commentId)) {
        throw new Error(`gh did not return a numeric comment id for issue #${assignment.issueNumber}`);
      }
      return prNumber !== undefined ? { commentId, prNumber } : { commentId };
    },
  };
}

/** Open a draft PR for the WIP branch (best-effort), returning its number, or undefined if none. */
function ensureDraftPr(
  runGh: RunGh,
  repo: string,
  host: string,
  assignment: Assignment,
  question: EscalationQuestion,
): number | undefined {
  const { title, body } = buildEscalationDraftPr({
    issueNumber: assignment.issueNumber,
    branch: assignment.branch,
    headline: question.headline,
  });
  try {
    const out = runGh([
      "pr",
      "create",
      "--repo",
      repo,
      "--draft",
      "--head",
      assignment.branch,
      "--base",
      assignment.base,
      "--title",
      title,
      "--body",
      body,
    ]);
    // `gh pr create` prints the PR URL; parse the trailing number (https://<host>/<repo>/pull/<n>).
    const match = out.trim().match(new RegExp(`${host.replace(/\./g, "\\.")}/.+/pull/(\\d+)`));
    return match ? Number(match[1]) : undefined;
  } catch {
    // A PR may already exist for this branch (a re-escalation): the comment is what matters; the
    // pipe-relayed prNumber is optional, so a missing draft PR is non-fatal.
    return undefined;
  }
}
