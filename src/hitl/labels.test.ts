import { describe, expect, it } from "vitest";
import {
  ANSWERABLE_LABELS,
  LABEL_AGENT_STUCK,
  LABEL_AWAITING_ANSWER,
  LABEL_REVIEW_MAXED,
  consequenceForAnswerableLabel,
  isAwaitingAnswerLabel,
  isTerminalAttentionLabel,
} from "./labels";

describe("ANSWERABLE_LABELS (ADR-0042 §7 — `agent-stuck` is a terminal, not an answerable state)", () => {
  it("serves exactly the resume-on-answer pauses", () => {
    expect([...ANSWERABLE_LABELS]).toEqual([LABEL_AWAITING_ANSWER, LABEL_REVIEW_MAXED]);
  });

  it("excludes the master-authored `agent-stuck` terminal", () => {
    // A completed master adjudication selects `agent-stuck`; answering it would silently
    // un-terminalize that adjudication into a fresh worker run with no master involvement.
    expect([...ANSWERABLE_LABELS]).not.toContain(LABEL_AGENT_STUCK);
    expect(isTerminalAttentionLabel(LABEL_AGENT_STUCK)).toBe(true);
    expect(isTerminalAttentionLabel(LABEL_AWAITING_ANSWER)).toBe(false);
    expect(isTerminalAttentionLabel(LABEL_REVIEW_MAXED)).toBe(false);
  });
});

describe("consequenceForAnswerableLabel (AC3 — what answering does)", () => {
  it("resumes from WIP for every answerable label — the only consequence left", () => {
    expect(consequenceForAnswerableLabel(LABEL_AWAITING_ANSWER)).toBe("resume-from-wip");
    expect(consequenceForAnswerableLabel(LABEL_REVIEW_MAXED)).toBe("resume-from-wip");
  });
});

describe("isAwaitingAnswerLabel", () => {
  it("recognizes the resume-on-answer labels from the canonical tuple", () => {
    expect(isAwaitingAnswerLabel(LABEL_AWAITING_ANSWER)).toBe(true);
    expect(isAwaitingAnswerLabel(LABEL_REVIEW_MAXED)).toBe(true);
    expect(isAwaitingAnswerLabel(LABEL_AGENT_STUCK)).toBe(false);
  });
});
