/**
 * The `ralph-decision` fenced comment — the **canonical, append-only** unit of the
 * durable decision ledger (ADR-0040).
 *
 * A master escalation session is fresh every time; nothing carries over in a
 * conversation. What carries over is this: a structured record posted on the
 * narrowest hierarchy node its scope matches, readable back verbatim by any later
 * session. It renders like every other daemon-authored comment — a human-readable
 * summary outside the fence, a machine-parseable JSON payload inside it — through
 * the one shared codec ({@link import("../core/fenced-payload")}) so the format
 * cannot drift from `ralph-question` / `ralph-review`.
 *
 * Two rules are structural, not stylistic:
 *
 * - **Append-only.** A later decision *supersedes* an earlier one by id; the old
 *   comment is never edited. History stays legible, and a fold over the thread can
 *   always reconstruct how the current answer was reached.
 * - **Tolerant reader (ADR-0026).** The payload schema is *loose*: unknown fields
 *   are preserved, never rejected, so a record written by a later slice still
 *   parses — and still round-trips — through today's code. Required fields are
 *   required; evolution is additive only.
 */

import { z } from "zod";
import {
  hasFencedPayload,
  parseFencedPayload,
  renderFencedPayload,
  sanitizeForFence,
} from "../core/fenced-payload";
import { formatRef } from "../github/ref";
import type { IssueRef } from "../github/types";

/** The fence language tag that marks a canonical decision record. */
export const RALPH_DECISION_FENCE = "ralph-decision";

/**
 * How far a decision reaches, **narrowest first**. The scope picks the storage
 * node: `issue` lives on the issue, `subtree` on the subtree root it governs,
 * `initiative` on the absolute root. A descendant inherits what its root→issue
 * path carries and nothing else.
 */
export const DECISION_SCOPES = ["issue", "subtree", "initiative"] as const;

export type DecisionScope = (typeof DECISION_SCOPES)[number];

const required = (label: string) => z.string().min(1, `${label} is required`);

/**
 * A ref is a closed value type — `owner/repo` plus a number, and nothing else is
 * ever going to be added to it — so this is the one schema here that is *not*
 * loose. Keeping its inferred shape exactly {@link IssueRef} lets refs flow between
 * the hierarchy and the ledger without a cast at every boundary.
 */
const issueRefSchema = z.object({
  repo: required("repo"),
  number: z.number().int().positive(),
});

/**
 * Where the decision came from — enough provenance to re-open the exact moment it
 * was made: which repo/issue, which run and phase, and the head SHA the reasoning
 * was against.
 */
const decisionOriginSchema = z.looseObject({
  repo: required("origin.repo"),
  issue: z.number().int().positive(),
  runId: z.number().int().nonnegative().optional(),
  phase: required("origin.phase"),
  headSha: required("origin.headSha"),
});

/** The `ralph-decision` payload. Loose by design (ADR-0026 tolerant reader). */
export const decisionRecordSchema = z.looseObject({
  /** Stable id of *this record*; the target of a later `supersedes`. */
  id: required("id"),
  /** Stable key of the *decision*, constant across supersessions. */
  key: required("key"),
  scope: z.enum(DECISION_SCOPES),
  /** The node whose comment thread holds this record; must be where it lives. */
  storageNode: issueRefSchema,
  decision: required("decision"),
  rationale: required("rationale"),
  constraints: z.array(z.string().min(1)).default([]),
  rejectedAlternatives: z.array(z.string().min(1)).default([]),
  /** Hierarchy nodes the decision binds beyond its storage node. */
  affectedNodes: z.array(issueRefSchema).default([]),
  /** Repo paths the decision binds (`src/hierarchy`, `docs/adr`). */
  affectedPaths: z.array(z.string().min(1)).default([]),
  /** Links backing the decision: PRs, comments, design docs. */
  evidence: z.array(z.string().min(1)).default([]),
  origin: decisionOriginSchema,
  authoredBy: z.looseObject({ model: required("authoredBy.model") }),
  /** ISO-8601 instant the record was authored. */
  recordedAt: required("recordedAt"),
  /** The `id` of the record this one replaces, when it replaces one. */
  supersedes: z.string().min(1).optional(),
});

