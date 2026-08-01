/**
 * Pass two of the zoom-out: turn the compact {@link HierarchyMap} into a
 * **deterministic, size-bounded context packet** (ADR-0040).
 *
 * The split is the whole point. Pass one builds the relationship map from cheap,
 * body-less native reads, so every sibling branch is *visible*. Pass two fetches
 * bodies and comments only for the nodes it selects — by default the origin, its
 * root→issue ancestors, and its direct children. A sibling subtree therefore costs
 * one line in the map, not a body fetch, until a caller explicitly asks for it.
 *
 * Two invariants a caller can rely on:
 *
 * - **Deterministic.** Selection order is fixed (origin → ancestors nearest-first
 *   → children → explicit extras) and every child listing was sorted in pass one,
 *   so the same hierarchy yields a byte-identical packet whatever order GitHub
 *   returned sub-issues in. A master session re-run on unchanged tickets sees
 *   unchanged context.
 * - **Bounded, and honest about it.** The budget is a plain **character** count —
 *   tokenizer-independent, so it means the same thing across providers. When the
 *   budget binds, the packet says exactly which nodes were trimmed and which were
 *   dropped rather than quietly shrinking.
 */

import { compareRefs, refKey, sameRef } from "../github/ref";
import type {
  HierarchyNode,
  InaccessibleReason,
  IssueContentRead,
  IssueRef,
  IssueState,
  PrComment,
} from "../github/types";
import { buildHierarchyMap, type HierarchyMap, type HierarchyMapOptions, type HierarchyReader } from "./map";

/**
 * Default character budget for one packet's fetched content. Sized for a
 * zoomed-out read of a deep hierarchy without swamping a session's context, and
 * deliberately a *constant* rather than a config key: the compatibility failure in
 * issue #19 makes a new daemon-only config field a live outage risk, and callers
 * that need a different bound pass it per call.
 */
export const DEFAULT_CONTEXT_CHAR_BUDGET = 60_000;

/** Default cap on comments carried per selected node (most recent kept). */
export const DEFAULT_MAX_COMMENTS_PER_NODE = 20;

/** The two reads a full assembly needs; the GitHub client satisfies both. */
export interface ContextReader extends HierarchyReader {
  readIssueContent(ref: IssueRef): Promise<IssueContentRead>;
}

export interface ContextPacketOptions extends HierarchyMapOptions {
  /** Character budget across all fetched content. Defaults to {@link DEFAULT_CONTEXT_CHAR_BUDGET}. */
  charBudget?: number;
  /** Comments carried per node. Defaults to {@link DEFAULT_MAX_COMMENTS_PER_NODE}. */
  maxCommentsPerNode?: number;
  /**
   * Extra nodes to fetch beyond the default selection — the escape hatch that
   * turns a map-only sibling branch into fetched content, and the *only* way a
   * sibling's body enters a packet.
   */
  select?: readonly IssueRef[];
}

/** Why a node is in the packet — the reason pass two selected it. */
export type ContextNodeRole = "origin" | "ancestor" | "child" | "selected";

/** One fetched node: the compact identity plus the content the budget allowed. */
export interface ContextNode {
  ref: IssueRef;
  id: string;
  title: string;
  state: IssueState;
  role: ContextNodeRole;
  body: string;
  comments: Array<{ id: number; author: string; body: string }>;
  /** Design references linked from the body (`docs/…`, `ADR-nnnn`), deduped + sorted. */
  designRefs: string[];
  /** True when the comment cap or the character budget cut this node's content. */
  truncated: boolean;
}

/** A node pass two selected but could not read. Surfaced, never silently dropped. */
export type ContextDiagnostic = {
  kind: "content-inaccessible";
  ref: IssueRef;
  reason: InaccessibleReason;
};

export interface ContextPacket {
  origin: IssueRef;
  /** Pass one's compact relationship map, including the typed root outcome. */
  map: HierarchyMap;
  /** Fetched nodes in deterministic selection order. */
  nodes: ContextNode[];
  budget: { charBudget: number; charsUsed: number };
  truncation: {
    truncated: boolean;
    /** Nodes whose content was cut to fit, in packet order. */
    trimmed: IssueRef[];
    /** Nodes selected but dropped whole once the budget was spent, in packet order. */
    dropped: IssueRef[];
  };
  diagnostics: ContextDiagnostic[];
}

/** Repo doc paths (`docs/…md`, `CONTEXT.md`, …) referenced in prose. */
const DOC_PATH_RE = /\b(?:docs\/[A-Za-z0-9_\-.\/]*?\.md|CONTEXT\.md|CLAUDE\.md|AGENTS\.md)\b/g;
/** Bare ADR ids (`ADR-0011`) referenced in prose. */
const ADR_ID_RE = /\bADR-\d{4}\b/g;

/**
 * Design references linked from an issue body: repo doc paths and ADR ids, deduped
 * and sorted. Pure text extraction — it reads what the ticket *says*, and never
 * infers hierarchy from it (that is the native graph's job alone).
 */
export function extractDesignReferences(body: string): string[] {
  const found = new Set<string>();
  for (const re of [DOC_PATH_RE, ADR_ID_RE]) {
    for (const match of body.matchAll(re)) {
      found.add(match[0]);
    }
  }
  return [...found].sort();
}

/** One node pass two intends to fetch, with the role it was selected for. */
interface Selection {
  ref: IssueRef;
  role: ContextNodeRole;
}

/**
 * The deterministic pass-two selection for a map: the origin, then its ancestors
 * nearest-first, then its direct children, then any explicitly requested extras.
 * Pure, so the "what does a packet cost" question is answerable without I/O.
 */
