/**
 * Pass one of the zoom-out: climb GitHub's **native** parent/sub-issue graph from
 * one issue to its absolute root and emit a compact relationship map (ADR-0040).
 *
 * Three properties are load-bearing, and each is a test:
 *
 * - **Native-only authority.** The climb follows {@link GitHubClient.readIssueHierarchy}
 *   and nothing else. Titles, labels, links, and prose headings (`epic`,
 *   `wayfinder`, `master epic`) carry no hierarchy meaning here — the depth at
 *   which a given word appears is an accident of how a human wrote the ticket.
 * - **Never a false root.** `root.kind === "root"` is reached only when GitHub
 *   itself reports *no* parent. A cycle, an over-ceiling chain, a deleted parent,
 *   and an unauthorized parent each terminate the climb with their own typed
 *   {@link RootResolution} — so a caller that needs the absolute root (an
 *   initiative-scoped decision, the root index) can fail closed instead of
 *   planting state on the deepest node it happened to reach.
 * - **Determinism.** Product semantics put no bound on depth, so the ceiling here
 *   is a *technical* safety stop, not a level count; and every child listing is
 *   sorted, so the map is byte-identical whatever order GitHub returned.
 *
 * The map is compact on purpose: nodes carry ref/id/title/state and no bodies.
 * Fetching content is pass two's job ({@link import("./context-packet")}).
 */

import { refKey, sameRef, sortNodes } from "../github/ref";
import type {
  HierarchyNode,
  HierarchyRead,
  InaccessibleReason,
  IssueRef,
} from "../github/types";

/**
 * The technical safety ceiling on ancestor-path length. Deliberately far above any
 * plausible ticket hierarchy: it exists to stop a pathological/corrupt graph from
 * spinning, not to encode "how many levels a programme may have". Hitting it is an
 * explicit, loud {@link RootResolution}, never a silent truncation.
 */
export const HIERARCHY_DEPTH_CEILING = 32;

/** How many sub-issues one path node lists in the compact map before eliding. */
export const DEFAULT_MAX_CHILDREN_PER_NODE = 50;

/** The one read pass one needs; the full GitHub client satisfies it. */
export interface HierarchyReader {
  readIssueHierarchy(ref: IssueRef): Promise<HierarchyRead>;
}

export interface HierarchyMapOptions {
  /** Override the technical depth ceiling (tests). Defaults to {@link HIERARCHY_DEPTH_CEILING}. */
  ceiling?: number;
  /** Cap on children listed per path node. Defaults to {@link DEFAULT_MAX_CHILDREN_PER_NODE}. */
  maxChildrenPerNode?: number;
}

/** The sub-issues of one node on the ancestor path — siblings included, compact. */
export interface HierarchyBranch {
  /** The path node these children hang off. */
  parent: IssueRef;
  /** Children in `compareRefs` order (repo, then number), capped by `maxChildrenPerNode`. */
  children: HierarchyNode[];
  /** How many children the cap elided; 0 when the listing is complete. */
  omitted: number;
}

/**
 * How the climb terminated. Exactly one variant means "this is the absolute root";
 * every failure mode is its own typed value carrying enough detail to adjudicate.
 */
export type RootResolution =
  | { kind: "root"; node: HierarchyNode }
  /** The parent chain re-entered a node already on it; `chain` is the visited path. */
  | { kind: "cycle"; at: IssueRef; chain: IssueRef[] }
  /**
   * The chain is longer than the technical ceiling. `unreadAncestor` is the node
   * the climb stopped *before* reading — the point the caller would resume from,
   * and proof that the path returned is a prefix, not a completed climb.
   */
  | { kind: "over-ceiling"; ceiling: number; unreadAncestor: IssueRef }
  /**
   * A node on the chain could not be read. `via` is the child that pointed at it
   * (absent when the *origin* itself was unreadable), `ref` the node when GitHub
   * named it.
   */
  | { kind: "inaccessible"; ref?: IssueRef; reason: InaccessibleReason; via?: IssueRef; detail?: string };

/** The compact relationship map: an ancestor path plus each path node's children. */
export interface HierarchyMap {
  /**
   * The issue the map was built from, in GitHub's **canonical** spelling (taken
   * from the origin node's own `repository`). GitHub repo names are
   * case-insensitive and survive renames, so a caller's `Acme/App` must not leave
   * an origin that never matches the `acme/app` the path carries — every
   * `sameRef(…, origin)` downstream (selection, storage-node resolution) depends
   * on this. Falls back to the caller's ref when the origin could not be read.
   */
  origin: IssueRef;
  /**
   * The ancestor path, **root-most first**, ending at the origin. Complete only
   * when `root.kind === "root"`; otherwise it is the prefix the climb did reach.
   */
  path: HierarchyNode[];
  /** One entry per path node, in the same root-first order. */
  branches: HierarchyBranch[];
  /** The typed climb outcome — the only place "this is the root" is asserted. */
  root: RootResolution;
}

