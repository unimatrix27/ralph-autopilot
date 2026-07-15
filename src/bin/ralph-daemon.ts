#!/usr/bin/env node
/**
 * The daemon entry point (DESIGN §1). Loads config, opens the SQLite store,
 * builds a logger, and runs reconcile ticks until a shutdown signal fires. This
 * is the long-lived process you leave running on the box; `runDaemon`
 * (daemon.ts) does the production wiring of the gh client, worktree manager, SDK
 * agents, executor, and review loop.
 *
 * Graceful shutdown (issue #35): the first SIGTERM/SIGINT — or a separate
 * `ralph-daemon --drain` invocation — starts a *drain*. New pickups/resumes
 * stop; the in-flight agents finish (review + merge); then the daemon exits 0
 * with nothing wedged. A configurable `scheduler.drainTimeoutSeconds` force-exits
 * a stalled drain and surfaces what was still running; a *second* signal forces
 * an immediate stop. See docs/OPERATING.md §3.
 *
 * Self-update (issue #30, ADR-0018): with `selfUpdate.enabled`, the daemon also
 * polls its own repo; on a new commit it drains and exits RESTART_EXIT_CODE (75)
 * so a supervisor (ops/ralph-supervisor.sh) pulls + builds + relaunches it. See
 * docs/SELF-UPDATE.md.
 *
 * Usage:
 *   ralph-daemon                     (reads .ralph/config.yaml)
 *   ralph-daemon --config path.yaml
 *   ralph-daemon --drain             (signal a running daemon to drain & exit)
 */

import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_CONFIG_PATH, loadConfig } from "../config/load";
import { openStore } from "../store/store";
import { createLogger } from "../log/logger";
import { runDaemon } from "../daemon/daemon";
import { RESTART_EXIT_CODE } from "../daemon/self-update";
import { ensureSingleton } from "../daemon/singleton";

interface CliArgs {
  config?: string;
  /** Signal a running daemon to drain, then exit (no new daemon is started). */
  drain: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { drain: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config" || arg === "-c") {
      args.config = argv[++i];
    } else if (arg === "--drain") {
      args.drain = true;
    }
  }
  return args;
}

/** The PID file the running daemon writes, next to its SQLite database. */
function pidFilePath(databasePath: string): string {
  return join(dirname(databasePath), "daemon.pid");
}

/**
 * `--drain` control: read the running daemon's PID and send it SIGTERM (which it
 * handles as a graceful drain). Throws a clear message if no daemon is running —
 * including a *stale* PID file (a crash that skipped cleanup): signal 0 probes
 * liveness without touching the process, so we never SIGTERM an unrelated process
 * that recycled the PID.
 */
