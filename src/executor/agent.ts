/**
 * The impl agent: a Claude Agent SDK session (ADR-0008 / DESIGN §3). Each run is
 * fresh-context, OAuth-authenticated (never an API key), and handed the curated
 * MCP set with the `memory` server removed. The SDK `query()` is the runtime
 * executor of record — per the design-authority rule it is never replaced by a
 * CLI shell-out (ADR-0011).
 */

import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { query, type McpServerConfig, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { TargetConfig } from "../config/schema";
import type { Issue } from "../github/types";
import type { Logger } from "../log/logger";
import type { Mode } from "../store/types";
import type { EscalationQuestion } from "../review/escalation";
import { SYSTEM_APPEND, type ResumeInjection } from "./prompts";
import type { StuckHealGuidance } from "../hitl/heal-readmit";
import { type StuckReport } from "./stuck-tool";
import { createGitGuardrailsHook } from "./git-guardrails";
import { type SessionReaper } from "./process-reaper";
import { linkedAbortController } from "./abort-linking";
import { runWallClockedSession, WallClockExceededError } from "./wall-clock";
import type { TranscriptSink } from "./transcript-sink";
import { UsageLimitError, isUsageLimitError, type RateLimitSignal } from "../core/usage";

/** A query-compatible function, injectable so the wall-clock path is unit-testable. */
export type QueryFn = typeof query;

/** The `memory` MCP server is never handed to an agent (fresh context, ADR-0008). */
export const MEMORY_MCP = "memory";

export interface AgentRunContext {
  issue: Issue;
  mode: Mode;
  worktreePath: string;
  branch: string;
  logger: Logger;
  /**
   * The run's correlation tag (ADR-0022), the same `run.id` the domain events and the
   * transcript stream carry. The container runner uses it to key the run's telemetry → store
   * fold (ADR-0038). Always set by the executor; optional only so existing test contexts need
   * not thread it.
   */
  runId?: number;
  abortSignal?: AbortSignal;
  /**
   * Wires the custom `escalate` tool into the session. When the agent calls it,
   * this checkpoints the WIP and posts a `ralph-question` (DESIGN §6). Absent →
   * the session has no `escalate` tool.
   */
  onEscalate?: (question: EscalationQuestion) => Promise<void>;
  /**
   * Present when *resuming* a paused run: the agent is driven with the resume
   * prompt (its WIP branch + the operator's answer injected) instead of the
   * fresh impl prompt (CONTEXT: resume, not restart).
   */
  resume?: ResumeInjection;
  /**
   * Present when *re-admitting* a healed stuck issue (#86): a fresh impl run whose
   * prompt carries the operator's guidance for why the prior attempt stopped. Unlike
   * {@link resume} there is no WIP branch — this is a clean start, not a continuation.
   */
  stuckHeal?: StuckHealGuidance;
  /**
   * The transcript capture sink for this run (ADR-0030), built by the executor from the
   * run's (repo, issue, runId). Forwarded into the session chokepoint so the impl/resume
   * conversation is persisted. Absent → no capture (e.g. tests).
   */
  transcriptSink?: TranscriptSink;
}

export interface AgentRunResult {
  /** Whether the SDK session ended without error. The PR itself is read from GitHub. */
  ok: boolean;
  /** Whether the agent called `escalate` during the session (terminal — no review). */
  escalated: boolean;
  /**
   * Set when the run bounded out (terminal — no PR, `agent-stuck`): the agent
   * called the `stuck` tool to self-stop, or the daemon killed it on a wall-clock
   * overrun (`category: "wall-clock"`). `null` otherwise (DESIGN §§3,8).
   */
  stuck?: StuckReport | null;
  /**
   * Set when the session aborted on a transient provider **usage/session/rate limit**.
   * NOT a fault and NOT `agent-stuck`: the executor defers the issue (restores
   * `ready-for-agent`, drops the run) and the relevant usage cooldown blocks
   * re-admission until the window resets (DESIGN §3).
   */
  limited?: boolean;
}

/** Runs one impl session for a picked issue. Swapped for a fake in tests. */
export interface AgentRunner {
  run(ctx: AgentRunContext): Promise<AgentRunResult>;
}

/**
 * The curated MCP subset to hand the agent: the configured servers whose configs
 * are known on this box, with the `memory` server always excluded — even if it
 * is configured. This is the enforcement point for "fresh context, no memory".
 */
export function selectCuratedMcpServers(
  available: Record<string, McpServerConfig>,
  curatedNames: string[],
): Record<string, McpServerConfig> {
  const selected: Record<string, McpServerConfig> = {};
  for (const name of curatedNames) {
    if (name === MEMORY_MCP) {
      continue;
    }
    const config = available[name];
    if (config) {
      selected[name] = config;
    }
  }
  return selected;
}

/**
 * The token config-owned MCP server definitions may carry in `args`/`env` values; it is
 * substituted with the session's working tree when the session is built, so servers that need an
 * explicit project-root arg get the per-run one — a container's fresh `/tmp` clone or a box
 * worktree alike (issue #264).
 */
export const MCP_WORKSPACE_TOKEN = "${workspace}";

/**
 * Materialize the config-owned MCP server definitions (`agent.mcpServerDefs`, issue #264) into
 * SDK stdio configs for one session, substituting {@link MCP_WORKSPACE_TOKEN} in every arg and
 * env value with the session's working tree. Pure — the per-run resolution is unit-testable.
 */
export function resolveMcpServerDefs(
  defs: TargetConfig["agent"]["mcpServerDefs"],
  workspacePath: string,
): Record<string, McpServerConfig> {
  const sub = (value: string): string => value.split(MCP_WORKSPACE_TOKEN).join(workspacePath);
  const resolved: Record<string, McpServerConfig> = {};
  for (const [name, def] of Object.entries(defs)) {
    resolved[name] = {
      type: "stdio",
      command: def.command,
      args: def.args.map(sub),
      ...(def.env ? { env: Object.fromEntries(Object.entries(def.env).map(([k, v]) => [k, sub(v)])) } : {}),
    };
  }
  return resolved;
}

/**
 * Read the box's MCP server definitions from `~/.claude.json` so the curated set
 * can be resolved by name. Returns `{}` if the file is absent or unparseable —
 * the agent still runs, just without those servers.
 */
export function loadBoxMcpServers(path = join(homedir(), ".claude.json")): Record<string, McpServerConfig> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers?: Record<string, McpServerConfig>;
    };
    return parsed.mcpServers ?? {};
  } catch {
    return {};
  }
}

