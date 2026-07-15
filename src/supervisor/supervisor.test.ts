/**
 * Drives the *real* supervisor script (ops/ralph-supervisor.sh) through spawned
 * bash with fake git/npm/daemon hooks on the env, exercising the safety-critical
 * paths the daemon itself cannot: build-gate + rollback (AC4) and the post-restart
 * health check (AC5). The script's update/rollback/current-commit steps are
 * overridable via env so the orchestration — when to relaunch, when to roll back,
 * when to surface a daemon-anomaly — is what's under test.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "../../ops/ralph-supervisor.sh");

let base: string;

/** A fake daemon: logs the commit it ran at, then exits per a scripted queue. */
const FAKE_DAEMON = `#!/usr/bin/env bash
head="$(cat "$STATE/head")"
line="$(head -n1 "$QUEUE" 2>/dev/null)"
tail -n +2 "$QUEUE" > "$QUEUE.tmp" 2>/dev/null && mv "$QUEUE.tmp" "$QUEUE"
code="\${line%% *}"; slp="\${line#* }"
[ -z "$code" ] && code=0
[ "$slp" = "$line" ] && slp=0
echo "launch head=$head code=$code" >> "$DLOG"
[ "\${slp:-0}" -gt 0 ] && sleep "$slp"
exit "\${code:-0}"
`;

/** A fake update step: advance HEAD to NEW_HEAD, then exit per BUILD_RESULT. */
const FAKE_UPDATE = `#!/usr/bin/env bash
echo "$NEW_HEAD" > "$STATE/head"
echo "updated -> $NEW_HEAD build=$BUILD_RESULT" >> "$ULOG"
exit "\${BUILD_RESULT:-0}"
`;

/** A fake rollback step: reset HEAD to the requested last-good commit. */
const FAKE_ROLLBACK = `#!/usr/bin/env bash
echo "$1" > "$STATE/head"
echo "rollback -> $1" >> "$RLOG"
exit "\${ROLLBACK_RESULT:-0}"
`;

interface Scenario {
  startHead: string;
  queue: string[]; // one "code sleepSeconds" per daemon launch, consumed in order
  newHead?: string;
  buildResult?: number;
  healthWindow?: number;
  maxCycles?: number;
  rollbackResult?: number;
  tmpDir?: string; // RALPH_TMP_DIR — the scrub root (a sandbox, never the real /tmp)
  scrubGlobs?: string; // RALPH_TMP_SCRUB_GLOBS — space-separated globs to delete
  scrubCmd?: string; // RALPH_TMP_SCRUB_CMD — override the scrub step (for ordering assertions)
}

