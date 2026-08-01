/**
 * The I/O edge of the decision ledger (ADR-0040): resolve a decision's storage
 * node from the hierarchy, append the canonical comment, and read the ledger back
 * from GitHub.
 *
 * The decision logic is pure and lives next door ({@link foldDecisionLedger}); what
 * is here is the small set of GitHub calls around it, behind an injected port.
 * There is **no SQLite**: every read walks canonical comments, so "delete the local
 * database" is not a recovery scenario, it is the normal path. A projection could
 * be added later purely as a cache — but no decision may ever exist only in it.
 *
 * Storage-node resolution is where "fail closed" is enforced on the write side. An
 * `initiative`-scoped decision needs the *absolute* root, and the climb only proves
 * one when GitHub reports a parentless node; a cycle, an over-ceiling chain, or an
 * unreadable parent all mean "no proven root", so the append is rejected rather
 * than planted on the deepest node reached.
 */

import { refKey, sameRef } from "../github/ref";
import type { IssueRef } from "../github/types";
import {
  absoluteRoot,
  buildHierarchyMap,
  isOnPath,
  pathRefs,
  type HierarchyMap,
  type HierarchyReader,
} from "../hierarchy/map";
import { formatDecisionComment, sanitizeDecisionRecord, type DecisionRecord, type DecisionScope } from "./decision";
import {
  collectDecisionComments,
  foldDecisionLedger,
  type LedgerDiagnostic,
  type LedgerFold,
  type StoredDecision,
} from "./fold";

/** Default cap on nodes visited by the whole-subtree crawl the root index renders. */
export const DEFAULT_CRAWL_MAX_NODES = 200;

/** Reading the ledger needs comment threads; the GitHub client satisfies this. */
export interface LedgerReadPort {
  readIssueContent(ref: IssueRef): Promise<import("../github/types").IssueContentRead>;
}

/** Appending needs to post on a (possibly cross-repo) node. */
export interface LedgerWritePort {
  postNodeComment(ref: IssueRef, body: string): Promise<{ id: number }>;
}

/** The subtree crawl needs the native child listing as well as comment threads. */
export interface LedgerCrawlPort extends LedgerReadPort, HierarchyReader {}

/** Why a decision could not be given a storage node. Each fails closed. */
export type StorageRejection =
  /** `subtree` scope with no subtree root named. */
  | "subtree-root-missing"
  /** The named subtree root is not on the issue's ancestor path. */
  | "subtree-root-off-path"
  /** `initiative` scope, but the climb never proved an absolute root. */
  | "unresolved-root"
  /** The map carries no origin node at all (the origin itself was unreadable). */
  | "no-origin";

export type StorageResolution =
  | { kind: "node"; node: IssueRef }
  | { kind: "rejected"; reason: StorageRejection; detail: string };

/**
 * The narrowest hierarchy node matching a decision's scope:
 * `issue` → the issue itself, `subtree` → the named subtree root on its ancestor
 * path, `initiative` → the proven absolute root.
 */
export function resolveStorageNode(
  map: HierarchyMap,
  scope: DecisionScope,
  subtreeRoot?: IssueRef,
): StorageResolution {
  // `initiative` needs only a proven root, so it is answered before the origin
  // check: a map whose origin node is missing can still carry a proven root, and
  // rejecting that as `no-origin` would hide the real state from the caller.
  if (scope === "initiative") {
    const root = absoluteRoot(map);
    if (!root) {
      return {
        kind: "rejected",
        reason: "unresolved-root",
        detail: `the climb from ${refKey(map.origin)} ended in \`${map.root.kind}\`, so no absolute root is proven`,
      };
    }
    return { kind: "node", node: root.ref };
  }
  const origin = map.path.find((n) => sameRef(n.ref, map.origin));
  if (!origin) {
    return {
      kind: "rejected",
      reason: "no-origin",
      detail: `the hierarchy map for ${refKey(map.origin)} carries no origin node`,
    };
  }
  if (scope === "issue") {
    return { kind: "node", node: origin.ref };
  }
  if (!subtreeRoot) {
    return {
      kind: "rejected",
      reason: "subtree-root-missing",
      detail: "a subtree-scoped decision must name the subtree root it governs",
    };
  }
  if (!isOnPath(map, subtreeRoot)) {
    return {
      kind: "rejected",
      reason: "subtree-root-off-path",
      detail: `${refKey(subtreeRoot)} is not on ${refKey(map.origin)}'s root→issue path`,
    };
  }
  return { kind: "node", node: subtreeRoot };
}

/** The proven absolute root of a map, or `undefined` — the fold's `root` input. */
function provenRoot(map: HierarchyMap): IssueRef | undefined {
  return absoluteRoot(map)?.ref;
}

export interface AppendDecisionInput {
  map: HierarchyMap;
  /** The subtree root a `subtree`-scoped record governs; ignored for other scopes. */
  subtreeRoot?: IssueRef;
  /**
   * The record to append. Its `scope` selects the storage node; whatever
   * `storageNode` it arrives with is replaced by the resolved one, so a caller
   * cannot mis-file a record by hand.
   */
  record: DecisionRecord;
}

export type AppendDecisionResult =
  | { kind: "appended"; node: IssueRef; commentId: number; record: DecisionRecord }
  | { kind: "rejected"; reason: StorageRejection; detail: string };

