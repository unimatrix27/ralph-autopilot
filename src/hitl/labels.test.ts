import { describe, expect, it } from "vitest";
import {
  LABEL_AGENT_STUCK,
  LABEL_AWAITING_ANSWER,
  LABEL_REVIEW_MAXED,
  consequenceForAnswerableLabel,
  isAwaitingAnswerLabel,
} from "./labels";

describe("consequenceForAnswerableLabel (AC3 — what answering does)", () => {
  it("resumes from WIP for the answerable awaiting labels", () => {
    expect(consequenceForAnswerableLabel(LABEL_AWAITING_ANSWER)).toBe("resume-from-wip");
    expect(consequenceForAnswerableLabel(LABEL_REVIEW_MAXED)).toBe("resume-from-wip");
  });

  it("re-admits a fresh run for an agent-stuck stuck-card", () => {
    expect(consequenceForAnswerableLabel(LABEL_AGENT_STUCK)).toBe("readmit-fresh");
  });
});

describe("isAwaitingAnswerLabel", () => {
  it("recognizes the resume-on-answer labels from the canonical tuple", () => {
    expect(isAwaitingAnswerLabel(LABEL_AWAITING_ANSWER)).toBe(true);
    expect(isAwaitingAnswerLabel(LABEL_REVIEW_MAXED)).toBe(true);
    expect(isAwaitingAnswerLabel(LABEL_AGENT_STUCK)).toBe(false);
  });
});
