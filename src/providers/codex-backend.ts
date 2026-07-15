/**
 * The OpenAI (Codex) provider backend (issue #131, ADR-0033). It owns the
 * provider-neutral session mechanics — folding the session-kind rubric into the prompt
 * (Codex has no `claude_code` preset to append a system prompt to), linking the run's
 * parent abort signal, and arming the wall-clock ceiling — then delegates the actual
 * SDK turn to an injected {@link CodexClient}. That split is deliberate: all the
 * abort/wall-clock/rubric logic is unit-testable behind a fake client, while the only
 * code that touches `@openai/codex-sdk` is the thin {@link import("./codex-client").SdkCodexClient}.
 *
 * **Constructed in-container for `review`/`fix` openai routes (ADR-0037 / issue #220).** Route
 * injection into the container ({@link import("../container/in-container-session").structuredBackendForRoute})
 * builds a `CodexSessionBackend` (on {@link import("./codex-client").SdkCodexClient}) when a
 * capability-open `review`/`fix` run resolves to an `openai` account — its `CODEX_HOME` mounted at
 * the container's `~/.codex`, its model/baseUrl from `providers.openai`. `impl` on Codex stays gated
 * by the capability flag (bare Codex cannot host the in-session `escalate`/`stuck` tools); the parked
 * ADR-0037 "Port impl onto Codex" follow-up — re-host those tools as an out-of-process MCP server —
 * flips `openai.toolsCapable` and unblocks impl→openai too.
 */

import { linkedAbortController } from "../executor/abort-linking";
import { runWallClockedSession, WallClockExceededError } from "../executor/wall-clock";
import type { SessionBackend, SessionRequest } from "./backend";

/**
 * One Codex turn's inputs, as the backend hands them to the client. The backend has
 * already folded `systemAppend` into `prompt` and resolved the model/effort/codexHome
 * — the client just maps these onto the SDK and returns the final response text.
 */
export interface CodexRunRequest {
  /** The fully-built prompt (session-kind rubric already folded in). */
  prompt: string;
  /** The worktree the Codex thread runs in (`startThread.workingDirectory`). */
  workingDirectory: string;
  /** The Codex model id. */
  model: string;
  /** This repo's reasoning-effort level (low|medium|high|xhigh|max); the client maps it. */
  effort: string;
  /** `CODEX_HOME` dir with the ChatGPT-subscription `auth.json` (routed via `env`). */
  codexHome: string;
  /** Optional OpenAI-compatible gateway base URL. */
  baseUrl?: string;
  /** Cancels the turn (wired to the wall-clock + parent abort). */
  signal?: AbortSignal;
}

/**
 * The injectable seam over the Codex SDK turn (issue #131): run one turn and return its
 * final assistant text. Production is {@link import("./codex-client").SdkCodexClient};
 * tests use a fake so the backend's abort/wall-clock/rubric logic is exercised without
 * the SDK or a live ChatGPT login.
 */
export interface CodexClient {
  run(req: CodexRunRequest): Promise<string>;
}

/** Everything a {@link CodexSessionBackend} needs that is constant across one session. */
export interface CodexSessionBackendParams {
  client: CodexClient;
  /** Hard wall-clock ceiling (seconds); on overrun the turn is aborted + re-cast typed. */
  wallClockSeconds: number;
  /** The Codex model id for this session's type. */
  model: string;
  /** This repo's reasoning-effort level, passed through to the client to map. */
  effort: string;
  /** `CODEX_HOME` dir holding the ChatGPT-subscription `auth.json`. */
  codexHome: string;
  /** Optional OpenAI-compatible gateway base URL. */
  baseUrl?: string;
}

/** The OpenAI (Codex) {@link SessionBackend}. */
export class CodexSessionBackend implements SessionBackend {
  constructor(private readonly params: CodexSessionBackendParams) {}

  /**
   * Run one Codex turn and return its final response. Bounded by the wall-clock ceiling
   * (issue #13): on overrun the turn's signal is aborted and the kill is re-cast to a
   * typed {@link WallClockExceededError} so the review loop tells it from a fault. A
   * parent-signal abort (drain / orphan kill) propagates as the client's own error, NOT
   * as a wall-clock kill.
   */
  async run(req: SessionRequest): Promise<string> {
    // Codex has no claude_code system-prompt preset, so the session-kind rubric is
    // folded into the prompt rather than passed as a system append (issue #131 facts).
    const prompt = req.systemAppend ? `${req.systemAppend}\n\n${req.prompt}` : req.prompt;

    // One controller per turn, linked to the run's parent signal so an outer
    // cancellation still aborts this Codex turn (shared owner — executor/abort-linking).
    const controller = linkedAbortController(req.abortSignal);

    // Wall-clock ceiling, routed through the shared owner (executor/wall-clock): on
    // overrun it aborts the turn (the SDK cancels via the signal) and swallows the
    // resulting failure, returning `expired` so we re-cast it to the typed terminal.
    //
    // The reaper is intentionally a no-op (Option 1, issue #131 / ADR-0033): unlike the
    // Claude path, `@openai/codex-sdk` spawns its `codex` CLI via child_process WITHOUT a
    // detached process group and hides the child pid, so abort delivers a single SIGTERM
    // to that one process — the `build`/`test`/bash children it launched can be orphaned
    // on overrun. DESIGN §3's process-group hard-kill / no-orphan guarantee therefore does
    // NOT hold for Codex; this is an accepted limitation, bounded by the dedicated,
    // credential-free box and a 24h reboot. Follow-up: run `codex` under
    // createProcessGroupReaper to regain process-group control and restore parity.
    let result = "";
    const { expired } = await runWallClockedSession(
      {
        abortController: controller,
        wallClockSeconds: this.params.wallClockSeconds,
        reaper: { reap: () => {} },
      },
      async () => {
        result = await this.params.client.run({
          prompt,
          workingDirectory: req.worktreePath,
          model: this.params.model,
          effort: this.params.effort,
          codexHome: this.params.codexHome,
          ...(this.params.baseUrl ? { baseUrl: this.params.baseUrl } : {}),
          signal: controller.signal,
        });
      },
    );
    // On overrun the turn was hard-killed: re-cast it to the typed wall-clock terminal
    // so the review loop tells it from a fault (mirrors ClaudeSessionBackend).
    if (expired) {
      throw new WallClockExceededError(this.params.wallClockSeconds);
    }
    return result;
  }
}
