/**
 * The **event → notification decision** (issue #117): a pure, total transform over a
 * coalesced batch of committed log events that decides which of them surface an
 * out-of-app notification, and dedups within the batch.
 *
 * It is the brain of the notification sink — exhaustive unit-tested here, free of any
 * node/store/SDK reference, so it composes under the broadcast channel's microtask drain
 * without ever touching I/O. The side-effecting dispatch lives in
 * {@link import("./dispatch").NotificationDispatcher}; the subscription + stall probe
 * wiring in {@link import("./sink").NotificationSink}.
 *
 * What notifies (the human-attention label families the operator would otherwise only
 * see in the UI):
 *   - a new **escalation** ← `Escalated { kind: "escalate" }` (an impl/fix agent paused
 *     for a decision — `awaiting-answer`),
 *   - a new **heal** ← `Escalated { kind: "heal-card" }` or `ReviewMaxed` (a review phase
 *     exhausted its fix attempts — both surface a heal-card),
 *   - a new **stuck** ← `RunStuck` (an agent bounded out — `agent-stuck`),
 *   - a new **anomaly** ← `AnomalyDetected` (the completeness invariant flagged an island
 *     — `daemon-anomaly`, the no-silent-loss guarantee, so it pages at max severity).
 *
 * Dedup is per `(repo, issueNumber, kind)` within one batch, with two lifecycle
 * coalescing rules: an `Escalated` closed by a later `QuestionAnswered` in the same
 * commit is an internal compensation (not a fresh operator question), and an
 * `AnomalyDetected` suppresses lower-severity same-issue facts from the same commit.
 * The `stall` kind is produced by the sink's probe, not here, and dedups by stall
 * episode there.
 */
import type { RecordedLogEvent } from "../store/log-broadcast";
import { parseIssueStreamId } from "../store/events/streams";
import type { NotificationKind, NotificationRequest, NotificationSeverity } from "./types";

/** The severity each attention kind pages at (escalation/heal/stuck are decisions; anomaly is max). */
const SEVERITY: Record<NotificationKind, NotificationSeverity> = {
  escalation: "high",
  heal: "high",
  stuck: "high",
  anomaly: "max",
  stall: "max",
};

/**
 * Decide which events in a committed batch notify, returning one deduped
 * {@link NotificationRequest} per `(repo, issue, kind)`, in first-seen order. Pure and
 * total: an empty/malformed/unknown batch yields `[]` (a tolerant reader — the sink must
 * never throw on an event it does not fully understand).
 *
 * `now` is injected so the stamped `at` instant is deterministic under test; it defaults
 * to the wall clock.
 */
