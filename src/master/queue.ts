/**
 * The **master queue** (ADR-0041): which queued escalation, if any, runs a master session
 * this tick — and the process-wide lease that keeps exactly one running.
 *
 * Three scheduling rules, and the pure {@link selectMasterTask} that folds them:
 *
 *  - **Master work outranks fresh admission.** A run already in flight that has escalated is
 *    worth more than a run not yet started: the escalated one holds a checkpointed branch, a
 *    PR, and a human's expectation. So the queue is serviced *before* `admit` computes open
 *    slots, and the slot it takes is simply one of the ordinary ones.
 *  - **Never above the cap.** Masters take an ordinary build slot from the same global budget
 *    (ADR-0020). There is no reservation and no hand-off: the worker freed its slot when it
 *    exited, and the master competes for a slot like anything else. That is why a master can
 *    wait — and why waiting is correct rather than a deadlock.
 *  - **One master at a time, globally.** V1 serializes master sessions across every repo. It
 *    is deliberately blunter than per-root leasing, and it buys the property that matters
 *    most right now: concurrent decision-ledger writes are impossible, so two masters can
 *    never fail-close each other's ledger by racing the same key.
 *
 * A second queued master waits **without blocking unrelated slot usage**: the selector returns
 * nothing, the tick proceeds, and ordinary admission fills the remaining slots as usual.
 */

import type { Run } from "../store/types";

/** The world {@link selectMasterTask} decides against — injected, so the selector stays pure. */
export interface MasterQueueWorld {
  /** Runs projected to `master-triage`, oldest park first. */
  queued: readonly Run[];
  /** Whether an issue already holds a build slot (or the merge lease) this tick. */
  isBusy: (issueNumber: number) => boolean;
  /** Whether at least one more agent may start under the global cap. */
  hasCapacity: () => boolean;
  /** Whether the process-wide master lease is currently held (V1 global serialization). */
  masterLeaseHeld: () => boolean;
}

/** Why no master task was selected — logged, so an idle master queue is never mysterious. */
export type MasterQueueSkip = "empty" | "lease-held" | "no-capacity" | "all-busy";

export type MasterQueueSelection = { run: Run } | { skip: MasterQueueSkip };

/**
 * Select at most one queued master escalation to run this tick. Pure and total.
 *
 * The lease check comes first and is deliberately cheap: when a master is already running,
 * the tick must do *no* master work at all — not scan, not probe capacity — so the common
 * case (a long master session spanning many ticks) costs nothing per tick.
 */
export function selectMasterTask(world: MasterQueueWorld): MasterQueueSelection {
  if (world.queued.length === 0) {
    return { skip: "empty" };
  }
  if (world.masterLeaseHeld()) {
    return { skip: "lease-held" };
  }
  if (!world.hasCapacity()) {
    return { skip: "no-capacity" };
  }
  const run = world.queued.find((r) => !world.isBusy(r.issueNumber));
  return run ? { run } : { skip: "all-busy" };
}
