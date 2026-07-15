import { describe, expect, it } from "vitest";
import { FakeGitHub } from "../testing/fake-github";
import {
  formatRalphQuestion,
  type EscalationQuestion,
} from "../review/escalation";
import { buildHealCardQuestion, formatHealCard } from "../review/escalation";
import { buildStuckCardQuestion } from "../executor/stuck";
import { RalphAnswerService } from "./ralph-answer";
import { formatRalphAnswer, parseRalphAnswer } from "./answer";
import { LABEL_AGENT_STUCK, LABEL_AWAITING_ANSWER, LABEL_REVIEW_MAXED, LABEL_READY } from "./labels";

const question: EscalationQuestion = {
  headline: "Delete the legacy adapter?",
  feature: "Ingestion",
  whereWeStand: "Review wants it gone.",
  decision: "Remove it or keep it behind a flag?",
  options: ["Delete it", "Keep behind a flag"],
  stakes: "One-way door for old consumers.",
  recommendation: "Keep behind a flag.",
};

/** Seed an awaiting-answer issue carrying a ralph-question comment. */
function seedEscalation(github: FakeGitHub, number: number, createdAt: string): void {
  github.seed({
    number,
    title: `Issue ${number}`,
    createdAt,
    labels: [LABEL_AWAITING_ANSWER, "afk", "mode:tdd"],
  });
  void github.postComment(number, formatRalphQuestion({ ...question, headline: `Q${number}` }));
}

describe("RalphAnswerService (AC3 — GitHub-only, no SQLite/daemon)", () => {
  it("constructs from a GitHubClient alone and serves from it", async () => {
    const github = new FakeGitHub();
    seedEscalation(github, 10, "2026-02-01T00:00:00Z");
    // No store, no executor, no worktrees — just GitHub.
    const service = new RalphAnswerService(github);

    const next = await service.next();
    expect(next!.issue.number).toBe(10);
    expect(next!.question.headline).toBe("Q10");
  });
});

