/**
 * The `ralph-decision-index` comment — **one** daemon-managed, idempotent,
 * *derived* view of the ledger, kept on the absolute root (ADR-0040).
 *
 * It exists for discoverability: a human (or a fresh master session) opening the
 * top of an initiative should see what has been decided beneath it without reading
 * every descendant's thread. It is explicitly **not authoritative** — the canonical
 * records are the individual `ralph-decision` comments, and this comment is
 * regenerated from them, never the other way round. Delete it and the next sync
 * recreates it byte-identically; the ledger loses nothing.
 *
 * Idempotence is structural, not best-effort:
 *
 * - the body is a pure function of the fold (which is itself deterministically
 *   ordered), so rebuilding twice yields identical bytes;
 * - nothing time-varying is rendered — no "generated at", no counts of transient
 *   state — so an unchanged ledger produces an unchanged comment and the sync makes
 *   **no write at all**;
 * - the existing index is found by its fence tag and edited in place, so a restart,
 *   a second repo, or a concurrent tick can never plant a second index.
 *
 * When the climb has not *proven* an absolute root the sync refuses outright:
 * planting the initiative's index on a node that merely looked like the top would
 * be exactly the false-root failure the hierarchy mapper exists to prevent.
 */

import { hasFencedPayload, renderFencedPayload } from "../core/fenced-payload";
import { commentUrl, formatRef } from "../github/ref";
import type { IssueRef } from "../github/types";
import { absoluteRoot, type HierarchyMap } from "../hierarchy/map";
import type { DecisionConflict, LedgerFold, StoredDecision } from "./fold";
import type { LedgerReadPort } from "./ledger";

/** The fence language tag that marks the derived index comment. */
export const RALPH_DECISION_INDEX_FENCE = "ralph-decision-index";

/** Whether a comment body is the derived decision index. */
export function isDecisionIndexComment(body: string): boolean {
  return hasFencedPayload(body, RALPH_DECISION_INDEX_FENCE);
}

export interface DecisionIndexInput {
  /** The absolute root the index lives on. */
  root: IssueRef;
  /** The whole-subtree fold the index renders (see `readInitiativeLedger`). */
  fold: LedgerFold;
}

/** One active decision as the index's machine-readable entry. */
interface IndexEntry {
  key: string;
  id: string;
  scope: string;
  storedOn: string;
  decision: string;
  source: string;
}

function toEntry(stored: StoredDecision): IndexEntry {
  return {
    key: stored.record.key,
    id: stored.record.id,
    scope: stored.record.scope,
    storedOn: formatRef(stored.node),
    decision: stored.record.decision,
    source: commentUrl(stored.node, stored.commentId),
  };
}

function conflictLines(conflict: DecisionConflict): string[] {
  return [
    `- **${conflict.key}** — ${conflict.claims.length} active records, none superseding the other:`,
    ...conflict.claims.map(
      (c) => `  - \`${c.record.id}\` on ${formatRef(c.node)}: ${c.record.decision} (${commentUrl(c.node, c.commentId)})`,
    ),
  ];
}

/**
 * Render the index body from a fold. Pure — the same fold always yields the same
 * bytes, which is what makes {@link syncDecisionIndex} a no-op when nothing moved.
 */
export function formatDecisionIndex({ root, fold }: DecisionIndexInput): string {
  const entries = fold.active.map(toEntry);
  const active =
    entries.length === 0
      ? ["No active decisions recorded under this root yet."]
      : entries.map(
          (e) => `- **${e.key}** (\`${e.scope}\`, on ${e.storedOn}) — ${e.decision} · [record](${e.source})`,
        );
  const conflicts =
    fold.conflicts.length === 0
      ? []
      : [
          "",
          "### Unresolved conflicts",
          "",
          "These keys carry two or more active records and **fail closed** — no reader picks a winner:",
          ...fold.conflicts.flatMap(conflictLines),
        ];

  return [
    `## ralph-decision-index — ${formatRef(root)}`,
    "",
    "A derived, replaceable view of the decisions recorded beneath this root. It is",
    "**not authoritative**: the canonical records are the individual `ralph-decision`",
    "comments this links to, and this comment is regenerated from them.",
    "",
    "### Active decisions",
    "",
    ...active,
    ...conflicts,
    "",
    "<!-- Daemon-managed: regenerated in place from the canonical records; safe to delete. -->",
    renderFencedPayload(RALPH_DECISION_INDEX_FENCE, {
      root,
      active: entries,
      conflicts: fold.conflicts.map((c) => ({
        key: c.key,
        claims: c.claims.map(toEntry),
      })),
    }),
  ].join("\n");
}

/** Posting/editing the index needs both directions on the root node. */
export interface DecisionIndexPort extends LedgerReadPort {
  postNodeComment(ref: IssueRef, body: string): Promise<{ id: number }>;
  updateNodeComment(ref: IssueRef, commentId: number, body: string): Promise<void>;
}

export type SyncDecisionIndexResult =
  | { kind: "created"; node: IssueRef; commentId: number }
  | { kind: "updated"; node: IssueRef; commentId: number }
  | { kind: "unchanged"; node: IssueRef; commentId: number }
  | { kind: "skipped"; reason: "unresolved-root" | "root-unreadable"; detail: string };

/**
 * Bring the one index comment on the absolute root in line with `fold`. Creates it
 * if absent, edits it in place if the ledger moved, and makes **no write** when the
 * rendered body is already byte-identical.
 */
export async function syncDecisionIndex(
  port: DecisionIndexPort,
  map: HierarchyMap,
  fold: LedgerFold,
): Promise<SyncDecisionIndexResult> {
  const root = absoluteRoot(map);
  if (!root) {
    return {
      kind: "skipped",
      reason: "unresolved-root",
      detail: `the climb from ${formatRef(map.origin)} ended in \`${map.root.kind}\`, so no absolute root is proven`,
    };
  }
  const content = await port.readIssueContent(root.ref);
  if (content.kind === "inaccessible") {
    return {
      kind: "skipped",
      reason: "root-unreadable",
      detail: `${formatRef(root.ref)} is ${content.reason}`,
    };
  }

  const body = formatDecisionIndex({ root: root.ref, fold });
  // The LAST index comment wins: if an earlier daemon ever left a stray one, the
  // live index is the most recent, and editing it keeps the thread converging on one.
  const existing = [...content.comments].reverse().find((c) => isDecisionIndexComment(c.body));
  if (!existing) {
    const { id } = await port.postNodeComment(root.ref, body);
    return { kind: "created", node: root.ref, commentId: id };
  }
  if (existing.body === body) {
    return { kind: "unchanged", node: root.ref, commentId: existing.id };
  }
  await port.updateNodeComment(root.ref, existing.id, body);
  return { kind: "updated", node: root.ref, commentId: existing.id };
}