/**
 * The header under which a target repo's `AGENTS.md` is appended to the system
 * prompt (ADR-0019). The SDK auto-loads `CLAUDE.md` + `.claude/` via
 * `settingSources: ["project"]`, but it does NOT load `AGENTS.md` — so the harness
 * reads it from the worktree and injects it here, for impl, resume, review, and
 * fix sessions alike (this is the one wiring point all four share).
 */
export const AGENTS_MD_HEADER = "--- Target repo AGENTS.md (project conventions) ---";

/**
 * Read the target worktree's `AGENTS.md`, returning a labeled block to append to
 * the system prompt, or `null` when the file is absent or unreadable (the agent
 * still runs — it just has no AGENTS.md context). Co-located with the other agent
 * wiring so the one place that builds session options owns project-context loading.
 */
export function readAgentsMd(worktreePath: string): string | null {
  let body: string;
  try {
    body = readFileSync(join(worktreePath, "AGENTS.md"), "utf8").trim();
  } catch {
    return null;
  }
  return body ? `${AGENTS_MD_HEADER}\n${body}` : null;
}

/**
 * An Anthropic-compatible 3rd-party endpoint override (z.ai/GLM, ADR-0034 / issue #149).
 * When a session carries one, it runs against `baseUrl` with `authToken` (a Bearer API
 * key) and `model` instead of the box OAuth login — injected as env on the Claude SDK
 * path, no new SDK. The key is the only API-key credential the daemon handles; it is
 * read from an env var at runtime and never stored in config.
 */