describe("RalphAnswerService (AC4 — one at a time, FIFO, writes answer + swaps label)", () => {
  it("serves the oldest question first", async () => {
    const github = new FakeGitHub();
    seedEscalation(github, 12, "2026-02-03T00:00:00Z");
    seedEscalation(github, 11, "2026-02-02T00:00:00Z");
    const service = new RalphAnswerService(github);

    expect((await service.next())!.issue.number).toBe(11);
  });

  it("captures a free-text answer, writes it back, and swaps the label", async () => {
    const github = new FakeGitHub();
    seedEscalation(github, 11, "2026-02-02T00:00:00Z");
    const service = new RalphAnswerService(github);

    const served = await service.serveOne(async () => "Keep it, but log a deprecation warning");

    expect(served!.issue.number).toBe(11);
    // The answer comment is parseable and carries the typed text.
    const answer = parseRalphAnswer((github.comments.get(11) ?? []).at(-1)!.body)!;
    expect(answer).toEqual({ kind: "free-text", text: "Keep it, but log a deprecation warning" });
    // Label swapped back to ready-for-agent (re-arms the daemon).
    const labels = github.issues.get(11)!.labels;
    expect(labels).toContain(LABEL_READY);
    expect(labels).not.toContain(LABEL_AWAITING_ANSWER);
  });

  it("applies the awaiting-label → ready-for-agent swap through one patch (AC3 — no eligible window)", async () => {
    const github = new FakeGitHub();
    seedEscalation(github, 11, "2026-02-02T00:00:00Z");
    const service = new RalphAnswerService(github);

    await service.serveOne(async () => "Keep it");

    expect(github.labelPatches).toEqual([{ issue: 11, remove: [LABEL_AWAITING_ANSWER], add: [LABEL_READY] }]);
  });

  it("supports an option pick and accept-recommendation", async () => {
    const github = new FakeGitHub();
    seedEscalation(github, 11, "2026-02-02T00:00:00Z");
    const service = new RalphAnswerService(github);

    await service.serveOne(async () => "2"); // pick option 2
    const answer = parseRalphAnswer((github.comments.get(11) ?? []).at(-1)!.body)!;
    expect(answer).toEqual({ kind: "option", text: "Keep behind a flag", optionIndex: 1 });
  });

  it("serves one at a time: after answering, the next call serves the following question", async () => {
    const github = new FakeGitHub();
    seedEscalation(github, 11, "2026-02-02T00:00:00Z");
    seedEscalation(github, 12, "2026-02-03T00:00:00Z");
    const service = new RalphAnswerService(github);

    const first = await service.serveOne(async () => "");
    expect(first!.issue.number).toBe(11);
    // #11 is answered (label gone); the queue now heads on #12.
    const second = await service.serveOne(async () => "");
    expect(second!.issue.number).toBe(12);
    // Queue drained.
    expect(await service.next()).toBeNull();
  });

  it("does not re-serve a question already answered while the label lags its removal", async () => {
    const github = new FakeGitHub();
    seedEscalation(github, 11, "2026-02-02T00:00:00Z");
    // The answer was posted but the awaiting-answer label has not been swapped
    // back yet (the daemon/label-swap is lagging). The queue must treat the
    // question as answered and skip it, not serve it a second time.
    void github.postComment(11, formatRalphAnswer({ kind: "free-text", text: "Keep behind a flag" }));
    const service = new RalphAnswerService(github);

    expect(await service.next()).toBeNull();
  });

  it("returns null and does nothing when the queue is empty", async () => {
    const github = new FakeGitHub();
    const service = new RalphAnswerService(github);
    let prompted = false;
    const served = await service.serveOne(async () => {
      prompted = true;
      return "";
    });
    expect(served).toBeNull();
    expect(prompted).toBe(false);
  });

  it("submitForIssue answers the requested issue through a per-issue open-question lookup", async () => {
    const github = new FakeGitHub();
    seedEscalation(github, 11, "2026-02-02T00:00:00Z");
    github.listOpenIssues = async () => {
      throw new Error("submitForIssue must not scan the full repo queue");
    };
    const service = new RalphAnswerService(github);

    const result = await service.submitForIssue((await github.getIssue(11))!, {
      kind: "free-text",
      text: "Keep it, but log a deprecation warning",
    });

    expect(result.kind).toBe("submitted");
    const answer = parseRalphAnswer((github.comments.get(11) ?? []).at(-1)!.body)!;
    expect(answer).toEqual({ kind: "free-text", text: "Keep it, but log a deprecation warning" });
    const labels = github.issues.get(11)!.labels;
    expect(labels).toContain(LABEL_READY);
    expect(labels).not.toContain(LABEL_AWAITING_ANSWER);
    expect(github.labelPatches).toEqual([{ issue: 11, remove: [LABEL_AWAITING_ANSWER], add: [LABEL_READY] }]);
  });

  it("submitForIssue reports a resumable pause that has no open question", async () => {
    const github = new FakeGitHub();
    github.seed({ number: 40, labels: [LABEL_AWAITING_ANSWER, "afk", "mode:tdd"] });
    const service = new RalphAnswerService(github);

    const result = await service.submitForIssue((await github.getIssue(40))!, {
      kind: "free-text",
      text: "Re-admit without additional guidance",
    });

    expect(result).toEqual({ kind: "missing-open-question", label: LABEL_AWAITING_ANSWER });
    const labels = github.issues.get(40)!.labels;
    expect(labels).toContain(LABEL_AWAITING_ANSWER);
    expect(labels).not.toContain(LABEL_READY);
  });

  it("submitForIssue leaves an already-answered label-lagging pause for the caller's label plan", async () => {
    const github = new FakeGitHub();
    seedEscalation(github, 41, "2026-02-02T00:00:00Z");
    await github.postComment(41, formatRalphAnswer({ kind: "free-text", text: "Already answered" }));
    const before = github.comments.get(41)!.length;
    const service = new RalphAnswerService(github);

    const result = await service.submitForIssue((await github.getIssue(41))!, {
      kind: "free-text",
      text: "Do not post this",
    });

    expect(result).toEqual({ kind: "not-submitted" });
    expect(github.comments.get(41)!).toHaveLength(before);
    expect(github.issues.get(41)!.labels).toContain(LABEL_AWAITING_ANSWER);
  });
});

