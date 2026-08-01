/**
 * Pure helpers over {@link IssueRef} — the `owner/repo#n` pointer every hierarchy
 * and decision-ledger surface keys on (ADR-0040).
 *
 * Two things live here and nowhere else: the **key** a ref hashes to (so a
 * cross-repo hierarchy can never collide two issues that share a number) and the
 * **sort order** the whole feature's determinism rests on. A context packet must
 * be byte-identical whatever order GitHub happened to return sub-issues in, so
 * every child listing is sorted through {@link compareRefs} exactly once.
 */

import type { HierarchyNode, IssueRef } from "./types";

/** The canonical `owner/repo#n` key for a ref — the Map/Set identity of a node. */
export function refKey(ref: IssueRef): string {
  return `${ref.repo}#${ref.number}`;
}

/** The human-readable form of a ref; identical to {@link refKey} by design. */
export function formatRef(ref: IssueRef): string {
  return refKey(ref);
}

/**
 * Parse a fully-qualified `owner/repo#n` ref, or `null`. Deliberately strict: a
 * bare `#41` is ambiguous across repos and a partial ref would silently point at
 * the wrong issue, so only the qualified form parses.
 */
export function parseIssueRef(text: string): IssueRef | null {
  const match = /^([^\s/#]+\/[^\s/#]+)#(\d+)$/.exec(text.trim());
  if (!match) {
    return null;
  }
  const number = Number(match[2]);
  return number > 0 ? { repo: match[1]!, number } : null;
}

/** Whether two refs point at the same issue node. */
export function sameRef(a: IssueRef, b: IssueRef): boolean {
  return a.repo === b.repo && a.number === b.number;
}

/** Total order over refs: repo (lexicographic) then number (numeric). */
export function compareRefs(a: IssueRef, b: IssueRef): number {
  if (a.repo !== b.repo) {
    return a.repo < b.repo ? -1 : 1;
  }
  return a.number - b.number;
}

/** A new array of nodes in {@link compareRefs} order; the input is untouched. */
export function sortNodes(nodes: readonly HierarchyNode[]): HierarchyNode[] {
  return [...nodes].sort((a, b) => compareRefs(a.ref, b.ref));
}

/** A new array of refs in {@link compareRefs} order; the input is untouched. */
export function sortRefs(refs: readonly IssueRef[]): IssueRef[] {
  return [...refs].sort(compareRefs);
}

/** The canonical web URL of an issue node. */
export function issueUrl(ref: IssueRef): string {
  return `https://github.com/${ref.repo}/issues/${ref.number}`;
}

/**
 * The permalink of one comment on an issue node — the source link every entry in
 * the derived `ralph-decision-index` carries back to its canonical record.
 */
export function commentUrl(ref: IssueRef, commentId: number): string {
  return `${issueUrl(ref)}#issuecomment-${commentId}`;
}

/** Split `owner/repo` into its two halves for APIs that want them separately. */
export function splitRepo(repo: string): { owner: string; name: string } {
  const slash = repo.indexOf("/");
  return slash < 0
    ? { owner: repo, name: "" }
    : { owner: repo.slice(0, slash), name: repo.slice(slash + 1) };
}
