/**
 * Test helper: upsert a run row and append the event fact that projects a given
 * lifecycle status, so the run reads back in that status off the event-sourced
 * projection.
 *
 * Issue #83 dropped the `runs.status` column — a run's status is now *only* ever the
 * fold of its issue stream's status events. Tests that used to seed a scenario with
 * `upsertRun({ status })` append the matching fact instead; this helper centralises the
 * status→fact mapping (the same one the production `record*` methods use) so a seed stays
 * a one-liner. It appends only the *status* fact (e.g. `review-maxed` is a bare `ReviewMaxed`,
 * with no heal-card question or resume context) — tests that need those add them explicitly.
 * `awaiting-answer` is the one exception: its status is only reachable through an `Escalated`,
 * so the helper seeds a placeholder question for it.
 */

import type { ScopedStore } from "../store/store";
import type { Mode, Run, RunStatus } from "../store/types";

export interface SeedRunInput {
  issueNumber: number;
  mode: Mode;
  /** The lifecycle status to project the run into, via the matching event fact. */
  status: RunStatus;
  branch?: string | null;
  worktreePath?: string | null;
  prNumber?: number | null;
}

/** Upsert a run row and append the fact that folds to {@link SeedRunInput.status}. */
export async function seedRun(store: ScopedStore, input: SeedRunInput): Promise<Run> {
  const { status, ...row } = input;
  const run = store.upsertRun(row);
  const base = { runId: run.id, issueNumber: run.issueNumber };
  switch (status) {
    case "running":
      // The empty stream already reads back `running` (the run-read default); nothing to
      // append — matching the pre-cleanup column, which carried no run span either.
      break;
    case "awaiting-ci":
      await store.recordCiAwaited(base);
      break;
    case "awaiting-merge":
      await store.recordReviewPassed(base);
      break;
    case "agent-stuck":
      await store.recordRunStuck({ ...base, reason: "" });
      break;
    case "merged":
      await store.recordMerged({ ...base, prNumber: input.prNumber ?? 0 });
      break;
    case "closed":
      await store.recordRunEnded({ ...base, outcome: "closed" });
      break;
    case "review-maxed":
      await store.recordReviewMaxed({ ...base, phase: 1 });
      break;
    case "awaiting-answer":
      // `awaiting-answer` is only reachable via an `Escalated`; seed a placeholder question.
      await store.addQuestion({ ...base, kind: "escalate", headline: "seeded" });
      break;
  }
  return run;
}
