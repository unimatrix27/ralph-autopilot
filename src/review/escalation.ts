/**
 * The `escalate` / heal-card surface (CONTEXT: escalate, ralph-question,
 * heal-card; ADR-0004). When a fix agent hits a finding that implies a risky
 * structural change it **escalates** rather than applying it blind: it emits a
 * structured `ralph-question` whose schema is a forcing function for operator
 * attention. `stakes` is required — it translates the decision up to the
 * architecture/user level so the operator can rule without reloading the deep
 * technical context.
 *
 * A `review-maxed` phase emits the same `ralph-question` shape as a **heal-card**
 * (CONTEXT: heal-card) so it flows through the one `ralph-answer` queue.
 *
 * Both render to a fenced comment GitHub stores verbatim; the daemon parses its
 * own comments back when rebuilding state.
 */

import { z } from "zod";
import { parseFencedPayload, renderFencedPayload } from "../core/fenced-payload";
import { buildLaunchMarker } from "../github/marker";
import type { Phase } from "../store/types";
import type { Worklist } from "./worklist";

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

export interface HealCardInput {
  phase: Phase;
  /** The worklist that remained blocking when the phase maxed out. */
  worklist: Worklist;
  /** Number of fix attempts spent before maxing out. */
  attempts: number;
  /**
   * `"infra"` when the maxout was a daemon-side container infrastructure fault that survived its
   * retries (issue #220), not a code/correctness blocker — selects the honest infra heal-card
   * (fix the box & re-enable) over the correctness/quality one. Absent for a normal maxout.
   */
  cause?: "infra";
}

/**
 * A `review-maxed` phase emits a heal-card: a `ralph-question` whose decision is
 * "how should we get this PR's remaining {CI|correctness|quality} blockers
 * resolved". Phase 0 maxout is a *CI* concern (issue #41); phase 1 a *correctness*
 * concern; phase 2 a *quality* one. A `cause: "infra"` maxout is none of those — it is a
 * container infrastructure fault, surfaced honestly so the operator fixes the box and re-runs
 * rather than chasing a non-existent code defect (issue #220).
 */
export function buildHealCardQuestion({ phase, worklist, attempts, cause }: HealCardInput): EscalationQuestion {
  if (cause === "infra") {
    return buildInfraHealCardQuestion(phase, worklist, attempts);
  }
  const concern = phase === 0 ? "CI" : phase === 1 ? "correctness" : "quality";
  const feature =
    phase === 0
      ? "Phase-0 CI gate (harness-owned merge)"
      : `Phase-${phase} ${phase === 1 ? "normal" : "behaviour-conserving"} review`;
  const blockers = worklist.items
    .filter((i) => i.severity === "P0" || i.severity === "P1" || i.severity === "escalate")
    .map((i) => `[${i.severity}] ${i.title}${i.detail ? ` — ${i.detail}` : ""}`);
  const standPreamblePhase0 = `The fix agent spent its ${attempts} attempt(s) and CI is still not green:`;
  const standPreamble = `The fix agent spent its ${attempts} attempt(s) and the phase-${phase} review still reports blockers:`;
  const stakes =
    phase === 0
      ? "CI is red (or never reached a terminal state): the harness will not merge a PR whose checks are not green."
      : phase === 1
        ? "Correctness is unverified: merging now risks shipping behaviourally-wrong code to master."
        : "Behaviour is verified correct; only structural quality remains. The PR is mergeable but below the thermo-nuclear bar.";
  return {
    headline:
      phase === 0
        ? "CI gate maxed out (could not get checks green)"
        : `Review maxed out on ${concern} (phase ${phase})`,
    feature,
    whereWeStand: [
      phase === 0 ? standPreamblePhase0 : standPreamble,
      ...blockers.map((b) => `- ${b}`),
    ].join("\n"),
    decision:
      phase === 0
        ? "How should the failing CI checks be resolved?"
        : `How should the remaining phase-${phase} ${concern} blockers be resolved?`,
    options: [
      "Provide guidance and re-enable the run (heal) so the fix agent retries with it injected",
      "Accept the PR as-is and merge manually",
      "Close the PR and re-scope the issue",
    ],
    stakes,
    recommendation:
      "Answer with concrete guidance on the listed blockers so the daemon resumes the fix agent from its WIP branch.",
  };
}

/**
 * The honest heal-card for a persistent container infrastructure fault (issue #220): the review
 * never completed, so there is no code/correctness verdict to act on. The decision is "fix the box
 * and re-run", and re-enabling resumes from the WIP branch and re-runs the review on the existing
 * PR (the run status, phase marker, and resume context are the same as any review-maxed heal).
 */
function buildInfraHealCardQuestion(phase: Phase, worklist: Worklist, attempts: number): EscalationQuestion {
  const blockers = worklist.items
    .filter((i) => i.severity === "P0" || i.severity === "P1" || i.severity === "escalate")
    .map((i) => `- [${i.severity}] ${i.title}${i.detail ? `: ${i.detail}` : ""}`);
  return {
    headline: `Review blocked by a container infrastructure fault (phase ${phase})`,
    feature: `Phase-${phase} review (container dispatch)`,
    whereWeStand: [
      `The review/fix container failed to produce a result after ${attempts} ${attempts === 1 ? "retry" : "retries"} — ` +
        "a daemon-side infrastructure fault, not a code defect:",
      ...blockers,
    ].join("\n"),
    decision: `The container could not run phase-${phase} review. How do you want to proceed?`,
    options: [
      "Fix the container host (docker / credentials / disk), then re-enable to re-run the review from the existing PR",
      "Accept the PR as-is and merge manually",
      "Close the PR and re-scope the issue",
    ],
    stakes:
      "No code defect is implied — the review never completed. The container host (docker / credentials / disk) " +
      "likely needs attention. Re-enabling resumes from the WIP branch and re-runs the review; the PR is preserved.",
    recommendation:
      "Fix the container host, then re-enable: the run resumes from its WIP branch and re-runs the review. The prior " +
      "failure was a daemon-side infrastructure fault, not something to fix in the code.",
  };
}

/**
 * Render a heal-card to its `ralph-question` comment body. The review-maxed phase
 * survives a cold store via the hidden {@link buildPhaseMarker} the caller stamps on
 * the comment (the same marker a review-loop escalation carries), so the body itself
 * needs no phase encoding.
 */
export function formatHealCard(input: HealCardInput): string {
  return formatRalphQuestion(buildHealCardQuestion(input));
}
