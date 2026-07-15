/**
 * Daemon singleton guard (issue #240). Two daemons reconciling the same repo +
 * SQLite store race each other catastrophically: they dispatch the same run (the
 * 2nd `docker run --name ralph-ralph-<n>` collides and dies in <1s → "container
 * review run produced no usable result" → spurious `review-maxed`), and each one's
 * orphan-container sweep (`docker ps --filter name=ralph-`) kills the OTHER's
 * in-flight containers. The 2026-06-29 review-maxed storm was exactly this: a
 * daemon that survived *outside* systemd's cgroup as a PPID-1 orphan, racing a
 * freshly-started supervised instance.
 *
 * The defence is a hard singleton enforced at startup, mechanism-agnostic (it does
 * not matter HOW a second daemon came to exist — manual launch, a missed reap on
 * stop, a detached orphan): before a new daemon opens the store it reads the PID
 * file, and if it names a *live, verified* ralph daemon it **reaps that incumbent**
 * (SIGTERM → grace → SIGKILL the group) and takes over. The newcomer wins on
 * purpose — a fresh start / `systemctl restart` is the operator's authoritative
 * intent, and a squatting orphan is exactly what we want gone. resume-not-restart
 * (ADR-0003) rehydrates any in-flight run the reaped daemon was driving.
 *
 * Identity is verified against `/proc/<pid>/cmdline` before any signal so PID reuse
 * (the file names a pid the OS recycled for an unrelated process) can never make us
 * kill a stranger — an unverifiable or non-matching pid is treated as a stale file.
 */

import { readFileSync } from "node:fs";
import type { Logger } from "../log/logger";

/** The substring that identifies a ralph daemon process in its argv. */
const DAEMON_MARKER = "ralph-daemon";

/**
 * The OS process operations the guard needs, injected so the decision logic is
 * unit-testable without spawning real processes (convention: push side effects to
 * the edge behind an interface). {@link nodeProcessControl} is the real binding.
 */
export interface ProcessControl {
  /** `kill(pid, 0)`: true iff the process exists and is signallable by us. */
  isAlive(pid: number): boolean;
  /** The process argv (NUL-joined `/proc/<pid>/cmdline`), or null if unreadable/gone. */
  cmdline(pid: number): string | null;
  /** Send a signal to a pid (or, for a negative pid, a process group). Swallows ESRCH. */
  kill(pidOrGroup: number, signal: NodeJS.Signals): void;
  /** Resolve after `ms` (used to poll for the incumbent's exit). */
  sleep(ms: number): Promise<void>;
}

/** The real {@link ProcessControl}, backed by `process.kill` + `/proc`. */
export const nodeProcessControl: ProcessControl = {
  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM means the process exists but we cannot signal it — still "alive".
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  cmdline(pid: number): string | null {
    try {
      // /proc/<pid>/cmdline is the argv joined by NUL bytes; normalise to spaces.
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    } catch {
      return null; // not Linux, or the process is gone — caller treats as unverifiable
    }
  },
  kill(pidOrGroup: number, signal: NodeJS.Signals): void {
    try {
      process.kill(pidOrGroup, signal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
        // ESRCH (already gone) is the happy path; anything else is worth surfacing.
        throw err;
      }
    }
  },
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};

export interface EnsureSingletonOptions {
  /** Path to the daemon PID file (per-store: `dirname(db)/daemon.pid`). */
  pidFile: string;
  /** This process's own pid (never reaps itself). Defaults to `process.pid`. */
  selfPid?: number;
  /** ms to wait for a SIGTERM'd incumbent to exit before escalating to SIGKILL. */
  graceMs?: number;
  /** ms to wait for a SIGKILL'd incumbent to disappear before declaring failure. */
  killWaitMs?: number;
  /** Poll interval while waiting for the incumbent to exit. */
  pollMs?: number;
  proc?: ProcessControl;
  logger?: Logger;
  /** Read the PID file's raw contents; injectable for tests. Defaults to reading `pidFile`. */
  readPidFile?: (pidFile: string) => string | null;
}