export interface EndpointOverride {
  baseUrl: string;
  authToken: string;
  model: string;
}

/**
 * Build the SDK options for an agent session: fresh context, OAuth, curated MCP.
 * `systemAppend` defaults to the impl session's append; review/fix sessions pass
 * their own (they are the same fresh-context, OAuth, curated-MCP shape).
 */
export function buildAgentOptions(
  config: TargetConfig,
  ctx: {
    worktreePath: string;
    abortController?: AbortController;
    systemAppend?: string;
    /** In-process SDK MCP servers to merge in (e.g. the `escalate` tool). */
    extraServers?: Record<string, McpServerConfig>;
    /**
     * Custom CLI spawn hook (issue #13): when present, the SDK spawns the `claude`
     * CLI through it so the session owns a reapable process group. Absent → the
     * SDK's default local spawn (used by call sites that don't need reaping).
     */
    spawn?: Options["spawnClaudeCodeProcess"];
    /**
     * `CLAUDE_CONFIG_DIR` for this session's CLI (ADR-0028 dual-subscription): the
     * credential store of the active OAuth login. Absent → the box default
     * (`~/.claude`), i.e. exactly the single-login behaviour.
     */
    configDir?: string;
    /**
     * When present, drive this session against an Anthropic-compatible 3rd-party
     * endpoint (z.ai/GLM, ADR-0034) via env injection instead of the box OAuth login:
     * the model is overridden, the API key + base URL are injected as
     * `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL`, `CLAUDE_CONFIG_DIR` is omitted (there
     * is no OAuth store), and `forceLoginMethod` is dropped (it forces the OAuth login
     * method and conflicts with token auth). Mutually exclusive with `configDir`.
     */
    endpoint?: EndpointOverride;
  },
  available: Record<string, McpServerConfig> = {},
): Options {
  // Resolve the curated names against the box file AND the config-owned definitions (issue
  // #264) — config wins on a name collision. The box `~/.claude.json` never reaches a run
  // container, so for container sessions the config definitions are the only real source.
  const definitions = { ...available, ...resolveMcpServerDefs(config.agent.mcpServerDefs, ctx.worktreePath) };
  const mcpServers = { ...selectCuratedMcpServers(definitions, config.agent.mcpServers), ...ctx.extraServers };
  // Honour the TARGET repo's own agent-instruction files (ADR-0019): the SDK loads
  // its CLAUDE.md + .claude via settingSources (default ["project"], relative to the
  // worktree cwd); AGENTS.md is appended by the harness since the SDK won't. We keep
  // the operator's "user" layer + the memory MCP out, preserving ADR-0008's intent.
  const baseAppend = ctx.systemAppend ?? SYSTEM_APPEND;
  const projectAgents = readAgentsMd(ctx.worktreePath);
  const options: Options = {
    cwd: ctx.worktreePath,
    // Every agent session (impl, review, fix) runs on the configured model and
    // reasoning effort — uniform horsepower, including the thermo-nuclear pass and
    // conflict-resolving fixes (config.agent.model / .effort; default opus/xhigh). An
    // Anthropic-compatible endpoint (z.ai/GLM, ADR-0034) overrides the model to its own.
    model: ctx.endpoint ? ctx.endpoint.model : config.agent.model,
    effort: config.agent.effort,
    mcpServers,
    // Per-target project context (ADR-0019), default ["project"]: read the target
    // repo's CLAUDE.md/.claude relative to cwd, never the operator's "user" layer.
    // The OAuth credential is read from the box's claude login regardless.
    settingSources: config.agent.settingSources,
    // OAuth from this box only — never an API key (ADR-0008). `claudeai` forces the
    // Claude Pro/Max OAuth login method rather than a Console/API-key path. Dropped for
    // an Anthropic-compatible endpoint (ADR-0034): that path authenticates with a Bearer
    // token via env, and forcing the OAuth login method would conflict with it.
    ...(ctx.endpoint ? {} : { settings: { forceLoginMethod: "claudeai" } }),
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: projectAgents ? `${baseAppend}\n\n${projectAgents}` : baseAppend,
    },
    // git-guardrails: block dangerous local git ops on every agent session (DESIGN §8).
    hooks: {
      PreToolUse: [createGitGuardrailsHook()],
    },
  };
  if (ctx.abortController) {
    options.abortController = ctx.abortController;
  }
  if (ctx.spawn) {
    options.spawnClaudeCodeProcess = ctx.spawn;
  }
  if (ctx.endpoint) {
    // Drive this session against an Anthropic-compatible 3rd-party endpoint (z.ai/GLM,
    // ADR-0034): the SDK passes `Options.env` straight to the spawned CLI, which honours
    // `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` to reach z.ai with the API key. NO
    // `CLAUDE_CONFIG_DIR` — there is no OAuth store on this path. `env` REPLACES the child
    // env, so process.env is spread to keep PATH/etc. The key is injected at runtime here,
    // never persisted to config or the log redactor's path.
    options.env = {
      ...process.env,
      ANTHROPIC_BASE_URL: ctx.endpoint.baseUrl,
      ANTHROPIC_AUTH_TOKEN: ctx.endpoint.authToken,
    } as Record<string, string>;
  } else if (ctx.configDir) {
    // Route this session's credential to the active login's store (ADR-0028). The
    // SDK passes `Options.env` straight to the spawned CLI, which reads BOTH its
    // OAuth credential and writes its transcripts under `CLAUDE_CONFIG_DIR`, so two
    // concurrent sessions on different stores are fully isolated. `env` REPLACES the
    // child env, so process.env is spread to keep PATH/etc. Still OAuth-only — the
    // store just selects which `claude login` (ADR-0008 letter held).
    options.env = { ...process.env, CLAUDE_CONFIG_DIR: ctx.configDir } as Record<string, string>;
  }
  return options;
}

