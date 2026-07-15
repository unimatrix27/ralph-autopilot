import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEMORY_DB, openStore, type Store } from "../store/store";
import { FakeGitHub } from "../testing/fake-github";
import { seedRun } from "../testing/seed-run";
import { formatRalphAnswer, resolveAnswer } from "./answer";
import { findResumableRuns, scanPausedRuns } from "./resume";
import { LABEL_AWAITING_ANSWER, LABEL_READY } from "./labels";
import { formatRalphQuestion, type EscalationQuestion } from "../review/escalation";

const question: EscalationQuestion = {
  headline: "Delete the legacy adapter?",
  feature: "Ingestion",
  whereWeStand: "Review wants it gone.",
  decision: "Remove it or keep it behind a flag?",
  options: ["Delete it", "Keep behind a flag"],
  stakes: "One-way door for old consumers.",
  recommendation: "Keep behind a flag.",
};

describe("findResumableRuns (AC5 — detect an answered pause)", () => {
  let store: Store;
  let github: FakeGitHub;

  beforeEach(() => {
    store = openStore(MEMORY_DB).forRepo("acme/widgets");
    github = new FakeGitHub();
  });
  afterEach(() => store.close());

  /** A run paused awaiting an answer, with resume context recorded. */
  async function pause(issueNumber: number, branch: string) {
    const run = await seedRun(store, {
      issueNumber,
      mode: "tdd",
      status: "awaiting-answer",
      branch,
      worktreePath: `/wt/${issueNumber}`,
      prNumber: 1001,
    });
    store.setResumeContext(run.id, { question }, branch);
    return run;
  }

  it("ignores a pause that is still awaiting (label not swapped back)", async () => {
    await pause(4, "ralph/4-x");
    github.seed({ number: 4, labels: [LABEL_AWAITING_ANSWER, "afk", "mode:tdd"] });

    expect(await findResumableRuns(github, store)).toEqual([]);
  });

  it("ignores a re-armed pause with no ralph-answer comment yet", async () => {
    await pause(4, "ralph/4-x");
    github.seed({ number: 4, labels: [LABEL_READY, "afk", "mode:tdd"] });

    expect(await findResumableRuns(github, store)).toEqual([]);
  });

  it("detects a pause re-armed with ready-for-agent + a ralph-answer, carrying the answer", async () => {
    const run = await pause(4, "ralph/4-x");
    github.seed({ number: 4, labels: [LABEL_READY, "afk", "mode:tdd"] });
    const answer = resolveAnswer(question, "2");
    void github.postComment(4, formatRalphAnswer(answer));

    const resumable = await findResumableRuns(github, store);

    expect(resumable).toHaveLength(1);
    expect(resumable[0]!.run.id).toBe(run.id);
    expect(resumable[0]!.context.question.headline).toBe(question.headline);
    expect(resumable[0]!.answer).toEqual(answer);
    expect(resumable[0]!.issue.number).toBe(4);
  });

  /**
   * A run paused on a *specific* question (its comment id recorded in resume
   * context), with the heal-loop's prior question/answer comments already in the
   * thread. `staleAnswers` are posted before the current question (they belong to
   * earlier cycles); the current question comment is posted last so its id
   * post-dates them.
   */
  async function pauseOnQuestion(issueNumber: number, branch: string, staleAnswers: string[]) {
    const run = await seedRun(store, {
      issueNumber,
      mode: "tdd",
      status: "review-maxed",
      branch,
      worktreePath: `/wt/${issueNumber}`,
      prNumber: 1003,
    });
    github.seed({ number: issueNumber, labels: [LABEL_READY, "afk", "mode:tdd"] });
    for (const text of staleAnswers) {
      void github.postComment(issueNumber, text);
    }
    // The current question this resume is keyed to — its id post-dates the stale
    // answers above and pre-dates any fresh answer posted after.
    return github.postComment(issueNumber, formatRalphQuestion(question)).then(({ id }) => {
      store.setResumeContext(run.id, { phase: 1, question, commentId: id }, branch);
      return run;
    });
  }

  it("ignores a stale prior answer that pre-dates the current question (AC: not the newest)", async () => {
    // Only a stale answer from an earlier heal cycle is present — no reply to the
    // current question yet. Positional matching would inject it; correlation must not.
    const stale = formatRalphAnswer(resolveAnswer(question, "1"));
    await pauseOnQuestion(6, "ralph/6-z", [stale]);

    expect(await findResumableRuns(github, store)).toEqual([]);
  });

  it("injects the newer answer when a stale prior answer is also present (AC: stale-answer case)", async () => {
    const staleAnswer = resolveAnswer(question, "1"); // "Delete it"
    const freshAnswer = resolveAnswer(question, "2"); // "Keep behind a flag"
    await pauseOnQuestion(7, "ralph/7-w", [formatRalphAnswer(staleAnswer)]);
    // The operator's actual reply to the current question, post-dating it.
    void github.postComment(7, formatRalphAnswer(freshAnswer));

    const resumable = await findResumableRuns(github, store);

    expect(resumable).toHaveLength(1);
    expect(resumable[0]!.answer).toEqual(freshAnswer);
    expect(resumable[0]!.answer).not.toEqual(staleAnswer);
  });

  it("detects a review-maxed pause once answered (heal flows the same way)", async () => {
    const run = await seedRun(store, {
      issueNumber: 5,
      mode: "tdd",
      status: "review-maxed",
      branch: "ralph/5-y",
      worktreePath: "/wt/5",
      prNumber: 1002,
    });
    store.setResumeContext(run.id, { question }, "ralph/5-y");
    github.seed({ number: 5, labels: [LABEL_READY, "afk", "mode:tdd"] });
    void github.postComment(5, formatRalphAnswer(resolveAnswer(question, "")));

    const resumable = await findResumableRuns(github, store);
    expect(resumable.map((r) => r.run.id)).toEqual([run.id]);
  });
});

