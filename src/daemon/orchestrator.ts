/**
 * The multi-repo orchestrator (ADR-0020). The daemon works several target repos at
 * once; this owns the one process-level loop over a per-repo {@link Reconciler}
 * each tick, sharing:
 *   - ONE global agent budget (`scheduler.maxConcurrentAgents`): reconcilers are
 *     driven sequentially and the budget is read live, so two repos filling in the
 *     same tick can never oversubscribe the operator's plan cap;
 *   - ONE graceful drain (issue #35) that empties every repo's build pool, merge
 *     lease, and awaiting-merge queue before exiting;
 *   - ONE self-update checker over the daemon's OWN repo (issue #30, ADR-0018),
 *     unchanged — it is independent of which targets the daemon works.
 *
 * The per-repo reconcilers keep their own in-flight/merge state (issue numbers are
 * not unique across repos, so the maps must be per-repo); this layer never touches
 * issue-keyed state, only the aggregate counts and the loop.
 */

import type { Logger } from "../log/logger";
import type { Store } from "../store/store";
import type { Reconciler } from "./reconciler";
import type { UpdateChecker } from "./self-update";
import type { DaemonControl } from "./control";

/** Self-update config (issue #30, ADR-0018); omit to disable self-update (default). */
export interface SelfUpdateDeps {
  /** Detects whether the daemon's own repo is behind its tracked branch. */
  checker: UpdateChecker;
  /** Run the update check every N reconcile ticks. */
  checkEveryTicks: number;
  /** Hard ceiling (seconds) on the graceful drain before a forced restart. */
  drainTimeoutSeconds: number;
}

/** How a graceful drain ended (issue #35). */
export type DrainKind =
  /** Every repo's in-flight set + merge queue emptied. */
  | "completed"
  /** The drain deadline passed with work still pending (a stall). */
  | "timeout"
  /** A force signal (a second stop request) cut the drain short. */
  | "forced";

export interface DrainOutcome {
  outcome: DrainKind;
  /** `repo#issue` for every run still in flight when the drain returned (empty on `completed`). */
  stillInFlight: string[];
}

/**
 * What {@link Orchestrator.runForever} resolved to: the drain outcome plus whether
 * the loop exited to let a supervisor pull + build + relaunch the daemon
 * (self-update, issue #30) instead of stopping. The bin maps `restartForUpdate`
 * to the dedicated restart exit code (75).
 */
export interface DaemonRunOutcome extends DrainOutcome {
  restartForUpdate: boolean;
}

/** How the daemon's run loop should react to shutdown signals. */
export interface RunForeverOptions {
  /** Seconds between reconcile ticks, in ms. */
  intervalMs: number;
  /** First SIGTERM/SIGINT (or `--drain`): begin a graceful drain. */
  drainSignal: AbortSignal;
  /** Second signal: force an immediate stop, abandoning in-flight runs. */
  forceSignal: AbortSignal;
  /** Configurable ceiling on a graceful drain before it force-exits. */
  drainTimeoutMs: number;
}

/** Abort-only capability for killing a live run by id. */
export interface RunAbortPort {
  abort(runId: number): boolean;
}

export interface OrchestratorDeps {
  /** One reconciler per target repo, all sharing the global budget passed at construction. */
  reconcilers: Reconciler[];
  /** The shared store — used once at startup to end stale agent rows across all repos. */
  store: Store;
  logger: Logger;
  /** Injected clock for snapshot/error timestamps; defaults to the system clock. */
  now?: () => Date;
  /** Self-update config (issue #30, ADR-0018); omit to disable self-update (default). */
  selfUpdate?: SelfUpdateDeps;
  /**
   * Abort-only run-kill port (issue #118): the daemon wires the same underlying session-handle
   * registry into every executor for register/release ownership, while the orchestrator receives
   * only the `abort(runId)` capability needed by `DaemonControl.killRun`.
   */
  runAbort: RunAbortPort;
}

