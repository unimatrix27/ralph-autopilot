/**
 * The `ralph-question` surface (CONTEXT: escalate, ralph-question; ADR-0004). A structured
 * question whose schema is a forcing function for operator attention: `stakes` is required
 * because it translates the decision up to the architecture/user level, so the operator can
 * rule without reloading the deep technical context.
 *
 * **After the triage cutover (ADR-0042) there is exactly one author of these: the master's
 * `ask_human`.** The review loop's heal-cards are gone — a maxed-out phase now enqueues master
 * triage with its blockers as evidence, and no operator is paged for work the daemon is about
 * to do itself. The shape is retained (and still parsed) for the master's questions, for the
 * `escalate` tool's *internal* hand-off payload, and for reading back pre-cutover comments
 * during adoption.
 *
 * Renders to a fenced comment GitHub stores verbatim; the daemon parses its own comments back
 * when rebuilding state.
 */

import { z } from "zod";
import { parseFencedPayload, renderFencedPayload } from "../core/fenced-payload";
import { buildLaunchMarker } from "../github/marker";
import type { Phase } from "../store/types";

const required = (label: string) => z.string().min(1, `${label} is required`);

/**
 * The escalation question schema (ADR-0004). Validated at the tool boundary so an
 * empty required field is rejected and re-asked. `stakes` is mandatory.
 */
export const escalationQuestionSchema = z
  .object({
    headline: required("headline"),
    feature: required("feature"),
    whereWeStand: required("where_we_stand"),
    decision: required("decision"),
    options: z.array(z.string().min(1)).optional(),
    stakes: required("stakes"),
    recommendation: required("recommendation"),
  })
  .strict();

export type EscalationQuestion = z.infer<typeof escalationQuestionSchema>;

/** Parse and validate an untrusted escalation question (e.g. an SDK agent's output). */
export function parseEscalationQuestion(value: unknown): EscalationQuestion {
  return escalationQuestionSchema.parse(value);
}

/**
 * The pre-send self-check on escalation *quality* (issue #22). Two ways an
 * escalation fails the bar:
 *
 * - `design-resolvable` — it is a behaviour-preserving, internal
 *   structure / layering / naming / abstraction call the design of record + repo
 *   conventions already imply. Per the design-authority rule (ADR-0011) the agent
 *   must DECIDE it and record an ADR — handing a one-way-door taste call to a human
 *   who has not read the diff wastes the system's scarcest resource (operator
 *   attention).
 * - `requires-code-context` — `whereWeStand` / `stakes` only parse once you've read
 *   the implementation (bare file paths or code symbols). The whole point of the
 *   tool is that the decision is rulable at the architecture / user level *without*
 *   reading the diff.
 */
export type EscalationBarFailureKind = "design-resolvable" | "requires-code-context";

export interface EscalationBarFailure {
  kind: EscalationBarFailureKind;
  /** Operator/agent-facing explanation that also names the corrective action. */
  message: string;
}

export interface EscalationBarVerdict {
  /** True iff the escalation clears the bar AND reads at zero code-context. */
  pass: boolean;
  failures: EscalationBarFailure[];
}

/** Corrective guidance returned when an escalation looks design-resolvable. */
export const DESIGN_RESOLVABLE_GUIDANCE =
  "This reads as a behaviour-preserving, design-resolvable internal structure / layering / naming / " +
  "abstraction decision. Per the design-authority rule (ADR-0011), DECIDE it yourself in the direction " +
  "the design of record and the repo's own conventions already imply, record an ADR, and continue — do " +
  "NOT escalate it. Escalate only if a human is genuinely better-positioned (a product/behaviour choice, " +
  "an irreversible or external effect, a financial-correctness or UX trade-off, an ambiguous requirement, " +
  "or a hard blocker); if so, say so plainly in `stakes`.";

/** Corrective guidance returned when an escalation only parses with the diff open. */
export const REQUIRES_CODE_CONTEXT_GUIDANCE =
  "`whereWeStand` / `stakes` only parse if the reader has seen the diff (bare file or code-symbol names). " +
  "Rewrite them for a reader who has NOT read the implementation: define every domain term, and state each " +
  "option's consequence in plain architecture/user language — what breaks, what a user would notice, what " +
  "becomes hard later. No bare symbol or file names as if the reader already knows them.";