describe("scanPausedRuns — stranded answered pauses (#132)", () => {
  let store: Store;
  let github: FakeGitHub;

  beforeEach(() => {
    store = openStore(MEMORY_DB).forRepo("acme/widgets");
    github = new FakeGitHub();
  });
  afterEach(() => store.close());

  /** A run paused awaiting an answer, keyed to a specific question comment. */
  async function pauseAndAsk(issueNumber: number, branch: string, labels: string[]) {
    const run = await seedRun(store, {
      issueNumber,
      mode: "tdd",
      status: "awaiting-answer",
      branch,
      worktreePath: `/wt/${issueNumber}`,
      prNumber: 1001,
    });
    github.seed({ number: issueNumber, labels });
    const { id } = await github.postComment(issueNumber, formatRalphQuestion(question));
    store.setResumeContext(run.id, { question, commentId: id }, branch);
    return run;
  }

  it("reproduces the #2112/#2113 wedge: answered, re-arm failed → awaiting-answer with no ready", async () => {
    // The state a rate-limited `deferResume` leaves behind: run row still paused, the
    // issue back on `awaiting-answer` (no `ready-for-agent`), and a `ralph-answer`
    // already in the thread. Invisible to resume (no ready) yet answered.
    const run = await pauseAndAsk(2112, "ralph/2112-x", [LABEL_AWAITING_ANSWER, "afk", "mode:tdd"]);
    void github.postComment(2112, formatRalphAnswer(resolveAnswer(question, "1")));

    const scan = await scanPausedRuns(github, store);

    // Not resumable (no ready label) — the wedge — but caught as stranded-answered.
    expect(scan.resumable).toEqual([]);
    expect(scan.strandedAnswered.map((s) => s.run.id)).toEqual([run.id]);
    expect(scan.strandedAnswered[0]!.issue.number).toBe(2112);
  });

  it("does not flag a genuinely-unanswered pause as stranded", async () => {
    await pauseAndAsk(7, "ralph/7-x", [LABEL_AWAITING_ANSWER, "afk", "mode:tdd"]);
    // No ralph-answer posted: the operator has not replied. Not stranded.

    const scan = await scanPausedRuns(github, store);
    expect(scan.resumable).toEqual([]);
    expect(scan.strandedAnswered).toEqual([]);
  });

  it("treats an answered pause that IS re-armed as resumable, never stranded", async () => {
    const run = await pauseAndAsk(8, "ralph/8-x", [LABEL_READY, "afk", "mode:tdd"]);
    void github.postComment(8, formatRalphAnswer(resolveAnswer(question, "1")));

    const scan = await scanPausedRuns(github, store);
    expect(scan.strandedAnswered).toEqual([]);
    expect(scan.resumable.map((r) => r.run.id)).toEqual([run.id]);
  });

  it("does not flag a re-escalated pause (a fresh unanswered question) as stranded", async () => {
    // Answered once, then the agent re-escalated — the LATEST question has no answer
    // after it, so the issue is genuinely awaiting again, not stranded.
    const run = await pauseAndAsk(9, "ralph/9-x", [LABEL_AWAITING_ANSWER, "afk", "mode:tdd"]);
    void github.postComment(9, formatRalphAnswer(resolveAnswer(question, "1")));
    await github.postComment(9, formatRalphQuestion(question)); // fresh, unanswered question
    void run;

    const scan = await scanPausedRuns(github, store);
    expect(scan.strandedAnswered).toEqual([]);
  });

  it("ignores a paused run whose issue has closed under it", async () => {
    await pauseAndAsk(10, "ralph/10-x", [LABEL_AWAITING_ANSWER, "afk", "mode:tdd"]);
    void github.postComment(10, formatRalphAnswer(resolveAnswer(question, "1")));
    github.issues.get(10)!.state = "CLOSED";

    const scan = await scanPausedRuns(github, store);
    expect(scan.strandedAnswered).toEqual([]);
    expect(scan.resumable).toEqual([]);
  });
});