describe("RalphAnswerService (AC6 — review-maxed heal-cards flow through the same queue)", () => {
  it("serves a review-maxed heal-card and swaps that label back to ready-for-agent", async () => {
    const github = new FakeGitHub();
    github.seed({
      number: 20,
      title: "Maxed out",
      createdAt: "2026-02-05T00:00:00Z",
      labels: [LABEL_REVIEW_MAXED, "afk", "mode:tdd"],
    });
    const healInput = {
      phase: 1 as const,
      attempts: 3,
      worklist: { items: [{ severity: "P0" as const, title: "race on retry" }] },
    };
    void github.postComment(20, formatHealCard(healInput));
    const service = new RalphAnswerService(github);

    const item = await service.next();
    expect(item!.label).toBe(LABEL_REVIEW_MAXED);
    expect(item!.question.headline).toBe(buildHealCardQuestion(healInput).headline);

    await service.serveOne(async () => "Provide guidance: widen the lock");
    const labels = github.issues.get(20)!.labels;
    expect(labels).toContain(LABEL_READY);
    expect(labels).not.toContain(LABEL_REVIEW_MAXED);
  });
});

describe("RalphAnswerService (#86 — agent-stuck stuck-cards are healable through the same queue)", () => {
  /** Seed an `agent-stuck` issue carrying an open stuck-card (#85). */
  function seedStuck(github: FakeGitHub, number: number, createdAt: string, reason = "looped on the same assertion"): void {
    github.seed({
      number,
      title: `Issue ${number}`,
      createdAt,
      // Post-pickup label set: `ready-for-agent` was removed on claim; the stuck
      // terminal added `agent-stuck`.
      labels: [LABEL_AGENT_STUCK, "afk", "mode:tdd"],
    });
    void github.postComment(number, formatRalphQuestion(buildStuckCardQuestion({ category: "fix-iterations", reason })));
  }

  it("lists an agent-stuck issue carrying an open stuck-card (AC1)", async () => {
    const github = new FakeGitHub();
    seedStuck(github, 30, "2026-02-10T00:00:00Z", "the migration never type-checked");
    const service = new RalphAnswerService(github);

    const item = await service.next();
    expect(item!.issue.number).toBe(30);
    expect(item!.label).toBe(LABEL_AGENT_STUCK);
    // The surfaced question is the stuck-card — its reason is readable to the operator.
    expect(item!.question.whereWeStand).toContain("the migration never type-checked");
  });

  it("orders stuck-cards FIFO alongside awaiting-answer/review-maxed (AC1)", async () => {
    const github = new FakeGitHub();
    // A stuck issue (older) and an escalation (newer) — oldest first, regardless of kind.
    seedStuck(github, 31, "2026-02-09T00:00:00Z");
    seedEscalation(github, 32, "2026-02-11T00:00:00Z");
    const service = new RalphAnswerService(github);

    const queue = await service.list();
    expect(queue.map((q) => q.issue.number)).toEqual([31, 32]);
  });

  it("does NOT surface a bare agent-stuck issue that carries no stuck-card (AC6)", async () => {
    const github = new FakeGitHub();
    // An `agent-stuck` terminal with no stuck-card (e.g. a crash-discarded orphan).
    github.seed({ number: 33, labels: [LABEL_AGENT_STUCK, "afk", "mode:tdd"] });
    const service = new RalphAnswerService(github);

    expect(await service.next()).toBeNull();
  });

  it("answering a stuck-card swaps agent-stuck → ready-for-agent through one patch (AC2)", async () => {
    const github = new FakeGitHub();
    seedStuck(github, 34, "2026-02-10T00:00:00Z");
    const service = new RalphAnswerService(github);

    const served = await service.serveOne(async () => "Regenerate the lockfile, then retry the migration");
    expect(served!.issue.number).toBe(34);

    // The answer comment is durable and parseable.
    const answer = parseRalphAnswer((github.comments.get(34) ?? []).at(-1)!.body)!;
    expect(answer).toEqual({ kind: "free-text", text: "Regenerate the lockfile, then retry the migration" });

    // The label patch swaps agent-stuck for ready-for-agent (re-admit, never picked up
    // as a stale paused run).
    const labels = github.issues.get(34)!.labels;
    expect(labels).toContain(LABEL_READY);
    expect(labels).not.toContain(LABEL_AGENT_STUCK);
    expect(github.labelPatches).toEqual([{ issue: 34, remove: [LABEL_AGENT_STUCK], add: [LABEL_READY] }]);

    // Once answered, the queue no longer serves it (AC5 — one at a time, drains).
    expect(await service.next()).toBeNull();
  });
});
