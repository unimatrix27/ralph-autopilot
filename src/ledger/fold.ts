/**
 * The pure fold from canonical `ralph-decision` comments to the **active ledger**
 * (ADR-0040). GitHub's comment threads are the source of truth; this module is the
 * deterministic function from "every record found on the nodes we read" to "what is
 * binding right now, what it replaced, and what nobody can decide".
 *
 * Three behaviours are deliberate and each is a test:
 *
 * - **Inheritance follows the hierarchy, not the text.** A record applies to an
 *   issue iff it lives on a node of that issue's root→issue ancestor path *and* its
 *   scope reaches down: `issue` binds only its own node, `subtree` binds the node
 *   and everything under it, `initiative` binds the whole tree from the absolute
 *   root. A sibling subtree's decisions are simply not on the path, so they are
 *   never inherited.
 * - **Supersession is by id, never by recency.** A record is inactive iff some
 *   other record names its `id` in `supersedes`. Comment order, timestamps, and
 *   authorship do not decide anything — an append-only thread stays legible under
 *   out-of-order reads and rebuilds.
 * - **Conflicts fail closed.** Two active records claiming one `key` with no
 *   supersession between them do not resolve to a winner: the key drops out of
 *   `active` and both claims surface, with their node and comment id, for a later
 *   master or human to adjudicate. Guessing here would silently pick an
 *   architecture.
 */

import { refKey, sameRef } from "../github/ref";
import type { IssueRef, PrComment } from "../github/types";
import {
  isDecisionComment,
  parseDecisionComment,
  storedWhereItClaims,
  type DecisionRecord,
} from "./decision";

/** One canonical record together with where it physically lives. */
export interface StoredDecision {
  /** The hierarchy node whose comment thread carries the record. */
  node: IssueRef;
  /** The REST comment id — the record's permalink and its adjudication evidence. */
  commentId: number;
  record: DecisionRecord;
}

/** A key no reader may resolve: ≥2 active records, none superseding the other. */
export interface DecisionConflict {
  key: string;
  claims: StoredDecision[];
}

/**
 * Something the fold saw and refused to treat as state. Diagnostics are returned,
 * never thrown and never silently dropped — a malformed record stays *visible*.
 */
export type LedgerDiagnostic =
  /** A comment carries the fence but its payload does not parse/validate. */
  | { kind: "malformed"; node: IssueRef; commentId: number; detail: string }
  /** The record's `storageNode` is not the node it was found on. */
  | { kind: "storage-node-mismatch"; node: IssueRef; commentId: number; detail: string }
  /** An `initiative` record parked below the absolute root. */
  | { kind: "scope-node-mismatch"; node: IssueRef; commentId: number; detail: string }
  /** A `supersedes` pointer naming a record no read turned up. */
  | { kind: "dangling-supersedes"; node: IssueRef; commentId: number; supersedes: string }
  /** The same record id appears on two comments — a retried post, or an id collision. */
  | { kind: "duplicate-record-id"; node: IssueRef; commentId: number; id: string; identical: boolean }
  /** A node on the path could not be read, so its records are unknown. */
  | { kind: "node-unreadable"; node: IssueRef; reason: string }
  /** The subtree crawl hit its node cap; the view may be incomplete. */
  | { kind: "crawl-capped"; maxNodes: number }
  /** GitHub listed only some of a node's sub-issues, so the crawl missed descendants. */
  | { kind: "crawl-incomplete"; node: IssueRef; listed: number; total: number };

export interface LedgerFold {
  /** Binding decisions, ordered by key then record id. Conflicted keys are absent. */
  active: StoredDecision[];
  /** Records replaced by a later one, kept whole for audit — never edited. */
  superseded: StoredDecision[];
  /** Keys that fail closed, with every claim's evidence. */
  conflicts: DecisionConflict[];
  /** Records read but out of this issue's scope (a sibling subtree, a peer's issue call). */
  inapplicable: StoredDecision[];
  diagnostics: LedgerDiagnostic[];
}

