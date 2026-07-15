/**
 * The `ralph-review` comment (issue #47) — the **review→fix handoff on the PR**.
 * After each review pass {@link import("./review-loop").ReviewLoop.runPhase} posts
 * (or edits) one rolling `ralph-review` comment per phase carrying that phase's
 * deduped {@link Worklist} as a fenced JSON payload, mirroring `ralph-question`
 * (`escalation.ts`): a machine-parseable payload inside the fence, a human-readable
 * summary outside it. The fix agent reads it back from the PR rather than only an
 * in-process value, so ralph's own findings live on the PR next to the bot/human
 * comments the loop already ingests — a reviewed PR now carries a durable record of
 * what review found and the fix step resolved (DESIGN §4).
 *
 * **One rolling comment per phase**, edited in place as fix attempts resolve items
 * — not one comment per iteration (3 attempts × 2 phases would bury the thread).
 * The comment is found again by parsing its payload's `phase`, so the rolling
 * comment stays a single comment even when a phase reviews **twice** — the build
 * review and the ADR-0017 integration re-review both converge on it (recover the id
 * from the PR, edit in place), never a duplicate.
 *
 * Both directions go through the one shared fenced-payload codec
 * ({@link import("../core/fenced-payload")}) so this format and `ralph-question`
 * cannot drift; zod v4 (ADR-0010) validates the payload, reusing the same
 * {@link worklistSchema} the review agent emits.
 */

import { z } from "zod";
import {
  hasFencedPayload,
  parseFencedPayload,
  renderFencedPayload,
} from "../core/fenced-payload";
import type { PrComment } from "../github/types";
import type { Phase } from "../store/types";
import { gatingItems, isGating, worklistSchema, type Worklist, type WorklistItem } from "./worklist";

/** The fence language tag that marks a daemon-authored review comment. */
export const RALPH_REVIEW_FENCE = "ralph-review";

/** The structured payload a `ralph-review` comment carries inside its fence. */
const reviewCommentPayloadSchema = z
  .object({
    phase: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    /** The deduped, severity-ranked worklist this phase's review produced. */
    worklist: worklistSchema,
  })
  .strict();

/** The structured payload a `ralph-review` comment carries (phase + its worklist). */
export type ReviewCommentData = z.infer<typeof reviewCommentPayloadSchema>;

/** Parse and validate a `ralph-review` payload (the JSON inside the fence). */
export function parseReviewCommentPayload(value: unknown): ReviewCommentData {
  return reviewCommentPayloadSchema.parse(value);
}

const PHASE_LABEL: Record<Phase, string> = {
  0: "CI gate",
  1: "normal review",
  2: "behaviour-conserving thermo review",
};

/** One worklist item rendered as a human-readable bullet. */
function itemLine(item: WorklistItem): string {
  const detail = item.detail ? ` — ${item.detail}` : "";
  return `- **[${item.severity}]** ${item.title}${detail}`;
}

/**
 * The human-readable summary outside the fence: blocking findings lead (operator
 * attention is scarce), then any non-blocking notes. A phase with no gating item is
 * stated clean, so the rolling comment reads as resolved once the fix attempts land
 * it.
 */
function summary(worklist: Worklist): string[] {
  const blocking = gatingItems(worklist);
  const nonBlocking = worklist.items.filter((i) => !isGating(i));
  const lines: string[] = [];
  if (blocking.length === 0) {
    lines.push("✓ No blocking findings — this phase is clean.");
  } else {
    lines.push(`${blocking.length} blocking finding(s) — every one gates the merge:`);
    for (const item of blocking) {
      lines.push(itemLine(item));
    }
  }
  if (nonBlocking.length > 0) {
    lines.push("", `${nonBlocking.length} non-blocking note(s):`);
    for (const item of nonBlocking) {
      lines.push(itemLine(item));
    }
  }
  return lines;
}

/**
 * Render a phase's deduped worklist as a `ralph-review` comment body: a heading, a
 * human-readable summary, then the fenced JSON payload the fix agent (and the
 * daemon, on recovery) parse back. The body is the rolling comment's whole content
 * — editing it in place replaces it wholesale.
 */
export function formatReviewComment({ phase, worklist }: ReviewCommentData): string {
  return [
    `## ralph-review — phase ${phase} (${PHASE_LABEL[phase]})`,
    "",
    ...summary(worklist),
    "",
    "<!-- The structured payload below is parsed by ralph-autopilot; the fix agent resolves its gating items. -->",
    renderFencedPayload(RALPH_REVIEW_FENCE, { phase, worklist }),
  ].join("\n");
}

/** Whether a comment body is a `ralph-review` comment (carries the fenced payload). */
export function isReviewComment(body: string): boolean {
  return hasFencedPayload(body, RALPH_REVIEW_FENCE);
}

/**
 * Extract and validate the structured worklist from a `ralph-review` comment body
 * (the JSON inside the fence), or `null` if it carries no parseable payload. The
 * fix agent and the daemon read the worklist back through here — GitHub is the
 * source of truth, the in-memory worklist is only a cache.
 */
export function parseReviewComment(body: string): ReviewCommentData | null {
  return parseFencedPayload(body, RALPH_REVIEW_FENCE, parseReviewCommentPayload);
}

/**
 * The latest (live) `ralph-review` comment for a phase, with its comment id, or
 * `null` if none is present. The rolling comment is recovered by parsing each
 * comment's payload for a matching `phase` so a phase that reviews twice (the build
 * review, then the ADR-0017 integration re-review) — or a daemon that restarted
 * mid-phase — edits the existing comment in place rather than posting a duplicate.
 * The last matching comment wins (it is the live one).
 */
export function latestReviewComment(
  comments: PrComment[],
  phase: Phase,
): { id: number; data: ReviewCommentData } | null {
  let found: { id: number; data: ReviewCommentData } | null = null;
  for (const comment of comments) {
    const data = parseReviewComment(comment.body);
    if (data && data.phase === phase) {
      found = { id: comment.id, data };
    }
  }
  return found;
}
