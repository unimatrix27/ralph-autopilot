/**
 * The `ralph-answer` comment format and the resolution of a typed reply into a
 * structured answer (CONTEXT: ralph-question / ralph-answer; ADR-0007).
 *
 * The operator answers an open `ralph-question` in one of three ways — free
 * text, picking one of the question's `options`, or accepting its
 * `recommendation`. Whichever they choose collapses to a single resolved text
 * the daemon injects when it resumes the agent. The reply is written back as a
 * fenced `ralph-answer` comment: a human-readable summary plus a machine-parseable
 * JSON payload, mirroring `ralph-question` so the daemon can read it back.
 */

import { hasFencedPayload, parseFencedPayload, renderFencedPayload } from "../core/fenced-payload";
import type { PrComment } from "../github/types";
import {
  parsePhaseMarker,
  parseRalphQuestionComment,
  RALPH_QUESTION_FENCE,
  type EscalationQuestion,
} from "../review/escalation";
import type { Phase } from "../store/types";

/** How the operator answered a `ralph-question`. */
export type AnswerKind = "free-text" | "option" | "accept-recommendation";

/** A structured answer to an escalation. `text` is what gets injected on resume. */
export interface RalphAnswer {
  kind: AnswerKind;
  /** The resolved answer text the agent is resumed with. */
  text: string;
  /** For `option`, the zero-based index of the chosen option. */
  optionIndex?: number;
}

/**
 * A UI/control-surface answer choice after transport-only envelope fields have been stripped.
 *
 * This is distinct from {@link resolveAnswer}'s raw CLI grammar: free text here is always the
 * operator's explicit free-text choice and is never re-derived into an option pick or recommendation
 * accept just because it happens to look like `1`, `r`, or `accept`.
 */
export type StructuredAnswerChoice =
  | { kind: "accept-recommendation" }
  | { kind: "option"; optionIndex: number }
  | { kind: "free-text"; text: string };

export type StructuredAnswerResolution = RalphAnswer | { kind: "invalid-answer"; error: string };

/** The fence language tag that marks a `ralph-answer` comment. */
export const RALPH_ANSWER_FENCE = "ralph-answer";

/**
 * Resolve a line of operator input against a question into a structured answer:
 *
 *   - empty input, or `r`/`recommend`/`accept` → accept the recommendation;
 *   - a bare 1-based index into `options` → pick that option;
 *   - anything else → free text, used verbatim.
 *
 * Pure and total: it never throws (an out-of-range or non-numeric token is just
 * treated as free text), so the CLI loop can hand it raw input directly.
 */
export function resolveAnswer(question: EscalationQuestion, rawInput: string): RalphAnswer {
  const input = rawInput.trim();

  if (input === "" || /^(r|recommend|recommendation|accept)$/i.test(input)) {
    return { kind: "accept-recommendation", text: question.recommendation };
  }

  const options = question.options ?? [];
  if (/^\d+$/.test(input)) {
    const index = Number(input) - 1;
    const choice = options[index];
    if (choice !== undefined) {
      return { kind: "option", text: choice, optionIndex: index };
    }
  }

  return { kind: "free-text", text: input };
}

/**
 * Resolve and validate an explicit structured answer choice against the canonical question.
 *
 * `accept-recommendation` and `option` are resolved from the live question; `free-text` is taken
 * verbatim so a control-surface text box can submit values that collide with the raw CLI grammar
 * without changing operator intent.
 */
export function resolveStructuredAnswer(
  question: EscalationQuestion,
  choice: StructuredAnswerChoice,
): StructuredAnswerResolution {
  switch (choice.kind) {
    case "accept-recommendation":
      return { kind: "accept-recommendation", text: question.recommendation };
    case "option": {
      const options = question.options ?? [];
      if (options.length === 0) {
        return { kind: "invalid-answer", error: "This question has no options to pick." };
      }
      const picked = options[choice.optionIndex];
      if (picked === undefined) {
        return {
          kind: "invalid-answer",
          error: `optionIndex ${choice.optionIndex} is out of range (0–${options.length - 1}).`,
        };
      }
      return { kind: "option", text: picked, optionIndex: choice.optionIndex };
    }
    case "free-text":
      if (choice.text.trim().length === 0) {
        return { kind: "invalid-answer", error: "A free-text answer requires non-empty text." };
      }
      return { kind: "free-text", text: choice.text };
  }
}

