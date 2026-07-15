/**
 * The **Inbox + answers** wire shape (ADR-0031/0032, issue #112) — the browser-safe
 * contract for the first write path: clearing escalations from the UI. Both the daemon
 * (serialize) and the UI (parse) share this leaf, so a drift is a compile error, not a
 * silent mis-render.
 *
 * The Inbox is the `ralph-answer` queue (CONTEXT: ralph-question / ralph-answer) surfaced
 * as a control surface: every open question across all repos, oldest-first, rendered as a
 * structured card. Answering reuses `RalphAnswerService` verbatim — the UI is not a second
 * source of truth, it posts the same `ralph-answer` comment + label swap the CLI does, and
 * the reconciler resumes/re-admits next tick (ADR-0032: writes are eventually-consistent
 * via the reconciler).
 *
 * Browser-safe like the rest of the leaf (zod only, zero node imports): the escalation
 * question fields are **mirrored** here rather than imported from `review/escalation` (that
 * module is not part of the leaf and pulls in non-leaf deps). The additive-only evolution
 * rule (ADR-0026) applies.
 */
import { z } from "zod";
import { issueNumber, repoSlug } from "./primitives";
import { powerActionCatalogSchema, powerActionSurfaceSchema } from "./power-actions";

/**
 * The escalation question, mirrored browser-side (ADR-0031). Structurally identical to the
 * node-side `EscalationQuestion` (`review/escalation`) — the same fields, the same optionality
 * — and guarded by the node-side converter in `web/inbox`. `stakes` and
 * `recommendation` are always present (the escalation schema requires them); the UI emphasizes
 * the stakes and highlights the recommendation.
 */
export const escalationQuestionWireSchema = z.object({
  headline: z.string(),
  feature: z.string(),
  whereWeStand: z.string(),
  decision: z.string(),
  options: z.array(z.string()).optional(),
  stakes: z.string(),
  recommendation: z.string(),
});
export type EscalationQuestionWire = z.infer<typeof escalationQuestionWireSchema>;

/**
 * The human-attention label an answerable issue carries — the wire mirror of the canonical
 * label names (`awaiting-answer` / `review-maxed` / `agent-stuck`). It is the index into the
 * `ralph-answer` queue and the determinant of what answering *does* (see {@link inboxConsequenceSchema}).
 */
export const INBOX_ATTENTION_LABELS = ["awaiting-answer", "review-maxed", "agent-stuck"] as const;
export const inboxAttentionLabelSchema = z.enum(INBOX_ATTENTION_LABELS);
export type InboxAttentionLabelWire = z.infer<typeof inboxAttentionLabelSchema>;

/**
 * What answering this question does to the run — the consequence the UI states plainly so the
 * operator is never lied to about immediacy (ADR-0032: no faked immediacy):
 *   - `resume-from-wip` — `awaiting-answer` (an impl escalation) and `review-maxed` (a heal-card)
 *     both resume the *paused* run from its checkpointed WIP branch next tick;
 *   - `readmit-fresh` — `agent-stuck` (a stuck-card) re-admits a *fresh* run with the operator's
 *     guidance injected (#86), not a resume.
 */
export const INBOX_CONSEQUENCES = ["resume-from-wip", "readmit-fresh"] as const;
export const inboxConsequenceSchema = z.enum(INBOX_CONSEQUENCES);
export type InboxConsequenceWire = z.infer<typeof inboxConsequenceSchema>;

/**
 * The phase marker a review-origin pause carries (recovered from its hidden `ralph-phase` marker),
 * or `null` for an impl-agent escalation (which carries no marker). Phase 0 is the CI gate/fix
 * loop; phases 1 and 2 are review phases. Surfaced so the UI can name the consequence precisely
 * rather than the generic "resume".
 */
const inboxPhaseSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]).nullable();

/**
 * The run enrichment for an inbox card's deep links — the run row's correlation tag, WIP branch,
 * and PR. `null` when no run row exists (e.g. a bare stuck-card on an issue never picked up into a
 * tracked run); the deep links then degrade to the issue alone.
 */
const inboxRunSchema = z
  .object({
    runId: z.string().nullable(),
    branch: z.string().nullable(),
    prNumber: z.number().int().positive().nullable(),
  })
  .nullable();

/**
 * One open question as the UI renders it: the answerable issue, its consequence, the structured
 * question (stakes + recommendation emphasized), and the run enrichment for deep links. Ordered
 * oldest-first in the response.
 */
