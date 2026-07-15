import { describe, expect, it } from "vitest";
import { ensureSingleton, type ProcessControl } from "./singleton";

/**
 * A scriptable fake {@link ProcessControl}. `alive` is the set of pids currently
 * "running"; `cmdlines` maps a pid to its argv. `signals` records every kill so a
 * test can assert the SIGTERM→SIGKILL escalation. `onSleep` lets a test mutate the
 * world between polls (e.g. let the incumbent finally exit), modelling the passage
 * of the grace window without real time.
 */
function makeProc(init: {
  alive: number[];
  cmdlines?: Record<number, string | null>;
  unkillable?: number[];
  onSleep?: (proc: FakeProc) => void;
}): FakeProc {
  return new FakeProc(init);
}

class FakeProc implements ProcessControl {
  alive: Set<number>;
  cmdlines: Record<number, string | null>;
  unkillable: Set<number>;
  signals: Array<{ pid: number; signal: string }> = [];
  slept = 0;
  private readonly onSleep?: (proc: FakeProc) => void;

  constructor(init: {
    alive: number[];
    cmdlines?: Record<number, string | null>;
    unkillable?: number[];
    onSleep?: (proc: FakeProc) => void;
  }) {
    this.alive = new Set(init.alive);
    this.cmdlines = init.cmdlines ?? {};
    this.unkillable = new Set(init.unkillable ?? []);
    this.onSleep = init.onSleep;
  }

  isAlive(pid: number): boolean {
    return this.alive.has(pid);
  }
  cmdline(pid: number): string | null {
    return pid in this.cmdlines ? this.cmdlines[pid]! : null;
  }
  kill(pidOrGroup: number, signal: NodeJS.Signals): void {
    const pid = Math.abs(pidOrGroup);
    this.signals.push({ pid, signal });
    if (signal === "SIGKILL" && !this.unkillable.has(pid)) {
      this.alive.delete(pid);
    }
  }
  sleep(_ms: number): Promise<void> {
    this.slept += 1;
    this.onSleep?.(this);
    return Promise.resolve();
  }
}

const RALPH = "node dist/bin/ralph-daemon.js";
const FAST = { graceMs: 1000, killWaitMs: 1000, pollMs: 250 } as const;

describe("ensureSingleton", () => {
  it("does nothing when there is no PID file", async () => {
    const proc = makeProc({ alive: [] });
    const result = await ensureSingleton({
      pidFile: "/x/daemon.pid",
      proc,
      readPidFile: () => null,
    });
    expect(result).toEqual({ reaped: null, reason: "no-pidfile" });
    expect(proc.signals).toEqual([]);
  });

  it("ignores a stale PID file whose process is gone", async () => {
    const proc = makeProc({ alive: [] });
    const result = await ensureSingleton({
      pidFile: "/x/daemon.pid",
      selfPid: 9000,
      proc,
      readPidFile: () => "4242\n",
    });
    expect(result.reason).toBe("stale");
    expect(proc.signals).toEqual([]);
  });

  it("never reaps itself", async () => {
    const proc = makeProc({ alive: [777], cmdlines: { 777: RALPH } });
    const result = await ensureSingleton({
      pidFile: "/x/daemon.pid",
      selfPid: 777,
      proc,
      readPidFile: () => "777",
    });
    expect(result.reason).toBe("self");
    expect(proc.signals).toEqual([]);
  });

  it("does NOT kill a live pid whose cmdline is not a ralph daemon (PID reuse)", async () => {
    const proc = makeProc({ alive: [555], cmdlines: { 555: "/usr/bin/postgres -D /data" } });
    const result = await ensureSingleton({
      pidFile: "/x/daemon.pid",
      selfPid: 9000,
      proc,
      readPidFile: () => "555",
    });
    expect(result).toEqual({ reaped: null, reason: "unverified" });
    expect(proc.signals).toEqual([]); // crucial: no signal sent to a stranger
  });

  it("treats an unreadable cmdline as unverified and sends no signal", async () => {
    const proc = makeProc({ alive: [556], cmdlines: { 556: null } });
    const result = await ensureSingleton({
      pidFile: "/x/daemon.pid",
      selfPid: 9000,
      proc,
      readPidFile: () => "556",
    });
    expect(result.reason).toBe("unverified");
    expect(proc.signals).toEqual([]);
  });

  it("reaps a verified incumbent with SIGTERM when it drains within the grace window", async () => {
    // The incumbent exits after the first poll (models a graceful drain completing).
    const proc = makeProc({
      alive: [1234],
      cmdlines: { 1234: RALPH },
      onSleep: (p) => p.alive.delete(1234),
    });
    const result = await ensureSingleton({
      pidFile: "/x/daemon.pid",
      selfPid: 9000,
      proc,
      readPidFile: () => "1234",
      ...FAST,
    });
    expect(result).toEqual({ reaped: 1234, reason: "reaped" });
    expect(proc.signals).toEqual([{ pid: 1234, signal: "SIGTERM" }]);
    expect(proc.signals.some((s) => s.signal === "SIGKILL")).toBe(false);
  });

  it("escalates to SIGKILL (group then pid) when the incumbent ignores SIGTERM", async () => {
    const proc = makeProc({ alive: [1234], cmdlines: { 1234: RALPH } });
    const result = await ensureSingleton({
      pidFile: "/x/daemon.pid",
      selfPid: 9000,
      proc,
      readPidFile: () => "1234",
      ...FAST,
    });
    expect(result).toEqual({ reaped: 1234, reason: "reaped" });
    const signals = proc.signals.map((s) => s.signal);
    expect(signals[0]).toBe("SIGTERM");
    expect(signals).toContain("SIGKILL");
    expect(proc.isAlive(1234)).toBe(false);
  });

  it("throws when a verified incumbent survives even SIGKILL (e.g. EPERM)", async () => {
    const proc = makeProc({
      alive: [1234],
      cmdlines: { 1234: RALPH },
      unkillable: [1234],
    });
    await expect(
      ensureSingleton({
        pidFile: "/x/daemon.pid",
        selfPid: 9000,
        proc,
        readPidFile: () => "1234",
        ...FAST,
      }),
    ).rejects.toThrow(/survived SIGKILL/);
  });
});
