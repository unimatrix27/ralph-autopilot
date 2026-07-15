import { describe, expect, it } from "vitest";
import type { OpenQuestionItem } from "../hitl/queue";
import type { EscalationQuestion } from "../review/escalation";
import type { Run } from "../store/types";
import type { InboxResponse } from "./contract";
import { answerRequestBodySchema, inboxPhaseLabel, inboxResponseSchema, inboxResumeTargetText } from "./contract";
import {
  toInboxCard,
  toInboxResponse,
} from "./inbox";

const question: EscalationQuestion = {
  headline: "Delete the legacy adapter?",
  feature: "Ingestion",
  whereWeStand: "Review wants it gone.",
  decision: "Remove it or keep it behind a flag?",
  options: ["Delete it", "Keep behind a flag"],
  stakes: "One-way door for old consumers.",
  recommendation: "Keep behind a flag.",
};

/** Build an open-question item carrying `label` and an optional review `phase`. */
function item(
  number: number,
  label: OpenQuestionItem["label"],
  createdAt: string,
  phase: OpenQuestionItem["phase"] = null,
): OpenQuestionItem {
  return {
    issue: { number, title: `Issue ${number}`, body: "", state: "OPEN", labels: [label], createdAt },
    question,
    label,
    phase,
  };
}

function run(number: number, over: Partial<Run> = {}): Run {
  return {
    id: number,
    repo: "owner/a",
    issueNumber: number,
    mode: "tdd",
    status: "awaiting-answer",
    branch: `ralph/${number}-x`,
    worktreePath: null,
    prNumber: 1000 + number,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

describe("inbox phase copy helpers (AC3 — phase 0 is the CI gate/fix path)", () => {
  it("renders phase 0 as the CI gate/fix loop, not phase-0 review", () => {
    expect(inboxPhaseLabel(0)).toBe("CI gate");
    expect(inboxResumeTargetText(0)).toBe("re-enters the CI gate/fix loop from its checkpointed WIP");
  });

  it("renders carried review phases and no-marker resumes precisely", () => {
    expect(inboxPhaseLabel(1)).toBe("phase 1");
    expect(inboxResumeTargetText(1)).toBe("re-enters phase-1 review from its checkpointed WIP");
    expect(inboxResumeTargetText(null)).toBe("resumes the agent from its checkpointed WIP branch");
  });
});

describe("answerRequestBodySchema (AC2 — three wire affordances)", () => {
  it("rejects malformed kind/body combinations at the contract edge", () => {
    expect(answerRequestBodySchema.safeParse({ repo: "o/r", issue: 1, kind: "option" }).success).toBe(false);
    expect(answerRequestBodySchema.safeParse({ repo: "o/r", issue: 1, kind: "free-text" }).success).toBe(false);
    expect(
      answerRequestBodySchema.safeParse({ repo: "o/r", issue: 1, kind: "accept-recommendation", text: "extra" }).success,
    ).toBe(false);
  });
});

describe("toInboxCard (AC1/AC3 — structured card with consequence + deep-link enrichment)", () => {
  it("derives the consequence from the label and threads the review phase", () => {
    const card = toInboxCard({ item: item(11, "review-maxed", "2026-02-02T00:00:00Z", 1), repo: "owner/a", run: undefined });
    expect(card.attentionLabel).toBe("review-maxed");
    expect(card.consequence).toBe("resume-from-wip");
    expect(card.phase).toBe(1);
    expect(card.question.stakes).toBe(question.stakes);
    expect(card.question.recommendation).toBe(question.recommendation);
    // A card always sits in the "attention" surface; its affordance is resolved from the catalog.
    expect(card.powerActionSurface).toBe("attention");
  });

  it("enriches with the run's runId / branch / PR for deep links", () => {
    const card = toInboxCard({ item: item(11, "awaiting-answer", "2026-02-02T00:00:00Z"), repo: "owner/a", run: run(11) });
    expect(card.run).toEqual({ runId: "11", branch: "ralph/11-x", prNumber: 1011 });
  });

  it("degrades to a null run when no run row exists (a bare stuck-card)", () => {
    const card = toInboxCard({ item: item(11, "agent-stuck", "2026-02-02T00:00:00Z"), repo: "owner/a", run: undefined });
    expect(card.attentionLabel).toBe("agent-stuck");
    expect(card.consequence).toBe("readmit-fresh");
    expect(card.run).toBeNull();
  });
});

describe("toInboxResponse (AC1 — oldest-first across repos, filter echoed)", () => {
  const now = (): Date => new Date("2026-06-22T00:00:00.000Z");

  it("orders cards oldest-first across repos and is contract-valid", () => {
    const entries = [
      // Newer escalation on owner/a.
      { item: item(31, "awaiting-answer", "2026-02-11T00:00:00Z"), repo: "owner/a", run: run(31) },
      // Older stuck-card on owner/b.
      { item: item(30, "agent-stuck", "2026-02-09T00:00:00Z"), repo: "owner/b", run: undefined },
    ];
    const res: InboxResponse = toInboxResponse(entries, {
      now,
      repos: ["owner/a", "owner/b"],
      reconcileIntervalSeconds: 30,
      priorityLabelsFor: (repo) => (repo === "owner/a" ? ["priority:p0"] : []),
    });
    expect(inboxResponseSchema.safeParse(res).success).toBe(true);
    expect(res.cards.map((c) => [c.repo, c.issue])).toEqual([
      ["owner/b", 30],
      ["owner/a", 31],
    ]);
    expect(res.repos).toEqual(["owner/a", "owner/b"]);
    expect(res.repo).toBeNull();
    expect(res.reconcileIntervalSeconds).toBe(30);
    // The per-repo affordance lives once in the catalog, keyed by repo + the "attention" surface.
    expect(res.cards[0]!.powerActionSurface).toBe("attention");
    expect(res.powerActions["owner/b"]?.attention?.priorityLabels).toEqual([]);
    expect(res.powerActions["owner/a"]?.attention?.priorityLabels).toEqual(["priority:p0"]);
  });

  it("echoes the active repo filter while preserving the full repo list", () => {
    const res = toInboxResponse([], {
      now,
      repos: ["owner/a", "owner/b", "owner/idle"],
      repo: "owner/a",
      reconcileIntervalSeconds: 30,
    });
    expect(res.repo).toBe("owner/a");
    expect(res.repos).toEqual(["owner/a", "owner/b", "owner/idle"]);
  });
});