export const inboxCardSchema = z
  .object({
    repo: repoSlug,
    issue: issueNumber,
    title: z.string(),
    /** ISO-8601 issue creation timestamp — the FIFO key (oldest-first ordering). */
    createdAt: z.string(),
    attentionLabel: inboxAttentionLabelSchema,
    consequence: inboxConsequenceSchema,
    phase: inboxPhaseSchema,
    question: escalationQuestionWireSchema,
    run: inboxRunSchema,
    /** The surface this card sits in; resolves its affordance in the response catalog. */
    powerActionSurface: powerActionSurfaceSchema,
  })
  .strict();
export type InboxCard = z.infer<typeof inboxCardSchema>;

/** Human-readable label for a carried phase marker, or `null` when no marker exists. */
export function inboxPhaseLabel(phase: InboxCard["phase"]): string | null {
  if (phase === null) {
    return null;
  }
  if (phase === 0) {
    return "CI gate";
  }
  return `phase ${phase}`;
}

/**
 * Plain-language target for a resume-from-WIP answer. Phase 0 is the CI gate/fix loop, not review;
 * phases 1 and 2 re-enter the review flow at the carried phase.
 */
export function inboxResumeTargetText(phase: InboxCard["phase"]): string {
  if (phase === 0) {
    return "re-enters the CI gate/fix loop from its checkpointed WIP";
  }
  if (phase !== null) {
    return `re-enters phase-${phase} review from its checkpointed WIP`;
  }
  return "resumes the agent from its checkpointed WIP branch";
}

/** The `/api/inbox` payload: every open question across repos, oldest-first. */
export const inboxResponseSchema = z
  .object({
    /** ISO-8601 instant this view was projected. */
    generatedAt: z.string(),
    /** The active repo filter, or null when aggregate across all repos. */
    repo: repoSlug.nullable(),
    /** Every configured target repo, for the filter — never narrowed by `repo`. */
    repos: z.array(repoSlug),
    /**
     * The daemon's reconcile interval in seconds — the honest "the daemon acts next tick (~Ns)"
     * figure the UI states (ADR-0032: no faked immediacy). Positive integer.
     */
    reconcileIntervalSeconds: z.number().int().positive(),
    /** Open questions oldest-first (by issue creation). */
    cards: z.array(inboxCardSchema),
    /**
     * The deduplicated power-action affordance catalog (issue #114): every (repo, surface)
     * pair the cards reference, emitted once. A card resolves its controls via
     * `powerActions[card.repo]?.[card.powerActionSurface]` — the static descriptor is never
     * repeated per card.
     */
    powerActions: powerActionCatalogSchema,
  })
  .strict();
export type InboxResponse = z.infer<typeof inboxResponseSchema>;

/**
 * How the operator answered — the three affordances the Inbox offers, mirroring the node-side
 * `AnswerKind`. The server resolves each against the canonical question (re-fetched from GitHub), so
 * the injected text is always authoritative, never a stale client copy — a free-text value is taken
 * verbatim even when it collides with the option/accept grammar.
 */
export const ANSWER_KINDS = ["accept-recommendation", "option", "free-text"] as const;
export const answerKindSchema = z.enum(ANSWER_KINDS);
export type AnswerKindWire = z.infer<typeof answerKindSchema>;

const answerRequestBaseShape = {
  repo: repoSlug,
  issue: issueNumber,
} as const;

/**
 * The `/api/inbox/answer` request body. It is a discriminated variant at the wire edge:
 * `optionIndex` exists only on an `option` answer and is required there; `text` exists only on a
 * `free-text` answer and is required there; `accept-recommendation` carries no answer payload.
 * The server still validates live-question constraints (option range, non-empty trimmed text)
 * immediately before submitting.
 */
export const answerRequestBodySchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...answerRequestBaseShape,
      kind: z.literal("accept-recommendation"),
    })
    .strict(),
  z
    .object({
      ...answerRequestBaseShape,
      kind: z.literal("option"),
      /** Zero-based index into the question's `options`. */
      optionIndex: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      ...answerRequestBaseShape,
      kind: z.literal("free-text"),
      /** The verbatim free-text reply. */
      text: z.string(),
    })
    .strict(),
]);
export type AnswerRequestBody = z.infer<typeof answerRequestBodySchema>;

/** The `/api/inbox/answer` response: what happened, and when the daemon acts on it. */
export const answerResponseSchema = z
  .object({
    /** ISO-8601 instant the answer was written back. */
    generatedAt: z.string(),
    repo: repoSlug,
    issue: issueNumber,
    attentionLabel: inboxAttentionLabelSchema,
    consequence: inboxConsequenceSchema,
    /**
     * The daemon's reconcile interval — the honest "resumes next tick (~Ns)" figure. The UI states
     * this so the operator knows the action is eventual, not immediate (ADR-0032).
     */
    resumesNextTickSeconds: z.number().int().positive(),
  })
  .strict();
export type AnswerResponse = z.infer<typeof answerResponseSchema>;
