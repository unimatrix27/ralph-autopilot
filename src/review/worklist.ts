/**
 * The **worklist** (CONTEXT: worklist) — the consolidated, deduplicated,
 * severity-ranked output of a review pass. It is the review agent's own findings
 * merged with the automated PR comments it ingested, each item tagged with one
 * disposition. The worklist is the single thing a fix agent consumes.
 *
 * The disposition vocabulary is fixed: `P0 | P1 | nit | out-of-scope | escalate`.
 * Only `P0`, `P1`, and `escalate` items **gate** a phase — nits and out-of-scope
 * findings never block a merge (DESIGN §4). A phase is clean the instant a review
 * returns no gating items.
 *
 * zod v4 here (peer-required by the Agent SDK, ADR-0010) doubles as the parser
 * for the structured worklist an SDK review agent emits.
 */

import { z } from "zod";

/** Every disposition a worklist item can carry. */
export const SEVERITIES = ["P0", "P1", "nit", "out-of-scope", "escalate"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Dispositions that block a phase from passing. Nits and out-of-scope do not. */
export const GATING_SEVERITIES: readonly Severity[] = ["P0", "P1", "escalate"] as const;

/** Severity rank, highest-first, for ordering and dedupe tie-breaks. */
const SEVERITY_RANK: Record<Severity, number> = {
  P0: 5,
  P1: 4,
  escalate: 3,
  nit: 2,
  "out-of-scope": 1,
};

export const worklistItemSchema = z
  .object({
    severity: z.enum(SEVERITIES),
    /** A one-line statement of the finding. */
    title: z.string().min(1, "a worklist item needs a title"),
    /** Optional elaboration: where, why it matters, what to change. */
    detail: z.string().optional(),
    /** Where the item came from: the review agent itself or an ingested PR comment. */
    source: z.enum(["review", "pr-comment"]).optional(),
  })
  .strict();

export const worklistSchema = z
  .object({
    items: z.array(worklistItemSchema),
  })
  .strict();

export type WorklistItem = z.infer<typeof worklistItemSchema>;
export type Worklist = z.infer<typeof worklistSchema>;

/** Parse and validate an untrusted worklist (e.g. an SDK agent's JSON output). */
export function parseWorklist(value: unknown): Worklist {
  return worklistSchema.parse(value);
}

/** Whether a single item gates a phase (P0, P1, or escalate). */
export function isGating(item: WorklistItem): boolean {
  return GATING_SEVERITIES.includes(item.severity);
}

/** The gating subset of a worklist — the items a fix agent must resolve. */
export function gatingItems(worklist: Worklist): WorklistItem[] {
  return worklist.items.filter(isGating);
}

/** A phase is clean when no item gates it (nits and out-of-scope are ignored). */
export function isClean(worklist: Worklist): boolean {
  return gatingItems(worklist).length === 0;
}

/** Whether any item is tagged `escalate` (a finding the fix agent must escalate, not fix). */
export function hasEscalation(worklist: Worklist): boolean {
  return worklist.items.some((i) => i.severity === "escalate");
}

/** Normalise a title for dedupe: lower-case, collapse whitespace, trim. */
function normaliseTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Deduplicate items that describe the same finding (same normalised title),
 * keeping the most severe disposition — so a finding the review agent and an
 * ingested bot comment both raised collapses to a single, correctly-ranked item.
 * The result is sorted by severity, highest-first, preserving input order within
 * a severity. This is the consolidation folded into the review agent (ADR-0005).
 */
export function dedupeWorklist(items: WorklistItem[]): WorklistItem[] {
  const byTitle = new Map<string, WorklistItem>();
  for (const item of items) {
    const key = normaliseTitle(item.title);
    const existing = byTitle.get(key);
    if (!existing || SEVERITY_RANK[item.severity] > SEVERITY_RANK[existing.severity]) {
      byTitle.set(key, item);
    }
  }
  return [...byTitle.values()].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );
}
