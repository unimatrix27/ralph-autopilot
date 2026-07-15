/**
 * The shared, typed vocabulary for the pipeline phase an agent row is in. It is
 * the single source of truth for the phase label the review loop **writes** (was
 * the stringly-typed `review-${phase}` / `fix-${phase}` template) and that the
 * live view **reads**. Producer and consumers derive from one closed union, so
 * the label can't drift between them.
 *
 * The full phase set (ADR-0017's build/integration split): `impl`, the CI gate,
 * the two numbered review/fix passes, and the rebase-aware `merge` /
 * `merge-conflict` phases. The `impl` phase has no stored label — an agent row
 * carries a `null` phase until the review loop sets the first one, and `null`
 * decodes to `impl`.
 */

import type { Phase } from "../store/types";

/** The pipeline phase an agent row is in, as a closed, typed union. */
export type AgentPhase =
  | { kind: "impl" }
  | { kind: "ci-gate" }
  | { kind: "review"; phase: 1 | 2 }
  | { kind: "fix"; phase: Phase }
  | { kind: "merge" }
  | { kind: "merge-conflict" }
  /** A stored label this build doesn't recognise — displayed verbatim, no crash. */
  | { kind: "other"; raw: string };

/** The CI gate phase (await CI before review / merge-time re-await). */
export const CI_GATE: AgentPhase = { kind: "ci-gate" };
/** The rebase-aware merge phase. */
export const MERGE: AgentPhase = { kind: "merge" };
/** The rebase-conflict resolution phase. */
export const MERGE_CONFLICT: AgentPhase = { kind: "merge-conflict" };
/** A review pass for phase 1 or 2. */
export function reviewPhase(phase: 1 | 2): AgentPhase {
  return { kind: "review", phase };
}
/** A fix attempt for a phase (0 = CI/merge gate, 1 = normal, 2 = thermo). */
export function fixPhase(phase: Phase): AgentPhase {
  return { kind: "fix", phase };
}

const REVIEW_PREFIX = "review-";
const FIX_PREFIX = "fix-";

/**
 * The stored/display label for a phase. The impl phase is `impl`; every other
 * phase serialises to the canonical token the store column holds and the live
 * views show. This is the label the review loop persists via `setAgentPhase`.
 */
export function phaseLabel(phase: AgentPhase): string {
  switch (phase.kind) {
    case "impl":
      return "impl";
    case "ci-gate":
      return "ci-gate";
    case "review":
      return `${REVIEW_PREFIX}${phase.phase}`;
    case "fix":
      return `${FIX_PREFIX}${phase.phase}`;
    case "merge":
      return "merge";
    case "merge-conflict":
      return "merge-conflict";
    case "other":
      return phase.raw;
  }
}

/** The trailing phase number of a `review-`/`fix-` label, or `null` (no regex). */
function suffixPhase(stored: string, prefix: string): Phase | null {
  if (!stored.startsWith(prefix)) {
    return null;
  }
  switch (stored.slice(prefix.length)) {
    case "0":
      return 0;
    case "1":
      return 1;
    case "2":
      return 2;
    default:
      return null;
  }
}

/**
 * Decode a stored phase label (or `null`/absent for impl) back into the typed
 * union. The one place a stored label is parsed, so producers and read-model
 * consumers do not drift.
 */
export function decodeAgentPhase(stored: string | null | undefined): AgentPhase {
  if (!stored || stored === "impl") {
    return { kind: "impl" };
  }
  if (stored === "ci-gate") {
    return CI_GATE;
  }
  if (stored === "merge") {
    return MERGE;
  }
  if (stored === "merge-conflict") {
    return MERGE_CONFLICT;
  }
  const review = suffixPhase(stored, REVIEW_PREFIX);
  if (review === 1 || review === 2) {
    return { kind: "review", phase: review };
  }
  const fix = suffixPhase(stored, FIX_PREFIX);
  if (fix !== null) {
    return { kind: "fix", phase: fix };
  }
  return { kind: "other", raw: stored };
}

/**
 * The review-phase number (1 or 2) whose live fix-attempt counter this phase
 * maps to, or `null`. Only the numbered review/fix phases carry a fix-attempt
 * count the live read-model surfaces — the CI gate (phase 0), merge, and impl do not.
 */
export function reviewPhaseNumber(phase: AgentPhase): 1 | 2 | null {
  if ((phase.kind === "review" || phase.kind === "fix") && (phase.phase === 1 || phase.phase === 2)) {
    return phase.phase;
  }
  return null;
}