function runSupervisor(s: Scenario) {
  const state = join(base, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "head"), `${s.startHead}\n`);
  writeFileSync(join(base, "queue"), s.queue.length ? s.queue.join("\n") + "\n" : "");

  const fakeDaemon = join(base, "fake-daemon.sh");
  const fakeUpdate = join(base, "fake-update.sh");
  const fakeRollback = join(base, "fake-rollback.sh");
  writeFileSync(fakeDaemon, FAKE_DAEMON);
  writeFileSync(fakeUpdate, FAKE_UPDATE);
  writeFileSync(fakeRollback, FAKE_ROLLBACK);

  const anomalyFile = join(base, "anomaly.log");
  const quarantineFile = join(base, "quarantine");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    STATE: state,
    QUEUE: join(base, "queue"),
    DLOG: join(base, "daemon.log"),
    ULOG: join(base, "update.log"),
    RLOG: join(base, "rollback.log"),
    NEW_HEAD: s.newHead ?? "new",
    BUILD_RESULT: String(s.buildResult ?? 0),
    ROLLBACK_RESULT: String(s.rollbackResult ?? 0),
    RALPH_REPO_DIR: base,
    RALPH_BRANCH: "main",
    RALPH_ANOMALY_FILE: anomalyFile,
    RALPH_QUARANTINE_FILE: quarantineFile,
    RALPH_HEALTH_WINDOW: String(s.healthWindow ?? 3600),
    RALPH_MAX_CYCLES: String(s.maxCycles ?? 5),
    RALPH_CRASH_BACKOFF: "0",
    RALPH_DAEMON_CMD: `bash ${fakeDaemon}`,
    RALPH_UPDATE_CMD: `bash ${fakeUpdate}`,
    RALPH_ROLLBACK_CMD: `bash ${fakeRollback}`,
    RALPH_CURRENT_COMMIT_CMD: `cat ${join(state, "head")}`,
    ...(s.tmpDir ? { RALPH_TMP_DIR: s.tmpDir } : {}),
    ...(s.scrubGlobs != null ? { RALPH_TMP_SCRUB_GLOBS: s.scrubGlobs } : {}),
    ...(s.scrubCmd ? { RALPH_TMP_SCRUB_CMD: s.scrubCmd } : {}),
  };

  const res = spawnSync("bash", [SCRIPT], { env, encoding: "utf8", timeout: 20_000 });
  const read = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");
  return {
    status: res.status,
    stderr: res.stderr,
    daemonLog: read(join(base, "daemon.log")),
    updateLog: read(join(base, "update.log")),
    rollbackLog: read(join(base, "rollback.log")),
    anomaly: read(anomalyFile),
    quarantine: read(quarantineFile).trim(),
    quarantineExists: existsSync(quarantineFile),
    launches: read(join(base, "daemon.log"))
      .trim()
      .split("\n")
      .filter(Boolean),
  };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ralph-supervisor-"));
});
afterEach(() => execFileSync("rm", ["-rf", base]));