/**
 * The classified terminal result a Claude session-drive returns on a normal end
 * (issue #146). The primitive owns *detection* — it classifies the SDK's terminal
 * `result` message into this shape — but NOT the *disposition*: whether a non-cap
 * error is fatal (the backend throws) or non-fatal (impl falls through to
 * PR-presence) is the caller's decision, made off `isError`.
 */
export interface ClassifiedSessionResult {
  /** The terminal `result` subtype (`success`, `error_max_turns`, …). */
  subtype: string;
  /** The result's `is_error` flag — the not-success signal every caller keys on. */
  isError: boolean;
  /** The result body text (success text, or the error detail for the backend's message). */
  text: string;
  /** The result's `num_turns`. */
  turns: number;
}

/**
 * Everything one Claude SDK session needs — the single input to
 * {@link runReapedWallClockedSession}, the one session-drive primitive (ADR-0035) every
 * Claude-SDK-backed agent type flows through. It bundles the per-session request (prompt,
 * worktree, sink) with the session wiring (`reaperFactory`, `queryFn`). The primitive now runs
 * only **inside the container** (ADR-0038 / #227: the in-process execution path is retired) —
 * the runner hosts the reaper/query/sink/wall-clock there, not the daemon.
 */
export interface SessionParams {
  config: TargetConfig;
  available: Record<string, McpServerConfig>;
  worktreePath: string;
  /** The run's parent signal; linked into the per-session controller created here. */
  abortSignal?: AbortSignal;
  reaperFactory: () => SessionReaper;
  queryFn: QueryFn;
  prompt: string;
  /** System-prompt append; omit to default to the impl session's {@link SYSTEM_APPEND}. */
  systemAppend?: string;
  /** In-process SDK MCP servers to merge in (e.g. the `escalate` tool). */
  extraServers?: Record<string, McpServerConfig>;
  /** `CLAUDE_CONFIG_DIR` of the bound OAuth login (ADR-0028); absent = box default. */
  configDir?: string;
  /**
   * Anthropic-compatible endpoint override (z.ai/GLM, ADR-0034): when present, the
   * session runs against it via env injection instead of the box OAuth login. Mutually
   * exclusive with `configDir` (z.ai has no OAuth store).
   */
  endpoint?: EndpointOverride;
  /** Logs the overrun at the call site (issue number, etc.) before the kill. */
  onExpire?: () => void;
  /**
   * Fold each streamed rate-limit signal into the bound login's usage state — every
   * `rate_limit_event` window update, plus the synthesized `rejected` the primitive
   * fires when it detects a cap (the single meter trip, so no caller can re-trip or
   * skip it). Absent → signals are dropped (single-login / tests).
   */
  onRateLimit?: (signal: RateLimitSignal) => void;
  /**
   * The transcript capture sink (ADR-0030): the single, mode-agnostic point at which
   * every impl/resume/review/fix/moding session's `SDKMessage`s are persisted to the
   * run's transcript stream. Absent → no capture (e.g. unit tests, single-login boxes
   * that never wired a store).
   */
  transcriptSink?: TranscriptSink;
}

