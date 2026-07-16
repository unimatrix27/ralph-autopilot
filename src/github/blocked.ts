/**
 * Parse the `## Blocked by` dependency section of an issue body. The triage /
 * to-issues skills emit dependencies as a markdown list of `#n` references under
 * a `Blocked by` heading; humans and planning agents also write them as GitHub
 * issue URLs (the form GitHub itself renders) or `owner/repo#n` shorthand
 * (issue #8). The gate treats each same-repo reference as a hard prerequisite.
 * A cross-repo reference is a dependency the gate cannot evaluate, so it is
 * reported separately — the caller fails closed and surfaces it — and a list
 * item that yields no reference at all is reported so the caller can warn:
 * a `Blocked by` section that parses to nothing is never a silent no-op.
 */

/** Matches a markdown heading line, capturing its text after the `#`s. */
const HEADING = /^#{1,6}\s+(.*)$/;

/**
 * Matches every issue reference within a line, most-specific alternative first:
 * a GitHub issue URL (`https://github.com/<owner>/<repo>/issues/<n>`, groups
 * 1–3), an `<owner>/<repo>#<n>` shorthand (groups 4–6), or a bare `#<n>`
 * (group 7). Ordering matters — the URL/shorthand alternatives consume their
 * `#<n>` tail, so the bare-ref alternative can never mis-read a shorthand's
 * number as a local reference.
 */
const ISSUE_REF =
  /https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)|([\w.-]+)\/([\w.-]+)#(\d+)|#(\d+)/g;

/** Matches a markdown list item (`-`/`*`/`+`/`1.`), capturing its content. */
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;

/** Everything the `## Blocked by` section declares, split by what the gate can do with it. */
export interface BlockedByRefs {
  /** Same-repo issue numbers, in order of appearance and de-duplicated. */
  refs: number[];
  /**
   * Cross-repo references (canonical `owner/repo#n`), de-duplicated — dependencies
   * the eligibility gate cannot evaluate against the local repo (issue #8).
   */
  crossRepo: string[];
  /** Non-empty list items in the section that yielded no reference at all. */
  unparsed: string[];
}

/**
 * Extract the dependency references listed under the `## Blocked by` heading.
 * Only references *inside* that section count; mentions elsewhere in the body
 * are ignored. `repo` is the owning `owner/repo` slug (compared
 * case-insensitively): URL and shorthand references to it parse as local
 * `refs`, references to any other repo land in `crossRepo`. Returns all-empty
 * when there is no such section.
 */
export function parseBlockedBy(body: string, repo: string): BlockedByRefs {
  const ownRepo = repo.toLowerCase();
  const lines = body.split(/\r?\n/);
  const refs: number[] = [];
  const seenRefs = new Set<number>();
  const crossRepo: string[] = [];
  const seenCross = new Set<string>();
  const unparsed: string[] = [];
  let inSection = false;

  const addRef = (n: number): void => {
    if (!seenRefs.has(n)) {
      seenRefs.add(n);
      refs.push(n);
    }
  };
  const addCross = (ref: string): void => {
    const key = ref.toLowerCase();
    if (!seenCross.has(key)) {
      seenCross.add(key);
      crossRepo.push(ref);
    }
  };

  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading) {
      const title = heading[1]!.trim().toLowerCase();
      inSection = title === "blocked by";
      continue;
    }
    if (!inSection) {
      continue;
    }
    let matched = false;
    for (const match of line.matchAll(ISSUE_REF)) {
      matched = true;
      if (match[7] !== undefined) {
        addRef(Number(match[7]));
        continue;
      }
      const owner = match[1] ?? match[4]!;
      const name = match[2] ?? match[5]!;
      const n = Number(match[3] ?? match[6]!);
      if (`${owner}/${name}`.toLowerCase() === ownRepo) {
        addRef(n);
      } else {
        addCross(`${owner}/${name}#${n}`);
      }
    }
    if (!matched) {
      const content = LIST_ITEM.exec(line)?.[1]?.trim();
      if (content) {
        unparsed.push(content);
      }
    }
  }

  return { refs, crossRepo, unparsed };
}