describe("ralph-supervisor.sh", () => {
  it("is shipped and syntactically valid bash", () => {
    expect(existsSync(SCRIPT)).toBe(true);
    const check = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
    expect(check.status).toBe(0);
  });

  it("hardcodes the daemon's restart exit code (75)", () => {
    const text = readFileSync(SCRIPT, "utf8");
    expect(text).toMatch(/RESTART_EXIT_CODE=75\b/);
  });

  it("sources .env before launching the daemon (direct supervisor/systemd start)", () => {
    const envLog = join(base, "env.log");
    const fakeDaemon = join(base, "fake-env-daemon.sh");
    writeFileSync(
      fakeDaemon,
      `#!/usr/bin/env bash\n{\n  echo "zai=\${ZAI_API_KEY:-missing}"\n  echo "tmpdir=\${TMPDIR:-missing}"\n  echo "ralph_tmp=\${RALPH_TMP_DIR:-missing}"\n} > "${envLog}"\nexit 0\n`,
    );
    writeFileSync(
      join(base, ".env"),
      `ZAI_API_KEY=from-dotenv\nRALPH_DAEMON_CMD='bash ${fakeDaemon}'\nRALPH_MAX_CYCLES=1\n`,
    );

    const env = { ...process.env, RALPH_REPO_DIR: base };
    delete env.TMPDIR;
    delete env.RALPH_TMP_DIR;
    const res = spawnSync("bash", [SCRIPT], {
      env,
      encoding: "utf8",
      timeout: 20_000,
    });

    expect(res.status).toBe(0);
    expect(readFileSync(envLog, "utf8")).toBe(
      `zai=from-dotenv\ntmpdir=${join(base, ".ralph/tmp")}\nralph_tmp=${join(base, ".ralph/tmp")}\n`,
    );
  });

  it("pulls + builds + relaunches the new version on the restart code (AC3)", () => {
    const r = runSupervisor({
      startHead: "good1",
      newHead: "new2",
      buildResult: 0,
      queue: ["75 0", "0 0"], // request restart, then the updated daemon stops clean
    });
    // Ran old, applied the update, relaunched the NEW commit; no anomaly.
    expect(r.launches).toEqual(["launch head=good1 code=75", "launch head=new2 code=0"]);
    expect(r.updateLog).toContain("updated -> new2");
    expect(r.anomaly).toBe("");
    expect(r.quarantineExists).toBe(false); // a healthy update quarantines nothing
  });

  it("does NOT relaunch into broken code on a build failure — keeps last-good + surfaces an anomaly (AC4)", () => {
    const r = runSupervisor({
      startHead: "good1",
      newHead: "broken2",
      buildResult: 1, // build of the new code fails
      queue: ["75 0", "0 0"], // request restart; after rollback the last-good stops clean
    });
    // Build failed → rolled back to last-good → relaunched last-good, never broken2.
    expect(r.launches).toEqual(["launch head=good1 code=75", "launch head=good1 code=0"]);
    expect(r.launches.join("\n")).not.toContain("broken2");
    expect(r.rollbackLog).toContain("rollback -> good1");
    expect(r.anomaly).toContain("daemon-anomaly");
    expect(r.anomaly).toContain("build-failed");
    // Quarantine the failed remote sha so the daemon (now back on good1) stops
    // re-draining for it — otherwise it re-detects 'behind' every cycle and the
    // box thrashes drain→rebuild→rollback forever (operator ruling).
    expect(r.quarantine).toBe("broken2");
  });

  it("rolls back to the previous good commit when the updated daemon crash-loops (AC5)", () => {
    const r = runSupervisor({
      startHead: "good1",
      newHead: "new2",
      buildResult: 0, // build is fine...
      healthWindow: 3600, // ...but the new daemon dies inside the health window
      queue: ["75 0", "1 0", "0 0"], // restart; new2 crashes fast; last-good then stops clean
    });
    expect(r.launches).toEqual([
      "launch head=good1 code=75",
      "launch head=new2 code=1",
      "launch head=good1 code=0",
    ]);
    expect(r.rollbackLog).toContain("rollback -> good1");
    expect(r.anomaly).toContain("daemon-anomaly");
    expect(r.anomaly).toContain("health-check");
    // The crash-looping commit is quarantined too (build passed but startup failed),
    // so the rolled-back daemon does not re-adopt it next cycle.
    expect(r.quarantine).toBe("new2");
  });

  it("does not roll back when the updated daemon survives the health window (AC5)", () => {
    const r = runSupervisor({
      startHead: "good1",
      newHead: "new2",
      buildResult: 0,
      healthWindow: 1, // a launch that lives ≥1s is healthy
      maxCycles: 3,
      // new2 runs 2s (past the window) then exits non-zero: a normal later crash,
      // NOT a failed health check → relaunch new2, never roll back.
      queue: ["75 0", "1 2", "0 0"],
    });
    expect(r.rollbackLog).toBe(""); // no rollback
    expect(r.anomaly).not.toContain("health-check");
    expect(r.quarantineExists).toBe(false); // a healthy version is never quarantined
    // After the late crash it relaunched the SAME (healthy) new version.
    expect(r.launches.filter((l) => l.includes("new2")).length).toBeGreaterThanOrEqual(2);
  });

  it("exits cleanly (0) when the daemon stops with code 0 (operator stop)", () => {
    const r = runSupervisor({ startHead: "good1", queue: ["0 0"], maxCycles: 5 });
    expect(r.status).toBe(0);
    expect(r.launches).toEqual(["launch head=good1 code=0"]);
    expect(r.anomaly).toBe("");
  });

  describe("tmp scrub (between runs, daemon down)", () => {
    // The scrub root is a sandbox dir under `base` — NEVER the real /tmp — so the suite
    // can exercise the real deletion path without touching the dev/CI machine's scratch.
    function seedTmp(): string {
      const tmp = join(base, "faketmp");
      mkdirSync(join(tmp, "scratch-a"), { recursive: true });
      writeFileSync(join(tmp, "scratch-a", "clone.bin"), "x");
      writeFileSync(join(tmp, "scratch-b.log"), "x");
      writeFileSync(join(tmp, "keep-me.txt"), "x"); // does not match the globs
      return tmp;
    }

    it("deletes only the matching globs before the daemon launches", () => {
      const tmp = seedTmp();
      runSupervisor({
        startHead: "good1",
        queue: ["0 0"],
        maxCycles: 1,
        tmpDir: tmp,
        scrubGlobs: "scratch-*",
      });
      // The daemon stopped clean (code 0) AFTER the scrub ran at the top of the loop, so
      // a deleted match proves the scrub fired before the launch.
      expect(existsSync(join(tmp, "scratch-a"))).toBe(false);
      expect(existsSync(join(tmp, "scratch-b.log"))).toBe(false);
      expect(existsSync(join(tmp, "keep-me.txt"))).toBe(true); // non-matching is spared
    });

    it("is a no-op when no globs are configured (the safe default)", () => {
      const tmp = seedTmp();
      runSupervisor({ startHead: "good1", queue: ["0 0"], maxCycles: 1, tmpDir: tmp });
      // Nothing configured → nothing touched, so a generic deployment / the test suite
      // never deletes real /tmp scratch.
      expect(existsSync(join(tmp, "scratch-a"))).toBe(true);
      expect(existsSync(join(tmp, "keep-me.txt"))).toBe(true);
    });

    it("refuses an unsafe scrub root (never rm -rf /)", () => {
      const text = readFileSync(SCRIPT, "utf8");
      // The guard rejects "" / "/" / "/." before any rm runs.
      expect(text).toMatch(/refusing unsafe RALPH_TMP_DIR/);
      expect(text).toMatch(/"" \| "\/" \| "\/\."/);
    });

    it("scrubs once per launch (overridable step runs before each daemon run)", () => {
      const marker = join(base, "scrub-ran");
      const r = runSupervisor({
        startHead: "good1",
        // crash once then stop clean → two launches → two scrubs ahead of them.
        queue: ["1 0", "0 0"],
        maxCycles: 5,
        scrubCmd: `echo ran >> ${marker}`,
      });
      const ran = existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").length : 0;
      expect(ran).toBe(r.launches.length);
    });
  });

  // Issue #240: on a stop signal the supervisor must FORWARD SIGTERM to its daemon
  // child (so it drains gracefully) and then exit — never leave the daemon orphaned
  // outside the cgroup, and never treat the drain's exit as a crash to relaunch.
  describe("stop-signal forwarding", () => {
    it("forwards SIGTERM to the daemon and exits without relaunching", async () => {
      const termMarker = join(base, "daemon-got-term");
      const launchLog = join(base, "launches");
      // A fake daemon that traps SIGTERM, records it, and exits 0 (a clean drain).
      // It blocks in `wait` so the supervisor is mid-`run_daemon` when we signal it.
      const fakeDaemon = join(base, "fake-daemon.sh");
      writeFileSync(
        fakeDaemon,
        `#!/usr/bin/env bash\n` +
          `echo launch >> "${launchLog}"\n` +
          `trap 'echo term >> "${termMarker}"; exit 0' TERM\n` +
          `sleep 30 &\n` +
          `wait $!\n`,
      );

      const child = spawn("bash", [SCRIPT], {
        env: {
          ...process.env,
          RALPH_REPO_DIR: base,
          RALPH_DAEMON_CMD: `bash ${fakeDaemon}`,
          RALPH_UPDATE_CMD: "true",
          RALPH_CURRENT_COMMIT_CMD: "echo head",
          RALPH_TMP_SCRUB_GLOBS: "",
          RALPH_CRASH_BACKOFF: "0",
          RALPH_MAX_CYCLES: "5",
        },
        stdio: "ignore",
      });

      const exitCode: number = await new Promise((resolveExit) => {
        // Wait until the daemon has actually launched, then stop the supervisor.
        const poll = setInterval(() => {
          if (existsSync(launchLog)) {
            clearInterval(poll);
            child.kill("SIGTERM");
          }
        }, 50);
        child.on("exit", (code) => {
          clearInterval(poll);
          resolveExit(code ?? -1);
        });
      });

      expect(existsSync(termMarker)).toBe(true); // daemon received the forwarded SIGTERM
      expect(exitCode).toBe(0); // clean stop, not a crash
      // Exactly one launch: the supervisor did NOT relaunch after the drain.
      const launches = readFileSync(launchLog, "utf8").trim().split("\n").filter(Boolean);
      expect(launches).toHaveLength(1);
    });
  });
});
