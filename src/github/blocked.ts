/**
 * Parse the `## Blocked by` dependency section of an issue body. The triage /
 * to-issues skills emit dependencies as a markdown list of `#n` references under
 * a `Blocked by` heading; the gate treats each as a hard prerequisite.
 */

/** Matches a markdown heading line, capturing its text after the `#`s. */
const HEADING = /^#{1,6}\s+(.*)$/;
/** Matches every `#123` reference within a line. */
const ISSUE_REF = /#(\d+)/g;

/**
 * Extract the issue numbers listed under the `## Blocked by` heading, in order
 * of appearance and de-duplicated. Only references *inside* that section count;
 * `#n` mentions elsewhere in the body are ignored. Returns `[]` when there is no
 * such section.
 */
export function parseBlockedBy(body: string): number[] {
  const lines = body.split(/\r?\n/);
  const numbers: number[] = [];
  const seen = new Set<number>();
  let inSection = false;

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
    for (const match of line.matchAll(ISSUE_REF)) {
      const n = Number(match[1]);
      if (!seen.has(n)) {
        seen.add(n);
        numbers.push(n);
      }
    }
  }

  return numbers;
}
