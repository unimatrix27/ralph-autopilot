/**
 * Auto-mode (CONTEXT: moding pass). The eligibility gate (DESIGN §2) requires a
 * `mode:tdd` / `mode:infra` label; an issue an operator has marked `ready-for-agent`
 * + `afk` but never stamped with a mode is excluded with reason `no-mode`, so a
 * backlog whose triage doesn't stamp modes silently stalls. The **moding pass** fills
 * exactly that one gap: it finds the open issues the gate rejects *solely* because
 * they lack a `mode:*` label and applies the one missing label, so they become
 * gate-eligible next tick. It does NOT triage the whole backlog — it only supplies a
 * label on issues a human has already marked ready, so human control over *what* gets
 * worked is preserved. Labels are the protocol (DESIGN §9).
 *
 * This module is the pure half: the candidate *selection* (reusing the gate, so the
 * "only the mode is missing" test can never drift from admission) plus the
 * {@link ModeClassifier} port and its validated {@link ModeDecision}. The concrete
 * classifier is a container-moding follow-up (ADR-0038): the in-process SDK impl was
 * retired with the rest of the in-process execution path (#227), so production wires no
 * classifier and the reconciler's bounded pass is a no-op until a container-backed
 * classifier re-arms it. The port, this selection, and the `autoMode` config are kept so
 * that re-arming is a drop-in.
 */

import { z } from "zod";
import { createDepCache, gateOne, type GateResult } from "./admission";
import { LABEL_MODE_TDD, readMode } from "./labels";
import type { Issue } from "../github/types";
import type { Logger } from "../log/logger";
import type { Mode } from "../store/types";
import type { TranscriptSink } from "../executor/transcript-sink";

/**
 * The classifier's verdict for one issue: the chosen {@link Mode} and a short reason.
 * The harness-owned rubric (ADR-0012) is `tdd` for code changes that should be driven
 * by a failing test, `infra` for no-code / no-test work (config, docs, infra,
 * schema/plan); the target's conventions are *context* for the call, never a gate.
 * `mode:ui` is deliberately NOT classifiable — it demands a rendering judgment (and a
 * chromium-equipped target image) the rubric doesn't make, so it is operator-applied
 * only; the schema below narrows to the two auto-modeable values on purpose.
 */
export interface ModeDecision {
  mode: Mode;
  reason: string;
}

/** Validates the classifier's structured output at the boundary (the #15 path). */
export const modeDecisionSchema = z
  .object({
    mode: z.enum(["tdd", "infra"]),
    reason: z.string().min(1, "must not be empty"),
  })
  .strict();

/** Parse + validate a classifier's raw JSON into a {@link ModeDecision}; throws on mismatch. */
export function parseModeDecision(value: unknown): ModeDecision {
  return modeDecisionSchema.parse(value);
}

/** What a {@link ModeClassifier} is handed for one classification. */
export interface ModeContext {
  /** The unmoded issue to classify — its title/body drive the decision. */
  issue: Issue;
  logger: Logger;
  /** Run-level abort signal, if any; links into the classification session. */
  abortSignal?: AbortSignal;
  /**
   * Transcript capture sink for the classification session (ADR-0030). The moding pass
   * has no run row, so it captures on the synthetic per-issue stream
   * `transcript:<repo>#<issue>:moding`. Absent → no capture.
   */
  transcriptSink?: TranscriptSink;
}

/**
 * Classifies one unmoded issue as `tdd` or `infra`. The production impl will be a
 * bounded, fresh-context session hosted inside the agent container (the container-moding
 * follow-up, ADR-0038) — the in-process SDK impl was retired with the in-process
 * execution path (#227), so today production wires no classifier and the pass no-ops;
 * tests inject a fake. Returns `null` when the classifier cannot decide (low confidence,
 * a wall-clock kill, or repeated unparseable output): the pass then leaves the issue
 * unmoded and logs it — never a guess-label and never a `daemon-anomaly` (no-silent-loss,
 * issue #27 / #16).
 */