/**
 * Append one canonical decision record to the ledger: resolve its storage node,
 * stamp the record with it, and post the comment. Append-only — no existing
 * comment is read, edited, or removed.
 */
export async function appendDecision(
  port: LedgerWritePort,
  input: AppendDecisionInput,
): Promise<AppendDecisionResult> {
  const resolved = resolveStorageNode(input.map, input.record.scope, input.subtreeRoot);
  if (resolved.kind === "rejected") {
    return resolved;
  }
  const record = sanitizeDecisionRecord({ ...input.record, storageNode: resolved.node });
  const { id } = await port.postNodeComment(resolved.node, formatDecisionComment(record));
  return { kind: "appended", node: resolved.node, commentId: id, record };
}

/**
 * The active ledger for the map's origin issue: read every node on its root→issue
 * path and fold. One content read per path node, bounded by the depth ceiling.
 */
export async function readDecisionLedger(
  port: LedgerReadPort,
  map: HierarchyMap,
): Promise<LedgerFold> {
  const path = pathRefs(map);
  const { stored, diagnostics } = await collectAcross(port, path);
  // The root is passed only when the climb PROVED one. Otherwise `path[0]` is just
  // the highest node reached, and an `initiative` record sitting on it must fail
  // closed on the read side exactly as `resolveStorageNode` refuses it on the write
  // side — a read that failed open here would let a decision bind a tree whose top
  // nobody could establish.
  const fold = foldDecisionLedger({
    path,
    ...(provenRoot(map) ? { root: provenRoot(map) } : {}),
    target: map.origin,
    stored,
  });
  return { ...fold, diagnostics: [...diagnostics, ...fold.diagnostics] };
}

export interface InitiativeLedgerOptions {
  /** Cap on nodes visited. Defaults to {@link DEFAULT_CRAWL_MAX_NODES}. */
  maxNodes?: number;
}

/**
 * The whole-subtree ledger under `root` — the view the derived root index renders.
 * Walks the native sub-issue graph breadth-first, visiting each node once (so a
 * corrupt graph with a cycle terminates) and stopping at an explicit node cap that
 * is reported as a diagnostic rather than silently shortening the view.
 *
 * Folded in `initiative` scope: nothing is filtered as out-of-scope, because the
 * index is a directory of everything decided anywhere in the initiative.
 */
export async function readInitiativeLedger(
  port: LedgerCrawlPort,
  root: IssueRef,
  options: InitiativeLedgerOptions = {},
): Promise<LedgerFold> {
  const maxNodes = options.maxNodes ?? DEFAULT_CRAWL_MAX_NODES;
  const visited = new Set<string>();
  const queue: IssueRef[] = [root];
  const nodes: IssueRef[] = [];
  const diagnostics: LedgerDiagnostic[] = [];
  let capped = false;

  while (queue.length > 0) {
    const ref = queue.shift()!;
    if (visited.has(refKey(ref))) {
      continue;
    }
    if (nodes.length >= maxNodes) {
      capped = true;
      break;
    }
    visited.add(refKey(ref));
    nodes.push(ref);
    const read = await port.readIssueHierarchy(ref);
    if (read.kind !== "node") {
      diagnostics.push({ kind: "node-unreadable", node: ref, reason: read.reason });
      continue;
    }
    // GitHub caps a sub-issue page, so a node with more children than one page hands
    // back a prefix. Say so: the descendants past it are never visited, and their
    // decision records are silently absent from the index otherwise.
    if (read.childCount !== undefined && read.childCount > read.children.length) {
      diagnostics.push({
        kind: "crawl-incomplete",
        node: ref,
        listed: read.children.length,
        total: read.childCount,
      });
    }
    for (const child of read.children) {
      if (!visited.has(refKey(child.ref))) {
        queue.push(child.ref);
      }
    }
  }
  if (capped) {
    diagnostics.push({ kind: "crawl-capped", maxNodes });
  }

  const collected = await collectAcross(port, nodes);
  const fold = foldDecisionLedger({
    path: [root],
    root,
    target: root,
    scope: "initiative",
    stored: collected.stored,
  });
  return {
    ...fold,
    diagnostics: [...diagnostics, ...collected.diagnostics, ...fold.diagnostics],
  };
}

/** Read every node's comment thread and collect the canonical records it carries. */
async function collectAcross(
  port: LedgerReadPort,
  nodes: readonly IssueRef[],
): Promise<{ stored: StoredDecision[]; diagnostics: LedgerDiagnostic[] }> {
  const stored: StoredDecision[] = [];
  const diagnostics: LedgerDiagnostic[] = [];
  for (const node of nodes) {
    const content = await port.readIssueContent(node);
    if (content.kind === "inaccessible") {
      diagnostics.push({ kind: "node-unreadable", node, reason: content.reason });
      continue;
    }
    const collected = collectDecisionComments(node, content.comments);
    stored.push(...collected.stored);
    diagnostics.push(...collected.diagnostics);
  }
  return { stored, diagnostics };
}

/**
 * Build the hierarchy map and the issue's active ledger in one call — the shape a
 * master session wants: "where does this issue sit, and what has already been
 * decided above it?".
 */
export async function readLedgerForIssue(
  port: LedgerCrawlPort,
  origin: IssueRef,
): Promise<{ map: HierarchyMap; ledger: LedgerFold }> {
  const map = await buildHierarchyMap(port, origin);
  return { map, ledger: await readDecisionLedger(port, map) };
}