export interface LedgerFoldInput {
  /** The root→issue ancestor path, root-most first. */
  path: readonly IssueRef[];
  /**
   * The **proven** absolute root, when the climb proved one. Passed explicitly
   * rather than read off `path[0]`, because `path[0]` is only the root when the
   * climb terminated in `root` — after a cycle, an over-ceiling chain, or an
   * unreadable parent it is merely the highest node reached. Absent means "no
   * proven root", and every `initiative`-scoped record then fails closed, matching
   * what the write side (`resolveStorageNode`) already refuses to do.
   */
  root?: IssueRef;
  /** The issue whose active ledger is being folded. */
  target: IssueRef;
  stored: readonly StoredDecision[];
  /**
   * `path` (default) folds what ONE issue inherits along root→issue.
   * `initiative` folds every record found anywhere in the tree — the whole-tree
   * view the derived root index renders; nothing is filtered as out-of-scope.
   */
  scope?: "path" | "initiative";
}

/**
 * Read the canonical records off one node's comment thread. Ordinary comments are
 * skipped outright: only a body carrying the `ralph-decision` fence is even a
 * candidate, so prose that merely *discusses* a decision (or pastes one in a
 * ```` ```json ```` block) can never become state. A fenced-but-unparseable body,
 * or one claiming to live somewhere else, is returned as a diagnostic instead.
 */
export function collectDecisionComments(
  node: IssueRef,
  comments: readonly PrComment[],
): { stored: StoredDecision[]; diagnostics: LedgerDiagnostic[] } {
  const stored: StoredDecision[] = [];
  const diagnostics: LedgerDiagnostic[] = [];
  for (const comment of comments) {
    if (!isDecisionComment(comment.body)) {
      continue;
    }
    const record = parseDecisionComment(comment.body);
    if (!record) {
      diagnostics.push({
        kind: "malformed",
        node,
        commentId: comment.id,
        detail: "ralph-decision payload did not parse or validate",
      });
      continue;
    }
    if (!storedWhereItClaims(record, node)) {
      diagnostics.push({
        kind: "storage-node-mismatch",
        node,
        commentId: comment.id,
        detail: `record ${record.id} declares storageNode ${refKey(record.storageNode)}`,
      });
      continue;
    }
    stored.push({ node, commentId: comment.id, record });
  }
  return { stored, diagnostics };
}

/**
 * Fold canonical records into the active ledger for one issue. Pure and total: it
 * classifies every record it is handed into exactly one of active / superseded /
 * inapplicable / conflicted, and reports anything it refused as a diagnostic.
 */
export function foldDecisionLedger(input: LedgerFoldInput): LedgerFold {
  const initiative = input.scope === "initiative";
  const root = input.root;
  const pathKeys = new Set(input.path.map(refKey));

  const diagnostics: LedgerDiagnostic[] = [];
  const inapplicable: StoredDecision[] = [];
  const candidates: StoredDecision[] = [];

  // A record posted twice (a `gh issue comment` that timed out after GitHub had
  // committed it, then retried) is ONE decision, not two claimants of a key. Collapse
  // byte-identical re-posts before anything else, so a retry cannot permanently
  // fail-close a decision nobody disputes.
  const stored = dedupeById(input.stored, diagnostics);

  for (const entry of stored) {
    // An `initiative` record must live on the absolute root — the node its scope
    // names. Parked anywhere else it is not "close enough": fail closed and say so,
    // rather than letting it bind a tree it does not actually top.
    if (entry.record.scope === "initiative" && (!root || !sameRef(entry.node, root))) {
      diagnostics.push({
        kind: "scope-node-mismatch",
        node: entry.node,
        commentId: entry.commentId,
        detail: `initiative-scoped record ${entry.record.id} is not stored on the absolute root`,
      });
      continue;
    }
    if (initiative || appliesToTarget(entry, input.target, pathKeys)) {
      candidates.push(entry);
    } else {
      inapplicable.push(entry);
    }
  }

  // Supersession is resolved over EVERY record read (including out-of-scope ones):
  // a narrower node may supersede an ancestor's call, and the ancestor must not stay
  // active just because the reader happened to fold from a different issue.
  const supersededIds = new Set<string>();
  const knownIds = new Set(stored.map((s) => s.record.id));
  for (const entry of stored) {
    const target = entry.record.supersedes;
    if (target === undefined) {
      continue;
    }
    if (!knownIds.has(target)) {
      diagnostics.push({
        kind: "dangling-supersedes",
        node: entry.node,
        commentId: entry.commentId,
        supersedes: target,
      });
      continue;
    }
    supersededIds.add(target);
  }

  const superseded = candidates.filter((c) => supersededIds.has(c.record.id));
  const live = candidates.filter((c) => !supersededIds.has(c.record.id));

  const grouped = new Map<string, StoredDecision[]>();
  for (const entry of live) {
    const bucket = grouped.get(conflictKey(entry, initiative));
    if (bucket) {
      bucket.push(entry);
    } else {
      grouped.set(conflictKey(entry, initiative), [entry]);
    }
  }

  const active: StoredDecision[] = [];
  const conflicts: DecisionConflict[] = [];
  for (const [, claims] of [...grouped.entries()].sort(([a], [b]) => compareStrings(a, b))) {
    if (claims.length === 1) {
      active.push(claims[0]!);
    } else {
      conflicts.push({ key: claims[0]!.record.key, claims: sortStored(claims) });
    }
  }

  return {
    active: active.sort(byKeyThenId),
    superseded: sortStored(superseded),
    conflicts,
    inapplicable: sortStored(inapplicable),
    diagnostics,
  };
}