export interface ModeClassifier {
  classify(ctx: ModeContext): Promise<ModeDecision | null>;
}

/**
 * Would this issue pass the full eligibility gate if it merely carried a mode? The
 * auto-mode pass's core "only the mode is missing" test, factored out so the backlog
 * projection (issue #113) can run the EXACT same gate — its moding-candidate set can
 * then never drift from what this pass selects. A synthetic mode (any mode satisfies
 * {@link readMode}) is added and the real gate ({@link gateOne}) is run over the
 * issue's `## Blocked by` deps; the synthetic label affects only the mode check, so an
 * `eligible` verdict means the mode is the ONLY missing condition, and a `blocked`
 * verdict carries the unmet deps. Intended for an already-unmoded issue (the caller's
 * precondition) — the verdict is then either `eligible` (a true moding candidate) or
 * `blocked` (the issue is also dependency-blocked, not auto-modeable).
 *
 * Delegates straight to {@link import("./admission").gateOne} — admit's own async gate
 * finisher — so the `parseBlockedBy → resolve each ref` dance is literally the code
 * admit runs, never a re-implementation. The caller's async dependency resolver (a
 * memoized {@link createDepCache} spanning the caller's issue set) is threaded through
 * unchanged, so neither caller hand-rolls the parse→resolve resolution the shared gate
 * exists to eliminate.
 */
export async function gateWithSyntheticMode(
  issue: Issue,
  resolveDep: (issueNumber: number) => Promise<boolean>,
): Promise<GateResult> {
  const synthetic: Issue = { ...issue, labels: [...issue.labels, LABEL_MODE_TDD] };
  return gateOne(synthetic, resolveDep);
}

/**
 * Select the open issues whose **only** unmet eligibility-gate condition is the
 * missing `mode:*` label — the moding pass's candidates — capped at `maxPerTick`,
 * oldest-first (FIFO by issue age, the scheduler's fairness order).
 *
 * The "only the mode is missing" test reuses the gate so it can never drift from
 * admission: an issue qualifies iff it carries no mode today AND a synthetic copy
 * *with* a mode would pass the full gate (OPEN + `ready-for-agent` + `afk` + not
 * `hitl` + not paused + not `[log]` + every `## Blocked by #n` dep closed-and-merged).
 * Already-moded, paused, in-flight (held by a run row, which the gate's paused/`hitl`
 * labels and the reconciler's own in-flight check exclude), or blocked issues are
 * never touched. Idempotent: a moded issue stops qualifying the instant its label lands.
 *
 * Dependencies are resolved lazily (only for an otherwise-qualifying issue that
 * carries `## Blocked by` refs) and cached across the call, mirroring {@link admit}.
 */
export async function selectModingCandidates(
  issues: Issue[],
  isDependencySatisfied: (issueNumber: number) => Promise<boolean>,
  maxPerTick: number,
): Promise<Issue[]> {
  if (maxPerTick <= 0) {
    return [];
  }
  const resolveDep = createDepCache(isDependencySatisfied);

  // Oldest-first so the moding budget is spent on the issues the scheduler would pick
  // up first — the pass never starves an old unmoded issue behind newer ones.
  const ordered = [...issues].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number,
  );

  const candidates: Issue[] = [];
  for (const issue of ordered) {
    if (candidates.length >= maxPerTick) {
      break;
    }
    // Already moded → not our gap to fill.
    if (readMode(issue.labels) !== null) {
      continue;
    }
    // Would it pass the full gate if it merely carried a mode? The shared
    // synthetic-mode gate ({@link gateWithSyntheticMode}) — the same test the backlog
    // projection uses (issue #113), so the two can never drift — owns the dep
    // resolution. An eligible verdict means the mode is the ONLY thing missing; every
    // other condition, including deps, already holds.
    if ((await gateWithSyntheticMode(issue, resolveDep)).eligible) {
      candidates.push(issue);
    }
  }
  return candidates;
}
