/**
 * The one provider seam (issue #131, ADR-0033). Everything a structured harness
 * session needs from an LLM provider reduces to a single operation: *run a fresh,
 * tool-using session in a worktree and return its final assistant text*. The caller
 * parses that text against its own contract (the review worklist, a fix outcome, a
 * mode verdict) — the provider is contract-agnostic.
 *
 * This module is a **leaf with zero imports**: pure types, so a new provider is a new
 * file implementing {@link SessionBackend}, never edits scattered across the codebase.
 * A backend throws `WallClockExceededError` (executor/wall-clock) on overrun — the one
 * cross-cutting terminal the retry/parse contract recognises — but does not import it
 * (the throw is a behavioural contract, documented here, not a type dependency).
 */

/** The provider-neutral request for one structured session. */
export interface SessionRequest {
  /** The fully-built user prompt for this session. */
  prompt: string;
  /** The worktree the session runs in (its cwd / working directory). */
  worktreePath: string;
  /**
   * The session-kind rubric appended to the system prompt (the review rubric, the
   * auto-mode rubric, …). The Claude backend passes it as a `claude_code` system
   * append; a provider without that preset (e.g. Codex) folds it into the prompt.
   * Omit to inherit the backend's default behaviour.
   */
  systemAppend?: string;
  /** The run's parent abort signal, linked into the session (wall-clock + drain). */
  abortSignal?: AbortSignal;
}

/**
 * One provider's ability to run a structured session. The sole abstraction the
 * in-container review/fix session hosts depend on; concrete impls are
 * {@link import("./claude-backend").ClaudeSessionBackend} and
 * {@link import("./codex-backend").CodexSessionBackend}.
 *
 * The matching backend is built **inside the container** from the daemon-injected
 * `{ provider, model, account }` route (ADR-0037 / issue #220,
 * {@link import("../container/in-container-session").structuredBackendForRoute}): a `claude`/`zai`
 * route → {@link import("./claude-backend").ClaudeSessionBackend} (z.ai via its Anthropic-compatible
 * endpoint), an `openai` route → {@link import("./codex-backend").CodexSessionBackend} on the mounted
 * `CODEX_HOME`. So `review`/`fix` (capability-open) reach all three providers; `impl` is gated to the
 * tools-capable backends (the parked ADR-0037 Codex-tools follow-up unblocks impl→openai).
 */
export interface SessionBackend {
  /**
   * Run one fresh session to completion and return its final assistant text. Throws
   * `WallClockExceededError` if the session overruns its wall-clock ceiling (a kill,
   * not a contract violation — never retried by the caller).
   */
  run(req: SessionRequest): Promise<string>;
}
