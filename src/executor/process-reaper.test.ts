/**
 * Subprocess reaping (issue #13, AC1): after a wall-clock kill, *no agent-spawned
 * child process survives*. The reaper spawns the CLI stand-in as a process-group
 * leader; reaping the group SIGKILLs the whole tree — the direct child **and** a
 * grandchild it spawned (the build/test/bash subprocess the issue is about).
 *
 * The stand-in is a `bash` that backgrounds a long `sleep` (the grandchild),
 * prints its pid, then blocks. We assert the grandchild is alive before the reap
 * and gone after it — proving the tree, not just the direct child, is reaped.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createProcessGroupReaper, type SessionReaper } from "./process-reaper";

/** A signal that never aborts — so only an explicit reap() kills anything. */
const neverAbort = new AbortController().signal;

/** Whether a pid is still alive (signal 0 probes without delivering a signal). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Resolve once `pid` has exited, or reject after `timeoutMs`. */
async function waitForExit(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() > deadline) {
      throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Read the first whitespace-delimited integer the process prints on stdout. */
function readFirstPid(stdout: NodeJS.ReadableStream): Promise<number> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString();
      const m = buf.match(/(\d+)/);
      if (m) {
        stdout.off("data", onData);
        resolve(Number(m[1]));
      }
    };
    stdout.on("data", onData);
    stdout.on("error", reject);
    setTimeout(() => reject(new Error("no pid emitted on stdout")), 5000);
  });
}

describe("createProcessGroupReaper (AC1: reap the whole subprocess tree)", () => {
  let reaper: SessionReaper | undefined;
  let grandchildPid: number | undefined;

  afterEach(() => {
    // Safety net: never leak a real process out of a test.
    reaper?.reap();
    if (grandchildPid !== undefined && isAlive(grandchildPid)) {
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    reaper = undefined;
    grandchildPid = undefined;
  });

  it("kills an agent-spawned grandchild when the session is reaped", async () => {
    reaper = createProcessGroupReaper();
    // bash (the CLI stand-in) backgrounds a sleep (the build/test grandchild),
    // prints its pid, then blocks so the whole group stays alive until reaped.
    const child = reaper.spawn({
      command: "bash",
      args: ["-c", "sleep 60 & echo $!; sleep 60"],
      env: process.env,
      signal: neverAbort,
    });

    grandchildPid = await readFirstPid(child.stdout);
    expect(isAlive(grandchildPid)).toBe(true);

    reaper.reap();

    await waitForExit(grandchildPid);
    expect(isAlive(grandchildPid)).toBe(false);
  });

  it("scopes reaping to its own session — a second reaper's tree is untouched", async () => {
    reaper = createProcessGroupReaper();
    const other = createProcessGroupReaper();
    const otherChild = other.spawn({
      command: "bash",
      args: ["-c", "sleep 60 & echo $!; sleep 60"],
      env: process.env,
      signal: neverAbort,
    });
    const otherPid = await readFirstPid(otherChild.stdout);

    try {
      const child = reaper.spawn({
        command: "bash",
        args: ["-c", "sleep 60 & echo $!; sleep 60"],
        env: process.env,
        signal: neverAbort,
      });
      grandchildPid = await readFirstPid(child.stdout);

      reaper.reap();
      await waitForExit(grandchildPid);

      // The other session's grandchild is still alive — reaping is per-session.
      expect(isAlive(otherPid)).toBe(true);
    } finally {
      other.reap();
      await waitForExit(otherPid).catch(() => {});
    }
  });
});
