import { describe, expect, it } from "vitest";
import { isExpectedVersionConflictError } from "@event-driven-io/emmett";
import { openStore, MEMORY_DB } from "./store";
import { ISSUE_PROJECTION_TABLE } from "./events/projection";

const REPO = "owner/repo";
const FIXED_NOW = "2026-06-20T12:00:00.000Z";

function freshStore() {
  return openStore(MEMORY_DB, { now: () => FIXED_NOW });
}

describe("EventLog — inline projection, same-transaction (ADR-0021)", () => {
  it("folds the projection inline; a read within the tick observes the write", async () => {
    const store = freshStore();
    try {
      await store.events.appendToIssue(REPO, 101, [
        { type: "RunStarted", data: { runId: "r1", mode: "tdd" } },
      ]);

      // Read-your-write: the projection row is current the instant the append resolves.
      const afterStart = store.events.readIssueProjection(REPO, 101);
      expect(afterStart).toMatchObject({
        streamId: "owner/repo#101",
        repo: REPO,
        issueNumber: 101,
        status: "running",
        runId: "r1",
        fixAttempts: { 0: 0, 1: 0, 2: 0 },
        streamPosition: 1,
        updatedAt: FIXED_NOW,
      });

      await store.events.appendToIssue(REPO, 101, [
        { type: "FixAttempted", data: { runId: "r1", phase: 1 } },
        { type: "FixAttempted", data: { runId: "r1", phase: 1 } },
      ]);
      expect(store.events.readIssueProjection(REPO, 101)).toMatchObject({
        fixAttempts: { 0: 0, 1: 2, 2: 0 },
        streamPosition: 3,
      });
    } finally {
      store.close();
    }
  });

  it("returns null for a projection with no events yet", () => {
    const store = freshStore();
    try {
      expect(store.events.readIssueProjection(REPO, 999)).toBeNull();
    } finally {
      store.close();
    }
  });

  it("aggregateIssue fold agrees with the projection table (read-your-write on the log)", async () => {
    const store = freshStore();
    try {
      await store.events.appendToIssue(REPO, 101, [
        { type: "RunStarted", data: { runId: "r1", mode: "tdd" } },
        { type: "PrOpened", data: { runId: "r1", prNumber: 42 } },
        { type: "FixAttempted", data: { runId: "r1", phase: 1 } },
      ]);
      const agg = await store.events.aggregateIssue(REPO, 101);
      expect(agg.exists).toBe(true);
      expect(agg.version).toBe(3n);
      expect(agg.state).toMatchObject({ status: "running", prNumber: 42, fixAttempts: { 1: 1 } });

      const proj = store.events.readIssueProjection(REPO, 101);
      expect(proj?.status).toBe(agg.state.status);
      expect(proj?.prNumber).toBe(agg.state.prNumber);
      expect(proj?.fixAttempts).toEqual(agg.state.fixAttempts);
    } finally {
      store.close();
    }
  });

  it("an empty stream aggregates to the initial state at version 0", async () => {
    const store = freshStore();
    try {
      const agg = await store.events.aggregateIssue(REPO, 5);
      expect(agg.exists).toBe(false);
      expect(agg.version).toBe(0n);
      expect(agg.state.status).toBe("none");
    } finally {
      store.close();
    }
  });
});

