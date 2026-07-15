import type { Database } from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  up: string;
}

/**
 * Ordered, append-only schema migrations. Each is applied at most once and
 * recorded in `schema_migrations`, so running them is idempotent: re-applying
 * on an up-to-date database is a no-op.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial-schema",
    up: `
      CREATE TABLE runs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_number  INTEGER NOT NULL UNIQUE,
        mode          TEXT    NOT NULL,
        status        TEXT    NOT NULL,
        branch        TEXT,
        worktree_path TEXT,
        pr_number     INTEGER,
        agent_pid     INTEGER,
        created_at    TEXT    NOT NULL,
        updated_at    TEXT    NOT NULL
      );

      CREATE TABLE fix_attempts (
        run_id   INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        phase    INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, phase)
      );

      CREATE TABLE resume_context (
        run_id     INTEGER PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        branch     TEXT,
        context    TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE open_questions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_number INTEGER NOT NULL,
        run_id       INTEGER REFERENCES runs(id) ON DELETE SET NULL,
        kind         TEXT    NOT NULL,
        headline     TEXT    NOT NULL,
        comment_id   INTEGER,
        status       TEXT    NOT NULL DEFAULT 'open',
        created_at   TEXT    NOT NULL,
        answered_at  TEXT
      );
      CREATE INDEX idx_open_questions_status ON open_questions(status);
      CREATE INDEX idx_open_questions_issue ON open_questions(issue_number);

      CREATE TABLE agents (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id        INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        pid           INTEGER,
        worktree_path TEXT    NOT NULL,
        branch        TEXT    NOT NULL,
        phase         TEXT,
        started_at    TEXT    NOT NULL,
        ended_at      TEXT
      );
      CREATE INDEX idx_agents_run ON agents(run_id);

      CREATE TABLE run_log (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id       INTEGER,
        issue_number INTEGER,
        level        TEXT    NOT NULL,
        event        TEXT    NOT NULL,
        data         TEXT,
        ts           TEXT    NOT NULL
      );
      CREATE INDEX idx_run_log_run ON run_log(run_id);
    `,
  },
  {
    version: 2,
    name: "daemon-snapshot",
    // A single-row store-of-record for the per-tick backlog/health snapshot the
    // daemon writes each reconcile tick (issue #20). The read model consumes this
    // row so it can render the whole pipeline (eligible queue, blocked, paused/stuck,
    // daemon health) without a GitHub dependency (ADR-0007). `id` is pinned to 1
    // so each tick overwrites the same row — the snapshot is "latest", not a log.
    // The tick time lives in the JSON payload (`generatedAt`), the sole copy any
    // reader uses, so there is no separate `generated_at` column to keep in sync.
    up: `
      CREATE TABLE daemon_snapshot (
        id      INTEGER PRIMARY KEY CHECK (id = 1),
        payload TEXT    NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: "agent-phase-timer",
    // Per-phase timer for live views (issue #20): impl→review→fix reuse a
    // single agent row and only flip the phase label, so `started_at` measures the
    // whole run, not the current (fresh) SDK session. Stamp the phase's start so
    // the read model can show elapsed time that matches the fresh review/fix session.
    up: `
      ALTER TABLE agents ADD COLUMN phase_started_at TEXT;
    `,
  },
  {
    version: 4,
    name: "drop-dead-pid-columns",
    // SDK sessions run in-process (ADR-0008), so there is never a child agent pid
    // to record — `runs.agent_pid` and `agents.pid` were always NULL and had no
    // readers (issue #15). Drop both. Neither is indexed or referenced, so the
    // column drops are clean.
    up: `
      ALTER TABLE runs DROP COLUMN agent_pid;
      ALTER TABLE agents DROP COLUMN pid;
    `,
  },
  {
    version: 5,
    name: "multi-repo",
    // Multi-target support (ADR-0020): GitHub issue numbers are NOT unique across
    // repos, so every issue-keyed row gains a `repo` slug and `runs` swaps its
    // UNIQUE(issue_number) for UNIQUE(repo, issue_number).
    //
    // Backfill = rebuild-from-GitHub (ADR-0003): runtime state is rebuildable, so
    // rather than guess the repo for legacy rows (a migration's static SQL cannot
    // read config), we clear the runtime tables. The next boot's per-repo
    // rehydrate() re-derives every in-flight/paused run from open PRs. Cut over with
    // the daemon drained (no in-flight work) and nothing is lost — GitHub is the
    // source of truth. The AUTOINCREMENT id counters reset with the table rebuild,
    // so orphaned child rows (agents/run_log referencing old ids) MUST be cleared to
    // avoid colliding with fresh ids. The recreated `runs` omits `agent_pid` (dropped
    // in v4).
    up: `
      DELETE FROM fix_attempts;
      DELETE FROM resume_context;
      DELETE FROM agents;
      DELETE FROM open_questions;
      DELETE FROM run_log;
      DELETE FROM runs;
      DROP TABLE runs;
      DELETE FROM sqlite_sequence WHERE name IN ('runs', 'agents', 'open_questions', 'run_log');

      CREATE TABLE runs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        repo          TEXT    NOT NULL,
        issue_number  INTEGER NOT NULL,
        mode          TEXT    NOT NULL,
        status        TEXT    NOT NULL,
        branch        TEXT,
        worktree_path TEXT,
        pr_number     INTEGER,
        created_at    TEXT    NOT NULL,
        updated_at    TEXT    NOT NULL,
        UNIQUE (repo, issue_number)
      );

      ALTER TABLE open_questions ADD COLUMN repo TEXT NOT NULL DEFAULT '';
      ALTER TABLE run_log ADD COLUMN repo TEXT;

      DROP TABLE daemon_snapshot;
      CREATE TABLE daemon_snapshot (
        repo    TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );
    `,
  },
  {
    version: 6,
    name: "drop-crud-state-superseded-by-events",
    // Event-sourcing slice 7 — the final strangler cleanup (ADR-0025, issue #83). Every
    // state cluster is now projected from the append-only issue event log, so the
    // superseded CRUD storage the shims wrote through is dead and dropped: the run's
    // `status`, the `fix_attempts` counter, the `resume_context` checkpoint, and the
    // `open_questions` index. The es_* projections (es_issue_projection / es_resume_context
    // / es_open_questions) are now the only current-state source.
    //
    // No data migration (ADR-0003/0025): current state rehydrates from GitHub and folds
    // from the local event log, so the dead tables are dropped rather than backfilled —
    // the same rebuild-not-migrate stance v5 (multi-repo) took. `run_log` is deliberately
    // NOT dropped: it was never event-sourced (US 14), it stays as observability.
    up: `
      ALTER TABLE runs DROP COLUMN status;
      DROP TABLE fix_attempts;
      DROP TABLE resume_context;
      DROP TABLE open_questions;
    `,
  },
  {
    version: 7,
    name: "web-push-subscriptions",
    // PWA web push (issue #119): the installable control plane's native push channel
    // needs the per-device push subscriptions the browser registers, persisted so they
    // survive a daemon restart (a subscription lives until the device unsubscribes — it is
    // not rebuildable from GitHub, unlike run state). One row per subscription, keyed by
    // the push-service `endpoint` URL (unique, since re-subscribing yields a new one).
    // `p256dh`/`auth` are the browser-generated ECDH public key + auth secret (base64url)
    // the daemon needs to encrypt payloads per RFC 8291. Re-subscribe is an upsert on the
    // endpoint so a device refreshing its keys does not strand a stale row. The daemon always
    // emits `aes128gcm` (RFC 8188), so the content encoding is a dispatcher constant, not
    // persisted state — a real encoding column lands only when a second encoding is supported.
    up: `
      CREATE TABLE push_subscriptions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint   TEXT    NOT NULL UNIQUE,
        p256dh     TEXT    NOT NULL,
        auth       TEXT    NOT NULL,
        created_at TEXT    NOT NULL,
        updated_at TEXT    NOT NULL
      );
    `,
  },
  {
    version: 8,
    name: "run-complexity-tier",
    // Complexity tiers (issue #278): record the issue's `complexity:1|2|3` label's tier on
    // the run row at pickup — non-derived bookkeeping like `branch` (dispatch re-reads the
    // live labels; this is what the run was launched under). Nullable: an unlabeled issue
    // runs on the global agent profile, and every pre-tier row simply has no tier.
    up: `
      ALTER TABLE runs ADD COLUMN tier INTEGER;
    `,
  },
];

/**
 * Apply every migration newer than the database's recorded version inside a
 * single transaction. Idempotent — a second call applies nothing.
 */
export function runMigrations(db: Database): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const currentRow = db
    .prepare<[], { version: number | null }>(
      "SELECT MAX(version) AS version FROM schema_migrations",
    )
    .get();
  const current = currentRow?.version ?? 0;

  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version,
  );
  if (pending.length === 0) {
    return current;
  }

  const record = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  const applyAll = db.transaction(() => {
    let last = current;
    for (const migration of pending) {
      db.exec(migration.up);
      record.run(migration.version, migration.name, new Date().toISOString());
      last = migration.version;
    }
    return last;
  });

  return applyAll();
}