/**
 * Climb from `origin` to the absolute root through the native graph, returning the
 * compact map. One `readIssueHierarchy` call per level, bounded by the ceiling.
 */
export async function buildHierarchyMap(
  reader: HierarchyReader,
  origin: IssueRef,
  options: HierarchyMapOptions = {},
): Promise<HierarchyMap> {
  const ceiling = options.ceiling ?? HIERARCHY_DEPTH_CEILING;
  const maxChildren = options.maxChildrenPerNode ?? DEFAULT_MAX_CHILDREN_PER_NODE;

  // Built origin-first, reversed once at the end so the caller reads root→issue.
  const climbed: HierarchyNode[] = [];
  const branches: HierarchyBranch[] = [];
  const seen = new Set<string>();
  let cursor: IssueRef = origin;
  let via: IssueRef | undefined;
  let root: RootResolution;

  for (;;) {
    if (climbed.length >= ceiling) {
      root = { kind: "over-ceiling", ceiling, unreadAncestor: cursor };
      break;
    }
    const read = await reader.readIssueHierarchy(cursor);
    if (read.kind === "inaccessible") {
      root = {
        kind: "inaccessible",
        ref: read.ref,
        reason: read.reason,
        ...(via ? { via } : {}),
        ...(read.detail === undefined ? {} : { detail: read.detail }),
      };
      break;
    }
    const key = refKey(read.node.ref);
    if (seen.has(key)) {
      root = { kind: "cycle", at: read.node.ref, chain: climbed.map((n) => n.ref) };
      break;
    }
    seen.add(key);
    climbed.push(read.node);
    branches.push(compactBranch(read.node.ref, read.children, maxChildren, read.childCount));

    const parent = read.parent;
    if (parent.kind === "none") {
      root = { kind: "root", node: read.node };
      break;
    }
    if (parent.kind === "inaccessible") {
      root = {
        kind: "inaccessible",
        ...(parent.ref ? { ref: parent.ref } : {}),
        reason: parent.reason,
        via: read.node.ref,
        ...(parent.detail === undefined ? {} : { detail: parent.detail }),
      };
      break;
    }
    via = read.node.ref;
    cursor = parent.node.ref;
  }

  // `climbed[0]` is the origin as GitHub spells it; the caller's ref may differ in
  // case or predate a repo rename. Adopt the canonical one before reversing.
  const canonicalOrigin = climbed[0]?.ref ?? origin;
  climbed.reverse();
  branches.reverse();
  return { origin: canonicalOrigin, path: climbed, branches, root };
}

/**
 * Sort a node's children and cap the listing, recording what was elided. `total`
 * is GitHub's own child count when it reported one: a single sub-issue page tops
 * out at 100, so `children` can already be a prefix before this cap is applied,
 * and `omitted` must be measured against the true total or it reads a truncated
 * listing as complete.
 */
function compactBranch(
  parent: IssueRef,
  children: readonly HierarchyNode[],
  maxChildren: number,
  total?: number,
): HierarchyBranch {
  const sorted = sortNodes(children);
  const kept = sorted.slice(0, maxChildren);
  return {
    parent,
    children: kept,
    omitted: Math.max(0, Math.max(total ?? sorted.length, sorted.length) - kept.length),
  };
}

/** The compact branch listing for one path node, or `null` if it is not on the path. */
export function branchFor(map: HierarchyMap, node: IssueRef): HierarchyBranch | null {
  return map.branches.find((b) => sameRef(b.parent, node)) ?? null;
}

/** Whether `node` lies on the map's root→origin ancestor path. */
export function isOnPath(map: HierarchyMap, node: IssueRef): boolean {
  return map.path.some((n) => sameRef(n.ref, node));
}

/**
 * The absolute root node, or `null` when the climb did not *prove* one. Callers
 * that plant state on the root (an initiative-scoped decision, the decision index)
 * go through here so an unresolved climb fails closed.
 */
export function absoluteRoot(map: HierarchyMap): HierarchyNode | null {
  return map.root.kind === "root" ? map.root.node : null;
}

/** The map's ancestor path as bare refs, root-most first. */
export function pathRefs(map: HierarchyMap): IssueRef[] {
  return map.path.map((n) => n.ref);
}
