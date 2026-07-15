/**
 * Pure builders for the Inbox + answers read/write models (issue #112). They fold the
 * GitHub-sourced open-question queue (`hitl/queue`) and the store's run enrichment into the
 * browser-safe wire shapes ({@link InboxResponse} / {@link AnswerResponse}), adding no queue
 * ownership of their own (ADR-0029: the read edge is a thin serialization; ADR-0032: answers reuse
 * `RalphAnswerService` verbatim). Kept pure (the GitHub round-trips happen in
 * {@link import("./control-plane").createWebPorts}) so the mapping is unit-testable with no network.
 *
 * The Inbox is the `ralph-answer` queue surfaced as a control surface: it neither owns state nor
 * bypasses the reconciler. Answer semantics live in `hitl/answer`; this module only serializes the
 * live queue entry and the resume/re-admit consequence derived from the HITL label semantics the
 * queue already carries.
 */
import type { OpenQuestionItem } from "../hitl/queue";
import { consequenceForAnswerableLabel } from "../hitl/labels";
import type { EscalationQuestion } from "../review/escalation";
import type { Phase, Run } from "../store/types";
import type {
  AnswerResponse,
  EscalationQuestionWire,
  InboxAttentionLabelWire,
  InboxCard,
  InboxConsequenceWire,
  InboxResponse,
} from "./contract";
import { buildPowerActionCatalog } from "./power-action-affordance";

type AssertTrue<T extends true> = T;
type SameShape<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? Exclude<keyof A, keyof B> extends never
      ? Exclude<keyof B, keyof A> extends never
        ? true
        : false
      : false
    : false
  : false;

/** Node-side drift guard for the browser-safe mirror in `src/web/contract/inbox.ts`. */
export type EscalationQuestionWireDriftGuard = AssertTrue<
  SameShape<EscalationQuestion, EscalationQuestionWire>
>;

/**
 * Explicitly serialize the canonical question into the browser-safe mirror. The type sentinel above
 * makes a required-field or optionality drift between `review/escalation` and the wire contract a
 * compile-time failure instead of letting zod strip an unmirrored nested field.
 */
export function toEscalationQuestionWire(question: EscalationQuestion): EscalationQuestionWire {
  return {
    headline: question.headline,
    feature: question.feature,
    whereWeStand: question.whereWeStand,
    decision: question.decision,
    ...(question.options === undefined ? {} : { options: question.options }),
    stakes: question.stakes,
    recommendation: question.recommendation,
  } satisfies EscalationQuestionWire;
}

/** The domain outcome of an answer attempt — the HTTP adapter maps each branch to a status. */
export type AnswerPortResult =
  | { kind: "answered"; response: AnswerResponse }
  | { kind: "invalid-answer"; error: string }
  | { kind: "no-open-question"; error: string };

/** One gathered inbox entry: the queue item, the repo it came from, and its run enrichment. */
export interface InboxEntry {
  item: OpenQuestionItem;
  repo: string;
  /** The run row for the entry's issue, for deep links; `undefined` when none exists. */
  run: Run | undefined;
}

/**
 * Map one gathered entry to its wire card: the consequence derived from the label, the carried
 * phase marker (if any), and the run enrichment (runId / branch / PR for deep links). Pure.
 */
export function toInboxCard(entry: InboxEntry): InboxCard {
  const { item, repo, run } = entry;
  const attentionLabel: InboxAttentionLabelWire = item.label;
  const consequence: InboxConsequenceWire = consequenceForAnswerableLabel(item.label);
  return {
    repo,
    issue: item.issue.number,
    title: item.issue.title,
    createdAt: item.issue.createdAt,
    attentionLabel,
    consequence,
    phase: item.phase satisfies Phase | null,
    question: toEscalationQuestionWire(item.question),
    run: run
      ? { runId: String(run.id), branch: run.branch, prNumber: run.prNumber }
      : null,
    // A card always sits in the "attention" surface; its affordance is resolved from the
    // response catalog built below (the static descriptor is emitted once, not per card).
    powerActionSurface: "attention",
  };
}

/**
 * Build the `/api/inbox` payload from the gathered entries: cards oldest-first (by issue creation,
 * matching the queue's own FIFO order), the active repo filter echoed, and the full configured
 * repo list preserved. Pure over the entries — the per-repo GitHub reads happen in the port.
 */
export function toInboxResponse(
  entries: readonly InboxEntry[],
  opts: {
    now: () => Date;
    repos: string[];
    repo?: string;
    reconcileIntervalSeconds: number;
    priorityLabelsFor?: (repo: string) => readonly string[];
  },
): InboxResponse {
  const priorityLabelsFor = opts.priorityLabelsFor ?? (() => []);
  const cards = [...entries]
    .map((entry) => toInboxCard(entry))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    generatedAt: opts.now().toISOString(),
    repo: opts.repo ?? null,
    repos: opts.repos,
    reconcileIntervalSeconds: opts.reconcileIntervalSeconds,
    cards,
    // The static "attention" descriptors are emitted once, deduplicated per repo — each
    // card carries only its repo + surface tag (issue #114 phase-2 P1).
    powerActions: buildPowerActionCatalog(
      cards.map((card) => ({ repo: card.repo, surface: card.powerActionSurface })),
      priorityLabelsFor,
    ),
  };
}
