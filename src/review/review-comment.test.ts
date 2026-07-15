import { describe, expect, it } from "vitest";
import type { PrComment } from "../github/types";
import { extractFencedPayload, parseFencedPayload } from "../core/fenced-payload";
import {
  formatReviewComment,
  isReviewComment,
  latestReviewComment,
  parseReviewComment,
  parseReviewCommentPayload,
  RALPH_REVIEW_FENCE,
} from "./review-comment";
import type { Worklist } from "./worklist";

const worklist: Worklist = {
  items: [
    { severity: "P0", title: "race on retry", detail: "two writers, no lock", source: "review" },
    { severity: "P1", title: "weak abstraction in X", source: "pr-comment" },
    { severity: "nit", title: "rename a local" },
  ],
};

describe("formatReviewComment / parseReviewComment", () => {
  it("round-trips the phase + deduped worklist through the comment", () => {
    const body = formatReviewComment({ phase: 1, worklist });

    expect(isReviewComment(body)).toBe(true);
    const parsed = parseReviewComment(body);
    expect(parsed).not.toBeNull();
    expect(parsed!.phase).toBe(1);
    expect(parsed!.worklist).toEqual(worklist);
  });

  it("round-trips through the SHARED fenced-payload codec (AC: shared codec)", () => {
    // The acceptance criterion is specifically that the ralph-review payload goes
    // through the one shared codec, not a bespoke split() — so the same
    // `extractFencedPayload` / `parseFencedPayload` that read `ralph-question` read
    // it back, anchored on the `ralph-review` fence tag.
    const body = formatReviewComment({ phase: 2, worklist });

    const raw = extractFencedPayload(body, RALPH_REVIEW_FENCE);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ phase: 2, worklist });

    const viaShared = parseFencedPayload(body, RALPH_REVIEW_FENCE, parseReviewCommentPayload);
    expect(viaShared).toEqual({ phase: 2, worklist });
  });

  it("renders a human-readable summary outside the fence (blocking findings lead)", () => {
    const body = formatReviewComment({ phase: 1, worklist });
    const beforeFence = body.split("```" + RALPH_REVIEW_FENCE)[0]!;
    expect(beforeFence).toContain("P0");
    expect(beforeFence).toContain("race on retry");
    // Nits are shown but flagged non-blocking — gating semantics unchanged.
    expect(beforeFence.toLowerCase()).toContain("non-blocking");
  });

  it("states the phase is clean when no item gates it, and still round-trips", () => {
    const cleanish: Worklist = { items: [{ severity: "nit", title: "tidy import" }] };
    const body = formatReviewComment({ phase: 1, worklist: cleanish });
    const beforeFence = body.split("```" + RALPH_REVIEW_FENCE)[0]!;
    expect(beforeFence.toLowerCase()).toContain("clean");
    expect(parseReviewComment(body)!.worklist).toEqual(cleanish);
  });

  it("round-trips an empty (fully clean) worklist", () => {
    const body = formatReviewComment({ phase: 2, worklist: { items: [] } });
    expect(parseReviewComment(body)).toEqual({ phase: 2, worklist: { items: [] } });
  });
});

describe("parseReviewComment — non-matching bodies", () => {
  it("returns null for a comment that carries no ralph-review payload", () => {
    expect(parseReviewComment("just a human comment")).toBeNull();
    expect(isReviewComment("just a human comment")).toBe(false);
  });

  it("returns null for a malformed payload rather than throwing", () => {
    const body = ["```" + RALPH_REVIEW_FENCE, "{ not json", "```"].join("\n");
    expect(parseReviewComment(body)).toBeNull();
  });
});

describe("latestReviewComment", () => {
  function comment(id: number, body: string, author = "ralph-autopilot"): PrComment {
    return { id, author, body };
  }

  it("finds the latest ralph-review comment for a phase, with its id", () => {
    const comments: PrComment[] = [
      comment(1, "a bot comment"),
      comment(2, formatReviewComment({ phase: 1, worklist })),
      comment(3, formatReviewComment({ phase: 2, worklist })),
      comment(4, formatReviewComment({ phase: 1, worklist: { items: [] } })),
    ];

    const latest1 = latestReviewComment(comments, 1);
    expect(latest1).not.toBeNull();
    // The newest phase-1 review comment (id 4) is the live rolling comment.
    expect(latest1!.id).toBe(4);
    expect(latest1!.data.worklist.items).toHaveLength(0);

    expect(latestReviewComment(comments, 2)!.id).toBe(3);
  });

  it("returns null when no ralph-review comment exists for the phase", () => {
    expect(latestReviewComment([comment(1, "nope")], 1)).toBeNull();
  });
});
