import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, runMigrations } from "./migrations";
import { MEMORY_DB, openStore, Store } from "./store";

const REPO = "acme/widgets";

describe("migrations", () => {
  it("are idempotent — re-running applies nothing new", () => {
    const db = new BetterSqlite3(MEMORY_DB);
    const v1 = runMigrations(db);
    const v2 = runMigrations(db);
    expect(v1).toBe(v2);
    const count = db
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM schema_migrations")
      .get();
    expect(count!.n).toBe(v1);
    db.close();
  });

  it("creates the live runtime-state tables and drops the event-superseded CRUD ones (v6)", () => {
    const db = new BetterSqlite3(MEMORY_DB);
    runMigrations(db);
    const tables = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);
    // The run row, agent bookkeeping, observability log, and the snapshot survive.
    for (const t of ["runs", "agents", "run_log", "daemon_snapshot"]) {
      expect(tables).toContain(t);
    }
    // PWA web push (issue #119): the persisted per-device push subscriptions.
    for (const t of ["push_subscriptions"]) {
      expect(tables).toContain(t);
    }
    // Slice 7 (issue #83): the CRUD state now projected from the event log is dropped.
    for (const t of ["fix_attempts", "resume_context", "open_questions"]) {
      expect(tables).not.toContain(t);
    }
  });

  it("drops the runs.status column — status is projected from the event log, not stored (v6)", () => {
    const db = new BetterSqlite3(MEMORY_DB);
    runMigrations(db);
    const cols = db
      .prepare<[], { name: string }>("PRAGMA table_info(runs)")
      .all()
      .map((r) => r.name);
    expect(cols).not.toContain("status");
    // The row still carries its non-derived bookkeeping.
    for (const c of ["id", "repo", "issue_number", "mode", "branch", "worktree_path", "pr_number"]) {
      expect(cols).toContain(c);
    }
    db.close();
  });

  it("adds the per-phase timer column to agents (v3)", () => {
    const db = new BetterSqlite3(MEMORY_DB);
    runMigrations(db);
    const cols = db
      .prepare<[], { name: string }>("PRAGMA table_info(agents)")
      .all()
      .map((r) => r.name);
    expect(cols).toContain("phase_started_at");
    db.close();
  });

  it("drops the dead pid columns (SDK sessions run in-process — issue #15, v4)", () => {
    const db = new BetterSqlite3(MEMORY_DB);
    runMigrations(db);
    const cols = (table: string): string[] =>
      db
        .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name);
    expect(cols("runs")).not.toContain("agent_pid");
    expect(cols("agents")).not.toContain("pid");
    db.close();
  });

  it("preserves rows through the v4 column drop, then clears them at the v5 multi-repo rebuild", () => {
    const db = new BetterSqlite3(MEMORY_DB);
    db.pragma("foreign_keys = ON");
    // Stand up the pre-cleanup (v1-only) schema, which still has the pid columns.
    db.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);",
    );
    db.exec(MIGRATIONS[0]!.up);
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'initial-schema', 't')",
    ).run();
    // Seed a run + agent carrying the (about-to-be-dropped) pid columns.
    const runId = Number(
      db
        .prepare(
          "INSERT INTO runs (issue_number, mode, status, agent_pid, created_at, updated_at) VALUES (5, 'tdd', 'running', 4242, 't', 't')",
        )
        .run().lastInsertRowid,
    );
    db.prepare(
      "INSERT INTO agents (run_id, pid, worktree_path, branch, started_at) VALUES (?, 4243, '/wt/5', 'ralph/5-x', 't')",
    ).run(runId);

    // Upgrade only through v4 (the dead-column drop): existing data must survive it.
    for (const m of MIGRATIONS.filter((mm) => mm.version >= 2 && mm.version <= 4)) {
      db.exec(m.up);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, 't')").run(
        m.version,
        m.name,
      );
    }
    const run = db
      .prepare<[number], { issue_number: number }>("SELECT issue_number FROM runs WHERE id = ?")
      .get(runId);
    expect(run?.issue_number).toBe(5);
    const agent = db
      .prepare<[number], { worktree_path: string }>("SELECT worktree_path FROM agents WHERE run_id = ?")
      .get(runId);
    expect(agent?.worktree_path).toBe("/wt/5");

    // The v5 multi-repo migration then rebuilds from GitHub (ADR-0020): it clears the
    // runtime tables (issue numbers aren't unique across repos), so the row does NOT
    // survive it — cut over with the daemon drained and rehydrate re-derives in-flight
    // runs from open PRs.
    db.exec(MIGRATIONS.find((mm) => mm.version === 5)!.up);
    expect(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM runs").get()!.n,
    ).toBe(0);
    db.close();
  });

  it("adds the nullable issue_title column additively (v9)", () => {
    const db = new BetterSqlite3(MEMORY_DB);
    runMigrations(db);
    const cols = db
      .prepare<[], { name: string }>("PRAGMA table_info(runs)")
      .all()
      .map((r) => r.name);
    expect(cols).toContain("issue_title");
    db.close();
  });

  it("adds the nullable runner_pushed_sha column additively (v10)", () => {
    const db = new BetterSqlite3(MEMORY_DB);
    runMigrations(db);
    const cols = db
      .prepare<[], { name: string }>("PRAGMA table_info(runs)")
      .all()
      .map((r) => r.name);
    expect(cols).toContain("runner_pushed_sha");
    db.close();
  });

  it("applies the issue_title migration idempotently against a pre-migration DB, reading old rows back with a null title (#13)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-title-migration-"));
    const path = join(dir, "ralph.sqlite");
    const db = new BetterSqlite3(path);
    db.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);",
    );
    // Stand up the schema at the version *before* issue_title existed, recording each so
    // runMigrations sees a DB that only needs the new column.
    for (const m of MIGRATIONS.filter((mm) => mm.version <= 8)) {
      db.exec(m.up);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, 't')").run(m.version, m.name);
    }
    // A run row seeded under the pre-migration schema — it has no issue_title column.
    db.prepare(
      "INSERT INTO runs (repo, issue_number, mode, tier, branch, worktree_path, pr_number, created_at, updated_at) VALUES ('acme/widgets', 5, 'tdd', NULL, 'ralph/5-x', '/wt/5', NULL, 't', 't')",
    ).run();
    db.close();

    // Opening the pre-migration DB succeeds; the additive migration lands and the old row
    // reads back with a null title (every consumer degrades gracefully).
    const store = openStore(path);
    const cols = store.db
      .prepare<[], { name: string }>("PRAGMA table_info(runs)")
      .all()
      .map((r) => r.name);
    expect(cols).toContain("issue_title");
    expect(store.getRunByIssue("acme/widgets", 5)?.issueTitle).toBeNull();
    store.close();

    // Re-opening applies nothing new (idempotent) and still reads the old row cleanly.
    const reopened = openStore(path);
    expect(reopened.getRunByIssue("acme/widgets", 5)?.issueTitle).toBeNull();
    reopened.close();
  });
});

