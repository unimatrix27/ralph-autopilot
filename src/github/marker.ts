/**
 * The `<!-- ralph-launch: … -->` marker the impl agent stamps into every PR it
 * opens. It is an HTML comment (invisible in the rendered PR) that lets the
 * daemon recognise its own launches when rebuilding state from GitHub — a PR
 * carrying this marker came from a ralph run, not a human.
 */

export interface LaunchMarker {
  issueNumber: number;
  branch: string;
}

// The branch token is constrained to the known `ralph/<n>-<slug>` shape a run
// works on (see core/slug.ts: `ralph/${issueNumber}-${slugify(title)}`), not any
// `\S+`. A marker whose branch doesn't fit the shape is treated as absent, so a
// malformed or hand-edited marker never drives the daemon onto a bogus branch.
const MARKER = /<!--\s*ralph-launch:\s*issue=#(\d+)\s+branch=(ralph\/\d+-[a-z0-9-]+)\s*-->/;

/** Render the marker for a PR body. */
export function buildLaunchMarker({ issueNumber, branch }: LaunchMarker): string {
  return `<!-- ralph-launch: issue=#${issueNumber} branch=${branch} -->`;
}

/** Parse the first ralph-launch marker in a PR body, or `null` if absent. */
export function parseLaunchMarker(body: string): LaunchMarker | null {
  const match = MARKER.exec(body);
  if (!match) {
    return null;
  }
  return { issueNumber: Number(match[1]), branch: match[2]! };
}
