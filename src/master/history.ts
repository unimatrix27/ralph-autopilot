/**
 * The **master history fold** (ADR-0041): the pure projection of an issue's event stream
 * into everything a fresh master session and the loop budget need to know about what has
 * already been tried. A master session is fresh every time (ADR-0008), so this — not a
 * conversation — is its memory of its own prior attempts.
 *
 * Deliberately *not* folded into `IssueState`: master history is per-run, per-phase, and
 * list-shaped, while `IssueState` is the flat row the status projection materialises. Folding
 * it there would mean a schema column for a growing list. It is instead re-folded on demand
 * from the append-only stream, which is what makes restart recovery exact — a daemon that
 * died between "requested" and "started" re-reads the same facts and reaches the same state.
 */

import type { RecordedStreamEvent } from "../store/event-log";
import { isMasterRequestSource } from "../store/types";
import type { MasterLane, MasterRequestSource, MasterResolution } from "../store/types";

/** A pending, unstarted master request — the head of the master queue for this issue. */
export interface PendingMasterRequest {
  runId: string;
  source: MasterRequestSource;
  phase: string;
  lane: MasterLane;
  signature: string;
  headline: string;
  recommendation?: string;
  prNumber?: number | null;
}

/** One completed (or in-flight) master intervention, in append order. */
export interface MasterInterventionRecord {
  runId: string;
  attempt: number;
  phase: string;
  signature: string;
  /** The chosen resolution, or null while the intervention is still running. */
  resolution: MasterResolution | null;
  /** The master's stated rationale for the resolution, or null while running. */
  rationale: string | null;
  /** Whether a `MasterInterventionCompleted` closed this attempt span. */
  completed: boolean;
  /**
   * How many times a **human answer** re-opened this same numbered attempt (ADR-0041). An
   * answered `ask-human` resumes the *checkpointed master*, so it re-adopts this attempt
   * rather than spending a fresh one — otherwise answering the second intervention's question
   * would immediately hit the two-per-phase ceiling and throw the answer away. The count is
   * what stops the other failure mode: once an attempt has been human-resumed, the engine
   * forbids it from choosing `ask-human` again, so ask → answer → ask cannot cycle forever.
   */
  humanResumes: number;
}

/** The folded master state of one issue. */
export interface MasterHistory {
  /**
   * The outstanding request the queue should service, or null. Cleared when the run span
   * ends or the master's chosen resolution moves the run out of `master-triage`, so a
   * serviced request is never re-serviced.
   */
  pending: PendingMasterRequest | null;
  /** Whether an intervention is currently open (started, not completed) — the restart guard. */
  inProgress: MasterInterventionRecord | null;
  /** Every intervention for the CURRENT run span, in append order. */
  interventions: MasterInterventionRecord[];
  /**
   * The attempt whose `ask-human` is outstanding, or null. Set by
   * `MasterHumanQuestionRequested` and cleared when that attempt is re-opened (the answer
   * landed) or the run span restarts. This is what routes an answered question back to
   * **master adjudication** rather than to the original worker's resume.
   */
  awaitingHuman: { attempt: number; phase: string } | null;
  /** Whether this issue has ever been promoted to tier 1 by a master escalation. */
  promoted: boolean;
  /** Ids of decisions this issue's masters have already published (dedupe on replay). */
  publishedDecisionIds: string[];
}

/** The empty history of an issue no master has ever touched. */
export function emptyMasterHistory(): MasterHistory {
  return {
    pending: null,
    inProgress: null,
    interventions: [],
    awaitingHuman: null,
    promoted: false,
    publishedDecisionIds: [],
  };
}

type Data = Record<string, unknown>;

const str = (d: Data, k: string): string => (typeof d[k] === "string" ? (d[k] as string) : "");
const num = (d: Data, k: string): number => (typeof d[k] === "number" ? (d[k] as number) : 0);

/**
 * Fold an issue's raw event stream into its {@link MasterHistory}. Pure and **tolerant**
 * (ADR-0026): unknown event types are skipped, and a `RunStarted` resets the per-span view —
 * "starting a genuinely new run span resets the per-run budget; the previous history remains
 * in context" (ADR-0041), which is exactly why `promoted` and `publishedDecisionIds` survive
 * the reset while `interventions` does not.
 */
