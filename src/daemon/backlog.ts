/**
 * Project the per-tick admission decision (issue #20) into the "whole pipeline"
 * backlog the daemon persists to SQLite each reconcile tick for the monitoring
 * TUI:
 *
 *   - **eligible** — the issues that passed the gate and are not held, in the
 *     exact order the scheduler picks them (from {@link LaunchPlan.eligible});
 *   - **blocked** — issues failing the gate *only* on an unsatisfied
 *     `## Blocked by`, with each blocker ref and whether it is satisfied (from
 *     the blocked exclusions admission already resolved);
 *   - **paused/stuck** — issues carrying a human-attention label
 *     (`awaiting-answer` / `review-maxed` / `agent-stuck` / `daemon-anomaly`);
 *   - **manual holds** — issues the operator paused with `hitl`, so the web
 *     control plane can offer `unpause`;
 *   - **moding candidates** — issues whose *only* unmet eligibility-gate condition
 *     is a missing `mode:*` label, i.e. ready + afk + every `## Blocked by` dep
 *     satisfied but unmoded — exactly what the auto-mode pass fills.
 *
 * Admission ({@link admit}) is the single source of the eligibility decision
 * (ADR-0007: "the daemon already computes eligibility each tick"), so the displayed
 * pick-order can never diverge from the real one. The projection mostly *maps* the
 * plan into the serialisable view, with one targeted resolution it cannot read off
 * the plan: admission emits `no-mode` at the mode check, *before* it resolves
 * `## Blocked by` deps (deps are its deliberately-last, GitHub-touching step), so a
 * ready+afk issue that is BOTH unmoded AND dependency-blocked lands in the plan as
 * `no-mode`, never `blocked`. To classify those honestly the projection re-runs the
 * **same** synthetic-mode gate the auto-mode pass uses ({@link gateWithSyntheticMode}),
 * resolving their deps — so it is no longer purely gate-free, and a blocked-and-unmoded
 * issue falls into **blocked** (with its dep mini-graph), never into moding candidates
 * the auto-mode pass would never act on (issue #113). Paused/stuck is read straight off
 * the labels — independent of admission, which would classify a label-paused issue
 * holding a run as `held` — so a stuck issue never silently leaves the view.
 */

import { createDepCache, priorityRankOf, type LaunchPlan } from "../core/admission";
import { LABEL_HITL, LABEL_READY, pausedStateOf } from "../core/labels";
import { gateWithSyntheticMode } from "../core/moding";
import type { Issue } from "../github/types";
import type {
  BacklogBlocked,
  BacklogEligible,
  BacklogManualHold,
  BacklogModingCandidate,
  BacklogNoProvider,
  BacklogPaused,
  BacklogPriorityColor,
  BacklogView,
} from "../store/types";

/**
 * Map this tick's polled issues + admission plan into the backlog view ({@link
 * BacklogView}, the single source of truth in `store/types`). `plan` supplies the
 * gated/ordered eligible queue and the resolved blocked exclusions; `issues`
 * supplies the paused/stuck label read; `priorityLabels` colours the eligible
 * rows by their scheduling tie-break; `isDependencySatisfied` resolves the
 * `## Blocked by` deps of admission's `no-mode` exclusions (which the gate
 * short-circuited before resolving) so a blocked-and-unmoded issue is classified
 * as blocked, not as a moding candidate (issue #113). Async only for that one
 * resolution; the rest is a pure map of the plan.
 */