/**
 * The single owner of one Claude SDK session's lifecycle AND its terminal detection
 * (issues #13, #146). It does the whole reaper/spawn/wall-clock dance in one place so
 * no call site can get it half-wired, and it owns the *one* definition of the per-message
 * handling that was previously duplicated by impl and the backend — the divergence that
 * made the weekly-cap fix (23e357e) a two-place edit:
 *
 *  1. link the parent abort signal into a fresh per-session controller,
 *  2. create the per-session reaper (`reaperFactory`),
 *  3. build the agent options with *that* reaper's `spawn` hook threaded in, and
 *  4. run the `query()` loop under the wall-clock ceiling, handing the ceiling the
 *     *same* reaper so an overrun reaps the subprocess tree.
 *
 * Inside that loop it owns, once: forwarding each `rate_limit_event` to the meter
 * (`onRateLimit`), detecting a usage cap on the terminal `result` (re-casting it to a
 * typed {@link UsageLimitError} AFTER tripping the meter once — the single meter-trip),
 * and re-casting an overrun to {@link WallClockExceededError}. Both throws are the
 * terminals every caller recognises; what each caller does with a *non-cap* classified
 * result (disposition) stays at the call site.
 *
 * Because one function owns both wiring points, the spawn hook handed to the SDK and
 * the reaper handed to the ceiling are guaranteed to be the same instance — the
 * invariant that, split across modules, was unenforced (forget the spawn wiring and
 * `reap()` silently no-ops over an empty group).
 */