// Internal-structure / layering / naming / abstraction signals — the class of
// decision the design + conventions resolve.
const STRUCTURE_SIGNALS = [
  "layer",
  "layering",
  "module boundary",
  "boundary",
  "dependency direction",
  "depend on",
  "depends on",
  "coupling",
  "decouple",
  "rename",
  "naming",
  "abstraction",
  "refactor",
  "restructure",
  "internal structure",
  "directory structure",
  "file structure",
  "should live",
  "belongs in",
  "canonical layer",
  "canonical home",
  "indirection",
  "split into",
  "extract",
];

// Signals the change is behaviour-preserving / build-green — i.e. there is no
// observable difference a human is needed to choose between.
const BEHAVIOUR_PRESERVING_SIGNALS = [
  "behaviour-preserving",
  "behavior-preserving",
  "behaviour preserving",
  "behavior preserving",
  "behaviour-conserving",
  "behavior-conserving",
  "no behaviour change",
  "no behavior change",
  "changes no behaviour",
  "changes no behavior",
  "no observable behaviour",
  "no observable behavior",
  "build-green",
  "build green",
  "purely structural",
  "purely internal",
  "internal layering",
  "internal refactor",
  "same behaviour",
  "same behavior",
  "preserves behaviour",
  "preserves behavior",
];

// Signals a human is genuinely better-positioned — a product/behaviour, external,
// irreversible, financial, UX, ambiguity, or hard-blocker stake. Their presence
// rescues an otherwise-structural call from the design-resolvable verdict.
const ESCALATE_WORTHY_SIGNALS = [
  "product",
  "behaviour change",
  "behavior change",
  "user",
  "customer",
  "ux",
  "user experience",
  "user-facing",
  "irreversible",
  "one-way door",
  "one way door",
  "external",
  "third-party",
  "third party",
  "financial",
  "money",
  "revenue",
  "payment",
  "billing",
  "charge",
  "invoice",
  "pricing",
  "data loss",
  "data migration",
  "schema migration",
  "security",
  "privacy",
  "compliance",
  "breaking change",
  "backwards-incompat",
  "backward-incompat",
  "ambiguous requirement",
  "requirement is ambiguous",
  "unclear requirement",
  "cannot be honoured",
  "cannot be honored",
  "hard blocker",
  "genuinely blocked",
  "conflicting requirement",
];

// Tokens that betray a stake only the diff explains: file paths and code symbols.
const CODE_REFERENCE_PATTERNS: RegExp[] = [
  // a slash-bearing path with a source extension: src/store/store.ts, ./a/b.go
  /[\w.$-]*\/[\w./$-]*\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|sql|ya?ml|json|css|scss|html)\b/i,
  // a member call: store.persist(, ReviewStore.applyVerdict(
  /\b[a-z_$][\w$]*\.[a-z_$][\w$]*\s*\(/i,
  // a function call: applyVerdict(), persistInvoice(order) — but not English "site(s)"
  /\b[a-z_$][\w$]*\((?!s\)|es\))[^)]{0,80}\)/i,
];

function hasAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

function looksDesignResolvable(q: EscalationQuestion): boolean {
  const text = [q.headline, q.feature, q.decision, q.whereWeStand, q.stakes, ...(q.options ?? [])]
    .join("\n")
    .toLowerCase();
  return (
    hasAny(text, STRUCTURE_SIGNALS) &&
    hasAny(text, BEHAVIOUR_PRESERVING_SIGNALS) &&
    !hasAny(text, ESCALATE_WORTHY_SIGNALS)
  );
}

function requiresCodeContext(q: EscalationQuestion): boolean {
  // Only the fields a non-implementer reads to rule: where-we-stand and stakes.
  const text = `${q.whereWeStand}\n${q.stakes}`;
  return CODE_REFERENCE_PATTERNS.some((re) => re.test(text));
}

/**
 * Run the pre-send self-check (issue #22) over an escalation. Returns every way it
 * fails the bar, each with the corrective action — empty `failures` means it clears
 * the bar. The `escalate` tool calls this at its boundary and rejects a failing
 * call before any checkpoint side effect, so a design-resolvable or
 * read-the-diff-only escalation never reaches the operator.
 */
export function evaluateEscalationBar(question: EscalationQuestion): EscalationBarVerdict {
  const failures: EscalationBarFailure[] = [];
  if (looksDesignResolvable(question)) {
    failures.push({ kind: "design-resolvable", message: DESIGN_RESOLVABLE_GUIDANCE });
  }
  if (requiresCodeContext(question)) {
    failures.push({ kind: "requires-code-context", message: REQUIRES_CODE_CONTEXT_GUIDANCE });
  }
  return { pass: failures.length === 0, failures };
}

