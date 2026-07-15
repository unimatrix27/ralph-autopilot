/**
 * Turn an issue title into the stable identifiers a run needs: the
 * `ralph/<n>-<slug>` branch (CONTEXT: worktree) and the worktree directory name.
 */

const MAX_SLUG_LENGTH = 50;

/**
 * A lowercase, hyphen-separated slug safe for a git branch and a directory name.
 * Non-alphanumeric runs become single hyphens; the result is trimmed of leading
 * and trailing hyphens, length-capped, and never empty (falls back to `issue`).
 */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "issue";
}

/** The branch a run works on: `ralph/<n>-<slug>`. */
export function branchName(issueNumber: number, title: string): string {
  return `ralph/${issueNumber}-${slugify(title)}`;
}

/** The flat, slash-free directory name for the issue's worktree. */
export function worktreeDirName(issueNumber: number, title: string): string {
  return `${issueNumber}-${slugify(title)}`;
}
