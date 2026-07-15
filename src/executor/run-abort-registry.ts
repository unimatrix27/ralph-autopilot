/**
 * The runId → AbortController registry (issue #118). The single home for the per-run
 * session-kill handle, owned by executor wiring and shared across every executor so
 * the web control plane's kill-run can tear down a specific in-flight run through the
 * orchestrator's abort-only port without reaching executor internals (ADR-0032: the
 * web layer talks to a port, never the reconciler/executor).
 *
 * The executor held its AbortControllers privately before (an issueNumber-keyed map),
 * so only the reconciler's orphan sweep could kill a wedged run. Surfacing them here —
 * keyed by run id (globally unique: one `runs` table across repos, ADR-0020) — lets
 * the orchestrator's abort-only `DaemonControl.killRun(runId)` path abort one run by id,
 * and (because each run registers its own controller) killing one run never touches another.
 *
 * Pure `AbortController`/`AbortSignal` with zero SDK or provider deps, like the sibling
 * abort-linking primitive (`abort-linking.ts`), so any layer can import it.
 */
export class RunAbortRegistry {
  private readonly controllers = new Map<number, AbortController>();

  /**
   * Register the AbortController for a run's live session. Called by the executor when a
   * session starts (under the failure guard); a re-registration for the same run id
   * replaces a stale entry (a fresh session resuming before the prior one's `finally`
   * settled — one run is in flight at a time, so this is defensive, not a race).
   *
   * Returns an idempotent release function that clears the registration only if this
   * controller is still the current owner. That keeps a stale session's `finally` from
   * deleting a newer registration for the same run id.
   */
  register(runId: number, controller: AbortController): () => void {
    this.controllers.set(runId, controller);
    let released = false;
    return (): void => {
      if (released) {
        return;
      }
      released = true;
      if (this.controllers.get(runId) === controller) {
        this.controllers.delete(runId);
      }
    };
  }

  /**
   * Abort a run's live session by run id. Returns whether a live controller was found and
   * aborted (`false` when the run already settled — the kill raced its own exit, which is
   * fine). Used by both the reconciler's orphan sweep (a run wedged past its lifetime, via
   * `Executor.terminate`) and the orchestrator's `DaemonControl.killRun`.
   */
  abort(runId: number): boolean {
    const controller = this.controllers.get(runId);
    if (!controller) {
      return false;
    }
    controller.abort();
    return true;
  }

  /** Whether a live session is currently registered for the run. */
  has(runId: number): boolean {
    return this.controllers.has(runId);
  }
}