export async function projectBacklog(
  issues: Issue[],
  plan: LaunchPlan,
  priorityLabels: string[],
  isDependencySatisfied: (issueNumber: number) => Promise<boolean>,
  noProviderResetsAt: string | null = null,
): Promise<BacklogView> {
  const eligible: BacklogEligible[] = plan.eligible.map((p) => {
    const rank = priorityRankOf(p.issue.labels, priorityLabels);
    return {
      issueNumber: p.issue.number,
      title: p.issue.title,
      priority: rank === null ? null : priorityLabels[rank]!,
      priorityColor: bucketPriorityColor(rank, priorityLabels.length),
    };
  });

  const blocked: BacklogBlocked[] = plan.excluded
    .filter((e) => e.reason === "blocked")
    .map((e) => ({
      issueNumber: e.issue.number,
      title: e.issue.title,
      blockers: e.blockers,
    }));

  // Resolve `## Blocked by` deps at most once each across this call, mirroring admit.
  const resolveDep = createDepCache(isDependencySatisfied);

  // Reclassify admission's `no-mode` exclusions (CONTEXT: moding pass). The gate emits
  // `no-mode` at the mode check, BEFORE it resolves `## Blocked by` deps, so a ready+afk
  // issue that is BOTH unmoded AND dependency-blocked is excluded as `no-mode`, never
  // `blocked` — admission carries no dep info for it. Re-run the SAME synthetic-mode full
  // gate the auto-mode pass uses ({@link gateWithSyntheticMode}) to split the set: an
  // issue whose only gap is the mode is a true moding candidate; one that ALSO has an
  // unmet dep is blocked and joins the Blocked section with its resolved dep mini-graph.
  // This keeps the moding set from ever drifting from what the auto-mode pass would
  // actually select, and stops a blocked issue being mislabelled as auto-modeable.
  const modingCandidates: BacklogModingCandidate[] = [];
  for (const e of plan.excluded) {
    if (e.reason !== "no-mode") {
      continue;
    }
    const verdict = await gateWithSyntheticMode(e.issue, resolveDep);
    if (verdict.eligible) {
      modingCandidates.push({ issueNumber: e.issue.number, title: e.issue.title });
    } else {
      // A `no-mode` exclusion already cleared every label check, so with a synthetic
      // mode the only possible rejection is `blocked` — carrying its unmet refs.
      const blockers = verdict.reason === "blocked" ? verdict.blockers : [];
      blocked.push({ issueNumber: e.issue.number, title: e.issue.title, blockers });
    }
  }

  blocked.sort((a, b) => a.issueNumber - b.issueNumber);
  modingCandidates.sort((a, b) => a.issueNumber - b.issueNumber);

  const paused: BacklogPaused[] = [];
  const manualHolds: BacklogManualHold[] = [];
  for (const issue of issues) {
    const state = pausedStateOf(issue.labels);
    if (state) {
      paused.push({ issueNumber: issue.number, title: issue.title, state });
      continue;
    }
    if (issue.labels.includes(LABEL_READY) && issue.labels.includes(LABEL_HITL)) {
      manualHolds.push({ issueNumber: issue.number, title: issue.title });
    }
  }
  paused.sort((a, b) => a.issueNumber - b.issueNumber);
  manualHolds.sort((a, b) => a.issueNumber - b.issueNumber);

  // Eligible-but-parked on the no-provider wait (ADR-0037): admission emits these in the same
  // scheduler pick-order it would have launched them in (the `ordered` queue), so preserve that
  // order verbatim — never re-sort — exactly as the eligible section does. Each carries the shared
  // per-tick reset ETA (null when unknown → the UI renders the wait without an ETA).
  const noProvider: BacklogNoProvider[] = plan.excluded
    .filter((e) => e.reason === "no-provider")
    .map((e) => ({ issueNumber: e.issue.number, title: e.issue.title, resetsAt: noProviderResetsAt }));

  return { eligible, blocked, paused, manualHolds, modingCandidates, noProvider };
}

/**
 * Bucket a priority rank into a row colour by its *proportional* position in the
 * configured list (operator ruling, issue #20): `f = rank / max(1, N-1)`, then
 * `f < 1/3` → red, `< 2/3` → yellow, else blue. Deriving the colour from the same
 * `priorityLabels` rank the scheduler orders by keeps a single priority model —
 * it tracks any naming convention and degrades cleanly for any list length (a
 * one-label list ranks red without dividing by zero). `null` rank (no priority
 * label) carries no colour.
 */
function bucketPriorityColor(rank: number | null, total: number): BacklogPriorityColor | null {
  if (rank === null) {
    return null;
  }
  const f = rank / Math.max(1, total - 1);
  if (f < 1 / 3) {
    return "red";
  }
  if (f < 2 / 3) {
    return "yellow";
  }
  return "blue";
}
