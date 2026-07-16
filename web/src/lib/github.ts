/**
 * Client-side GitHub URL derivation from a repo slug — no new wire field needed (issue #13).
 * The daemon already carries the `owner/name` repo slug and the issue number in every view;
 * the canonical issue URL is derivable from those two, so we build it here rather than plumb
 * a link through the contract.
 */

/** The canonical GitHub issue URL for a `owner/name` repo slug + issue number. */
export function githubIssueUrl(repo: string, issue: number): string {
  return `https://github.com/${repo}/issues/${issue}`;
}

/**
 * The heading text for a run/agent row: the GitHub issue title when known, else the bare
 * `repo #issue` reference (issue #13). A run predating the persisted title, or one whose title
 * was never captured, degrades gracefully to the reference every consumer already shows.
 */
export function issueHeading(title: string | null, repo: string, issue: number): string {
  return title && title.length > 0 ? title : `${repo} #${issue}`;
}
