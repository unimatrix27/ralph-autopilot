/**
 * Session abort-linking (issue #13): the single place the "fresh per-session
 * AbortController, linked to the run's parent signal" wiring lives, so no call site —
 * the Claude path ({@link import("./agent").runReapedWallClockedSession}) or a provider
 * backend ({@link import("../providers/codex-backend").CodexSessionBackend}) —
 * re-implements it and drifts. It is pure `AbortController`/`AbortSignal` with zero SDK
 * or provider dependencies, so any backend can import it without pulling in another
 * provider's stack.
 */

/**
 * Create a fresh {@link AbortController} for a session, linked to an optional parent
 * signal: if the parent is already aborted, abort at once; otherwise forward its abort
 * exactly once (`{ once: true }`, so the listener auto-removes after firing).
 */
export function linkedAbortController(signal?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }
  return controller;
}
