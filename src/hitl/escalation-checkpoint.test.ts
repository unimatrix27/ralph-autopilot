import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../log/logger";
import { MEMORY_DB, openStore, type Store } from "../store/store";
import { FakeGitHub } from "../testing/fake-github";
import { FakeWorktreeManager } from "../testing/fake-worktree";
import { parseEscalationQuestion, parsePhaseMarker, RALPH_QUESTION_FENCE } from "../review/escalation";
import { EscalationCheckpointer, recordEscalation } from "./escalation-checkpoint";
import { LABEL_AWAITING_ANSWER } from "./labels";

const silent = createLogger({ write: () => {} });
const BRANCH = "ralph/4-hitl";

const question = {
  headline: "Cannot honour the binding storage decision",
  feature: "Ledger persistence",
  whereWeStand: "The committed design says SQLite, but the table needs JSONB the SDK can't model.",
  decision: "Stay on the committed store or escalate for a schema change?",
  options: ["Keep SQLite, denormalise", "Escalate for Postgres"],
  stakes: "Switching stores is an architecture-level change with migration and ops impact.",
  recommendation: "Keep SQLite and denormalise this cycle.",
};

describe("EscalationCheckpointer (AC2)", () => {
  let store: Store;
  let github: FakeGitHub;
  let worktrees: FakeWorktreeManager;

  beforeEach(() => {
    store = openStore(MEMORY_DB).forRepo("acme/widgets");
    github = new FakeGitHub();
    worktrees = new FakeWorktreeManager();
  });
  afterEach(() => store.close());

  function setup() {
    const issue = github.seed({ number: 4, title: "HITL" });
    const run = store.upsertRun({
      issueNumber: 4,
      mode: "tdd",
      status: "running",
      branch: BRANCH,
      worktreePath: "/wt/4",
    });
    const checkpointer = new EscalationCheckpointer({ store, github, worktrees });
    return { issue, run, checkpointer };
  }

  it("checkpoints WIP to a draft PR before the slot frees", async () => {
    const { issue, run, checkpointer } = setup();

    const { prNumber } = await checkpointer.checkpoint(
      { issue, mode: "tdd", runId: run.id, branch: BRANCH, worktreePath: "/wt/4", logger: silent },
      question,
    );

    // WIP committed + pushed before anything else.
    expect(worktrees.checkpointed).toEqual([{ worktreePath: "/wt/4", branch: BRANCH }]);
    // A draft PR now exists, recorded on the run.
    expect(github.draftPulls).toContain(prNumber);
    const pr = await github.findPullRequestForBranch(BRANCH);
    expect(pr!.number).toBe(prNumber);
    expect(pr!.body).toContain("Closes #4");
    expect(store.getRunByIssue(4)!.prNumber).toBe(prNumber);
  });

  it("writes a parseable ralph-question and swaps to awaiting-answer", async () => {
    const { issue, run, checkpointer } = setup();

    await checkpointer.checkpoint(
      { issue, mode: "tdd", runId: run.id, branch: BRANCH, worktreePath: "/wt/4", logger: silent },
      question,
    );

    // The `awaiting-answer` status the reconciler's per-tick diff projects its label
    // from (issue #82, ADR-0027) — no imperative `addLabel` at the checkpoint.
    expect(store.getRunByIssue(4)!.status).toBe("awaiting-answer");
    expect(github.addedLabels.some((l) => l.label === LABEL_AWAITING_ANSWER)).toBe(false);

    // The ralph-question comment round-trips through the fenced payload.
    const comment = (github.comments.get(4) ?? []).at(-1)!;
    expect(comment.body).toContain("```" + RALPH_QUESTION_FENCE);
    const fence = comment.body.split("```" + RALPH_QUESTION_FENCE)[1]!.split("```")[0]!;
    expect(parseEscalationQuestion(JSON.parse(fence))).toEqual(question);

    // Indexed as an open question, with resume context for resume-not-restart.
    const open = store.listOpenQuestions();
    expect(open).toHaveLength(1);
    expect(open[0]!.kind).toBe("escalate");
    const resume = store.getResumeContext(run.id)!;
    expect(resume.branch).toBe(BRANCH);
    expect(parseEscalationQuestion(resume.context.question)).toEqual(question);
    // An impl-agent escalation carries no phase and stamps no marker → impl resume (issue #9).
    expect(parsePhaseMarker(comment.body)).toBeNull();
    expect(resume.context.phase).toBeUndefined();
  });

  it("stamps a recoverable phase marker on a review-loop escalation (issue #9)", async () => {
    setup();
    // recordEscalation is the shared half the review loop uses directly (it already
    // has a PR). With a phase, the SAME comment bytes it posts must round-trip back
    // to that phase, so a cold-store rehydrate re-enters the review loop there.
    await recordEscalation(store, github, {
      issueNumber: 4,
      runId: store.getRunByIssue(4)!.id,
      question,
      branch: BRANCH,
      phase: 2,
    });

    const comment = (github.comments.get(4) ?? []).at(-1)!;
    // The question still round-trips, and the hidden marker recovers the phase.
    const fence = comment.body.split("```" + RALPH_QUESTION_FENCE)[1]!.split("```")[0]!;
    expect(parseEscalationQuestion(JSON.parse(fence))).toEqual(question);
    expect(parsePhaseMarker(comment.body)).toBe(2);

    // The warm resume context carries the phase too — both ends agree.
    const resume = store.getResumeContext(store.getRunByIssue(4)!.id)!;
    expect(resume.context.phase).toBe(2);
  });
});
