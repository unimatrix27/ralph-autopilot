/**
 * Direct unit tests on the unified Claude session-drive primitive
 * {@link runReapedWallClockedSession} (issue #146). It owns terminal *detection* —
 * rate-limit forwarding, usage-cap detection (+ the single meter trip), and the
 * wall-clock kill — but NOT the *disposition* of non-cap outcomes, which stays
 * per-caller. These tests pin the primitive's own contract independent of either
 * caller (impl / backend).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig, resolveTargets } from "../config/load";
import type { TargetConfig } from "../config/schema";
import type { QueryFn } from "./agent";
import { runReapedWallClockedSession } from "./agent";
import type { SessionReaper } from "./process-reaper";
import { isUsageLimitError, UsageLimitError, type RateLimitSignal } from "../core/usage";
import { WallClockExceededError } from "./wall-clock";

function config(wallClockSeconds = 3600): TargetConfig {
  return resolveTargets(
    parseConfig({
      targets: [
        { repo: "acme/widgets", commands: { build: "npm run build", test: "npm test" }, agent: { wallClockSeconds } },
      ],
    }),
  )[0]!;
}

/** A reaper that spawns nothing and (optionally) records reap() calls. */
function spyReaper(): SessionReaper & { reaped: () => number } {
  let count = 0;
  return {
    spawn: (() => {
      throw new Error("spawn should not be called with an injected query");
    }) as unknown as SessionReaper["spawn"],
    reap: () => {
      count += 1;
    },
    reaped: () => count,
  };
}

/** Build a query that yields the given messages then ends. */
function yieldingQuery(...messages: unknown[]): QueryFn {
  return (() =>
    (async function* () {
      for (const m of messages) {
        yield m;
      }
    })()) as unknown as QueryFn;
}

/** A query that blocks until its session's abortController fires, then ends. */
const blockingQuery: QueryFn = ((args: { options: { abortController?: AbortController } }) => {
  const signal = args.options.abortController!.signal;
  return (async function* () {
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  })();
}) as unknown as QueryFn;