export function foldMasterHistory(events: readonly RecordedStreamEvent[]): MasterHistory {
  const history = emptyMasterHistory();

  for (const event of events) {
    const data = (event.data ?? {}) as Data;
    switch (event.type) {
      case "RunStarted":
        // A fresh span: the per-run intervention budget resets by construction. The
        // cross-span facts (promotion, published decisions) deliberately persist.
        history.pending = null;
        history.inProgress = null;
        history.interventions = [];
        history.awaitingHuman = null;
        break;
      case "MasterTriageRequested":
        history.pending = {
          runId: str(data, "runId"),
          // Tolerant reader (ADR-0026): an unknown source from a future vocabulary folds to
          // `escalate` rather than dropping the request — losing a queued escalation because
          // a fact carries a name this build has not learned yet is the one outcome the
          // completeness invariant forbids.
          source: isMasterRequestSource(data.source) ? data.source : "escalate",
          phase: str(data, "phase"),
          lane: (str(data, "lane") || "impl") as MasterLane,
          signature: str(data, "signature"),
          headline: str(data, "headline"),
          ...(typeof data.recommendation === "string" ? { recommendation: data.recommendation } : {}),
          ...(typeof data.prNumber === "number" ? { prNumber: data.prNumber } : {}),
        };
        break;
      case "ComplexityPromoted":
        history.promoted = true;
        break;
      case "MasterInterventionStarted": {
        const attempt = num(data, "attempt");
        const phase = str(data, "phase");
        const existing = history.interventions.find((i) => i.attempt === attempt && i.phase === phase);
        if (existing) {
          // A RE-OPEN of the same numbered attempt: a human answered its `ask-human` and the
          // checkpointed master resumes. It spends no fresh budget (it is the same
          // intervention continuing) — but it is counted, so the engine can refuse a second
          // `ask-human` on it and close the ask → answer → ask cycle.
          const reopened: MasterInterventionRecord = {
            ...existing,
            resolution: null,
            rationale: null,
            completed: false,
            humanResumes: existing.humanResumes + (history.awaitingHuman?.attempt === attempt ? 1 : 0),
          };
          history.interventions = history.interventions.map((i) => (i === existing ? reopened : i));
          history.inProgress = reopened;
        } else {
          const record: MasterInterventionRecord = {
            runId: str(data, "runId"),
            attempt,
            phase,
            signature: str(data, "signature"),
            resolution: null,
            rationale: null,
            completed: false,
            humanResumes: 0,
          };
          history.interventions = [...history.interventions, record];
          history.inProgress = record;
        }
        history.awaitingHuman = null;
        // The request has been taken off the queue by this session; a restart must not
        // hand the same request to a *second* session (the never-duplicate guarantee).
        history.pending = null;
        break;
      }
      case "MasterHumanQuestionRequested":
        history.awaitingHuman = { attempt: num(data, "attempt"), phase: str(data, "phase") };
        break;
      case "MasterResolutionSelected": {
        const attempt = num(data, "attempt");
        // Match on (attempt, phase), mirroring `MasterInterventionStarted`: attempt numbers are
        // per-phase, so an impl and a review intervention in ONE run span both carry attempt 1.
        // Folding by attempt alone would map this resolution over the OTHER phase's same-numbered
        // record too, corrupting the loop budget's per-signature `forbiddenResolutions`.
        const phase = str(data, "phase");
        history.interventions = history.interventions.map((i) =>
          i.attempt === attempt && i.phase === phase
            ? {
                ...i,
                resolution: str(data, "resolution") as MasterResolution,
                rationale: str(data, "rationale"),
              }
            : i,
        );
        if (history.inProgress?.attempt === attempt && history.inProgress?.phase === phase) {
          history.inProgress = history.interventions.find((i) => i.attempt === attempt && i.phase === phase) ?? null;
        }
        break;
      }
      case "MasterInterventionCompleted": {
        const attempt = num(data, "attempt");
        // Same (attempt, phase) match as the resolution handler above: closing an attempt span by
        // attempt alone would also clear the other phase's same-numbered record's `inProgress`
        // guard and overwrite its resolution.
        const phase = str(data, "phase");
        history.interventions = history.interventions.map((i) =>
          i.attempt === attempt && i.phase === phase
            ? { ...i, completed: true, resolution: (str(data, "resolution") as MasterResolution) || i.resolution }
            : i,
        );
        if (history.inProgress?.attempt === attempt && history.inProgress?.phase === phase) {
          history.inProgress = null;
        }
        break;
      }
      case "DecisionPublished":
        history.publishedDecisionIds = [...history.publishedDecisionIds, str(data, "decisionId")];
        break;
      default:
        // Tolerant reader (ADR-0026): every other fact is someone else's business.
        break;
    }
  }

  return history;
}

/** The interventions in `history` that belong to one run phase — the budget's counting unit. */
export function interventionsInPhase(history: MasterHistory, phase: string): MasterInterventionRecord[] {
  return history.interventions.filter((i) => i.phase === phase);
}
