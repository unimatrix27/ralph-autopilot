/**
 * Mapping a runner's terminal {@link ResultFrame} onto the daemon's run-state store (ADR-0038,
 * issue #184). The daemon stays the **sole writer** of run/transcript state (ADR-0030): when a
 * container reports its terminal disposition over the pipe, the daemon folds it into the event
 * log here.
 *
 * The boundary split decides *which* terminals are pipe-recorded. `git`/PR/escalate are
 * **runner-direct** — they land on GitHub independent of the pipe, and the daemon observes them
 * through its normal reconcile — so `pr-opened` / `escalated` are **not** forced into a terminal
 * store write from the (best-effort) pipe. What the daemon *does* own off the result frame are
 * the no-work-product terminals: `stuck` and `failed` both pin the run to `agent-stuck`.
 */
import type { ResultFrame } from "./protocol";

/** The narrow store port this needs — structurally satisfied by `ScopedStore`. */
export interface TerminalRunRecorder {
  recordRunStuck(input: { runId: number; issueNumber: number; reason: string }): Promise<void>;
}

/** Identifies the run whose terminal state is being recorded. */
export interface TerminalRunRef {
  runId: number;
  issueNumber: number;
}

/**
 * Record the run's terminal state from its result frame. `stuck`/`failed` pin `agent-stuck`
 * (with the frame's detail as the reason); `pr-opened`/`escalated` are runner-direct and pin
 * nothing here (the daemon picks them up via GitHub). Total over {@link ResultFrame.outcome}.
 */
export async function recordTerminalResult(
  recorder: TerminalRunRecorder,
  run: TerminalRunRef,
  result: ResultFrame,
): Promise<void> {
  switch (result.outcome) {
    case "stuck":
      await recorder.recordRunStuck({ ...run, reason: result.detail ?? "agent stuck" });
      return;
    case "failed":
      await recorder.recordRunStuck({ ...run, reason: result.detail ?? "run failed" });
      return;
    case "pr-opened":
    case "escalated":
      // Runner-direct: the PR / escalation landed on GitHub independent of the pipe; the
      // daemon observes it through reconcile, not through a forced store write here.
      return;
  }
}
