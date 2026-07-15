import { describe, expect, it } from "vitest";
import {
  formatRalphAnswer,
  isRalphAnswerComment,
  latestAnswerAfter,
  parseRalphAnswer,
  RALPH_ANSWER_FENCE,
  resolveAnswer,
  resolveStructuredAnswer,
} from "./answer";
import type { EscalationQuestion } from "../review/escalation";
import type { PrComment } from "../github/types";

const question: EscalationQuestion = {
  headline: "Delete the legacy adapter?",
  feature: "Ingestion",
  whereWeStand: "Review wants it gone.",
  decision: "Remove it or keep it behind a flag?",
  options: ["Delete it", "Keep behind a flag"],
  stakes: "One-way door for old consumers.",
  recommendation: "Keep behind a flag.",
};

describe("resolveAnswer (AC4 — three ways to answer)", () => {
  it("accepts the recommendation on empty input", () => {
    expect(resolveAnswer(question, "")).toEqual({
      kind: "accept-recommendation",
      text: "Keep behind a flag.",
    });
  });

  it("accepts the recommendation on an explicit accept token", () => {
    for (const token of ["r", "R", "recommend", "accept"]) {
      expect(resolveAnswer(question, token).kind).toBe("accept-recommendation");
    }
  });

  it("picks an option by its 1-based number", () => {
    expect(resolveAnswer(question, "1")).toEqual({
      kind: "option",
      text: "Delete it",
      optionIndex: 0,
    });
    expect(resolveAnswer(question, "2")).toEqual({
      kind: "option",
      text: "Keep behind a flag",
      optionIndex: 1,
    });
  });

  it("treats an out-of-range number as free text", () => {
    expect(resolveAnswer(question, "9")).toEqual({ kind: "free-text", text: "9" });
  });

  it("treats anything else as free text, used verbatim", () => {
    expect(resolveAnswer(question, "Keep it but log a deprecation warning")).toEqual({
      kind: "free-text",
      text: "Keep it but log a deprecation warning",
    });
  });

  it("picks an option even with no options when the index is out of range (free text)", () => {
    const noOptions = { ...question, options: undefined };
    expect(resolveAnswer(noOptions, "1")).toEqual({ kind: "free-text", text: "1" });
  });
});

describe("resolveStructuredAnswer (AC2 — explicit answer choices)", () => {
  it("accept-recommendation resolves directly to the live recommendation", () => {
    expect(resolveStructuredAnswer(question, { kind: "accept-recommendation" })).toEqual({
      kind: "accept-recommendation",
      text: "Keep behind a flag.",
    });
  });

  it("option resolves directly to the live chosen option text", () => {
    expect(resolveStructuredAnswer(question, { kind: "option", optionIndex: 1 })).toEqual({
      kind: "option",
      text: "Keep behind a flag",
      optionIndex: 1,
    });
  });

  it("free-text stays verbatim", () => {
    expect(resolveStructuredAnswer(question, { kind: "free-text", text: "log a deprecation first" })).toEqual({
      kind: "free-text",
      text: "log a deprecation first",
    });
  });

  it("keeps a colliding free-text value verbatim (no re-derivation to option/accept)", () => {
    // The operator picked the free-text box, so what they typed is authoritative — even when it
    // collides with resolveAnswer's raw-input grammar (a bare option number, or r/accept/recommend).
    expect(resolveStructuredAnswer(question, { kind: "free-text", text: "1" })).toEqual({
      kind: "free-text",
      text: "1",
    });
    expect(resolveStructuredAnswer(question, { kind: "free-text", text: "2" })).toEqual({
      kind: "free-text",
      text: "2",
    });
    expect(resolveStructuredAnswer(question, { kind: "free-text", text: "r" })).toEqual({
      kind: "free-text",
      text: "r",
    });
    expect(resolveStructuredAnswer(question, { kind: "free-text", text: "accept" })).toEqual({
      kind: "free-text",
      text: "accept",
    });
  });

  it("rejects an option answer whose index is out of range", () => {
    expect(resolveStructuredAnswer(question, { kind: "option", optionIndex: 5 })).toEqual({
      kind: "invalid-answer",
      error: "optionIndex 5 is out of range (0–1).",
    });
  });

  it("rejects an option answer against a question with no options", () => {
    const noOptions: EscalationQuestion = { ...question, options: undefined };
    expect(resolveStructuredAnswer(noOptions, { kind: "option", optionIndex: 0 })).toEqual({
      kind: "invalid-answer",
      error: "This question has no options to pick.",
    });
  });

  it("rejects an empty free-text answer", () => {
    expect(resolveStructuredAnswer(question, { kind: "free-text", text: "   " })).toEqual({
      kind: "invalid-answer",
      error: "A free-text answer requires non-empty text.",
    });
  });

  it("keeps non-empty free-text whitespace verbatim", () => {
    expect(resolveStructuredAnswer(question, { kind: "free-text", text: "  do the thing  " })).toEqual({
      kind: "free-text",
      text: "  do the thing  ",
    });
  });
});

describe("ralph-answer comment format", () => {
  it("round-trips an answer through its fenced payload", () => {
    const answer = resolveAnswer(question, "1");
    const body = formatRalphAnswer(answer);
    expect(body).toContain("```" + RALPH_ANSWER_FENCE);
    expect(isRalphAnswerComment(body)).toBe(true);
    expect(parseRalphAnswer(body)).toEqual(answer);
  });

  it("parses null from a comment with no answer fence", () => {
    expect(parseRalphAnswer("just a normal comment")).toBeNull();
    expect(isRalphAnswerComment("just a normal comment")).toBe(false);
  });
});

describe("latestAnswerAfter (canonical answer correlation)", () => {
  const answerBody = (text: string): string => formatRalphAnswer({ kind: "free-text", text });
  const comment = (id: number, body: string): PrComment => ({ id, author: "operator", body });

  it("returns the newest ralph-answer that post-dates the question's comment", () => {
    const comments: PrComment[] = [
      comment(10, answerBody("stale answer to a prior question")),
      comment(20, "## ralph-question for this run"),
      comment(30, answerBody("first reply")),
      comment(40, answerBody("corrected reply")),
    ];
    expect(latestAnswerAfter(comments, 20)).toEqual({ kind: "free-text", text: "corrected reply" });
  });

  it("ignores answers at or before the question's comment id", () => {
    const comments: PrComment[] = [
      comment(20, answerBody("answer exactly at the question id")),
      comment(15, answerBody("answer before the question")),
    ];
    expect(latestAnswerAfter(comments, 20)).toBeNull();
  });

  it("falls back to the newest answer when the question id is null (legacy)", () => {
    const comments: PrComment[] = [
      comment(10, answerBody("older")),
      comment(20, answerBody("newest")),
    ];
    expect(latestAnswerAfter(comments, null)).toEqual({ kind: "free-text", text: "newest" });
  });

  it("returns null when no parseable ralph-answer post-dates the question", () => {
    const comments: PrComment[] = [comment(30, "a plain follow-up comment, no answer fence")];
    expect(latestAnswerAfter(comments, 20)).toBeNull();
  });
});