/** The raw zod shape of the question, for wiring the `escalate` tool's input schema. */
export const escalationQuestionShape = escalationQuestionSchema.shape;

/**
 * Extract and validate the structured question from a `ralph-question` comment
 * body (the JSON inside the fence). Returns `null` if the comment carries no
 * parseable question — the `ralph-answer` CLI reads questions back this way
 * (GitHub-only, no SQLite).
 */
export function parseRalphQuestionComment(body: string): EscalationQuestion | null {
  return parseFencedPayload(body, RALPH_QUESTION_FENCE, parseEscalationQuestion);
}

/** The fence language tag that marks a daemon-authored question comment. */
export const RALPH_QUESTION_FENCE = "ralph-question";

const PHASE_MARKER = /<!--\s*ralph-phase:\s*(\d)\s*-->/;

/**
 * A hidden `<!-- ralph-phase: N -->` marker appended to any review-origin
 * `ralph-question` comment — a review-loop fix-agent escalation or a `review-maxed`
 * heal-card (issue #9). It is invisible in the rendered comment and is the only
 * place the review phase survives a cold store. Its presence on rehydration tells a
 * review-origin pause (re-enter the review loop at this phase) apart from an
 * impl-agent escalation (no marker — resume the impl session).
 */
export function buildPhaseMarker(phase: Phase): string {
  return `<!-- ralph-phase: ${phase} -->`;
}

/** Recover the phase from a {@link buildPhaseMarker} marker, or `null` if absent. */
export function parsePhaseMarker(body: string): Phase | null {
  const match = PHASE_MARKER.exec(body);
  if (!match) {
    return null;
  }
  const n = Number(match[1]);
  return n === 0 || n === 1 || n === 2 ? (n as Phase) : null;
}

function fieldBlock(label: string, value: string): string {
  return `**${label}**\n${value}`;
}

/**
 * Render an escalation as a `ralph-question` fenced comment. The body is a JSON
 * payload inside the fence (machine-parseable on rebuild) preceded by a
 * human-readable summary outside it.
 */
export function formatRalphQuestion(question: EscalationQuestion): string {
  const lines = [
    `## ${question.headline}`,
    "",
    fieldBlock("Feature", question.feature),
    "",
    fieldBlock("Where we stand", question.whereWeStand),
    "",
    fieldBlock("Decision", question.decision),
  ];
  if (question.options && question.options.length > 0) {
    lines.push("", "**Options**", ...question.options.map((o) => `- ${o}`));
  }
  lines.push(
    "",
    fieldBlock("Stakes", question.stakes),
    "",
    fieldBlock("Recommendation", question.recommendation),
    "",
    "<!-- The structured payload below is parsed by ralph-autopilot; answer via the ralph-answer CLI. -->",
    renderFencedPayload(RALPH_QUESTION_FENCE, question),
  );
  return lines.join("\n");
}

/** Inputs to {@link buildEscalationDraftPr} — a pure value builder, no I/O. */
export interface EscalationDraftPrInput {
  issueNumber: number;
  /** The run's WIP branch the draft PR is opened from. */
  branch: string;
  /** The escalation's one-line headline, surfaced in the PR body. */
  headline: string;
  /**
   * The issue title, when the caller has the `Issue` (daemon-side, where the PR title reads
   * `[WIP] #n <title>`); omitted in-container, which carries no `Issue` (ADR-0038) so the title is
   * the bare `[WIP] #n`.
   */
  title?: string;
}

/**
 * Build the title + body of the draft "checkpoint" PR an `escalate` opens to make a paused agent's
 * WIP visible (DESIGN §6). **Pure** (no I/O): it is the one renderer shared by the daemon-side
 * {@link import("../hitl/escalation-checkpoint").EscalationCheckpointer} and the in-container
 * runner-direct escalation, so the two checkpoints render the same PR and cannot drift (issue #187).
 * The hidden `<!-- ralph-launch -->` marker lets the daemon recognise the PR as its own on rehydrate.
 */
export function buildEscalationDraftPr(input: EscalationDraftPrInput): { title: string; body: string } {
  const title = input.title ? `[WIP] #${input.issueNumber} ${input.title}` : `[WIP] #${input.issueNumber}`;
  const marker = buildLaunchMarker({ issueNumber: input.issueNumber, branch: input.branch });
  const body = [
    `Draft checkpoint for #${input.issueNumber}, paused on an operator question.`,
    "",
    input.headline,
    "",
    `Closes #${input.issueNumber}`,
    "",
    marker,
  ].join("\n");
  return { title, body };
}