export class Orchestrator implements DaemonControl {
  private restartRequested = false;
  private ticksSinceUpdateCheck = 0;
  private startupComplete = false;
  private readonly now: () => Date;
  /**
   * The web-driven drain trigger (issue #118). DaemonControl.drain() aborts this; runForever
   * races it alongside the process drain signal, so a UI drain begins the same graceful drain
   * a SIGTERM would. Distinct from the bin-owned drain signal so the orchestrator can fire it
   * itself without holding the bin's AbortController.
   */
  private readonly drainController = new AbortController();
  /** The current forceTick signal — aborted by DaemonControl.forceTick, consumed by runForever's sleep. */
  private forceTickController = new AbortController();

  constructor(private readonly deps: OrchestratorDeps) {
    this.now = deps.now ?? ((): Date => new Date());
  }

  /** Total agents in flight across every repo — build pools plus merge leases. */
  private activeCount(): number {
    return this.deps.reconcilers.reduce((n, r) => n + r.activeCount(), 0);
  }

  /** `repo#issue` for every run still in flight across all repos. */
  private stillInFlight(): string[] {
    return this.deps.reconcilers.flatMap((r) => r.stillInFlight().map((n) => `${r.targetRepo}#${n}`));
  }

  /** True once a self-update restart has been requested (issue #30, ADR-0018). */
  restartForUpdateRequested(): boolean {
    return this.restartRequested;
  }

  /**
   * Process startup phase: end stale active-agent rows once, then rehydrate every repo
   * from GitHub before the first live tick (ADR-0003). Exposed separately so daemon
   * composition can start isolated edges in a visible order after recovered facts land.
   * Idempotent for callers that still enter through {@link runForever} directly.
   */
  async startup(): Promise<void> {
    if (this.startupComplete) {
      return;
    }
    // Stale active-agent rows are global (the agents table is not repo-scoped): end
    // them once before any repo rehydrates — nothing runs on a fresh process.
    this.deps.store.endAllActiveAgents();
    // Re-derive reality from GitHub before the first tick (ADR-0003), per repo.
    for (const r of this.deps.reconcilers) {
      try {
        await r.rehydrate();
        r.setLastError(null);
      } catch (err) {
        r.setLastError({ event: "reconcile.rehydrate-failed", at: this.now().toISOString() });
        this.deps.logger.error("reconcile.rehydrate-failed", { repo: r.targetRepo, error: String(err) });
      }
    }
    this.startupComplete = true;
  }

  /**
   * One reconcile round: drive every repo's reconciler in turn (so the shared build
   * budget is consumed in a defined order, never double-spent), capturing a thrown
   * tick per repo, then poll self-update once. This is the loop body of
   * {@link runForever}; exposed so a single round can be driven deterministically.
   */
  async tick(): Promise<void> {
    for (const r of this.deps.reconcilers) {
      try {
        await r.tick();
        r.setLastError(null);
      } catch (err) {
        r.setLastError({ event: "reconcile.tick-failed", at: this.now().toISOString() });
        this.deps.logger.error("reconcile.tick-failed", { repo: r.targetRepo, error: String(err) });
      }
    }
    await this.maybeCheckForUpdate();
  }

  /**
   * DaemonControl.drain (issue #118): begin a graceful drain from the UI. Aborts the
   * orchestrator's own drain trigger, which runForever races alongside the process drain
   * signal — so a UI drain runs the exact same graceful drain a SIGTERM / `--drain` would
   * (no new pickups, in-flight runs finish, then exit). Fire-and-forget: the web request
   * returns immediately; the drain settles under runForever. Idempotent — aborting an
   * already-aborted controller is a no-op, and once the loop has exited there is nothing to
   * wake. Never touches the reconcilers or executors directly (ADR-0032: a port, not a
   * reach-in) — it only signals the loop, which owns the drain pump.
   */
  drain(): void {
    this.drainController.abort();
  }

