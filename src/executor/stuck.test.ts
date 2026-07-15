/**
 * The stuck-card surface (#85): recording an `agent-stuck` terminal must also post
 * one structured `ralph-question`/heal-card comment carrying the stuck category and
 * the agent's free-text reason, so the reason a run gave up is visible on the issue
 * — not only in the daemon host's run log.
 *
 * #86 made that card **healable**: a stuck issue carrying an open stuck-card is now
 * surfaced in the GitHub-only `ralph-answer` queue (answering it re-admits a fresh
 * run with the operator's guidance). It is still NOT indexed in the SQLite open-question
 * table — that table drives *resume*, and a stuck heal *re-admits* (no run to resume).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEMORY_DB, openStore, type Store } from "../store/store";
import { FakeGitHub } from "../testing/fake-github";
import {
  escalationQuestionSchema,
  parseRalphQuestionComment,
  RALPH_QUESTION_FENCE,
} from "../review/escalation";
import { listOpenQuestions } from "../hitl/queue";
import { LABEL_AGENT_STUCK, LABEL_AWAITING_ANSWER, LABEL_REVIEW_MAXED } from "../hitl/labels";
import type { StuckCategory, StuckReport } from "./stuck-tool";
import { buildStuckCardQuestion, recordAgentStuck } from "./stuck";

const ALL_CATEGORIES: StuckCategory[] = ["fix-iterations", "no-green-build", "futility", "wall-clock"];

describe("buildStuckCardQuestion (#85)", () => {
  it("renders a valid, heal-shaped question for every stuck category", () => {
    for (const category of ALL_CATEGORIES) {
      const q = buildStuckCardQuestion({ category, reason: `reason for ${category}` });
      // Conforms to the strict escalation/ralph-question schema, so it round-trips
      // through the same parser escalate and review-maxed comments use.
      expect(() => escalationQuestionSchema.parse(q)).not.toThrow();
      // Carries the category and the agent's reason where a human (and the follow-up
      // heal path) can read them.
      expect(`${q.headline} ${q.feature}`).toContain(category);
      expect(q.whereWeStand).toContain(`reason for ${category}`);
      // Heal-style options: provide guidance and re-enable / re-scope / close.
      expect(q.options?.some((o) => /re-enable/i.test(o))).toBe(true);
      expect(q.options?.some((o) => /re-scope/i.test(o))).toBe(true);
      expect(q.options?.some((o) => /close/i.test(o))).toBe(true);
    }
  });
});

describe("recordAgentStuck stuck-card comment (#85)", () => {
  let store: Store;
  let github: FakeGitHub;

  beforeEach(() => {
    store = openStore(MEMORY_DB).forRepo("acme/widgets");
    github = new FakeGitHub();
  });
  afterEach(() => store.close());

  function setup() {
    // Post-pickup label set: `ready-for-agent` was already removed when the run was
    // claimed, so the issue carries only `afk` + `mode:*` here.
    const issue = github.seed({ number: 7, title: "Flaky thing", labels: ["afk", "mode:tdd"] });
    const run = store.upsertRun({
      issueNumber: 7,
      mode: "tdd",
      status: "running",
      branch: "ralph/7-flaky",
      worktreePath: "/wt/7",
    });
    return { issue, run };
  }

  async function record(report: StuckReport) {
    const { run } = setup();
    await recordAgentStuck(store, github, { issueNumber: 7, runId: run.id, report });
    return run;
  }

  it("posts exactly one structured comment carrying the category and reason (AC1, AC5)", async () => {
    const report: StuckReport = {
      category: "no-green-build",
      reason: "typecheck never passed after six edits to the migration",
    };
    await record(report);

    const comments = github.comments.get(7) ?? [];
    expect(comments).toHaveLength(1);
    const body = comments[0]!.body;
    expect(body).toContain("no-green-build");
    expect(body).toContain("typecheck never passed after six edits to the migration");
  });

  it("reuses the ralph-question/heal-card format and parses consistently (AC2)", async () => {
    const report: StuckReport = { category: "futility", reason: "the spec contradicts the data model" };
    await record(report);

    const body = (github.comments.get(7) ?? [])[0]!.body;
    // Same fenced payload escalate/review-maxed use.
    expect(body).toContain("```" + RALPH_QUESTION_FENCE);
    const question = parseRalphQuestionComment(body);
    expect(question).not.toBeNull();
    expect(`${question!.headline} ${question!.feature}`).toContain("futility");
    expect(question!.whereWeStand).toContain("the spec contradicts the data model");
    // Heal-style options are presented (even though answering is the follow-up).
    expect(question!.options?.some((o) => /re-enable/i.test(o))).toBe(true);
    expect(question!.options?.some((o) => /re-scope/i.test(o))).toBe(true);
    expect(question!.options?.some((o) => /close/i.test(o))).toBe(true);
  });

  it("both the self-stop set and the wall-clock kill produce the comment (AC3)", async () => {
    for (const category of ALL_CATEGORIES) {
      const github2 = new FakeGitHub();
      const store2 = openStore(MEMORY_DB).forRepo("acme/widgets");
      try {
        github2.seed({ number: 9, title: "x", labels: ["afk", "mode:tdd"] });
        const run = store2.upsertRun({
          issueNumber: 9,
          mode: "tdd",
          status: "running",
          branch: "ralph/9-x",
          worktreePath: "/wt/9",
        });
        await recordAgentStuck(store2, github2, {
          issueNumber: 9,
          runId: run.id,
          report: { category, reason: `${category} happened` },
        });
        const body = (github2.comments.get(9) ?? [])[0]!.body;
        expect(body).toContain(category);
      } finally {
        store2.close();
      }
    }
  });

  it("stays terminal on the label and unindexed in SQLite, but its card is healable via the GitHub queue (#86)", async () => {
    const run = await record({ category: "fix-iterations", reason: "looped on the same assertion" });

    // `recordAgentStuck` no longer labels imperatively: the `agent-stuck` label is a
    // level-triggered effect of the run status the `RunStuck` fact projects (issue #82,
    // ADR-0027). It sets the status — the reconciler's per-tick diff applies the label —
    // and adds no other (awaiting/heal) label.
    expect(store.getRunByIssue(7)!.status).toBe("agent-stuck");
    expect(github.addedLabels.some((l) => l.label === LABEL_AGENT_STUCK)).toBe(false);
    expect(github.issues.get(7)!.labels).not.toContain(LABEL_AWAITING_ANSWER);
    expect(github.issues.get(7)!.labels).not.toContain(LABEL_REVIEW_MAXED);

    // Not indexed in the SQLite open-question table — that table drives *resume*, and a
    // stuck heal *re-admits* a fresh run (there is no paused run to resume).
    expect(store.listOpenQuestions()).toHaveLength(0);

    // Once the reconciler diff has applied `agent-stuck` (simulated here), the GitHub-only
    // answer queue surfaces it (#86): the open stuck-card is healable, FIFO alongside
    // awaiting-answer/review-maxed, and swaps back via `agent-stuck`.
    await github.addLabel(7, LABEL_AGENT_STUCK);
    const surfaced = await listOpenQuestions(github);
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]!.issue.number).toBe(7);
    expect(surfaced[0]!.label).toBe(LABEL_AGENT_STUCK);

    // The run-log event still records the category/reason for live views (unchanged).
    const stuckEvent = store.tailLog(run.id).find((e) => e.event === "agent-stuck");
    expect(stuckEvent?.data).toMatchObject({ category: "fix-iterations" });

    // The bounded-out terminal also closed the run span on the issue stream (issue #80):
    // recordAgentStuck appends RunEnded{stuck}, asserted here through the real path.
    expect((await store.aggregateIssue(7)).state.ended).toBe(true);
  });
});