export function decideNotifications(
  events: RecordedLogEvent[],
  now: () => Date = (): Date => new Date(),
): NotificationRequest[] {
  const at = now().toISOString();
  const facts = batchFacts(events);
  // First-seen-wins dedup keyed by repo+issue+kind (a coalesced batch may carry the same
  // attention event twice for one issue — page once).
  const seen = new Set<string>();
  const out: NotificationRequest[] = [];
  for (const ev of events) {
    const planned = planNotification(ev, at, facts);
    if (planned === null) {
      continue;
    }
    const key = `${planned.repo}#${planned.issueNumber}#${planned.kind}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(planned);
  }
  return out;
}

/**
 * Map one committed event to its notification (or `null` if it should not notify / cannot
 * be safely read). The single event-classification site: an unknown type, an unreadable
 * payload, or a stream id that is not a recoverable `<repo>#<issue>` all yield `null`.
 */
function planNotification(ev: RecordedLogEvent, at: string, facts: BatchFacts): NotificationRequest | null {
  const ref = parseIssueStreamId(ev.streamId);
  if (ref === null) {
    // System / transcript / malformed streams carry no per-issue attention signal.
    return null;
  }
  const where = `${ref.repo}#${ref.issueNumber}`;
  if (ev.type !== "AnomalyDetected" && facts.anomalyIssues.has(issueKey(ref))) {
    // Claim parks can commit `RunStuck` and `AnomalyDetected` together. The issue's
    // visible human-attention surface is the daemon anomaly, so page only the max signal.
    return null;
  }
  switch (ev.type) {
    case "Escalated": {
      if (facts.answeredEscalations.has(ev.globalPosition)) {
        return null;
      }
      const kind = field(ev.data, "kind");
      if (kind === "escalate") {
        return build("escalation", ref, at, `Escalation on ${where}`, text(ev.data, "headline"));
      }
      if (kind === "heal-card") {
        return build("heal", ref, at, `Heal card on ${where}`, text(ev.data, "headline"));
      }
      return null; // an Escalated without a recognised kind — tolerant no-op.
    }
    case "ReviewMaxed": {
      if (facts.answeredReviewMaxed.has(ev.globalPosition)) {
        return null;
      }
      const phase = numberField(ev.data, "phase");
      const suffix = typeof phase === "number" ? ` (phase ${phase})` : "";
      return build("heal", ref, at, `Review maxed on ${where}`, `Review phase exhausted its fix attempts${suffix}.`);
    }
    case "RunStuck": {
      return build("stuck", ref, at, `Agent stuck on ${where}`, text(ev.data, "reason"));
    }
    case "AnomalyDetected": {
      return build("anomaly", ref, at, `Daemon anomaly on ${where}`, text(ev.data, "reason"));
    }
    default:
      return null; // RunStarted/FixAttempted/Merged/AnomalyCleared/transcripts/… do not notify.
  }
}

interface BatchFacts {
  /** `globalPosition`s of `Escalated` events closed by a later `QuestionAnswered` in the same batch. */
  answeredEscalations: Set<number>;
  /** `ReviewMaxed` restore compensations closed by a later `QuestionAnswered` in the same batch. */
  answeredReviewMaxed: Set<number>;
  /** Issues that carry an anomaly fact in this batch; anomaly pages suppress lower-severity siblings. */
  anomalyIssues: Set<string>;
}

function batchFacts(events: RecordedLogEvent[]): BatchFacts {
  const answeredEscalations = new Set<number>();
  const answeredReviewMaxed = new Set<number>();
  const anomalyIssues = new Set<string>();
  const answerAllByStream = new Set<string>();
  const answerByComment = new Set<string>();
  const answerAnyByStream = new Set<string>();

  for (const ev of events) {
    if (ev.type !== "AnomalyDetected") {
      continue;
    }
    const ref = parseIssueStreamId(ev.streamId);
    if (ref !== null) {
      anomalyIssues.add(issueKey(ref));
    }
  }

  // Walk backward so only a later `QuestionAnswered` suppresses an earlier `Escalated`.
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]!;
    const ref = parseIssueStreamId(ev.streamId);
    if (ref === null) {
      continue;
    }
    if (ev.type === "QuestionAnswered") {
      const answeredComment = commentId(ev.data);
      answerAnyByStream.add(ev.streamId);
      if (answeredComment === null || answeredComment === undefined) {
        answerAllByStream.add(ev.streamId);
      } else {
        answerByComment.add(commentKey(ev.streamId, answeredComment));
      }
      continue;
    }
    if (ev.type === "ReviewMaxed") {
      if (answerAnyByStream.has(ev.streamId)) {
        answeredReviewMaxed.add(ev.globalPosition);
      }
      continue;
    }
    if (ev.type !== "Escalated") {
      continue;
    }
    const escalatedComment = commentId(ev.data);
    if (
      answerAllByStream.has(ev.streamId) ||
      (escalatedComment !== null &&
        escalatedComment !== undefined &&
        answerByComment.has(commentKey(ev.streamId, escalatedComment)))
    ) {
      answeredEscalations.add(ev.globalPosition);
    }
  }

  return { answeredEscalations, answeredReviewMaxed, anomalyIssues };
}

/** Build a request, filling a tolerant fallback body when the event carried no text. */
function build(
  kind: NotificationKind,
  ref: { repo: string; issueNumber: number },
  at: string,
  title: string,
  body: string,
): NotificationRequest {
  return {
    kind,
    severity: SEVERITY[kind],
    title,
    message: body.length > 0 ? body : title,
    repo: ref.repo,
    issueNumber: ref.issueNumber,
    at,
  };
}

/** Read a string field off an opaque event payload, or `null` if absent/not a string. */
function field(data: unknown, key: string): string | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const v = (data as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
}

/** Read a string field trimmed, or `""` when absent — the tolerant body for a notification. */
function text(data: unknown, key: string): string {
  return (field(data, key) ?? "").trim();
}

function numberField(data: unknown, key: string): number | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const v = (data as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function commentId(data: unknown): number | null | undefined {
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const v = (data as Record<string, unknown>).commentId;
  if (v === null) {
    return null;
  }
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function issueKey(ref: { repo: string; issueNumber: number }): string {
  return `${ref.repo}#${ref.issueNumber}`;
}

function commentKey(streamId: string, id: number): string {
  return `${streamId}#${id}`;
}