  /**
   * DaemonControl.forceTick (issue #118): force a reconcile round now. Aborts the current
   * force-tick signal, which runForever passes into the same abortable sleep path used by
   * drain/force signals — so the next tick runs immediately instead of waiting for the
   * configured interval. Best-effort: if a tick is already running this only shortens the
   * *next* sleep, and before the loop starts or after it exits there may be no awaiter
   * (a harmless no-op). The controller is recreated immediately after the sleep consumes it.
   */
  forceTick(): void {
    this.forceTickController.abort();
  }

  /**
   * DaemonControl.killRun (issue #118): kill one in-flight run by run id through the
   * abort-only port backed by the shared runId → AbortController registry. Returns whether a
   * live session was found and aborted (false when the run already settled — the kill raced
   * its exit). Aborting the controller tears the run's live session down; the executor's
   * failure guard then terminalizes it to `agent-stuck` and frees its slot through
   * occupySlot's single owner. Each run registers its own controller, so this never touches
   * another in-flight run, and the orchestrator never owns register/release.
   */
  killRun(runId: number): boolean {
    return this.deps.runAbort.abort(runId);
  }

  /**
   * Run reconcile ticks across every target until a shutdown signal fires or a
   * self-update restart is requested, then drain gracefully (issue #35 / #30). Each
   * tick drives the reconcilers sequentially (so the shared budget is consumed in a
   * defined order, never double-spent), then polls self-update once. A `forceSignal`
   * before any drain is an immediate stop. Otherwise every repo drains to completion
   * (build pools + merge leases + awaiting-merge queues empty), bounded by the drain
   * timeout / a second force signal. Returns how the drain ended plus whether the
   * caller should restart-for-update (exit 75).
   */
  async runForever(opts: RunForeverOptions): Promise<DaemonRunOutcome> {
    await this.startup();

    while (
      !opts.drainSignal.aborted &&
      !this.drainController.signal.aborted &&
      !opts.forceSignal.aborted &&
      !this.restartRequested
    ) {
      // One reconcile round across every repo, then the self-update poll — a detected
      // update breaks the loop and drains + restarts now.
      await this.tick();
      if (this.restartRequested) {
        break;
      }
      // Sleep until the next interval OR any abortable wake: a process drain/force signal,
      // a web-driven drain (this.drainController), or a forceTick. The force-tick controller
      // is recreated immediately after the sleep consumes it, so a forceTick landing before
      // the sleep begins still forces the next round and the following sleep gets a fresh
      // signal.
      await sleep(
        opts.intervalMs,
        opts.drainSignal,
        opts.forceSignal,
        this.drainController.signal,
        this.forceTickController.signal,
      );
      this.forceTickController = new AbortController();
    }

    if (opts.forceSignal.aborted && !this.restartRequested) {
      // Forced before a graceful drain even began: abandon in-flight runs.
      return { outcome: "forced", stillInFlight: this.stillInFlight(), restartForUpdate: false };
    }
    // A self-update drain uses its own (usually shorter) ceiling; a shutdown drain
    // uses the scheduler's. A web-driven drain (this.drainController) is a shutdown drain.
    const drainTimeoutMs =
      this.restartRequested && this.deps.selfUpdate
        ? this.deps.selfUpdate.drainTimeoutSeconds * 1000
        : opts.drainTimeoutMs;
    this.deps.logger.info("daemon.draining", {
      reason: this.restartRequested ? "self-update" : "shutdown",
      inFlight: this.stillInFlight(),
    });
    const drain = await this.drainToCompletion({ timeoutMs: drainTimeoutMs, force: opts.forceSignal });
    return { ...drain, restartForUpdate: this.restartRequested };
  }