function signalDrain(pidFile: string): number {
  let raw: string;
  try {
    raw = readFileSync(pidFile, "utf8").trim();
  } catch {
    throw new Error(`no running daemon found (missing PID file ${pidFile})`);
  }
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`invalid PID ${JSON.stringify(raw)} in ${pidFile}`);
  }
  try {
    process.kill(pid, 0); // liveness probe: does this process exist?
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      // No such process — a stale PID file from a crash. Clean it up and report.
      try {
        rmSync(pidFile, { force: true });
      } catch {
        /* best effort */
      }
      throw new Error(`no running daemon found (stale PID file ${pidFile}; pid ${pid} not running)`);
    }
    // EPERM etc. — the process exists but we can't probe it; fall through to SIGTERM.
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    throw new Error(`failed to signal daemon (pid ${pid}): ${err instanceof Error ? err.message : String(err)}`);
  }
  return pid;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.config);
  const pidFile = pidFilePath(config.paths.database);

  // Control mode: tell the running daemon to drain, then exit — start nothing.
  if (args.drain) {
    const pid = signalDrain(pidFile);
    process.stdout.write(`ralph-daemon: sent graceful-drain signal to daemon (pid ${pid})\n`);
    return 0;
  }

  const logFile = config.logging.file;
  const logger = createLogger({
    level: config.logging.level,
    // Always to stdout (so you can watch / tee it); also append to the
    // configured log file if set. The logger already redacts secrets per line.
    write: (line) => {
      process.stdout.write(line + "\n");
      if (logFile) {
        try {
          appendFileSync(logFile, line + "\n");
        } catch {
          /* stdout already carries the line; a log-file write error is non-fatal */
        }
      }
    },
  });

  // Singleton guard (issue #240): BEFORE opening the store, reap any other live
  // daemon that owns it. Two daemons reconciling one repo/store race — colliding
  // `docker run` names and cross-killing each other's orphan sweep — which is the
  // root cause of the 2026-06-29 review-maxed storm. The newcomer wins (operator
  // intent); resume-not-restart rehydrates whatever the reaped daemon was driving.
  // Throws (→ non-zero exit, supervisor surfaces a daemon-anomaly) only if a
  // verified incumbent survives SIGKILL — proceeding would re-create the race.
  await ensureSingleton({ pidFile, logger });

  const store = openStore(config.paths.database);

  // The store's open created the `.ralph/` dir, so the PID file write is safe now.
  // It lets `ralph-daemon --drain` find this process and is the singleton token the
  // next daemon's guard reads.
  try {
    writeFileSync(pidFile, String(process.pid));
  } catch (err) {
    logger.warn("daemon.pidfile-write-failed", { pidFile, error: String(err) });
  }

  // Two-stage shutdown (issue #35): the first signal drains gracefully; a second
  // forces an immediate stop, abandoning in-flight runs.
  const drainController = new AbortController();
  const forceController = new AbortController();
  let signalCount = 0;
  const onSignal = (signal: string): void => {
    signalCount += 1;
    if (signalCount === 1) {
      logger.info("daemon.signal", { signal, action: "drain" });
      drainController.abort();
    } else {
      logger.warn("daemon.signal", { signal, action: "force" });
      forceController.abort();
    }
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  try {
    const outcome = await runDaemon(
      // Absolute config path so `container`-mode runs can bind-mount it into the runner (ADR-0038).
      { config, store, logger, configPath: resolve(args.config ?? DEFAULT_CONFIG_PATH) },
      { drain: drainController.signal, force: forceController.signal },
    );
    // Self-update (issue #30): the daemon drained because its own repo is behind.
    // Exit the dedicated restart code so the supervisor pulls + builds + relaunches.
    // A still-in-flight (timeout/forced) drain still restarts — the next startup
    // rehydrates in-flight runs from GitHub (ADR-0003), so nothing is abandoned.
    if (outcome.restartForUpdate) {
      logger.info("daemon.restart-for-update", {
        outcome: outcome.outcome,
        stillInFlight: outcome.stillInFlight,
        exitCode: RESTART_EXIT_CODE,
      });
      return RESTART_EXIT_CODE;
    }
    if (outcome.outcome !== "completed") {
      logger.warn("daemon.drain-incomplete", {
        outcome: outcome.outcome,
        stillInFlight: outcome.stillInFlight,
      });
      return 1;
    }
    return 0;
  } finally {
    store.close();
    try {
      rmSync(pidFile, { force: true });
    } catch {
      /* a leftover PID file is harmless; --drain reports a missing daemon clearly */
    }
  }
}

main()
  .then((code) => {
    process.exitCode = code;
    // A clean drain (code 0) leaves no live handles, so the process exits on its
    // own — flushing all buffered stdout. A forced/timeout drain (code != 0)
    // abandons live agent sessions that would otherwise keep the event loop
    // alive, so we must force exit — but flush stdout first so the
    // still-in-flight diagnostic survives a piped stdout.
    if (code !== 0) {
      process.stdout.write("", () => process.exit(code));
    }
  })
  .catch((err) => {
    process.stderr.write(`ralph-daemon: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