describe("Store", () => {
  let store: Store;

  beforeEach(() => {
    store = openStore(MEMORY_DB);
  });
  afterEach(() => {
    store.close();
  });

  it("persists a sqlite file and survives reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-store-"));
    const path = join(dir, "nested", "ralph.sqlite");
    const s1 = openStore(path);
    s1.upsertRun({ repo: REPO, issueNumber: 7, mode: "tdd" });
    s1.close();

    const s2 = openStore(path);
    expect(s2.getRunByIssue(REPO, 7)?.mode).toBe("tdd");
    s2.close();
  });

  it("a normal restart recovers the run span and resume context from the local log (issue #80)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-restart-"));
    const path = join(dir, "ralph.sqlite");
    const question = {
      headline: "Keep the shim?",
      feature: "Resume",
      whereWeStand: "Paused on a review escalation.",
      decision: "Keep or drop?",
      stakes: "Resumability.",
      recommendation: "Keep.",
    };

    const s1 = openStore(path);
    const run = s1.upsertRun({ repo: REPO, issueNumber: 8, mode: "tdd" });
    await s1.recordRunStarted(REPO, 8, { runId: run.id, mode: "tdd", branch: "ralph/8-x" });
    s1.setResumeContext(run.id, { phase: 1, question, commentId: 12 }, "ralph/8-x");
    s1.close();

    // Restart: the daemon folds the local log + reads the persisted projection — no rebuild
    // from GitHub needed (the SQLite file survived).
    const s2 = openStore(path);
    const agg = await s2.events.aggregateIssue(REPO, 8);
    expect(agg.exists).toBe(true);
    expect(agg.state.status).toBe("running");
    const ctx = s2.getResumeContext(run.id);
    expect(ctx?.branch).toBe("ralph/8-x");
    expect(ctx?.context.phase).toBe(1);
    expect(ctx?.context.commentId).toBe(12);
    expect(ctx?.context.question.headline).toBe("Keep the shim?");
    s2.close();
  });

  describe("runs", () => {
    it("inserts then upserts by issue number", async () => {
      const created = store.upsertRun({ repo: REPO, issueNumber: 1, mode: "infra", branch: "ralph/1-foo" });
      // Status is event-sourced (issue #83): a row with no status fact reads the run-read default.
      expect(created.status).toBe("running");
      expect(created.branch).toBe("ralph/1-foo");

      const updated = store.upsertRun({ repo: REPO, issueNumber: 1, mode: "infra", prNumber: 99 });
      expect(updated.id).toBe(created.id);
      expect(updated.prNumber).toBe(99);
      expect(store.listRuns(REPO)).toHaveLength(1);

      // The merged status is the fold of the `Merged` fact, not a row field.
      await store.recordMerged(REPO, 1, { runId: created.id, prNumber: 99 });
      expect(store.getRun(created.id)?.status).toBe("merged");
    });

    it("persists the issue title at dispatch, preserving it across a title-less upsert (#13)", () => {
      const created = store.upsertRun({ repo: REPO, issueNumber: 50, mode: "tdd", issueTitle: "Plumb the title once" });
      expect(created.issueTitle).toBe("Plumb the title once");
      expect(store.getRunByIssue(REPO, 50)?.issueTitle).toBe("Plumb the title once");

      // A later upsert (e.g. recording the PR) that does not re-pass the title must NOT
      // clobber it to null — the title is durable for run history (issue #13, ADR-0029).
      const updated = store.upsertRun({ repo: REPO, issueNumber: 50, mode: "tdd", prNumber: 7 });
      expect(updated.issueTitle).toBe("Plumb the title once");
      expect(updated.prNumber).toBe(7);
    });

    it("leaves the issue title null when a run is created without one (#13)", () => {
      const created = store.upsertRun({ repo: REPO, issueNumber: 51, mode: "tdd" });
      expect(created.issueTitle).toBeNull();
    });

    it("records the runner-pushed head and preserves it across an unrelated upsert (#21)", () => {
      const created = store.upsertRun({ repo: REPO, issueNumber: 21, mode: "tdd", branch: "ralph/21-x" });
      // A fresh run has no recorded runner push — the divergence guard is unaffected.
      expect(created.runnerPushedSha).toBeNull();

      // The container rebase-conflict fix's runner force-pushed this head — record it on the run.
      store.setRunnerPushedHead(REPO, 21, "deadbeefcafe1234567890abcdef1234567890ab");
      expect(store.getRunByIssue(REPO, 21)?.runnerPushedSha).toBe(
        "deadbeefcafe1234567890abcdef1234567890ab",
      );

      // A later upsert (e.g. the resume re-attaching the worktree) that does not re-pass the SHA
      // must NOT clobber it — resume reads it to hard-sync the diverged local ref to origin (#21).
      const updated = store.upsertRun({ repo: REPO, issueNumber: 21, mode: "tdd", worktreePath: "/wt/21", prNumber: 5 });
      expect(updated.runnerPushedSha).toBe("deadbeefcafe1234567890abcdef1234567890ab");
      expect(updated.prNumber).toBe(5);
    });

    it("derives status from the issue stream's facts (append → fold → derived status)", async () => {
      const run = store.upsertRun({ repo: REPO, issueNumber: 2, mode: "tdd" });
      // The heal-card's `Escalated` first, then `ReviewMaxed` on top — the read-back folds it.
      await store.recordReviewMaxedQuestion(REPO, 2, { runId: run.id, phase: 1, headline: "q" });
      expect(store.getRun(run.id)?.status).toBe("review-maxed");
      expect(store.listOpenQuestions(REPO)[0]).toMatchObject({ issueNumber: 2, kind: "heal-card" });
    });

    it("keeps runs for the same issue number in different repos distinct", async () => {
      // Issue numbers are not unique across repos (v4 migration): the same #5 in
      // two repos is two separate runs, keyed by (repo, issue_number).
      store.upsertRun({ repo: "a/x", issueNumber: 5, mode: "tdd" });
      const b = store.upsertRun({ repo: "b/y", issueNumber: 5, mode: "tdd" });
      await store.recordMerged("b/y", 5, { runId: b.id, prNumber: 1 });

      expect(store.getRunByIssue("a/x", 5)?.status).toBe("running"); // run-read default, no fact
      expect(store.getRunByIssue("b/y", 5)?.status).toBe("merged");
      expect(store.listAllRuns()).toHaveLength(2);

      // A per-repo scoped view only ever resolves its own repo's run for #5.
      expect(store.forRepo("a/x").getRunByIssue(5)?.status).toBe("running");
      expect(store.forRepo("b/y").getRunByIssue(5)?.status).toBe("merged");
    });
  });

  // Run status is event-sourced (issue #81/#83): each transition is its own past-tense fact
  // on the issue stream (there is no stored `runs.status` column — it was dropped at the
  // strangler cleanup), and `getRun`/`getRunByIssue`/`listRunsByStatus` fold it back. These
  // assert through the store seam (record-fact → read-back), never the event-table internals.
  describe("run status (event-sourced)", () => {
    it("each transition's fact projects its status (append → fold → derived status)", async () => {
      const run = store.upsertRun({ repo: REPO, issueNumber: 40, mode: "tdd", prNumber: 7 });
      await store.recordRunStarted(REPO, 40, { runId: run.id, mode: "tdd" });
      expect(store.getRun(run.id)?.status).toBe("running");

      // The fast-path-safe review→integration hand-off (ReviewPassed), then the merge.
      await store.recordReviewPassed(REPO, 40, { runId: run.id });
      expect(store.getRun(run.id)?.status).toBe("awaiting-merge");
      await store.recordMerged(REPO, 40, { runId: run.id, prNumber: 7 });
      expect(store.getRunByIssue(REPO, 40)?.status).toBe("merged");
    });

    it("awaiting-merge is projected from ReviewPassed, not from a passed phase (fast-path-safe)", async () => {
      const run = store.upsertRun({ repo: REPO, issueNumber: 41, mode: "tdd" });
      await store.recordRunStarted(REPO, 41, { runId: run.id, mode: "tdd" });
      // The integration fast-path skips re-review when the rebase's net diff is unchanged,
      // so passing the final phase is NOT the hand-off signal — status stays running.
      await store.events.appendToIssue(REPO, 41, [
        { type: "ReviewPhasePassed", data: { runId: String(run.id), phase: 2 } },
      ]);
      expect(store.getRun(run.id)?.status).toBe("running");
      // The explicit ReviewPassed fact is what pins awaiting-merge.
      await store.recordReviewPassed(REPO, 41, { runId: run.id });
      expect(store.getRun(run.id)?.status).toBe("awaiting-merge");
    });

    it("listRunsByStatus folds the projected status", async () => {
      const a = store.upsertRun({ repo: REPO, issueNumber: 42, mode: "tdd" });
      await store.recordRunStarted(REPO, 42, { runId: a.id, mode: "tdd" });
      await store.recordCiAwaited(REPO, 42, { runId: a.id });
      const b = store.upsertRun({ repo: REPO, issueNumber: 43, mode: "tdd" });
      await store.recordRunStarted(REPO, 43, { runId: b.id, mode: "tdd" });
      await store.recordReviewPassed(REPO, 43, { runId: b.id });

      expect(store.listRunsByStatus(REPO, "awaiting-ci").map((r) => r.issueNumber)).toEqual([42]);
      expect(store.listRunsByStatus(REPO, "awaiting-merge").map((r) => r.issueNumber)).toEqual([43]);
      expect(store.listRunsByStatus(REPO, "running")).toHaveLength(0);
    });

    it("folds the latest span — a re-pickup after a terminal run reflects the new span", async () => {
      const run = store.upsertRun({ repo: REPO, issueNumber: 44, mode: "tdd" });
      await store.recordRunStarted(REPO, 44, { runId: run.id, mode: "tdd" });
      await store.recordMerged(REPO, 44, { runId: run.id, prNumber: 1 });
      await store.recordRunEnded(REPO, 44, { runId: run.id, outcome: "merged" });
      expect(store.getRun(run.id)?.status).toBe("merged");

      // A re-pickup opens a fresh RunStarted span: the status fold reflects the new span,
      // not the prior terminal (appended history, no destructive delete, ADR-0022).
      await store.recordRunStarted(REPO, 44, { runId: run.id, mode: "tdd" });
      expect(store.getRun(run.id)?.status).toBe("running");
    });

    it("the closed-orphan terminal (RunEnded { closed }) projects the effect-neutral closed status", async () => {
      const run = store.upsertRun({ repo: REPO, issueNumber: 45, mode: "tdd" });
      await store.recordRunStarted(REPO, 45, { runId: run.id, mode: "tdd" });
      // The orphan-discard's terminal marker for an issue that concluded out-of-band.
      await store.recordRunEnded(REPO, 45, { runId: run.id, outcome: "closed" });
      expect(store.getRun(run.id)?.status).toBe("closed");
    });

    it("reads the run-read default before any status fact (a FixAttempted-only stream)", async () => {
      // A row whose stream carries no status-defining fact (only a fix attempt) folds to
      // status `none` — there is no longer a bootstrap column to overlay, so the read
      // returns the `running` default (issue #83).
      const run = store.upsertRun({ repo: REPO, issueNumber: 46, mode: "tdd" });
      await store.recordFixAttempt(REPO, 46, { runId: run.id, phase: 1 });
      expect(store.getRun(run.id)?.status).toBe("running");
    });
  });

  // The fix-attempt counter is event-sourced (issue #78/#83): `recordFixAttempt` appends a
  // `FixAttempted`, `recordReviewPhaseEntered` opens a fresh span, and `getFixAttempts`
  // reads the folded projection. These assert through the store seam (record → read-back),
  // never the event-table internals.
  describe("fix-attempt counters (event-sourced)", () => {
    it("record and re-enter per phase (append → fold → derived count)", async () => {
      const run = store.upsertRun({ repo: REPO, issueNumber: 3, mode: "tdd" });
      expect(store.getFixAttempts(run.id, 1)).toBe(0);
      expect(await store.recordFixAttempt(REPO, 3, { runId: run.id, phase: 1 })).toBe(1);
      expect(await store.recordFixAttempt(REPO, 3, { runId: run.id, phase: 1 })).toBe(2);
      // The synchronous read agrees with the append's returned count.
      expect(store.getFixAttempts(run.id, 1)).toBe(2);
      // Counts are per phase; phase 2 is untouched by phase 1's attempts.
      expect(store.getFixAttempts(run.id, 2)).toBe(0);
      await store.recordReviewPhaseEntered(REPO, 3, { runId: run.id, phase: 1 });
      expect(store.getFixAttempts(run.id, 1)).toBe(0);
    });

    it("re-entering a phase yields a fresh count without losing prior events", async () => {
      const run = store.upsertRun({ repo: REPO, issueNumber: 4, mode: "tdd" });
      await store.recordReviewPhaseEntered(REPO, 4, { runId: run.id, phase: 1 }); // first span
      await store.recordFixAttempt(REPO, 4, { runId: run.id, phase: 1 });
      await store.recordFixAttempt(REPO, 4, { runId: run.id, phase: 1 });
      expect(store.getFixAttempts(run.id, 1)).toBe(2);

      // Re-entering the phase opens a fresh span — the count starts over by construction.
      await store.recordReviewPhaseEntered(REPO, 4, { runId: run.id, phase: 1 });
      expect(store.getFixAttempts(run.id, 1)).toBe(0);
      expect(await store.recordFixAttempt(REPO, 4, { runId: run.id, phase: 1 })).toBe(1);

      // The reset was non-destructive: every FixAttempted event is still in the log
      // (two from the first span + one from the second + the two ReviewPhaseEntered).
      const agg = await store.events.aggregateIssue(REPO, 4);
      expect(agg.version).toBe(5n);
    });

    it("counts are isolated per run/issue", async () => {
      const a = store.upsertRun({ repo: REPO, issueNumber: 5, mode: "tdd" });
      const b = store.upsertRun({ repo: REPO, issueNumber: 6, mode: "tdd" });
      await store.recordFixAttempt(REPO, 5, { runId: a.id, phase: 1 });
      await store.recordFixAttempt(REPO, 5, { runId: a.id, phase: 1 });
      await store.recordFixAttempt(REPO, 6, { runId: b.id, phase: 1 });
      expect(store.getFixAttempts(a.id, 1)).toBe(2);
      expect(store.getFixAttempts(b.id, 1)).toBe(1);
    });
  });

  // The per-phase route is event-sourced (ADR-0037 P3.1 / issue #164): `recordRouteResolved`
  // appends a `RouteResolved` at dispatch and `getRunRoute` reads the inline projection's folded
  // latest-wins route — the same append → fold → derived-read shape as the fix-attempt counter.
  describe("per-phase route (event-sourced)", () => {
    it("records the dispatched route and reads it back through the projection", async () => {
      const run = store.upsertRun({ repo: REPO, issueNumber: 64, mode: "tdd" });
      expect(store.getRunRoute(run.id)).toBeNull(); // no dispatch yet
      await store.recordRouteResolved(REPO, 64, {
        runId: run.id,
        phase: "impl",
        route: { provider: "claude", model: "opus", account: "c1" },
      });
      expect(store.getRunRoute(run.id)).toEqual({ provider: "claude", model: "opus", account: "c1" });
    });

    it("is latest-wins: a re-dispatch overwrites the recorded route (one route per container)", async () => {
      const run = store.upsertRun({ repo: REPO, issueNumber: 65, mode: "tdd" });
      await store.recordRouteResolved(REPO, 65, { runId: run.id, phase: "impl", route: { provider: "claude", account: "c1" } });
      // A later phase / a resume re-dispatches onto a different account; the latest wins.
      await store.recordRouteResolved(REPO, 65, { runId: run.id, phase: "review-1", route: { provider: "zai", model: "glm-5.2", account: "z3" } });
      expect(store.getRunRoute(run.id)).toEqual({ provider: "zai", model: "glm-5.2", account: "z3" });
      // Non-destructive: both RouteResolved facts remain in the log (run-start + two routes).
      const agg = await store.events.aggregateIssue(REPO, 65);
      expect(agg.version).toBe(2n);
    });
  });

  // Slice 7 / the final strangler cleanup (ADR-0025, issue #83): with every cluster on
  // events, the temporary CRUD-mutation shims and the superseded stored state are gone —
  // the append-only model is the only model left.
  describe("append-only is the only model (issue #83)", () => {
    it("the run-status / fix-attempt mutation shims are deleted from both store views", () => {
      const view = (o: object) => o as unknown as Record<string, unknown>;
      for (const shim of ["setRunStatus", "incrementFixAttempts", "resetFixAttempts"]) {
        expect(view(store)[shim], `Store.${shim}`).toBeUndefined();
        expect(view(store.forRepo(REPO))[shim], `ScopedStore.${shim}`).toBeUndefined();
      }
    });

    it("rebuilds current state by folding the local event log on reopen (no data migration)", async () => {
      // A run's status and fix-attempt count live ONLY in its issue stream now. A reopened
      // store (the SQLite file survived) folds them back identically — rebuildability holds
      // with no migration step (ADR-0003/0025), the same way GitHub re-derivation would.
      const dir = mkdtempSync(join(tmpdir(), "ralph-rebuild-"));
      const path = join(dir, "ralph.sqlite");
      const s1 = openStore(path);
      const run = s1.upsertRun({ repo: REPO, issueNumber: 70, mode: "tdd" });
      await s1.recordRunStarted(REPO, 70, { runId: run.id, mode: "tdd" });
      await s1.recordFixAttempt(REPO, 70, { runId: run.id, phase: 1 });
      await s1.recordReviewPassed(REPO, 70, { runId: run.id });
      s1.close();

      const s2 = openStore(path);
      const reopened = s2.getRunByIssue(REPO, 70)!;
      expect(reopened.status).toBe("awaiting-merge"); // folded from ReviewPassed, never a column
      expect(s2.getFixAttempts(reopened.id, 1)).toBe(1); // folded from FixAttempted
      s2.close();
    });
  });

  describe("resume context", () => {
    const question = {
      headline: "Drop the legacy adapter?",
      feature: "Ingestion",
      whereWeStand: "Review wants it gone.",
      decision: "Remove it or keep behind a flag?",
      stakes: "One-way door for old consumers.",
      recommendation: "Keep behind a flag.",
    };

    it("round-trips a typed resume payload", () => {
      const run = store.upsertRun({ repo: REPO, issueNumber: 4, mode: "tdd" });
      store.setResumeContext(run.id, { question, commentId: 77 }, "ralph/4-x");
      const ctx = store.getResumeContext(run.id);
      expect(ctx?.branch).toBe("ralph/4-x");
      // No phase → an impl-agent escalate (impl resume).
      expect(ctx?.context.phase).toBeUndefined();
      expect(ctx?.context.question.headline).toBe("Drop the legacy adapter?");
      expect(ctx?.context.commentId).toBe(77);
    });

    it("overwrites on a second checkpoint (escalate → review-maxed)", () => {
      const run = store.upsertRun({ repo: REPO, issueNumber: 5, mode: "tdd" });
      store.setResumeContext(run.id, { question });
      store.setResumeContext(run.id, { phase: 1, question, commentId: 91 });
      const ctx = store.getResumeContext(run.id);
      // The second checkpoint overwrote the first: its review phase and comment id win.
      expect(ctx?.context.phase).toBe(1);
      expect(ctx?.context.commentId).toBe(91);
    });

    it("folds over the latest run span — a re-pickup (RunStarted) resets it", async () => {
      const run = store.upsertRun({ repo: REPO, issueNumber: 7, mode: "tdd" });
      store.setResumeContext(run.id, { question, commentId: 5 }, "ralph/7-x");
      expect(store.getResumeContext(run.id)).toBeDefined();
      // A re-pickup appends a fresh `RunStarted` span (appended history, no destructive
      // delete, ADR-0022). The resume context is a projection over the *latest* span, so
      // the new span starts with no checkpoint until it escalates again.
      await store.events.appendToIssue(REPO, 7, [
        { type: "RunStarted", data: { runId: String(run.id), mode: "tdd", branch: "ralph/7-x" } },
      ]);
      expect(store.getResumeContext(run.id)).toBeUndefined();
    });
  });

  describe("open-question index", () => {
    it("adds, lists open, and answers", async () => {
      const run = store.upsertRun({ repo: REPO, issueNumber: 6, mode: "tdd" });
      const q = await store.addQuestion({
        repo: REPO,
        issueNumber: 6,
        runId: run.id,
        kind: "escalate",
        headline: "Which auth flow?",
      });
      expect(q.repo).toBe(REPO);
      expect(store.listOpenQuestions(REPO)).toHaveLength(1);

      await store.answerQuestion(q.id);
      expect(store.listOpenQuestions(REPO)).toHaveLength(0);
      expect(store.getQuestion(q.id)?.status).toBe("answered");
      expect(store.getQuestion(q.id)?.answeredAt).not.toBeNull();
    });

    it("restores an awaiting-answer status with an already-answered compensation batch", async () => {
      const run = store.upsertRun({ repo: REPO, issueNumber: 16, mode: "tdd" });
      await store.restorePausedStatus(REPO, 16, {
        runId: run.id,
        status: "awaiting-answer",
        headline: "Which auth flow?",
        commentId: 616,
      });

      expect(store.getRun(run.id)?.status).toBe("awaiting-answer");
      expect(store.listOpenQuestions(REPO)).toHaveLength(0);
    });

    it("restores a review-maxed status without opening a fresh heal question", async () => {
      const run = store.upsertRun({ repo: REPO, issueNumber: 17, mode: "tdd" });
      await store.restorePausedStatus(REPO, 17, {
        runId: run.id,
        status: "review-maxed",
        phase: 1,
        commentId: 717,
      });

      expect(store.getRun(run.id)?.status).toBe("review-maxed");
      expect(store.listOpenQuestions(REPO)).toHaveLength(0);
    });
  });

  describe("agent bookkeeping", () => {
    it("tracks active agents and phase transitions", () => {
      const run = store.upsertRun({ repo: REPO, issueNumber: 8, mode: "infra" });
      const agent = store.addAgent({
        runId: run.id,
        worktreePath: "/wt/8",
        branch: "ralph/8-y",
      });
      store.setAgentPhase(agent.id, "review:1");
      expect(store.listActiveAgents()).toHaveLength(1);
      expect(store.getAgent(agent.id)?.phase).toBe("review:1");
      store.endAgent(agent.id);
      expect(store.listActiveAgents()).toHaveLength(0);
    });

    it("stamps the phase clock at creation and re-stamps on each phase change", () => {
      // A clock that advances one second per read makes the re-stamp observable.
      let t = 0;
      const tick = (): string => new Date(t++ * 1000).toISOString();
      const s = openStore(MEMORY_DB, { now: tick });
      const run = s.upsertRun({ repo: REPO, issueNumber: 9, mode: "tdd" });
      const created = s.addAgent({ runId: run.id, worktreePath: "/wt/9", branch: "ralph/9" });
      // Fresh agent: the phase clock matches the start.
      expect(created.phaseStartedAt).toBe(created.startedAt);

      s.setAgentPhase(created.id, "fix-1");
      const after = s.getAgent(created.id)!;
      // The phase clock advanced; the run start did not.
      expect(after.startedAt).toBe(created.startedAt);
      expect(after.phaseStartedAt).not.toBe(created.phaseStartedAt);
      expect(Date.parse(after.phaseStartedAt!)).toBeGreaterThan(Date.parse(created.startedAt));
      s.close();
    });
  });

  describe("daemon backlog snapshot", () => {
    it("returns null before the first tick, then round-trips and overwrites", () => {
      expect(store.getBacklogSnapshot(REPO)).toBeNull();

      store.saveBacklogSnapshot(REPO, {
        generatedAt: "2026-06-19T12:00:00.000Z",
        targetRepo: REPO,
        cap: 5,
        reconcileIntervalSeconds: 30,
        daemonStartedAt: "2026-06-19T11:00:00.000Z",
        lastError: null,
        eligible: [{ issueNumber: 7, title: "do a thing", priority: "priority:p0", priorityColor: "red" }],
        blocked: [{ issueNumber: 8, title: "blocked", blockers: [{ ref: 99, satisfied: false }] }],
        paused: [{ issueNumber: 9, title: "paused", state: "awaiting-answer" }],
        manualHolds: [{ issueNumber: 11, title: "held" }],
        modingCandidates: [{ issueNumber: 10, title: "needs a mode" }],
      });

      const got = store.getBacklogSnapshot(REPO)!;
      expect(got.targetRepo).toBe(REPO);
      expect(got.eligible.map((e) => e.issueNumber)).toEqual([7]);
      // The full eligible row round-trips, including the precomputed priority colour.
      expect(got.eligible[0]).toEqual({
        issueNumber: 7,
        title: "do a thing",
        priority: "priority:p0",
        priorityColor: "red",
      });
      expect(got.blocked[0]!.blockers).toEqual([{ ref: 99, satisfied: false }]);
      expect(got.paused[0]!.state).toBe("awaiting-answer");
      expect(got.manualHolds).toEqual([{ issueNumber: 11, title: "held" }]);
      expect(got.modingCandidates).toEqual([{ issueNumber: 10, title: "needs a mode" }]);

      // A second save overwrites this repo's single row, not appends.
      store.saveBacklogSnapshot(REPO, { ...got, generatedAt: "2026-06-19T12:00:30.000Z", eligible: [] });
      const rows = store.db
        .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM daemon_snapshot")
        .get();
      expect(rows!.n).toBe(1);
      expect(store.getBacklogSnapshot(REPO)!.generatedAt).toBe("2026-06-19T12:00:30.000Z");
      expect(store.getBacklogSnapshot(REPO)!.eligible).toEqual([]);
    });

    it("per-repo backlog snapshots are independent", () => {
      const base = {
        generatedAt: "2026-06-19T12:00:00.000Z",
        cap: 5,
        reconcileIntervalSeconds: 30,
        daemonStartedAt: "2026-06-19T11:00:00.000Z",
        lastError: null,
        blocked: [],
        paused: [],
        manualHolds: [],
        modingCandidates: [],
      };
      store.saveBacklogSnapshot("a/x", {
        ...base,
        targetRepo: "a/x",
        eligible: [{ issueNumber: 1, title: "x-one", priority: null, priorityColor: null }],
      });
      store.saveBacklogSnapshot("b/y", {
        ...base,
        targetRepo: "b/y",
        eligible: [{ issueNumber: 2, title: "y-two", priority: null, priorityColor: null }],
      });

      // Each repo reads back only its own payload.
      expect(store.getBacklogSnapshot("a/x")!.eligible.map((e) => e.issueNumber)).toEqual([1]);
      expect(store.getBacklogSnapshot("b/y")!.eligible.map((e) => e.issueNumber)).toEqual([2]);

      // The global view returns both, repo-ordered.
      expect(store.listBacklogSnapshots().map((s) => s.targetRepo)).toEqual(["a/x", "b/y"]);
    });
  });

  describe("run log", () => {
    it("appends and tails newest-first", () => {
      const run = store.upsertRun({ repo: REPO, issueNumber: 9, mode: "tdd" });
      store.appendLog({ runId: run.id, level: "info", event: "first" });
      store.appendLog({ runId: run.id, level: "warn", event: "second", data: { detail: true } });
      const tail = store.tailLog(run.id);
      expect(tail).toHaveLength(2);
      expect(tail[0]!.event).toBe("second");
      expect(tail[0]!.data).toEqual({ detail: true });
    });

    it("tails recent entries across every run, newest-first", () => {
      const a = store.upsertRun({ repo: REPO, issueNumber: 10, mode: "tdd" });
      const b = store.upsertRun({ repo: REPO, issueNumber: 11, mode: "tdd" });
      store.appendLog({ runId: a.id, level: "info", event: "a1" });
      store.appendLog({ runId: b.id, level: "info", event: "b1" });
      store.appendLog({ runId: a.id, level: "info", event: "a2" });
      const recent = store.recentLog(2);
      expect(recent.map((e) => e.event)).toEqual(["a2", "b1"]);
    });

    it("logSince returns entries at/after a cutoff, oldest-first (the analytics window)", () => {
      let ts = "";
      const clocked = openStore(MEMORY_DB, { now: () => ts });
      try {
        const a = clocked.upsertRun({ repo: REPO, issueNumber: 10, mode: "tdd" });
        ts = "2026-06-01T00:00:00.000Z";
        clocked.appendLog({ runId: a.id, level: "info", event: "old" });
        ts = "2026-06-20T00:00:00.000Z";
        clocked.appendLog({ runId: a.id, level: "info", event: "in1" });
        ts = "2026-06-21T00:00:00.000Z";
        clocked.appendLog({ runId: a.id, level: "info", event: "in2" });

        const since = clocked.logSince("2026-06-15T00:00:00.000Z");
        expect(since.map((e) => e.event)).toEqual(["in1", "in2"]); // oldest-first, cutoff excludes "old"
      } finally {
        clocked.close();
      }
    });

    it("runStartTimes returns each run's earliest log timestamp (the time-to-merge anchor)", () => {
      let ts = "";
      const clocked = openStore(MEMORY_DB, { now: () => ts });
      try {
        const a = clocked.upsertRun({ repo: REPO, issueNumber: 10, mode: "tdd" });
        const b = clocked.upsertRun({ repo: REPO, issueNumber: 11, mode: "tdd" });
        ts = "2026-06-20T09:00:00.000Z";
        clocked.appendLog({ runId: a.id, level: "info", event: "pickup" });
        ts = "2026-06-20T12:00:00.000Z";
        clocked.appendLog({ runId: a.id, level: "info", event: "merged" });
        ts = "2026-06-21T08:00:00.000Z";
        clocked.appendLog({ runId: b.id, level: "info", event: "pickup" });
        // A daemon-global entry (no run id) must not produce a spurious start row.
        clocked.appendLog({ level: "info", event: "reconcile.tick-failed" });

        const starts = Object.fromEntries(clocked.runStartTimes().map((s) => [s.runId, s.startedAt]));
        expect(starts[a.id]).toBe("2026-06-20T09:00:00.000Z"); // earliest, not the merge ts
        expect(starts[b.id]).toBe("2026-06-21T08:00:00.000Z");
        expect(Object.keys(starts)).toHaveLength(2); // the null-run entry is excluded
      } finally {
        clocked.close();
      }
    });

    it("latestAnomalies returns the newest daemon-anomaly reason per (repo, issue)", () => {
      // Issue 42 re-surfaced with a fresher reason; the later row must win.
      store.appendLog({ repo: REPO, issueNumber: 42, level: "warn", event: "daemon-anomaly", data: { reason: "stale-reason" } });
      store.appendLog({ repo: REPO, issueNumber: 7, level: "warn", event: "daemon-anomaly", data: { reason: "run-wedged-past-lifetime" } });
      // Chatter between the edges must not bury the reason (it is logged once at the edge).
      store.appendLog({ repo: REPO, issueNumber: 42, level: "info", event: "review-worklist" });
      store.appendLog({ repo: REPO, issueNumber: 42, level: "warn", event: "daemon-anomaly", data: { reason: "paused-label-missing-run" } });
      // A different repo, same issue number — keyed independently.
      store.appendLog({ repo: "other/repo", issueNumber: 42, level: "warn", event: "daemon-anomaly", data: { reason: "unclassified" } });

      const anomalies = store.latestAnomalies();
      const byKey = Object.fromEntries(anomalies.map((a) => [`${a.repo}#${a.issueNumber}`, a.data?.reason]));
      expect(byKey[`${REPO}#42`]).toBe("paused-label-missing-run"); // newest reason, not the stale one
      expect(byKey[`${REPO}#7`]).toBe("run-wedged-past-lifetime");
      expect(byKey["other/repo#42"]).toBe("unclassified");
      // Exactly one row per (repo, issue) with the event — no duplicates.
      expect(anomalies).toHaveLength(3);
      expect(anomalies.every((a) => a.event === "daemon-anomaly")).toBe(true);
    });
  });

  describe("listRunsByStatus", () => {
    it("returns only runs in the given status, queue-ordered", async () => {
      const a = store.upsertRun({ repo: REPO, issueNumber: 30, mode: "tdd" });
      const b = store.upsertRun({ repo: REPO, issueNumber: 31, mode: "tdd" });
      const c = store.upsertRun({ repo: REPO, issueNumber: 32, mode: "tdd" });
      // Status is event-sourced (issue #83): seed it via the matching facts.
      await store.addQuestion({ repo: REPO, issueNumber: 30, runId: a.id, kind: "escalate", headline: "q" });
      await store.addQuestion({ repo: REPO, issueNumber: 32, runId: c.id, kind: "escalate", headline: "q" });
      await store.recordReviewMaxedQuestion(REPO, 31, { runId: b.id, phase: 1, headline: "q" });
      const awaiting = store.listRunsByStatus(REPO, "awaiting-answer").map((r) => r.issueNumber);
      expect(awaiting).toEqual([30, 32]);
      expect(store.listRunsByStatus(REPO, "review-maxed").map((r) => r.issueNumber)).toEqual([31]);
    });
  });
});

