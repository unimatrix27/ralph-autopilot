import { describe, expect, it } from "vitest";
import { renderQuestion } from "./render";
import { LABEL_AGENT_STUCK, LABEL_AWAITING_ANSWER, LABEL_REVIEW_MAXED } from "./labels";
import type { OpenQuestionItem } from "./queue";
import type { Issue } from "../github/types";

const issue: Issue = {
  number: 4,
  title: "HITL",
  body: "",
  state: "OPEN",
  labels: [LABEL_AWAITING_ANSWER],
  createdAt: "2026-02-01T00:00:00Z",
};

const base: OpenQuestionItem = {
  issue,
  label: LABEL_AWAITING_ANSWER,
  question: {
    headline: "Delete the legacy adapter?",
    feature: "Ingestion",
    whereWeStand: "Review wants it gone.",
    decision: "Remove it or keep it behind a flag?",
    options: ["Delete it", "Keep behind a flag"],
    stakes: "One-way door for old consumers.",
    recommendation: "Keep behind a flag.",
  },
};

describe("renderQuestion", () => {
  it("leads with stakes and numbers the options for picking", () => {
    const out = renderQuestion(base);
    expect(out).toContain("#4 · HITL");
    expect(out).toContain("STAKES:");
    expect(out).toContain("One-way door for old consumers.");
    expect(out).toContain("1. Delete it");
    expect(out).toContain("2. Keep behind a flag");
  });

  it("tags a review-maxed heal-card and tolerates a question with no options", () => {
    const out = renderQuestion({
      ...base,
      label: LABEL_REVIEW_MAXED,
      question: { ...base.question, options: undefined },
    });
    expect(out).toContain("review-maxed / heal-card");
    expect(out).not.toContain("Options:");
  });

  it("tags an agent-stuck stuck-card so the operator knows it heals by re-admission (#86)", () => {
    const out = renderQuestion({ ...base, label: LABEL_AGENT_STUCK });
    expect(out).toContain("agent-stuck / stuck-card");
  });
});