describe("EventLog — expected-version optimistic concurrency (ADR-0022)", () => {
  it("appends at the expected version and reports the next version", async () => {
    const store = freshStore();
    try {
      const v1 = await store.events.appendToIssue(
        REPO,
        101,
        [{ type: "RunStarted", data: { runId: "r1", mode: "tdd" } }],
        0n,
      );
      expect(v1).toBe(1n);
      const v2 = await store.events.appendToIssue(
        REPO,
        101,
        [{ type: "FixAttempted", data: { runId: "r1", phase: 1 } }],
        1n,
      );
      expect(v2).toBe(2n);
    } finally {
      store.close();
    }
  });

  it("rejects a stale-version append and leaves no side effects (no wedge)", async () => {
    const store = freshStore();
    try {
      await store.events.appendToIssue(REPO, 101, [
        { type: "RunStarted", data: { runId: "r1", mode: "tdd" } },
      ]);
      await store.events.appendToIssue(REPO, 101, [
        { type: "FixAttempted", data: { runId: "r1", phase: 1 } },
      ]); // stream now at v2

      // Stale append expecting v1 (an already-consumed version) is rejected.
      let err: unknown;
      await store.events
        .appendToIssue(
          REPO,
          101,
          [{ type: "FixAttempted", data: { runId: "r1", phase: 1 } }],
          1n,
        )
        .catch((e) => {
          err = e;
        });
      expect(isExpectedVersionConflictError(err)).toBe(true);

      // A stale *create* (expected v0 on an existing stream) is rejected too — the path
      // Emmett 0.42.3 mishandles natively (spike Constraint 1), here pre-checked.
      let createErr: unknown;
      await store.events
        .appendToIssue(REPO, 101, [{ type: "RunStarted", data: { runId: "rx", mode: "tdd" } }], 0n)
        .catch((e) => {
          createErr = e;
        });
      expect(isExpectedVersionConflictError(createErr)).toBe(true);

      // The rejections were side-effect-free: version still 2, fix count still 1.
      const agg = await store.events.aggregateIssue(REPO, 101);
      expect(agg.version).toBe(2n);
      expect(store.events.readIssueProjection(REPO, 101)?.fixAttempts[1]).toBe(1);

      // The stream is NOT wedged: a correct-version append still succeeds.
      const v3 = await store.events.appendToIssue(
        REPO,
        101,
        [{ type: "FixAttempted", data: { runId: "r1", phase: 1 } }],
        2n,
      );
      expect(v3).toBe(3n);
      expect(store.events.readIssueProjection(REPO, 101)?.fixAttempts[1]).toBe(2);
    } finally {
      store.close();
    }
  });
});

describe("EventLog — fix-attempt events under expected-version concurrency (ADR-0022)", () => {
  it("rejects a second writer that races a fix-attempt append at the same version", async () => {
    const store = freshStore();
    try {
      // Two writers both observe version 0 and try to record the first fix attempt.
      const v0 = (await store.events.aggregateIssue(REPO, 303)).version;
      expect(v0).toBe(0n);

      const first = await store.events.appendToIssue(
        REPO,
        303,
        [{ type: "FixAttempted", data: { runId: "r1", phase: 1 } }],
        v0,
      );
      expect(first).toBe(1n);

      // The loser still expects v0 — its append is rejected, leaving the count at 1.
      let err: unknown;
      await store.events
        .appendToIssue(REPO, 303, [{ type: "FixAttempted", data: { runId: "r1", phase: 1 } }], v0)
        .catch((e) => {
          err = e;
        });
      expect(isExpectedVersionConflictError(err)).toBe(true);
      expect(store.events.readIssueProjection(REPO, 303)?.fixAttempts[1]).toBe(1);

      // Re-reading the version lets the writer retry successfully (no wedge).
      const v1 = (await store.events.aggregateIssue(REPO, 303)).version;
      const second = await store.events.appendToIssue(
        REPO,
        303,
        [{ type: "FixAttempted", data: { runId: "r1", phase: 1 } }],
        v1,
      );
      expect(second).toBe(2n);
      expect(store.events.readIssueProjection(REPO, 303)?.fixAttempts[1]).toBe(2);
    } finally {
      store.close();
    }
  });
});

describe("EventLog — system stream isolation (ADR-0022)", () => {
  it("daemon-lifecycle events go to a stream isolated from issue streams", async () => {
    const store = freshStore();
    try {
      await store.events.appendToSystem([
        { type: "DaemonStarted", data: { version: "abc123", at: FIXED_NOW } },
      ]);

      // The system stream folds independently.
      const sys = await store.events.aggregateSystem();
      expect(sys.version).toBe(1n);
      expect(sys.state).toMatchObject({ running: true, draining: false, lastEvent: "DaemonStarted" });

      // It produced no issue-projection rows (system events are not issue events).
      const rows = store.db
        .prepare(`SELECT COUNT(*) AS c FROM ${ISSUE_PROJECTION_TABLE}`)
        .get() as { c: number };
      expect(rows.c).toBe(0);

      // An issue stream is untouched by the system event.
      const issue = await store.events.aggregateIssue(REPO, 101);
      expect(issue.exists).toBe(false);

      // Appending issue events does not perturb the system stream.
      await store.events.appendToIssue(REPO, 101, [
        { type: "RunStarted", data: { runId: "r1", mode: "tdd" } },
      ]);
      const sysAfter = await store.events.aggregateSystem();
      expect(sysAfter.version).toBe(1n);
      expect(store.events.readIssueProjection(REPO, 101)?.status).toBe("running");
    } finally {
      store.close();
    }
  });

  it("folds drain on top of start", async () => {
    const store = freshStore();
    try {
      await store.events.appendToSystem([
        { type: "DaemonStarted", data: { version: null, at: FIXED_NOW } },
        { type: "DaemonDrained", data: { reason: "self-update", at: FIXED_NOW } },
      ]);
      const sys = await store.events.aggregateSystem();
      expect(sys.state).toMatchObject({ running: true, draining: true, lastEvent: "DaemonDrained" });
    } finally {
      store.close();
    }
  });
});