describe("push subscriptions (PWA web push, issue #119)", () => {
  let store: Store;
  beforeEach(() => {
    store = openStore(MEMORY_DB);
  });
  afterEach(() => {
    store.close();
  });

  it("persists a subscription and reads it back", () => {
    store.upsertPushSubscription({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      p256dh: "BG...p256dh",
      auth: "authsecret",
    });
    expect(store.listPushSubscriptions()).toEqual([
      {
        endpoint: "https://fcm.googleapis.com/fcm/send/abc",
        p256dh: "BG...p256dh",
        auth: "authsecret",
      },
    ]);
    expect(store.getPushSubscription("https://fcm.googleapis.com/fcm/send/abc")?.auth).toBe("authsecret");
    expect(store.getPushSubscription("https://fcm.googleapis.com/fcm/send/missing")).toBeUndefined();
  });

  it("upserts on a duplicate endpoint (a device refreshing its keys, not a stranded row)", () => {
    store.upsertPushSubscription({ endpoint: "ep", p256dh: "k1", auth: "a1" });
    store.upsertPushSubscription({ endpoint: "ep", p256dh: "k2", auth: "a2" });
    expect(store.listPushSubscriptions()).toHaveLength(1);
    expect(store.getPushSubscription("ep")?.p256dh).toBe("k2");
  });

  it("deletes by endpoint and is a no-op when already gone", () => {
    store.upsertPushSubscription({ endpoint: "ep", p256dh: "k", auth: "a" });
    store.deletePushSubscription("ep");
    store.deletePushSubscription("ep"); // no throw
    expect(store.listPushSubscriptions()).toEqual([]);
  });

  it("survives a restart (subscriptions are durable runtime state, unlike run rows)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-push-"));
    const path = join(dir, "ralph.sqlite");
    const s1 = openStore(path);
    s1.upsertPushSubscription({ endpoint: "ep", p256dh: "k", auth: "a" });
    s1.close();
    const s2 = openStore(path);
    expect(s2.listPushSubscriptions().map((s) => s.endpoint)).toEqual(["ep"]);
    s2.close();
  });
});