/** What the guard did, for logging / tests. */
export interface SingletonResult {
  /** The pid of the incumbent daemon that was reaped, or null if there was none. */
  reaped: number | null;
  /** Why the guard took no reap action ("none" when it did reap). */
  reason: "reaped" | "no-pidfile" | "stale" | "unverified" | "self";
}

function defaultReadPidFile(pidFile: string): string | null {
  try {
    return readFileSync(pidFile, "utf8");
  } catch {
    return null;
  }
}

/**
 * Enforce the single-daemon invariant before the caller opens the store. If the PID
 * file names a live, verified ralph daemon other than us, reap it and return once it
 * is gone. A missing/invalid/stale PID file, or one that names an unrelated process
 * (PID reuse), is a no-op — the caller overwrites it with its own pid afterwards.
 *
 * Throws only when an incumbent is verified-alive but survives SIGKILL (e.g. EPERM:
 * owned by another user) — refusing to start is correct there, because proceeding
 * would resurrect the very two-daemon race this guard exists to prevent.
 */
export async function ensureSingleton(opts: EnsureSingletonOptions): Promise<SingletonResult> {
  const proc = opts.proc ?? nodeProcessControl;
  const selfPid = opts.selfPid ?? process.pid;
  const graceMs = opts.graceMs ?? 15_000;
  const killWaitMs = opts.killWaitMs ?? 5_000;
  const pollMs = opts.pollMs ?? 250;
  const readPidFile = opts.readPidFile ?? defaultReadPidFile;
  const log = opts.logger;

  const raw = readPidFile(opts.pidFile);
  if (raw === null) {
    return { reaped: null, reason: "no-pidfile" };
  }
  const pid = Number(raw.trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    log?.warn("singleton.pidfile-invalid", { pidFile: opts.pidFile, raw: raw.trim() });
    return { reaped: null, reason: "stale" };
  }
  if (pid === selfPid) {
    return { reaped: null, reason: "self" };
  }
  if (!proc.isAlive(pid)) {
    log?.info("singleton.incumbent-stale", { pid });
    return { reaped: null, reason: "stale" };
  }

  // Verify identity before signalling: a recycled pid pointing at a stranger must
  // never be killed. An unreadable cmdline (process just exited, or non-Linux) is
  // treated as not-ours — fail safe rather than risk killing an unrelated process.
  const cmdline = proc.cmdline(pid);
  if (cmdline === null || !cmdline.includes(DAEMON_MARKER)) {
    log?.warn("singleton.incumbent-unverified", { pid, cmdline });
    return { reaped: null, reason: "unverified" };
  }

  // A verified live daemon owns our store. Reap it: SIGTERM (it begins a graceful
  // drain), wait out the grace, then SIGKILL the whole process group as a backstop.
  log?.warn("singleton.reaping-incumbent", { pid, graceMs });
  proc.kill(pid, "SIGTERM");
  if (await waitForExit(proc, pid, graceMs, pollMs)) {
    log?.info("singleton.incumbent-drained", { pid });
    return { reaped: pid, reason: "reaped" };
  }

  log?.warn("singleton.incumbent-sigkill", { pid });
  proc.kill(-pid, "SIGKILL"); // process group first, to reap any children it leaked
  proc.kill(pid, "SIGKILL"); // then the pid itself, in case it was not a group leader
  if (await waitForExit(proc, pid, killWaitMs, pollMs)) {
    log?.info("singleton.incumbent-killed", { pid });
    return { reaped: pid, reason: "reaped" };
  }

  // Verified-alive but unkillable (almost always EPERM — a daemon owned by another
  // user). Refusing to start is the safe outcome: a second daemon would re-create
  // the race. The supervisor surfaces the non-zero exit as a daemon-anomaly.
  throw new Error(
    `singleton guard: incumbent daemon pid ${pid} survived SIGKILL; refusing to start a second daemon`,
  );
}

/** Poll until the pid is gone or the timeout elapses; true iff it exited in time. */
async function waitForExit(
  proc: ProcessControl,
  pid: number,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  let waited = 0;
  while (waited < timeoutMs) {
    if (!proc.isAlive(pid)) {
      return true;
    }
    await proc.sleep(pollMs);
    waited += pollMs;
  }
  return !proc.isAlive(pid);
}