describe("runReapedWallClockedSession — the unified Claude session-drive primitive (issue #146)", () => {
  afterEach(() => vi.useRealTimers());

  it("classifies a success result (no throw)", async () => {
    const fn = yieldingQuery({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "did the thing",
      num_turns: 4,
    });
    const r = await runReapedWallClockedSession({
      config: config(),
      available: {},
      worktreePath: "/wt/1",
      reaperFactory: spyReaper,
      queryFn: fn,
      prompt: "go",
    });
    expect(r).toEqual({ subtype: "success", isError: false, text: "did the thing", turns: 4 });
  });

  it("classifies a non-cap error result with isError:true and does NOT throw", async () => {
    // error_max_turns with non-cap body: the primitive must surface it as a classified
    // error result so the impl caller can fall through to PR-presence (its disposition),
    // not terminalize. Only the *cap* error result throws.
    const fn = yieldingQuery({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      result: "ran out of turns before finishing",
      num_turns: 50,
    });
    const r = await runReapedWallClockedSession({
      config: config(),
      available: {},
      worktreePath: "/wt/1",
      reaperFactory: spyReaper,
      queryFn: fn,
      prompt: "go",
    });
    expect(r).toEqual({ subtype: "error_max_turns", isError: true, text: "ran out of turns before finishing", turns: 50 });
  });

  it("throws UsageLimitError on a cap result and fires onRateLimit({rejected, resetsAt}) exactly once", async () => {
    const signals: RateLimitSignal[] = [];
    const fn = yieldingQuery({
      type: "result",
      subtype: "success", // caps often still arrive as subtype "success" with is_error
      is_error: true,
      result: "Claude AI usage limit reached|1750000000",
      num_turns: 1,
    });
    const err = await runReapedWallClockedSession({
      config: config(),
      available: {},
      worktreePath: "/wt/1",
      reaperFactory: spyReaper,
      queryFn: fn,
      prompt: "go",
      onRateLimit: (s) => signals.push(s),
    }).catch((e) => e);

    expect(err).toBeInstanceOf(UsageLimitError);
    expect(isUsageLimitError(err)).toBe(true);
    // The primitive is the single owner of the meter trip: exactly one rejected
    // signal with the parsed reset, fired before the throw. No caller re-trips.
    expect(signals).toEqual([{ status: "rejected", resetsAt: 1_750_000_000_000 }]);
  });

  it("throws WallClockExceededError on overrun and reaps the subprocess tree", async () => {
    vi.useFakeTimers();
    const reaper = spyReaper();
    const promise = runReapedWallClockedSession({
      config: config(1),
      available: {},
      worktreePath: "/wt/1",
      reaperFactory: () => reaper,
      queryFn: blockingQuery,
      prompt: "go",
    });
    const settled = promise.catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000);
    const err = await settled;

    expect(err).toBeInstanceOf(WallClockExceededError);
    expect(reaper.reaped()).toBe(1);
  });

  it("still surfaces the wall-clock terminal when the SDK throws AbortError on overrun", async () => {
    // The real SDK propagates the abort as a thrown AbortError out of the `for await`
    // (its ProcessTransport raises one when the CLI exits while the signal is aborted).
    // The primitive must still surface the wall-clock terminal — the AbortError is
    // swallowed only because the ceiling fired — and reap the tree, never let it escape.
    vi.useFakeTimers();
    const reaper = spyReaper();
    const throwingQuery: QueryFn = ((args: { options: { abortController?: AbortController } }) => {
      const signal = args.options.abortController!.signal;
      return (async function* () {
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        const err = new Error("Claude Code process aborted by user");
        err.name = "AbortError";
        throw err;
      })();
    }) as unknown as QueryFn;
    const promise = runReapedWallClockedSession({
      config: config(1),
      available: {},
      worktreePath: "/wt/1",
      reaperFactory: () => reaper,
      queryFn: throwingQuery,
      prompt: "go",
    });
    const settled = promise.catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000);
    const err = await settled;

    expect(err).toBeInstanceOf(WallClockExceededError);
    expect(reaper.reaped()).toBe(1);
  });

  it("propagates a genuine session fault and does NOT reap (not a wall-clock kill)", async () => {
    // A query that throws for a reason other than the overrun abort is a real fault: it
    // must surface (the caller's failure guard), not be masked as a wall-clock terminal,
    // and the reaper must not fire (the ceiling never expired).
    const reaper = spyReaper();
    const faultingQuery: QueryFn = (() =>
      (async function* () {
        throw new Error("boom");
      })()) as unknown as QueryFn;
    const err = await runReapedWallClockedSession({
      config: config(3600),
      available: {},
      worktreePath: "/wt/1",
      reaperFactory: () => reaper,
      queryFn: faultingQuery,
      prompt: "go",
    }).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("boom");
    expect(err).not.toBeInstanceOf(WallClockExceededError);
    expect(reaper.reaped()).toBe(0);
  });

  it("does not fire the ceiling (no reap, timer cleared) when the session finishes in time", async () => {
    vi.useFakeTimers();
    const reaper = spyReaper();
    const fn = yieldingQuery({ type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1 });
    const r = await runReapedWallClockedSession({
      config: config(3600),
      available: {},
      worktreePath: "/wt/1",
      reaperFactory: () => reaper,
      queryFn: fn,
      prompt: "go",
    });

    expect(r.isError).toBe(false);
    expect(reaper.reaped()).toBe(0);
    // The wall-clock timer must have been cleared — no pending timers remain.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forwards each streamed rate_limit_event to onRateLimit (the meter fold)", async () => {
    const signals: RateLimitSignal[] = [];
    const fn = yieldingQuery(
      { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", utilization: 0.5, rateLimitType: "five_hour" } },
      { type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1 },
    );
    await runReapedWallClockedSession({
      config: config(),
      available: {},
      worktreePath: "/wt/1",
      reaperFactory: spyReaper,
      queryFn: fn,
      prompt: "go",
      onRateLimit: (s) => signals.push(s),
    });

    // The streamed 0–1 utilization is normalized to 0–100 by toRateLimitSignal.
    expect(signals).toEqual([{ status: "allowed_warning", utilization: 50, rateLimitType: "five_hour" }]);
  });

  it("drops rate-limit signals when no onRateLimit is wired (single-login / tests)", async () => {
    // No onRateLimit: the session still classifies a success result and never throws.
    const fn = yieldingQuery(
      { type: "rate_limit_event", rate_limit_info: { status: "allowed", utilization: 0.2 } },
      { type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1 },
    );
    const r = await runReapedWallClockedSession({
      config: config(),
      available: {},
      worktreePath: "/wt/1",
      reaperFactory: spyReaper,
      queryFn: fn,
      prompt: "go",
    });
    expect(r).toEqual({ subtype: "success", isError: false, text: "ok", turns: 1 });
  });
});
