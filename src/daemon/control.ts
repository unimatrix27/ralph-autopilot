/**
 * Tier-2 daemon control (issue #118, ADR-0032): the lifecycle port the
 * orchestrator implements for web writes. Owned by the daemon layer so the core
 * loop never imports a web-edge contract; web/server/ports.ts re-exports it for
 * HTTP adapters and tests.
 */
export interface DaemonControl {
  /**
   * Begin a graceful drain (issue #35): no new pickups/resumes, in-flight runs finish
   * (review + merge), then the loop exits. Fire-and-forget: the web request that triggers
   * it returns immediately; the drain runs out under `runForever` and the process exits.
   * Idempotent: a call while already draining (or after the loop has exited) is a no-op.
   */
  drain(): void;
  /**
   * Force a reconcile round now, cutting the inter-tick sleep short. Best-effort: if a tick
   * is already running it is a no-op (a tick is in flight), otherwise the next tick runs
   * immediately rather than waiting for the configured interval. Safe before the loop starts
   * or after it exits (there may be no sleep currently observing the signal).
   */
  forceTick(): void;
  /**
   * Kill one in-flight run by run id via the runId -> AbortController registry. Returns
   * whether a live session was found and aborted (`false` when the run already settled -
   * the kill raced its own exit). Aborting the run's controller tears down its live session;
   * the executor's failure guard then terminalizes the run to `agent-stuck` and frees its
   * slot. Killing one run never affects another (each run registers its own controller).
   */
  killRun(runId: number): boolean;
}
