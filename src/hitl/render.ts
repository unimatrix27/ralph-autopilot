/**
 * Render an open question for the `ralph-answer` terminal — the operator-facing
 * view of a `ralph-question` (DESIGN §6). `stakes` leads, because the operator's
 * attention is the system's scarcest resource: the up-a-level consequence is what
 * lets them rule without reloading the deep technical context.
 */

import { LABEL_AGENT_STUCK, LABEL_AWAITING_ANSWER, LABEL_REVIEW_MAXED } from "./labels";
import type { OpenQuestionItem } from "./queue";

/** The operator-facing tag for each answerable label — what the question is. */
const LABEL_TAG: Record<OpenQuestionItem["label"], string> = {
  [LABEL_AWAITING_ANSWER]: "escalation",
  [LABEL_REVIEW_MAXED]: "review-maxed / heal-card",
  [LABEL_AGENT_STUCK]: "agent-stuck / stuck-card",
};

/** Render one question as a plain-text block, options numbered for picking. */
export function renderQuestion(item: OpenQuestionItem): string {
  const { issue, question, label } = item;
  const tag = LABEL_TAG[label];
  const lines = [
    "",
    "────────────────────────────────────────────────────────",
    `#${issue.number} · ${issue.title}  [${tag}]`,
    "────────────────────────────────────────────────────────",
    `▸ ${question.headline}`,
    "",
    `Feature:        ${question.feature}`,
    `Where we stand: ${question.whereWeStand}`,
    `Decision:       ${question.decision}`,
    "",
    `STAKES:         ${question.stakes}`,
    "",
    `Recommendation: ${question.recommendation}`,
  ];
  if (question.options && question.options.length > 0) {
    lines.push("", "Options:");
    question.options.forEach((opt, i) => lines.push(`  ${i + 1}. ${opt}`));
  }
  lines.push("");
  return lines.join("\n");
}
