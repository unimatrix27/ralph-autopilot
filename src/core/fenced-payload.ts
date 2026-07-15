/**
 * The one canonical codec for a fenced JSON payload embedded in a GitHub comment
 * body. Both daemon-authored comment types — `ralph-question` (the escalation /
 * heal-card surface) and `ralph-answer` (the operator's reply) — render a
 * human-readable summary followed by a machine-parseable JSON payload inside a
 * language-tagged code fence, and read that payload back on rebuild. This module
 * is the single home of both directions so the two formats cannot drift.
 *
 * Extraction is **regex-anchored on the fence's language tag** rather than a
 * `split("```")` walk: a bare ```` ``` ```` appearing in the prose summary can't be
 * mistaken for the payload boundary, because only ```` ```<tag> ```` opens a match.
 */

/** Escape a literal string for safe interpolation into a RegExp source. */
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match a fenced block opened by ```` ```<fence> ```` (the tag leading a line),
 * capturing the payload up to the next closing ```` ``` ````. Non-greedy, so the
 * first such block wins — mirroring "the latest parseable comment is the live
 * one" scan that operates one comment body at a time.
 */
function fencedBlockRegex(fence: string): RegExp {
  return new RegExp("```" + escapeForRegExp(fence) + "[^\\n]*\\n([\\s\\S]*?)```");
}

/**
 * Render a JSON `value` as a fenced payload block: ```` ```<fence> ````, the
 * pretty-printed JSON, then the closing ```` ``` ````. Callers prepend their own
 * human-readable summary outside the fence.
 */
export function renderFencedPayload(fence: string, value: unknown): string {
  return ["```" + fence, JSON.stringify(value, null, 2), "```"].join("\n");
}

/**
 * Neutralize backticks in an untrusted string before it is interpolated INSIDE a fenced payload.
 * A raw backtick run in embedded detail (a git error, an agent's output tail) would close the
 * enclosing code fence early and truncate the payload — making the comment unparseable to its
 * reader ({@link parseFencedPayload} / ralph-answer). Swap each backtick for a visually-near
 * lookalike (U+00B4 ACUTE ACCENT) so the text still reads while the fence stays intact. Fence
 * safety belongs to the codec that owns the fence, so callers embedding untrusted detail in a
 * fenced heal-card / question run their interpolated fields through this rather than re-deriving it.
 */
export function sanitizeForFence(s: string): string {
  return s.replace(/`/g, "´");
}

/** Whether `body` carries a fenced payload block for `fence`. */
export function hasFencedPayload(body: string, fence: string): boolean {
  return body.includes("```" + fence);
}

/**
 * The raw JSON text inside the first ```` ```<fence> ```` block in `body`, or
 * `null` if there is none. Anchored on the language tag (see module note).
 */
export function extractFencedPayload(body: string, fence: string): string | null {
  const match = fencedBlockRegex(fence).exec(body);
  return match ? match[1]! : null;
}

/**
 * Extract, JSON-parse, and validate the fenced payload in `body`. Returns `null`
 * if there is no fence, the payload is not valid JSON, or `validate` throws — so a
 * malformed or absent comment is a clean "no parseable payload", never an
 * exception out of a rebuild path.
 */
export function parseFencedPayload<T>(
  body: string,
  fence: string,
  validate: (value: unknown) => T,
): T | null {
  const json = extractFencedPayload(body, fence);
  if (json === null) {
    return null;
  }
  try {
    return validate(JSON.parse(json));
  } catch {
    return null;
  }
}