describe("ScopedStore — repo-scoped issue streams (ADR-0020/0023)", () => {
  it("auto-injects the repo so colliding issue numbers across repos stay isolated", async () => {
    const store = freshStore();
    try {
      const repoA = store.forRepo("owner/a");
      const repoB = store.forRepo("owner/b");

      await repoA.appendIssueEvents(7, [{ type: "RunStarted", data: { runId: "ra", mode: "tdd" } }]);
      await repoB.appendIssueEvents(7, [
        { type: "RunStarted", data: { runId: "rb", mode: "infra" } },
        { type: "RunStuck", data: { runId: "rb", reason: "futility" } },
      ]);

      const aAgg = await repoA.aggregateIssue(7);
      const bAgg = await repoB.aggregateIssue(7);
      expect(aAgg.state).toMatchObject({ status: "running", runId: "ra" });
      expect(bAgg.state).toMatchObject({ status: "agent-stuck", runId: "rb" });

      expect(repoA.readIssueProjection(7)?.runId).toBe("ra");
      expect(repoB.readIssueProjection(7)?.runId).toBe("rb");
      // Cross-repo: repoA never sees repoB's row for the same issue number.
      expect(repoA.readIssueProjection(7)?.status).toBe("running");
    } finally {
      store.close();
    }
  });

  it("the expected-version guard rejects a stale scoped append", async () => {
    const store = freshStore();
    try {
      const repo = store.forRepo("owner/a");
      await repo.appendIssueEvents(7, [{ type: "RunStarted", data: { runId: "ra", mode: "tdd" } }], 0n);
      let err: unknown;
      await repo
        .appendIssueEvents(7, [{ type: "FixAttempted", data: { runId: "ra", phase: 1 } }], 0n)
        .catch((e) => {
          err = e;
        });
      expect(isExpectedVersionConflictError(err)).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("EventLog — slice 2 cuts fix-attempts over to events (ADR-0025)", () => {
  it("direct event appends never touch the legacy runs table (run lifecycle uncut)", async () => {
    const store = freshStore();
    try {
      await store.events.appendToIssue(REPO, 101, [
        { type: "RunStarted", data: { runId: "r1", mode: "tdd" } },
        { type: "FixAttempted", data: { runId: "r1", phase: 1 } },
      ]);
      // The run lifecycle is NOT event-sourced yet — appending events creates no run row.
      expect(store.getRunByIssue(REPO, 101)).toBeUndefined();
      const runsCount = store.db.prepare("SELECT COUNT(*) AS c FROM runs").get() as { c: number };
      expect(runsCount.c).toBe(0);
    } finally {
      store.close();
    }
  });

  it("recordFixAttempt appends to the issue stream; the count is the derived fold", async () => {
    const store = freshStore();
    try {
      // The run row maps the numeric run id to the stream; the count is the derived fold.
      const run = store.upsertRun({ repo: REPO, issueNumber: 202, mode: "tdd" });
      expect(await store.recordFixAttempt(REPO, 202, { runId: run.id, phase: 1 })).toBe(1);
      expect(await store.recordFixAttempt(REPO, 202, { runId: run.id, phase: 1 })).toBe(2);

      // The count is derived from FixAttempted on issue 202's stream — not a stored counter.
      expect(store.events.readIssueProjection(REPO, 202)?.fixAttempts[1]).toBe(2);
      expect(store.getFixAttempts(run.id, 1)).toBe(2);

      // Re-entry opens a fresh span via ReviewPhaseEntered (a non-destructive reset).
      await store.recordReviewPhaseEntered(REPO, 202, { runId: run.id, phase: 1 });
      expect(store.getFixAttempts(run.id, 1)).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe("EventLog — slice 3 cuts open-questions over to events (ADR-0025)", () => {
  it("addQuestion appends Escalated; the open-question list is the derived projection", async () => {
    const store = freshStore();
    try {
      const run = store.upsertRun({ repo: REPO, issueNumber: 303, mode: "tdd" });
      const q = await store.addQuestion({
        repo: REPO,
        issueNumber: 303,
        runId: run.id,
        kind: "escalate",
        headline: "Which DB driver?",
        commentId: 55,
      });

      // The index is event-sourced: addQuestion put an `Escalated` on issue 303's stream
      // (the issue-state fold reflects it as `awaiting-answer`), not a CRUD row.
      expect(store.events.readIssueProjection(REPO, 303)?.status).toBe("awaiting-answer");

      // The open-question list is the projection folded from that event.
      const open = store.listOpenQuestions(REPO);
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({
        repo: REPO,
        issueNumber: 303,
        runId: run.id,
        kind: "escalate",
        headline: "Which DB driver?",
        commentId: 55,
        status: "open",
      });
      // The read-back returns the same materialised row (stable id) the projection holds.
      expect(open[0]!.id).toBe(q.id);
      expect(store.getQuestion(q.id)?.status).toBe("open");
    } finally {
      store.close();
    }
  });

  it("answerQuestion appends QuestionAnswered; the row leaves the open list, retained as answered", async () => {
    const store = freshStore();
    try {
      const run = store.upsertRun({ repo: REPO, issueNumber: 304, mode: "tdd" });
      const q = await store.addQuestion({
        repo: REPO,
        issueNumber: 304,
        runId: run.id,
        kind: "heal-card",
        headline: "3 P0s remain",
        commentId: 77,
      });
      expect(store.listOpenQuestions(REPO)).toHaveLength(1);

      await store.answerQuestion(q.id);

      // Closed: gone from the open list, but the row is retained with the answer fact.
      expect(store.listOpenQuestions(REPO)).toHaveLength(0);
      expect(store.getQuestion(q.id)?.status).toBe("answered");
      expect(store.getQuestion(q.id)?.answeredAt).not.toBeNull();
    } finally {
      store.close();
    }
  });

  it("escalate → answer → re-escalate keeps exactly one question open at a time", async () => {
    const store = freshStore();
    try {
      const run = store.upsertRun({ repo: REPO, issueNumber: 305, mode: "tdd" });
      const first = await store.addQuestion({
        repo: REPO,
        issueNumber: 305,
        runId: run.id,
        kind: "escalate",
        headline: "first",
        commentId: 1,
      });
      await store.answerQuestion(first.id);
      const second = await store.addQuestion({
        repo: REPO,
        issueNumber: 305,
        runId: run.id,
        kind: "escalate",
        headline: "second",
        commentId: 2,
      });

      const open = store.listOpenQuestions(REPO);
      expect(open).toHaveLength(1);
      expect(open[0]!.id).toBe(second.id);
      expect(open[0]!.headline).toBe("second");
    } finally {
      store.close();
    }
  });

  it("listAllOpenQuestions spans repos; listOpenQuestions is repo-scoped", async () => {
    const store = freshStore();
    try {
      const a = store.upsertRun({ repo: "owner/a", issueNumber: 1, mode: "tdd" });
      const b = store.upsertRun({ repo: "owner/b", issueNumber: 1, mode: "tdd" });
      await store.addQuestion({ repo: "owner/a", issueNumber: 1, runId: a.id, kind: "escalate", headline: "qa", commentId: 10 });
      await store.addQuestion({ repo: "owner/b", issueNumber: 1, runId: b.id, kind: "escalate", headline: "qb", commentId: 11 });

      expect(store.listOpenQuestions("owner/a").map((x) => x.headline)).toEqual(["qa"]);
      expect(store.listOpenQuestions("owner/b").map((x) => x.headline)).toEqual(["qb"]);
      expect(store.listAllOpenQuestions().map((x) => x.headline).sort()).toEqual(["qa", "qb"]);
    } finally {
      store.close();
    }
  });
});

describe("EventLog — slice 4: the run span (ADR-0022) + resume context over events (ADR-0025)", () => {
  const QUESTION = {
    headline: "Drop the legacy adapter?",
    feature: "Ingestion",
    whereWeStand: "Review wants it gone.",
    decision: "Remove it or keep behind a flag?",
    stakes: "One-way door for old consumers.",
    recommendation: "Keep behind a flag.",
  };

  it("pickup appends RunStarted; a terminal appends RunEnded; the run row maps the id to the stream", async () => {
    const store = freshStore();
    try {
      const run = store.upsertRun({ repo: REPO, issueNumber: 401, mode: "tdd" });
      await store.recordRunStarted(REPO, 401, {
        runId: run.id,
        mode: "tdd",
        branch: "ralph/401-x",
        worktreePath: "/wt/401",
      });
      expect(store.events.readIssueProjection(REPO, 401)).toMatchObject({
        status: "running",
        ended: false,
      });

      await store.recordRunEnded(REPO, 401, { runId: run.id, outcome: "merged" });
      expect(store.events.readIssueProjection(REPO, 401)?.ended).toBe(true);
      // The span events are on the issue stream — RunStarted + RunEnded.
      expect((await store.events.aggregateIssue(REPO, 401)).version).toBe(2n);
    } finally {
      store.close();
    }
  });

  it("a re-pickup appends a new RunStarted span in the same stream — no destructive delete", async () => {
    const store = freshStore();
    try {
      const run = store.upsertRun({ repo: REPO, issueNumber: 402, mode: "tdd" });
      await store.recordRunStarted(REPO, 402, { runId: run.id, mode: "tdd" });
      await store.recordRunEnded(REPO, 402, { runId: run.id, outcome: "merged" });

      // Re-pickup: a fresh RunStarted. The prior span's events stay in the log (the latest
      // span is the projected current run, ADR-0022).
      await store.recordRunStarted(REPO, 402, { runId: run.id, mode: "tdd" });
      const proj = store.events.readIssueProjection(REPO, 402);
      expect(proj?.status).toBe("running");
      expect(proj?.ended).toBe(false);
      expect((await store.events.aggregateIssue(REPO, 402)).version).toBe(3n);
    } finally {
      store.close();
    }
  });

  it("a re-pickup over an unclosed span abandons it first (RunEnded { abandoned } then RunStarted)", async () => {
    const store = freshStore();
    try {
      const run = store.upsertRun({ repo: REPO, issueNumber: 403, mode: "tdd" });
      await store.recordRunStarted(REPO, 403, { runId: run.id, mode: "tdd" }); // span 1 open (v1)
      await store.recordRunStarted(REPO, 403, { runId: run.id, mode: "tdd" }); // abandon + start (v3)
      expect((await store.events.aggregateIssue(REPO, 403)).version).toBe(3n);
      const proj = store.events.readIssueProjection(REPO, 403);
      expect(proj).toMatchObject({ status: "running", ended: false });
    } finally {
      store.close();
    }
  });

  it("resume context round-trips over the latest span; a new RunStarted resets it", async () => {
    const store = freshStore();
    try {
      const run = store.upsertRun({ repo: REPO, issueNumber: 404, mode: "tdd" });
      await store.recordRunStarted(REPO, 404, { runId: run.id, mode: "tdd", branch: "ralph/404-x" });

      // The escalate checkpoint (impl-agent or review-loop, phase-keyed) is the shim write.
      store.setResumeContext(run.id, { phase: 1, question: QUESTION, commentId: 9 }, "ralph/404-x");
      const ctx = store.getResumeContext(run.id);
      expect(ctx).toMatchObject({ runId: run.id, branch: "ralph/404-x", updatedAt: FIXED_NOW });
      expect(ctx?.context).toMatchObject({ phase: 1, commentId: 9 });
      expect(ctx?.context.question.headline).toBe(QUESTION.headline);

      // A re-pickup (new span) folds the resume context fresh — the prior checkpoint is gone.
      await store.recordRunStarted(REPO, 404, { runId: run.id, mode: "tdd" });
      expect(store.getResumeContext(run.id)).toBeUndefined();
      // The checkpoint write was event-driven-cleared, not a stored counter: the stream's
      // span events are all retained.
      expect((await store.events.aggregateIssue(REPO, 404)).exists).toBe(true);
    } finally {
      store.close();
    }
  });

  it("deleteRunByIssue drops the resume-context row but keeps the stream's events", async () => {
    const store = freshStore();
    try {
      const run = store.upsertRun({ repo: REPO, issueNumber: 405, mode: "tdd" });
      await store.recordRunStarted(REPO, 405, { runId: run.id, mode: "tdd" });
      store.setResumeContext(run.id, { question: QUESTION, commentId: 1 }, "ralph/405-x");
      expect(store.events.resumeContextForIssue(REPO, 405)).not.toBeNull();

      store.deleteRunByIssue(REPO, 405);
      // The read model row is gone (the old FK cascade's analogue); the events remain.
      expect(store.events.resumeContextForIssue(REPO, 405)).toBeNull();
      expect((await store.events.aggregateIssue(REPO, 405)).exists).toBe(true);
    } finally {
      store.close();
    }
  });

  it("getResumeContext is undefined when the run row is gone (a missing run cannot resume)", async () => {
    const store = freshStore();
    try {
      const run = store.upsertRun({ repo: REPO, issueNumber: 406, mode: "tdd" });
      store.setResumeContext(run.id, { question: QUESTION }, "ralph/406-x");
      expect(store.getResumeContext(run.id)).toBeDefined();
      store.deleteRunByIssue(REPO, 406);
      expect(store.getResumeContext(run.id)).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