/**
 * Render a resolved answer as a `ralph-answer` comment body: a short prose
 * summary outside the fence, the JSON payload inside it.
 */
export function formatRalphAnswer(answer: RalphAnswer): string {
  const heading =
    answer.kind === "accept-recommendation"
      ? "Accepted the recommendation."
      : answer.kind === "option"
        ? `Picked option ${(answer.optionIndex ?? 0) + 1}.`
        : "Answer:";
  return [
    "## ralph-answer",
    "",
    `${heading}`,
    "",
    answer.text,
    "",
    "<!-- The structured payload below is parsed by ralph-autopilot on resume. -->",
    renderFencedPayload(RALPH_ANSWER_FENCE, answer),
  ].join("\n");
}

/**
 * Parse the structured answer out of a `ralph-answer` comment body, or `null` if
 * the comment carries no parseable answer.
 */
export function parseRalphAnswer(body: string): RalphAnswer | null {
  return parseFencedPayload(body, RALPH_ANSWER_FENCE, (value) => {
    const partial = value as Partial<RalphAnswer>;
    if (typeof partial.text !== "string" || typeof partial.kind !== "string") {
      throw new Error("malformed ralph-answer payload");
    }
    return partial as RalphAnswer;
  });
}

/** Whether a comment body is a `ralph-answer` comment. */
export function isRalphAnswerComment(body: string): boolean {
  return hasFencedPayload(body, RALPH_ANSWER_FENCE);
}

/** Whether a comment body is a `ralph-question` comment. */
export function isRalphQuestionComment(body: string): boolean {
  return hasFencedPayload(body, RALPH_QUESTION_FENCE);
}

/**
 * The latest (live) `ralph-question` in a comment thread, with its comment id and
 * any recovered review `phase`, or `null` if none is parseable. The label is the
 * index: the last parseable `ralph-question` comment is the live one, so a
 * re-escalation in the same thread supersedes earlier questions. This is the single
 * home of that scan — both the answer queue ({@link import("./queue").listOpenQuestions})
 * and startup rehydration derive the live question through here, so the
 * question-comment format cannot drift between the two paths.
 *
 * `phase` is recovered from a review-origin pause's hidden marker (issue #9) — a
 * review-loop escalation or a `review-maxed` heal-card alike; it is `null` only for
 * an impl-agent escalation, which carries no marker.
 */
export function latestRalphQuestion(
  comments: PrComment[],
): { question: EscalationQuestion; commentId: number; phase: Phase | null } | null {
  let found: { question: EscalationQuestion; commentId: number; phase: Phase | null } | null = null;
  for (const comment of comments) {
    if (!isRalphQuestionComment(comment.body)) {
      continue;
    }
    const question = parseRalphQuestionComment(comment.body);
    if (question) {
      found = { question, commentId: comment.id, phase: parsePhaseMarker(comment.body) };
    }
  }
  return found;
}

/**
 * The latest `ralph-answer` in a comment thread that *post-dates* a given
 * question's comment — the operator's reply to that question — or `null` if none
 * has been posted yet. Correlating by comment id (not merely "newest comment")
 * keeps a stale answer from an earlier heal cycle out: a run only ever has one
 * open question at a time, so "answer newer than this question" is an exact match
 * even when the thread has accumulated prior answers across cycles (issue #10).
 *
 * `questionCommentId` is `null` for legacy resume contexts written before the id
 * was recorded; there we fall back to the newest answer (no worse than before).
 *
 * The companion to {@link latestRalphQuestion}: both resume detection and
 * stuck-heal re-admission derive the correlated answer through here, so the
 * id-vs-position correlation cannot drift between those paths.
 */
export function latestAnswerAfter(
  comments: PrComment[],
  questionCommentId: number | null,
): RalphAnswer | null {
  let answer: RalphAnswer | null = null;
  for (const comment of comments) {
    if (questionCommentId !== null && comment.id <= questionCommentId) {
      continue; // a stale answer that pre-dates the current question — skip it.
    }
    if (isRalphAnswerComment(comment.body)) {
      const parsed = parseRalphAnswer(comment.body);
      if (parsed) {
        answer = parsed;
      }
    }
  }
  return answer;
}