  /**
   * Drain every repo to completion (issue #35). Pickups/resumes stop (the loop has
   * exited), but each repo's merge worker is pumped so finished review runs are
   * carried through integration — the build pools feed the merge queues, so the
   * pending sets can still grow after the drain starts. Resolves when every repo is
   * idle (no build run, no merge lease, empty queue), or on timeout / a force signal.
   */
  async drainToCompletion(opts: { timeoutMs: number; force?: AbortSignal }): Promise<DrainOutcome> {
    const { timeoutMs, force } = opts;
    const idle = (): boolean => this.deps.reconcilers.every((r) => r.isIdle());
    const pumpMerge = (): void => {
      for (const r of this.deps.reconcilers) r.serviceMergeWorker();
    };

    if (force?.aborted) {
      return { outcome: "forced", stillInFlight: this.stillInFlight() };
    }
    pumpMerge();
    if (idle()) {
      return { outcome: "completed", stillInFlight: [] };
    }

    const kind = await new Promise<DrainKind>((resolve) => {
      let settled = false;
      const finish = (k: DrainKind): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        force?.removeEventListener("abort", onForce);
        resolve(k);
      };
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      const onForce = (): void => finish("forced");
      force?.addEventListener("abort", onForce, { once: true });
      // Pump: keep every repo's merge worker fed, complete when all are idle, else
      // wait for the next in-flight promise (any repo) to settle and re-pump. A review
      // run that finishes during drain enqueues an awaiting-merge run, which the next
      // pump leases — so every queue drains to empty, not abandoned at a snapshot.
      const pump = (): void => {
        if (settled) return;
        pumpMerge();
        if (idle()) {
          finish("completed");
          return;
        }
        const promises = this.deps.reconcilers.flatMap((r) => r.inFlightPromises());
        if (promises.length === 0) {
          // Not idle but nothing in flight: a queue item the merge worker could not
          // lease this turn (e.g. its issue/PR concluded out-of-band, terminalizing on
          // the next pump). Re-pump after a short delay rather than spin.
          setTimeout(pump, 50);
          return;
        }
        Promise.race(promises.map((p) => p.catch(() => {}))).then(pump, pump);
      };
      pump();
    });

    return { outcome: kind, stillInFlight: kind === "completed" ? [] : this.stillInFlight() };
  }

  /**
   * Every `checkEveryTicks` ticks, ask the {@link UpdateChecker} whether the daemon's
   * own repo is behind its tracked branch (issue #30, ADR-0018). If so, request a
   * self-update restart: {@link runForever} then drains in-flight work and exits the
   * restart code so a supervisor rebuilds + relaunches. A check error fails *safe* —
   * log and skip, never restart on a flaky `git fetch`. No-op when self-update is off
   * or a restart is already pending.
   */
  private async maybeCheckForUpdate(): Promise<void> {
    const su = this.deps.selfUpdate;
    if (!su || this.restartRequested) {
      return;
    }
    this.ticksSinceUpdateCheck += 1;
    if (this.ticksSinceUpdateCheck < su.checkEveryTicks) {
      return;
    }
    this.ticksSinceUpdateCheck = 0;
    let status;
    try {
      status = await su.checker.check();
    } catch (err) {
      this.deps.logger.error("self-update.check-failed", { error: String(err) });
      return;
    }
    if (!status.behind) {
      return;
    }
    this.restartRequested = true;
    this.deps.logger.info("self-update.detected", {
      branch: status.branch,
      behindBy: status.behindBy,
      localHead: status.localHead,
      remoteHead: status.remoteHead,
      inFlight: this.activeCount(),
    });
  }
}

/** Sleep `ms`, resolving early if any of `signals` aborts. */
function sleep(ms: number, ...signals: AbortSignal[]): Promise<void> {
  return new Promise((resolve) => {
    if (signals.some((s) => s.aborted)) {
      resolve();
      return;
    }
    const cleanup = (): void => {
      clearTimeout(timer);
      for (const s of signals) s.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    for (const s of signals) s.addEventListener("abort", onAbort, { once: true });
  });
}
