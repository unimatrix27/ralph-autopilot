/**
 * Subprocess reaping for an SDK session (issue #13, DESIGN §3 — the wall-clock is
 * a *hard kill*). The Agent SDK spawns the `claude` CLI as a direct child and, on
 * abort, only signals that child — a `build`/`test`/bash subprocess the agent
 * spawned underneath it is **not** guaranteed to be reaped and can outlive the
 * "killed" run, holding the slot's resources.
 *
 * We close that gap with the SDK's `spawnClaudeCodeProcess` hook: we spawn the CLI
 * as its own **process-group leader** (`detached`), so `process.kill(-pgid, …)`
 * reaps the entire tree — the CLI and every descendant it spawned — in one signal.
 * The SDK `query()` stays the runtime executor of record (ADR-0011); we only own
 * how its one child process is grouped and torn down.
 */

import { spawn } from "node:child_process";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

/** The SDK's spawn hook type and the shape it must return (a spawned process). */
export type SpawnClaudeCodeProcess = NonNullable<Options["spawnClaudeCodeProcess"]>;
type SpawnOptions = Parameters<SpawnClaudeCodeProcess>[0];
type SpawnedProcess = ReturnType<SpawnClaudeCodeProcess>;

/**
 * Owns the subprocess lifecycle for one SDK session. {@link spawn} is handed to
 * the SDK as `spawnClaudeCodeProcess`; {@link reap} force-kills the whole process
 * tree of every process this reaper spawned. One reaper per session, so reaping
 * one session never touches a concurrently-running session's processes.
 */
export interface SessionReaper {
  /** The SDK `spawnClaudeCodeProcess` hook — spawns the CLI as a group leader. */
  spawn: SpawnClaudeCodeProcess;
  /** SIGKILL every spawned process group — the CLI and all its descendants. */
  reap(): void;
}

/** SIGKILL a whole process group by its leader pid; a gone group is a no-op. */
function killGroup(pgid: number): void {
  try {
    // Negative pid → signal the entire process group (POSIX). This is what
    // reaches the agent-spawned build/test/bash grandchildren, not just the CLI.
    process.kill(-pgid, "SIGKILL");
  } catch {
    // ESRCH (already gone) or EPERM — nothing left to reap on this group.
  }
}

/**
 * A {@link SessionReaper} that spawns the CLI in a fresh process group and reaps
 * that group on demand. `detached: true` makes the spawned pid the group leader
 * (pgid === pid), which is what lets one signal tear down the entire subtree.
 */
export function createProcessGroupReaper(): SessionReaper {
  const groupLeaders: number[] = [];
  return {
    spawn(options: SpawnOptions): SpawnedProcess {
      const child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        // Match the SDK's own stdio contract: piped stdin/stdout for the JSON
        // protocol, stderr discarded (the SDK surfaces errors via the stream).
        stdio: ["pipe", "pipe", "ignore"],
        // Own process group so the whole tree is reapable in one kill.
        detached: true,
        windowsHide: true,
      });
      const pid = child.pid;
      if (typeof pid === "number") {
        groupLeaders.push(pid);
        // The SDK forwards its abort *after* a graceful stdin-EOF + grace window,
        // and only when the caller actually aborted. When it fires, reap the
        // whole group (not just the CLI) so a forced cancel never orphans the
        // build/test subtree. The wall-clock path additionally calls reap()
        // synchronously for an immediate hard kill (no grace).
        const onAbort = () => killGroup(pid);
        if (options.signal.aborted) {
          onAbort();
        } else {
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      }
      return child as unknown as SpawnedProcess;
    },
    reap(): void {
      for (const pgid of groupLeaders) {
        killGroup(pgid);
      }
    },
  };
}
