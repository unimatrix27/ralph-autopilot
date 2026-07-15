/**
 * The Claude provider backend (issue #131, ADR-0033 / ADR-0008): the exact session
 * body lifted out of structured-session.ts's old private `runSession`. It runs one session
 * through {@link runReapedWallClockedSession} — the one session-drive primitive (ADR-0035):
 * fresh-context, OAuth-only, curated-MCP, under the wall-clock ceiling + process-group reaper —
 * which owns terminal *detection*
 * (issue #146): it folds each streamed plan rate-limit signal into the bound login's
 * usage state (ADR-0028), re-casts a usage cap to a typed `UsageLimitError` (after the
 * single meter trip), and re-casts an overrun to a typed `WallClockExceededError`. This
 * backend's only remaining job is *disposition*: a non-cap error result is fatal (the
 * result text IS its contract), and both typed terminals propagate untouched.
 *
 * It is the default backend: an unconfigured daemon runs every structured session
 * through this, byte-for-byte identical to the pre-#131 path. It also backs the **z.ai
 * (GLM)** provider (ADR-0034 / issue #149): given an {@link ClaudeSessionBackendParams.endpoint}
 * override it runs the same SDK session against z.ai's Anthropic-compatible endpoint via
 * env injection — no new SDK, no OAuth login, and deliberately outside the OAuth usage
 * router so GLM usage never contaminates the Claude plan window.
 */

import { type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { TargetConfig } from "../config/schema";
import { runReapedWallClockedSession, type EndpointOverride, type QueryFn } from "../executor/agent";
import type { SessionReaper } from "../executor/process-reaper";
import type { TranscriptSink } from "../executor/transcript-sink";
import type { RateLimitSignal } from "../core/usage";
import type { SessionBackend, SessionRequest } from "./backend";

/** Everything a {@link ClaudeSessionBackend} needs that is constant across one session's retries. */
export interface ClaudeSessionBackendParams {
  config: TargetConfig;
  available: Record<string, McpServerConfig>;
  reaperFactory: () => SessionReaper;
  queryFn: QueryFn;
  /**
   * `CLAUDE_CONFIG_DIR` of the OAuth login this session is bound to (ADR-0028).
   * Absent → the box-default login.
   */
  configDir?: string;
  /**
   * When present, drive this session against an Anthropic-compatible 3rd-party endpoint
   * (z.ai/GLM) via env injection instead of the box OAuth login (ADR-0034 / issue #149):
   * the model + base URL + API key are injected onto the same SDK `env` seam, no new SDK.
   * A z.ai backend passes NO `configDir` and is NOT bound to the OAuth usage meter —
   * its quota signals may be forwarded to a separate provider cooldown meter, never the
   * Claude plan window (ADR-0028).
   */
  endpoint?: EndpointOverride;
  /**
   * Forward each streamed plan rate-limit signal to the meter, so the session's usage
   * folds into its bound login's state and can trigger a failover (ADR-0028). Absent →
   * signals are dropped (e.g. tests).
   */
  onRateLimit?: (signal: RateLimitSignal) => void;
  /** Transcript capture sink for this session (ADR-0030). Absent → no capture (e.g. tests). */
  transcriptSink?: TranscriptSink;
}

/**
 * The Claude {@link SessionBackend}. Constructed per call by the Claude runners so each
 * session binds to the active OAuth login (ADR-0028) — that per-call rebuild is why the
 * login/sink/router wiring lives in the constructor params, not the request.
 */
export class ClaudeSessionBackend implements SessionBackend {
  constructor(private readonly params: ClaudeSessionBackendParams) {}

  /**
   * Drive one SDK session to completion and return its final result text. The primitive
   * owns terminal detection (issue #146): a usage cap throws {@link UsageLimitError}
   * (the meter already tripped inside) and an overrun throws
   * {@link WallClockExceededError} — both propagate untouched to the caller. The
   * backend's own disposition is the *result text* contract: a non-cap error result is
   * fatal (it throws, because the result text IS this backend's contract), while a
   * success returns its text.
   */
  async run(req: SessionRequest): Promise<string> {
    const { config, available, reaperFactory, queryFn } = this.params;
    const r = await runReapedWallClockedSession({
      config,
      available,
      worktreePath: req.worktreePath,
      abortSignal: req.abortSignal,
      reaperFactory,
      queryFn,
      prompt: req.prompt,
      systemAppend: req.systemAppend,
      configDir: this.params.configDir,
      endpoint: this.params.endpoint,
      transcriptSink: this.params.transcriptSink,
      // Forward each rate-limit signal (incl. the cap's synthesized `rejected`, tripped
      // inside the primitive) to the bound login's meter so a busy review/fix/moding
      // session also drives failover (ADR-0028). The primitive owns the single trip.
      onRateLimit: this.params.onRateLimit,
    });
    if (r.isError) {
      // A non-cap error result: the result text is this backend's contract, so a
      // not-success outcome is fatal. Keep the body in the message so it isn't lost.
      throw new Error(`agent session ended without success: ${r.subtype}${r.text ? ` — ${r.text}` : ""}`);
    }
    return r.text;
  }
}