describe("busy_timeout (concurrent monitor process)", () => {
  it("configures a non-zero busy_timeout on the connection", () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-busy-"));
    const store = openStore(join(dir, "ralph.sqlite"));
    try {
      const timeout = store.db.pragma("busy_timeout", { simple: true });
      expect(timeout).toBe(5000);
    } finally {
      store.close();
    }
  });

  it("daemon write retries instead of throwing SQLITE_BUSY while the monitor holds the write lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-busy-"));
    const path = join(dir, "ralph.sqlite");
    // Daemon connection — creates the schema and (after the fix) sets busy_timeout.
    const store = openStore(path);

    // Simulate a separate process opening the same DB file (historically the
    // out-of-band monitors; the web control plane reads in-process, but any external
    // reader behaves the same) and grabbing the write lock (BEGIN IMMEDIATE),
    // holding it briefly, then releasing it. A separate thread is required:
    // better-sqlite3 is synchronous, so the lock must be released by something
    // other than the daemon's own (blocked) thread for busy_timeout to do its job.
    const monitorCode = `
      const { parentPort, workerData } = require("node:worker_threads");
      const Database = require("better-sqlite3");
      const db = new Database(workerData.path);
      db.pragma("busy_timeout = 5000");
      db.exec("BEGIN IMMEDIATE");
      parentPort.postMessage("locked");
      setTimeout(() => {
        db.exec("COMMIT");
        db.close();
        parentPort.postMessage("released");
      }, 300);
    `;
    const monitor = new Worker(monitorCode, { eval: true, workerData: { path } });
    try {
      await new Promise<void>((resolve, reject) => {
        monitor.once("message", (m) => (m === "locked" ? resolve() : reject(new Error(`unexpected: ${m}`))));
        monitor.once("error", reject);
      });

      // The monitor now holds the write lock. Without busy_timeout this throws
      // SQLITE_BUSY immediately; with it, the write blocks until the monitor
      // releases (~300ms) and then succeeds.
      expect(() => store.upsertRun({ repo: REPO, issueNumber: 1, mode: "tdd" })).not.toThrow();
      expect(store.getRunByIssue(REPO, 1)?.mode).toBe("tdd");
    } finally {
      store.close();
      await monitor.terminate();
    }
  });
});

describe("run complexity tier (issue #278)", () => {
  it("persists the tier on create, reads it back, and defaults to null when absent", () => {
    const store = openStore(MEMORY_DB).forRepo(REPO);
    const tiered = store.upsertRun({ issueNumber: 41, mode: "tdd", tier: 1 });
    expect(tiered.tier).toBe(1);
    expect(store.getRunByIssue(41)?.tier).toBe(1);
    const untiered = store.upsertRun({ issueNumber: 42, mode: "infra" });
    expect(untiered.tier).toBeNull();
  });

  it("an upsert overwrites the tier — including back to null when the label is gone", () => {
    const store = openStore(MEMORY_DB).forRepo(REPO);
    store.upsertRun({ issueNumber: 43, mode: "tdd", tier: 3 });
    expect(store.getRunByIssue(43)?.tier).toBe(3);
    store.upsertRun({ issueNumber: 43, mode: "tdd", tier: 2 });
    expect(store.getRunByIssue(43)?.tier).toBe(2);
    store.upsertRun({ issueNumber: 43, mode: "tdd" });
    expect(store.getRunByIssue(43)?.tier).toBeNull();
  });
});