export async function runReapedWallClockedSession(params: SessionParams): Promise<ClassifiedSessionResult> {
  // One controller per session, linked to the run's parent signal so an outer
  // cancellation still aborts this session's query iteration.
  const abortController = linkedAbortController(params.abortSignal);
  // One reaper per session: the SDK spawns the CLI through it as a process-group
  // leader, so the wall-clock kill can reap the whole subprocess tree.
  const reaper = params.reaperFactory();
  const options = buildAgentOptions(
    params.config,
    {
      worktreePath: params.worktreePath,
      abortController,
      systemAppend: params.systemAppend,
      extraServers: params.extraServers,
      spawn: reaper.spawn,
      configDir: params.configDir,
      endpoint: params.endpoint,
    },
    params.available,
  );
  // Classified from the terminal `result` message as it streams; null until then.
  let classified: ClassifiedSessionResult | null = null;
  const { expired } = await runWallClockedSession(
    {
      abortController,
      wallClockSeconds: params.config.agent.wallClockSeconds,
      reaper,
      onExpire: params.onExpire,
    },
    async () => {
      for await (const message of params.queryFn({ prompt: params.prompt, options })) {
        // Transcript capture is a best-effort side-channel that never throws (ADR-0030),
        // so it can never mask the classification below.
        params.transcriptSink?.capture(message);
        // The single owner of every Claude session's rate-limit + cap handling (issue
        // #146): forward each window update to the meter, detect a cap on the terminal
        // result, trip the meter once, and throw the typed UsageLimitError. impl and the
        // backend no longer reimplement any of this — divergence here was the weekly-cap
        // two-place bug.
        if (message.type === "rate_limit_event") {
          params.onRateLimit?.(toRateLimitSignal(message.rate_limit_info));
        }
        if (message.type === "result") {
          const text = "result" in message && typeof message.result === "string" ? message.result : "";
          classified = { subtype: message.subtype, isError: message.is_error, text, turns: message.num_turns };
          // A capped session ends as an *error result* (`is_error`) whose limit text lives
          // in the body rather than as a thrown SDK error. Re-cast it to the typed
          // UsageLimitError so callers defer-not-terminalize, and trip the bound meter to
          // `rejected` (with the parsed reset) FIRST — this is the ONE meter trip, fired
          // before the throw, so no caller can double-trip or skip it (the weekly-cap
          // incident, 23e357e, terminalized the backlog precisely because this lived in
          // two divergent copies).
          if (message.is_error && isUsageLimitError(text)) {
            const limit = new UsageLimitError(text);
            params.onRateLimit?.({ status: "rejected", resetsAt: limit.resetsAtMs ?? undefined });
            throw limit;
          }
        }
      }
      // Flush captured appends before the session is torn down (best-effort; never throws).
      await params.transcriptSink?.flush();
    },
  );
  // On overrun the session was hard-killed: re-cast it to the typed wall-clock terminal
  // so the caller can tell a kill from a fault (the impl reports a `wall-clock` stuck;
  // the backend lets it propagate to `review-maxed`).
  if (expired) {
    throw new WallClockExceededError(params.config.agent.wallClockSeconds);
  }
  // The SDK always streams a terminal `result`; a normal end that streamed none is
  // anomalous (a truncated/aborted session). Default to a non-success classified result
  // so a caller never mistakes it for success — impl logs ok=false and falls through to
  // PR-presence, the backend throws "ended without success".
  return classified ?? { subtype: "", isError: true, text: "", turns: 0 };
}

/**
 * Normalize the SDK's streamed utilization to the **0–100** scale the usage core
 * expects ({@link import("../core/usage").usageGate} compares it against the integer
 * `admitBelowPercent`, e.g. 85). The streaming `SDKRateLimitInfo.utilization` is an
 * undocumented **0–1 fraction** — unlike the SDK's *structured* `/usage` field, which
 * is documented 0–100. Left unscaled, a window at 87% arrives as `0.87`, never trips
 * the gate, and the daemon burns the login past its weekly limit (ADR-0028 failover
 * never fires). A value already on the 0–100 scale (`> 1`) passes through, so this stays
 * correct if the SDK ever unifies the units; the result is clamped to 0–100.
 */
export function toUtilizationPercent(u: number | undefined): number | undefined {
  if (u == null || !Number.isFinite(u)) {
    return undefined;
  }
  const pct = u <= 1 ? u * 100 : u;
  return Math.max(0, Math.min(100, pct));
}

/** Reduce the SDK's `SDKRateLimitInfo` to the {@link RateLimitSignal} the meter folds in. */
export function toRateLimitSignal(info: {
  status?: "allowed" | "allowed_warning" | "rejected";
  utilization?: number;
  resetsAt?: number;
  rateLimitType?: string;
}): RateLimitSignal {
  return {
    status: info.status,
    utilization: toUtilizationPercent(info.utilization),
    resetsAt: info.resetsAt,
    rateLimitType: info.rateLimitType,
  };
}
