/**
 * The wall-clock ceiling that bounds **every** SDK session (DESIGN §3, issue #13).
 * One hour by default (`config.agent.wallClockSeconds`); on overrun the session is
 * a *hard kill* — abort the SDK `query()` iteration **and** reap the subprocess
 * tree so no agent-spawned `build`/`test`/bash child outlives the run.
 *
 * This is shared by every SDK session — impl, resume, review, fix, moding — all flowing
 * through the one session-drive primitive ({@link runReapedWallClockedSession}) inside the
 * container, so the ceiling is uniform and lives in one place rather than being
 * re-implemented (or, as it was, omitted) per call site.
 */

import type { SessionReaper } from "./process-reaper";

/**
 * Thrown when a session is killed at the wall-clock ceiling. The impl/resume path
 * turns it into a `wall-clock` stuck terminal; the review/fix path lets it
 * propagate so the review loop can surface it as `review-maxed`.
 */
export class WallClockExceededError extends Error {
  constructor(public readonly wallClockSeconds: number) {
    super(`Killed after exceeding the ${wallClockSeconds}s wall-clock ceiling.`);
    this.name = "WallClockExceededError";
  }
}

/** Parameters that arm the wall-clock ceiling around a session. */
export interface WallClockParams {
  abortController: AbortController;
  wallClockSeconds: number;
  reaper: Pick<SessionReaper, "reap">;
  /** Optional hook to log the overrun at the call site (issue number, etc.). */
  onExpire?: () => void;
}

/**
 * Run one SDK session under the wall-clock ceiling and report whether the ceiling
 * fired. This is the single owner of the session-lifecycle control flow every call
 * site shares: arm a timer that on expiry hard-kills the session — abort the
 * `abortController` (ending the `query()` iteration) then reap the subprocess tree,
 * so nothing the agent spawned survives — run `body` (the per-call `query()` loop),
 * and on the overrun abort — which the SDK's ProcessTransport surfaces as a thrown
 * AbortError when the CLI exits while the signal is aborted — swallow it *only* when
 * the ceiling fired; any other error is a real fault and propagates. The timer is
 * always disarmed in a `finally`.
 *
 * The caller maps the kill to its own terminal off the returned `expired` flag —
 * the impl/resume path returns a `wall-clock` stuck result, the review/fix path
 * throws {@link WallClockExceededError} — so the only thing that differs per call
 * site stays at the call site instead of being copied into divergent catch/finally
 * blocks.
 */
export async function runWallClockedSession(
  params: WallClockParams,
  body: () => Promise<void>,
): Promise<{ expired: boolean }> {
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    params.onExpire?.();
    // Order matters: abort first so the SDK begins its teardown, then reap the
    // process group so any subprocess that ignored the abort is force-killed.
    params.abortController.abort();
    params.reaper.reap();
  }, params.wallClockSeconds * 1000);
  try {
    await body();
  } catch (err) {
    if (!expired) {
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }
  return { expired };
}
