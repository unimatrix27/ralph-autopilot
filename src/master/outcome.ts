/**
 * The master's **outcome contract** (ADR-0041): the exactly-five terminal dispositions a
 * master intervention may reach, as a strict zod discriminated union, plus the scoped
 * decision drafts an intervention may publish alongside its outcome.
 *
 * Two properties are load-bearing:
 *
 *  - **Exactly one outcome, always.** There is no "deferred", no "partially resolved", no
 *    free-text tail (the no-deferral rule has nowhere to hide here by construction). A
 *    master that cannot pick an autonomous move must pick `ask-human` or `terminal-stuck` —
 *    both of which are *real work products*, not shrugs.
 *  - **`conclusion` and `rationale` are required on every arm.** The worker's recommendation
 *    is primary evidence, never an automatically accepted answer, so the master is forced to
 *    state its *own* conclusion. A schema that let it echo "agreed" would quietly turn the
 *    master into a rubber stamp, which is the one failure mode this whole slice exists to
 *    prevent.
 *
 * Strict everywhere (ADR-0010): an unknown key is a rejected outcome, re-asked, not a
 * silently-dropped field.
 */

import { z } from "zod";
import { escalationQuestionSchema } from "../review/escalation";
import { DECISION_SCOPES } from "../ledger/decision";
import type { MasterResolution } from "../store/types";

const required = (label: string) => z.string().min(1, `${label} is required`);

/**
 * The fields every arm carries. `conclusion` is the master's own reading of the situation;
 * `rationale` is why *this* resolution follows from it. Both are shown back to whoever
 * continues the work (the resumed phase, the fresh worker, the human), so they are the
 * durable product of the intervention, not session chatter.
 */
const common = {
  conclusion: required("conclusion"),
  rationale: required("rationale"),
} as const;

/**
 * The typed harness retries a `retry-pipeline` outcome may request (ADR-0041). Each names an
 * existing daemon action; **none** of them skips the gate it re-runs — "retry the CI gate"
 * means run it again, never treat it as passed.
 */
export const PIPELINE_RETRY_ACTIONS = ["ci", "review", "merge", "reconcile"] as const;
export type PipelineRetryAction = (typeof PIPELINE_RETRY_ACTIONS)[number];

const resolvedAndContinueSchema = z
  .object({
    resolution: z.literal("resolved-and-continue"),
    ...common,
    /**
     * Authoritative guidance injected into the re-entered phase. Required: "the master made a
     * repair" with nothing to say leaves the resumed worker exactly as blind as before.
     */
    guidance: required("guidance"),
    /** The head SHA the master pushed, when it made a direct repair. */
    pushedSha: z.string().min(1).optional(),
  })
  .strict();

const redispatchTierOneSchema = z
  .object({
    resolution: z.literal("redispatch-tier-1"),
    ...common,
    /** The brief the fresh tier-1 worker resumes the preserved WIP branch with. */
    brief: required("brief"),
  })
  .strict();

const retryPipelineSchema = z
  .object({
    resolution: z.literal("retry-pipeline"),
    ...common,
    /** Which typed harness action to re-run — never a gate bypass. */
    action: z.enum(PIPELINE_RETRY_ACTIONS),
  })
  .strict();

const askHumanSchema = z
  .object({
    resolution: z.literal("ask-human"),
    ...common,
    /** The structured `ralph-question` to publish — the ONLY path to one in this slice. */
    question: escalationQuestionSchema,
  })
  .strict();

const terminalStuckSchema = z
  .object({
    resolution: z.literal("terminal-stuck"),
    ...common,
    /** Why neither another autonomous action nor a human decision can help. */
    reason: required("reason"),
  })
  .strict();

/** The master's terminal disposition — exactly one of five (ADR-0041). */
export const masterOutcomeSchema = z.discriminatedUnion("resolution", [
  resolvedAndContinueSchema,
  redispatchTierOneSchema,
  retryPipelineSchema,
  askHumanSchema,
  terminalStuckSchema,
]);

export type MasterOutcome = z.infer<typeof masterOutcomeSchema>;
export type ResolvedAndContinueOutcome = z.infer<typeof resolvedAndContinueSchema>;
export type RedispatchTierOneOutcome = z.infer<typeof redispatchTierOneSchema>;
export type RetryPipelineOutcome = z.infer<typeof retryPipelineSchema>;
export type AskHumanOutcome = z.infer<typeof askHumanSchema>;
export type TerminalStuckOutcome = z.infer<typeof terminalStuckSchema>;

/** Every resolution name, in the ADR's order — the vocabulary tests and prompts iterate. */
export const MASTER_RESOLUTIONS: readonly MasterResolution[] = [
  "resolved-and-continue",
  "redispatch-tier-1",
  "retry-pipeline",
  "ask-human",
  "terminal-stuck",
];

/**
 * A binding decision the master wants written into the durable ledger (ADR-0040). This is
 * the *draft*: the master supplies the substance, the engine supplies provenance (repo,
 * issue, run, phase, head SHA, authoring model, timestamp) and resolves the storage node
 * from the hierarchy — so a master can neither forge provenance nor plant a decision on a
 * node it does not govern.
 */
export const masterDecisionDraftSchema = z
  .object({
    /** The decision key this record claims (e.g. `test-strategy`). */
    key: required("key"),
    /** How far the decision reaches — it lands on the narrowest node matching this scope. */
    scope: z.enum(DECISION_SCOPES),
    /** The subtree root this decision governs; required for `subtree` scope. */
    subtreeRoot: z.object({ repo: required("repo"), number: z.number().int().positive() }).optional(),
    decision: required("decision"),
    rationale: required("rationale"),
    constraints: z.array(z.string().min(1)).default([]),
    rejectedAlternatives: z.array(z.string().min(1)).default([]),
    evidence: z.array(z.string().min(1)).default([]),
    /**
     * The id of an existing record this one supersedes. Present ⇒ the master is *changing*
     * a standing decision, which it may not do autonomously — the engine routes it to
     * `ask-human` (ADR-0041). Kept in the schema so the intent is explicit and auditable
     * rather than smuggled in as a same-key re-claim.
     */
    supersedes: z.string().min(1).optional(),
  })
  .strict();

export type MasterDecisionDraft = z.infer<typeof masterDecisionDraftSchema>;

/** What one master session returns: its single outcome plus any decisions it wants published. */
export const masterSessionResultSchema = z
  .object({
    outcome: masterOutcomeSchema,
    decisions: z.array(masterDecisionDraftSchema).default([]),
  })
  .strict();

export type MasterSessionResult = z.infer<typeof masterSessionResultSchema>;

/** Parse an untrusted master session result (an SDK agent's tool call / structured output). */
export function parseMasterSessionResult(value: unknown): MasterSessionResult {
  return masterSessionResultSchema.parse(value);
}

/** Whether a resolution is one of the two final-adjudication arms. */
export function isFinalAdjudication(resolution: MasterResolution): boolean {
  return resolution === "ask-human" || resolution === "terminal-stuck";
}