export type DecisionRecord = z.infer<typeof decisionRecordSchema>;

/** Parse and validate an untrusted decision record (an agent's output, a comment). */
export function parseDecisionRecord(value: unknown): DecisionRecord {
  return decisionRecordSchema.parse(value);
}

/** One bullet list rendered outside the fence, or nothing when empty. */
function bulletSection(heading: string, items: readonly string[]): string[] {
  return items.length === 0 ? [] : ["", `**${heading}**`, ...items.map((i) => `- ${i}`)];
}

/** Recursively neutralise backticks in every string of a JSON value. */
function sanitizeDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeForFence(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeDeep);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeDeep(v)]));
  }
  return value;
}

/**
 * The **canonical** form of a record: every string neutralised for fence safety
 * ({@link sanitizeForFence}). A backtick run anywhere in a record — a rationale
 * quoting code, an agent pasting a fenced snippet — would otherwise close the
 * enclosing fence early and make the record unreadable to its own parser. Fence
 * safety belongs to the codec that owns the fence, so the record is canonicalised
 * once, here, and the canonical form is what GitHub stores and readers fold.
 * Applied deeply so additive fields (ADR-0026) are covered without knowing them.
 */
export function sanitizeDecisionRecord(record: DecisionRecord): DecisionRecord {
  return sanitizeDeep(record) as DecisionRecord;
}

/**
 * Render a decision as its canonical comment body: a human-readable summary the
 * operator can rule on at a glance, then the fenced payload the daemon parses
 * back. The record is canonicalised through {@link sanitizeDecisionRecord} first,
 * so what the summary shows and what the payload carries are the same text.
 */
export function formatDecisionComment(input: DecisionRecord): string {
  const record = sanitizeDecisionRecord(input);
  const scopeLine = `**Scope:** \`${record.scope}\` on ${formatRef(record.storageNode)}`;
  return [
    `## ralph-decision — \`${record.key}\``,
    "",
    scopeLine,
    `**Decision:** ${record.decision}`,
    "",
    `**Why:** ${record.rationale}`,
    ...bulletSection("Constraints", record.constraints),
    ...bulletSection("Rejected alternatives", record.rejectedAlternatives),
    ...bulletSection("Evidence", record.evidence),
    ...(record.supersedes ? ["", `Supersedes \`${record.supersedes}\`.`] : []),
    "",
    `Recorded by ${record.authoredBy.model} at ${record.recordedAt} ` +
      `(${record.origin.repo}#${record.origin.issue}, phase ${record.origin.phase}, ` +
      `head ${record.origin.headSha}).`,
    "",
    "<!-- Canonical, append-only: never edit this comment. A later record supersedes it by id. -->",
    renderFencedPayload(RALPH_DECISION_FENCE, record),
  ].join("\n");
}

/**
 * Whether a comment body carries a `ralph-decision` fence. Anchored on the fence
 * tag, so an ordinary comment that *discusses* a decision — or pastes one inside a
 * ```` ```json ```` block — is never mistaken for the record itself.
 */
export function isDecisionComment(body: string): boolean {
  return hasFencedPayload(body, RALPH_DECISION_FENCE);
}

/**
 * Parse a decision record out of a comment body, or `null` when the body carries
 * no fence or the payload does not validate. A malformed record is *not* state —
 * callers surface it as a diagnostic ({@link import("./fold").collectDecisionComments}).
 */
export function parseDecisionComment(body: string): DecisionRecord | null {
  return parseFencedPayload(body, RALPH_DECISION_FENCE, parseDecisionRecord);
}

/** Human-readable one-liner for a record — the index's table cell. */
export function decisionSummary(record: DecisionRecord): string {
  return `${record.key} — ${record.decision}`;
}

/** Whether a record's declared storage node matches the node it actually lives on. */
export function storedWhereItClaims(record: DecisionRecord, node: IssueRef): boolean {
  return record.storageNode.repo === node.repo && record.storageNode.number === node.number;
}