export function selectContextNodes(
  map: HierarchyMap,
  extras: readonly IssueRef[] = [],
): Selection[] {
  const selections: Selection[] = [];
  const seen = new Set<string>();
  const take = (ref: IssueRef, role: ContextNodeRole): void => {
    const key = refKey(ref);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    selections.push({ ref, role });
  };

  const origin = map.path.find((n) => sameRef(n.ref, map.origin));
  if (origin) {
    take(origin.ref, "origin");
  }
  // Ancestors nearest-first: the closer a node is, the more it constrains the work.
  for (const node of [...map.path].reverse()) {
    if (!sameRef(node.ref, map.origin)) {
      take(node.ref, "ancestor");
    }
  }
  const originBranch = map.branches.find((b) => sameRef(b.parent, map.origin));
  for (const child of originBranch?.children ?? []) {
    take(child.ref, "child");
  }
  for (const extra of [...extras].sort(compareRefs)) {
    take(extra, "selected");
  }
  return selections;
}

/**
 * Build the full two-pass context packet for `origin`: map the native hierarchy,
 * then fetch the selected nodes within the character budget.
 */
export async function assembleContextPacket(
  reader: ContextReader,
  origin: IssueRef,
  options: ContextPacketOptions = {},
): Promise<ContextPacket> {
  const map = await buildHierarchyMap(reader, origin, options);
  return packContextPacket(reader, map, options);
}

/**
 * Pass two alone, against an already-built map — for a caller that has paid for
 * pass one and wants a second packet at a different budget or selection.
 */
export async function packContextPacket(
  reader: Pick<ContextReader, "readIssueContent">,
  map: HierarchyMap,
  options: ContextPacketOptions = {},
): Promise<ContextPacket> {
  const charBudget = options.charBudget ?? DEFAULT_CONTEXT_CHAR_BUDGET;
  const maxComments = options.maxCommentsPerNode ?? DEFAULT_MAX_COMMENTS_PER_NODE;

  const nodes: ContextNode[] = [];
  const diagnostics: ContextDiagnostic[] = [];
  const trimmed: IssueRef[] = [];
  const dropped: IssueRef[] = [];
  let remaining = charBudget;

  for (const selection of selectContextNodes(map, options.select ?? [])) {
    const read = await reader.readIssueContent(selection.ref);
    if (read.kind === "inaccessible") {
      diagnostics.push({ kind: "content-inaccessible", ref: read.ref, reason: read.reason });
      continue;
    }
    if (remaining <= 0) {
      dropped.push(read.node.ref);
      continue;
    }
    const kept = capComments(read.comments, maxComments);
    const fitted = fitToBudget(read.body, kept.comments, remaining);
    remaining -= fitted.chars;
    // `trimmed` means "this node lost content", whatever cut it — the comment cap as
    // much as the character budget. Reporting only budget cuts would let a packet
    // claim `truncated: false` while half a thread was dropped by the cap.
    const cut = kept.cut || fitted.cut;
    if (cut) {
      trimmed.push(read.node.ref);
    }
    nodes.push(toContextNode(read.node, selection.role, fitted, cut));
  }

  return {
    origin: map.origin,
    map,
    nodes,
    budget: { charBudget, charsUsed: charBudget - remaining },
    truncation: { truncated: trimmed.length > 0 || dropped.length > 0, trimmed, dropped },
    diagnostics,
  };
}

/** Keep the most recent `max` comments — the ones nearest the current state. */
function capComments(comments: readonly PrComment[], max: number): { comments: PrComment[]; cut: boolean } {
  return comments.length <= max
    ? { comments: [...comments], cut: false }
    : { comments: comments.slice(comments.length - max), cut: true };
}

/** A node's content after the character budget was applied. */
interface FittedContent {
  body: string;
  comments: PrComment[];
  /** Characters this node consumed — body plus every kept comment body. */
  chars: number;
  /** True when the budget cut the body or dropped comments. */
  cut: boolean;
}

/**
 * Spend at most `remaining` characters on one node: the body first (it is the
 * ticket's own statement of the work), then comments **newest-first** until the
 * budget is gone — the same bias as {@link capComments}, for the same reason. Under
 * pressure a session must see the latest state of a thread, not its opening; filling
 * oldest-first would systematically hand it the stale half. The kept comments are
 * then restored to chronological order so the thread still reads forwards. Cutting
 * mid-string is deliberate — the cut is reported in the truncation metadata rather
 * than spending budget on an inline marker.
 */
function fitToBudget(body: string, comments: readonly PrComment[], remaining: number): FittedContent {
  const total = body.length + comments.reduce((sum, c) => sum + c.body.length, 0);
  if (total <= remaining) {
    return { body, comments: [...comments], chars: total, cut: false };
  }
  let left = remaining;
  const fittedBody = body.slice(0, left);
  left -= fittedBody.length;
  const fittedComments: PrComment[] = [];
  for (const comment of [...comments].reverse()) {
    if (left <= 0) {
      break;
    }
    const text = comment.body.slice(0, left);
    left -= text.length;
    fittedComments.push({ ...comment, body: text });
  }
  fittedComments.reverse();
  return { body: fittedBody, comments: fittedComments, chars: remaining - left, cut: true };
}

function toContextNode(
  node: HierarchyNode,
  role: ContextNodeRole,
  fitted: FittedContent,
  truncated: boolean,
): ContextNode {
  return {
    ref: node.ref,
    id: node.id,
    title: node.title,
    state: node.state,
    role,
    body: fitted.body,
    comments: fitted.comments.map((c) => ({ id: c.id, author: c.author, body: c.body })),
    designRefs: extractDesignReferences(fitted.body),
    truncated,
  };
}