/**
 * The bucket two records must share before they can *possibly* conflict.
 *
 * In the `path` fold every candidate already binds the same issue, so the decision
 * key alone is the bucket — two live records for one key genuinely disagree.
 *
 * The `initiative` fold spans the whole tree, where a bare key would manufacture
 * conflicts out of nothing: `#10` and `#11` each recording their own
 * `issue`-scoped `test-strategy` are two issues deciding their own business, not a
 * disagreement. There, records conflict only when they govern the *same node* —
 * precise, never false. A genuine cross-node disagreement (an ancestor's subtree
 * call vs a descendant's) is still caught where it matters: the per-issue `path`
 * fold, which is the one that gates behaviour. The index is a discovery view, and a
 * false conflict there would bury the real ones.
 */
function conflictKey(entry: StoredDecision, initiative: boolean): string {
  return initiative ? `${refKey(entry.node)} ${entry.record.key}` : entry.record.key;
}

/**
 * Collapse records that share an id. A byte-identical re-post is one decision
 * (recorded as a benign diagnostic); two *different* records under one id are a real
 * collision — both are kept so they conflict, and the diagnostic says which.
 */
function dedupeById(
  stored: readonly StoredDecision[],
  diagnostics: LedgerDiagnostic[],
): StoredDecision[] {
  const firstById = new Map<string, StoredDecision>();
  const kept: StoredDecision[] = [];
  for (const entry of stored) {
    const first = firstById.get(entry.record.id);
    if (!first) {
      firstById.set(entry.record.id, entry);
      kept.push(entry);
      continue;
    }
    const identical = JSON.stringify(first.record) === JSON.stringify(entry.record);
    diagnostics.push({
      kind: "duplicate-record-id",
      node: entry.node,
      commentId: entry.commentId,
      id: entry.record.id,
      identical,
    });
    if (!identical) {
      kept.push(entry);
    }
  }
  return kept;
}

/**
 * Whether a record binds `target`: it must live on the target's ancestor path, and
 * an `issue`-scoped record binds only its own node (an ancestor's issue-scoped call
 * is that ancestor's business, not its descendants').
 */
function appliesToTarget(entry: StoredDecision, target: IssueRef, pathKeys: Set<string>): boolean {
  if (!pathKeys.has(refKey(entry.node))) {
    return false;
  }
  return entry.record.scope === "issue" ? sameRef(entry.node, target) : true;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byKeyThenId(a: StoredDecision, b: StoredDecision): number {
  return (
    compareStrings(a.record.key, b.record.key) || compareStrings(a.record.id, b.record.id)
  );
}

/** Deterministic order for any record list: by key, then id. */
function sortStored(entries: readonly StoredDecision[]): StoredDecision[] {
  return [...entries].sort(byKeyThenId);
}
