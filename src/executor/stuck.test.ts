/**
 * The stuck-card surface (#85): recording an `agent-stuck` terminal must also post one
 * structured `ralph-question`-shaped comment carrying the stuck category and the agent's
 * free-text reason, so the reason a run gave up is visible on the issue — not only in the
 * daemon host's run log.
 *
 * The triage cutover (ADR-0042 / issue #43) settled what that card *is*: **evidence, never a
 * question**. `agent-stuck` is a master-selected terminal, so the card is not answerable —
 * `openQuestionForIssue` types such an issue `terminal` and `listOpenQuestions` omits it
 * entirely, and no answer can re-admit the run. The #86 heal lane that once served these cards
 * is retired. The card must still be posted and still parse: a master's conclusion has to stay
 * readable on the issue for the human who eventually reads it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEMORY_DB, openStore, type Store } from "../store/store";
import { FakeGitHub } from "../testing/fake-github";
import {
  escalationQuestionSchema,
  parseRalphQuestionComment,
  RALPH_QUESTION_FENCE,
} from "../review/escalation";
import { listOpenQuestions, openQuestionForIssue } from "../hitl/queue";
import { LABEL_AGENT_STUCK, LABEL_AWAITING_ANSWER, LABEL_REVIEW_MAXED } from "../hitl/labels";
import type { StuckCategory, StuckReport } from "./stuck-tool";
import {
  buildNoPrCardQuestion,
  buildStuckCardQuestion,
  recordAgentStuck,
  recordFinishedWithoutPr,
  STUCK_CARD_FEATURE,
} from "./stuck";

const ALL_CATEGORIES: StuckCategory[] = ["fix-iterations", "no-green-build", "futility", "wall-clock"];

describe("buildStuckCardQuestion (#85)", () => {
  it("renders a valid, self-explaining card for every stuck category", () => {
    for (const category of ALL_CATEGORIES) {
      const q = buildStuckCardQuestion({ category, reason: `reason for ${category}` });
      // Conforms to the strict escalation/ralph-question schema, so it round-trips
      // through the same parser escalate and review-maxed comments use.
      expect(() => escalationQuestionSchema.parse(q)).not.toThrow();
      // Carries the category and the agent's reason where a human (and the follow-up
      // heal path) can read them.
      expect(`${q.headline} ${q.feature}`).toContain(category);
      expect(q.whereWeStand).toContain(`reason for ${category}`);
      // The operator's moves are on the ISSUE (re-enable / re-scope / close) — never
      // "answer this card", which `ralph-answer` refuses (ADR-0042 §7).
      expect(q.options?.some((o) => /re-enable/i.test(o))).toBe(true);
      expect(q.options?.some((o) => /re-scope/i.test(o))).toBe(true);
      expect(q.options?.some((o) => /close/i.test(o))).toBe(true);
      expect(q.options?.some((o) => /heal|answer/i.test(o))).toBe(false);
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

  it("reuses the ralph-question format and parses consistently (AC2)", async () => {
    const report: StuckReport = { category: "futility", reason: "the spec contradicts the data model" };
    await record(report);

    const body = (github.comments.get(7) ?? [])[0]!.body;
    // Same fenced payload escalate/review-maxed use.
    expect(body).toContain("```" + RALPH_QUESTION_FENCE);
    const question = parseRalphQuestionComment(body);
    expect(question).not.toBeNull();
    expect(`${question!.headline} ${question!.feature}`).toContain("futility");
    expect(question!.whereWeStand).toContain("the spec contradicts the data model");
    // The on-issue moves survive the round-trip.
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

  it("stays terminal and unindexed, and its card is NEVER answerable (ADR-0042 §7)", async () => {
    const run = await record({ category: "fix-iterations", reason: "looped on the same assertion" });

    // `recordAgentStuck` no longer labels imperatively: the `agent-stuck` label is a
    // level-triggered effect of the run status the `RunStuck` fact projects (issue #82,
    // ADR-0027). It sets the status — the reconciler's per-tick diff applies the label —
    // and adds no other (awaiting) label.
    expect(store.getRunByIssue(7)!.status).toBe("agent-stuck");
    expect(github.addedLabels.some((l) => l.label === LABEL_AGENT_STUCK)).toBe(false);
    expect(github.issues.get(7)!.labels).not.toContain(LABEL_AWAITING_ANSWER);
    expect(github.issues.get(7)!.labels).not.toContain(LABEL_REVIEW_MAXED);

    // Not indexed in the SQLite open-question table — that table drives *resume*, and a
    // terminal has no paused run to resume.
    expect(store.listOpenQuestions()).toHaveLength(0);

    // …and once the reconciler diff has applied `agent-stuck` (simulated here), the
    // GitHub-only answer queue does not surface it either. The #86 heal lane is retired
    // (issue #43): a card on a terminal is the conclusion of an adjudication, and serving it
    // would let an answer un-terminalize one. The queue says so by *type* rather than by
    // silence, so `ralph-answer` can refuse it informatively.
    await github.addLabel(7, LABEL_AGENT_STUCK);
    expect(await listOpenQuestions(github)).toEqual([]);
    expect(await openQuestionForIssue(github, github.issues.get(7)!)).toEqual({
      kind: "terminal",
      label: LABEL_AGENT_STUCK,
    });

    // The card itself is still on the issue — evidence a human can read, which is the whole
    // point of posting it (#85). Retiring the heal lane must not retire the explanation.
    const card = parseRalphQuestionComment((github.comments.get(7) ?? [])[0]!.body);
    expect(card!.feature).toBe(STUCK_CARD_FEATURE);
    expect(card!.whereWeStand).toContain("looped on the same assertion");

    // The run-log event still records the category/reason for live views (unchanged).
    const stuckEvent = store.tailLog(run.id).find((e) => e.event === "agent-stuck");
    expect(stuckEvent?.data).toMatchObject({ category: "fix-iterations" });

    // The bounded-out terminal also closed the run span on the issue stream (issue #80):
    // recordAgentStuck appends RunEnded{stuck}, asserted here through the real path.
    expect((await store.aggregateIssue(7)).state.ended).toBe(true);
  });
});

describe("buildNoPrCardQuestion (finished-without-a-PR terminal)", () => {
  it("renders a valid, stuck-card-featured question", () => {
    const q = buildNoPrCardQuestion();
    // Round-trips through the strict escalation/ralph-question schema.
    expect(() => escalationQuestionSchema.parse(q)).not.toThrow();
    // Carries the STUCK_CARD_FEATURE marker, so the whole stuck-card family reads as one
    // thing on the issue thread.
    expect(q.feature).toBe(STUCK_CARD_FEATURE);
    // Self-explaining: names the no-PR outcome and the backgrounded-build cause.
    expect(q.headline.toLowerCase()).toContain("without opening a pr");
    expect(q.stakes.toLowerCase()).toContain("no pull request");
    expect(q.whereWeStand.toLowerCase()).toContain("background");
    // The operator's moves are on the ISSUE: re-enable / re-scope / close — never "heal".
    expect(q.options?.some((o) => /re-enable|ready-for-agent/i.test(o))).toBe(true);
    expect(q.options?.some((o) => /close/i.test(o))).toBe(true);
    expect(q.options?.some((o) => /heal/i.test(o))).toBe(false);
  });
});

describe("recordFinishedWithoutPr (clean session, no PR)", () => {
  let store: Store;
  let github: FakeGitHub;

  beforeEach(() => {
    store = openStore(MEMORY_DB).forRepo("acme/widgets");
    github = new FakeGitHub();
  });
  afterEach(() => store.close());

  it("posts a self-explaining stuck-card that is evidence, not an answerable question", async () => {
    github.seed({ number: 7, title: "Flaky thing", labels: ["afk", "mode:tdd"] });
    const run = store.upsertRun({
      issueNumber: 7,
      mode: "tdd",
      status: "running",
      branch: "ralph/7-flaky",
      worktreePath: "/wt/7",
    });

    await recordFinishedWithoutPr(store, github, { issueNumber: 7, runId: run.id });

    // Exactly one structured comment, parseable as a stuck-card.
    const comments = github.comments.get(7) ?? [];
    expect(comments).toHaveLength(1);
    const body = comments[0]!.body;
    expect(body).toContain("```" + RALPH_QUESTION_FENCE);
    const question = parseRalphQuestionComment(body);
    expect(question).not.toBeNull();
    expect(question!.feature).toBe(STUCK_CARD_FEATURE);
    expect(body.toLowerCase()).toContain("no pull request");

    // Terminal on the run status (the reconciler diff projects the label from it —
    // no imperative addLabel), and the span is closed (RunEnded{stuck}).
    expect(store.getRunByIssue(7)!.status).toBe("agent-stuck");
    expect(github.addedLabels.some((l) => l.label === LABEL_AGENT_STUCK)).toBe(false);
    expect((await store.aggregateIssue(7)).state.ended).toBe(true);

    // Once `agent-stuck` is applied, the card is still NOT surfaced for answering: the #86
    // heal lane is retired (issue #43), so the queue types it as a terminal instead.
    await github.addLabel(7, LABEL_AGENT_STUCK);
    expect(await listOpenQuestions(github)).toEqual([]);
    expect(await openQuestionForIssue(github, github.issues.get(7)!)).toEqual({
      kind: "terminal",
      label: LABEL_AGENT_STUCK,
    });

    // Recorded in the run log for live views.
    expect(store.tailLog(run.id).some((e) => e.event === "agent-no-pr")).toBe(true);
  });
});
