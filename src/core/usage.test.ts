import { describe, expect, it } from "vitest";
import {
  DEFAULT_COOLDOWN_MS,
  EMPTY_USAGE,
  isTokenGated,
  isUsageLimitError,
  parseUsageLimitReset,
  pickActiveToken,
  recordRateLimit,
  resetToMs,
  soonestReset,
  tripCooldown,
  UsageLimitError,
  usageGate,
  type UsageState,
} from "./usage";

const NOW = 1_750_000_000_000; // fixed epoch-ms for deterministic cooldown math

describe("soonestReset (ADR-0037 no-provider ETA, issue #165)", () => {
  it("returns the earliest future reset across an active cooldown and gating windows", () => {
    const state: UsageState = {
      windows: {
        five_hour: { utilization: 90, resetsAtMs: NOW + 30 * 60_000 }, // gating, resets in 30m
        seven_day: { utilization: 95, resetsAtMs: NOW + 60 * 60_000 }, // gating, resets in 60m
      },
      cooldownUntilMs: NOW + 45 * 60_000,
    };
    expect(soonestReset(state, NOW, 85)).toBe(NOW + 30 * 60_000);
  });

  it("ignores a window that is not currently gating (utilization below the threshold)", () => {
    const state: UsageState = {
      windows: { five_hour: { utilization: 10, resetsAtMs: NOW + 10 * 60_000 } }, // below threshold
      cooldownUntilMs: null,
    };
    expect(soonestReset(state, NOW, 85)).toBeNull();
  });

  it("ignores a lapsed cooldown / past reset and returns null when nothing is in the future", () => {
    const state: UsageState = {
      windows: { five_hour: { utilization: 99, resetsAtMs: NOW - 1 } },
      cooldownUntilMs: NOW - 1,
    };
    expect(soonestReset(state, NOW, 85)).toBeNull();
  });

  it("degrades to null for an empty / never-streamed state", () => {
    expect(soonestReset(EMPTY_USAGE, NOW, 85)).toBeNull();
    expect(soonestReset(undefined, NOW, 85)).toBeNull();
  });
});

/** A window state at a given utilization, no reset (for the rotation tests). */
function util(pct: number): UsageState {
  return { windows: { five_hour: { utilization: pct, resetsAtMs: null } }, cooldownUntilMs: null };
}

describe("resetToMs", () => {
  it("scales epoch-seconds up to ms and leaves epoch-ms untouched", () => {
    expect(resetToMs(1_750_000_000)).toBe(1_750_000_000_000); // seconds → ms
    expect(resetToMs(1_750_000_000_000)).toBe(1_750_000_000_000); // already ms
    expect(resetToMs(null)).toBeNull();
    expect(resetToMs(undefined)).toBeNull();
    expect(resetToMs(Number.NaN)).toBeNull();
  });
});

describe("usageGate", () => {
  it("admits when nothing is known", () => {
    expect(usageGate(EMPTY_USAGE, NOW, 85)).toEqual({ admit: true });
  });

  it("refuses while a cooldown is active, then admits once it passes", () => {
    const state: UsageState = { windows: {}, cooldownUntilMs: NOW + 60_000 };
    expect(usageGate(state, NOW, 85).admit).toBe(false);
    expect(usageGate(state, NOW, 85).reason).toBe("cooldown");
    // After the reset, the gate opens on its own (self-heal).
    expect(usageGate(state, NOW + 60_001, 85)).toEqual({ admit: true });
  });

  it("refuses when any window is at/above the threshold (the 85% knob)", () => {
    const state: UsageState = {
      windows: { five_hour: { utilization: 85, resetsAtMs: null }, seven_day: { utilization: 40, resetsAtMs: null } },
      cooldownUntilMs: null,
    };
    const gate = usageGate(state, NOW, 85);
    expect(gate.admit).toBe(false);
    expect(gate.reason).toBe("utilization");
    expect(gate.detail).toContain("five_hour");
  });

  it("admits when every window is below the threshold", () => {
    const state: UsageState = {
      windows: { five_hour: { utilization: 84, resetsAtMs: null }, seven_day: { utilization: 10, resetsAtMs: null } },
      cooldownUntilMs: null,
    };
    expect(usageGate(state, NOW, 85)).toEqual({ admit: true });
  });

  it("stops gating on a window once its reset has passed (issue #279 — stale state must expire)", () => {
    // No fresh signal can arrive while the pool is gated (signals only flow from live
    // sessions), so the gate itself must treat a lapsed window as unknown — otherwise a
    // fully-gated pool wedges closed forever on last-known utilization.
    const state: UsageState = {
      windows: { five_hour: { utilization: 90, resetsAtMs: NOW - 1 } },
      cooldownUntilMs: null,
    };
    expect(usageGate(state, NOW, 85)).toEqual({ admit: true });
    // Same state a moment before the reset: still gated.
    expect(usageGate(state, NOW - 2, 85).admit).toBe(false);
  });

  it("keeps gating on an over-threshold window whose reset is unknown (no evidence it ended)", () => {
    const state: UsageState = {
      windows: { seven_day: { utilization: 85, resetsAtMs: null } },
      cooldownUntilMs: null,
    };
    expect(usageGate(state, NOW, 85).admit).toBe(false);
  });

  it("skips a stale cooldown once its windows show headroom (cooldown analogue of #279)", () => {
    // The real wedge: a long-horizon cooldown (a weekly/overage reset ~15h out) left
    // standing over an account whose own windows all show headroom. Once every account
    // is gated no fresh signal can supersede the cooldown, so it must not self-seal —
    // an uncorroborated future cooldown degrades to optimism and the gate admits.
    const state: UsageState = {
      windows: {
        five_hour: { utilization: 6, resetsAtMs: NOW + 2 * 3_600_000 },
        seven_day: { utilization: 41, resetsAtMs: NOW + 15 * 3_600_000 },
      },
      cooldownUntilMs: NOW + 15 * 3_600_000,
    };
    expect(usageGate(state, NOW, 85)).toEqual({ admit: true });
  });

  it("still honours a cooldown corroborated by a gating window (a real cap stays parked)", () => {
    const state: UsageState = {
      windows: { seven_day: { utilization: 100, resetsAtMs: NOW + 15 * 3_600_000 } },
      cooldownUntilMs: NOW + 15 * 3_600_000,
    };
    expect(usageGate(state, NOW, 85).admit).toBe(false);
  });

  it("still honours a bare cooldown with no window telemetry (a short backoff)", () => {
    // A `rejected` carrying neither a window nor a reset — the DEFAULT_COOLDOWN backoff.
    // Nothing contradicts it, so it must keep gating until it passes (not self-heal early).
    const state: UsageState = { windows: {}, cooldownUntilMs: NOW + 60_000 };
    expect(usageGate(state, NOW, 85).reason).toBe("cooldown");
  });
});

describe("recordRateLimit", () => {
  it("records a window's utilization + reset without tripping a cooldown when allowed", () => {
    const next = recordRateLimit(EMPTY_USAGE, { status: "allowed", rateLimitType: "five_hour", utilization: 30, resetsAt: NOW / 1000 + 3600 }, NOW);
    expect(next.windows.five_hour).toEqual({ utilization: 30, resetsAtMs: NOW + 3_600_000 });
    expect(next.cooldownUntilMs).toBeNull();
  });

  it("trips the cooldown to the window reset on a `rejected` signal", () => {
    const resetsAt = NOW / 1000 + 1800; // epoch seconds, 30 min out
    const next = recordRateLimit(EMPTY_USAGE, { status: "rejected", rateLimitType: "five_hour", utilization: 100, resetsAt }, NOW);
    expect(next.cooldownUntilMs).toBe(NOW + 1_800_000);
    expect(usageGate(next, NOW, 85).admit).toBe(false);
  });

  it("falls back to a default cooldown when `rejected` carries no reset", () => {
    const next = recordRateLimit(EMPTY_USAGE, { status: "rejected" }, NOW);
    expect(next.cooldownUntilMs).toBe(NOW + DEFAULT_COOLDOWN_MS);
  });

  it("marks a rejected window as at-limit (100%) when the signal carries no utilization", () => {
    // A rejection is definitionally at the limit for its window; recording it as 100
    // lets the window hold the gating truth so a real cap stays parked via usageGate's
    // window path even after its scalar cooldown is treated as uncorroborated.
    const next = recordRateLimit(
      EMPTY_USAGE,
      { status: "rejected", rateLimitType: "seven_day_overage_included", resetsAt: NOW / 1000 + 3600 },
      NOW,
    );
    expect(next.windows.seven_day_overage_included?.utilization).toBe(100);
    expect(usageGate(next, NOW, 85).admit).toBe(false);
  });

  it("never shortens an active cooldown (monotonic)", () => {
    const state: UsageState = { windows: {}, cooldownUntilMs: NOW + 100_000 };
    // A rejected signal whose reset is sooner must not pull the cooldown earlier.
    const next = recordRateLimit(state, { status: "rejected", resetsAt: (NOW + 10_000) / 1000 }, NOW);
    expect(next.cooldownUntilMs).toBe(NOW + 100_000);
  });
});

describe("tripCooldown", () => {
  it("sets a default-ahead cooldown when no reset is known", () => {
    expect(tripCooldown(EMPTY_USAGE, null, NOW).cooldownUntilMs).toBe(NOW + DEFAULT_COOLDOWN_MS);
  });
  it("is monotonic — keeps the later of existing vs new", () => {
    const state: UsageState = { windows: {}, cooldownUntilMs: NOW + 500_000 };
    expect(tripCooldown(state, NOW + 1_000, NOW).cooldownUntilMs).toBe(NOW + 500_000);
  });
});

describe("isUsageLimitError", () => {
  it("matches the SDK's session/usage-limit wording, not unrelated faults", () => {
    expect(isUsageLimitError(new Error("Claude Code returned an error result: You've hit your session limit · resets 10:40pm (Europe/Berlin)"))).toBe(true);
    expect(isUsageLimitError(new Error("usage limit reached"))).toBe(true);
    expect(isUsageLimitError({ stderr: "weekly limit reached, resets Monday" })).toBe(true);
    expect(isUsageLimitError(new Error("429 Too Many Requests: rate limit exceeded"))).toBe(true);
    expect(isUsageLimitError(new Error("quota exceeded for this API key"))).toBe(true);
    expect(isUsageLimitError(new Error("insufficient quota"))).toBe(true);
    expect(isUsageLimitError(new Error("ENOENT: no such file"))).toBe(false);
    expect(isUsageLimitError(new Error("git push rejected"))).toBe(false);
  });

  it("matches a UsageLimitError by type even when its text carries no keyword", () => {
    expect(isUsageLimitError(new UsageLimitError("ended without success"))).toBe(true);
  });
});

describe("UsageLimitError / parseUsageLimitReset", () => {
  it("extracts the trailing epoch-seconds from the classic pipe form", () => {
    const e = new UsageLimitError("Claude AI usage limit reached|1750000000");
    expect(e.resetsAtMs).toBe(1_750_000_000_000); // seconds → ms via resetToMs
    expect(e.name).toBe("UsageLimitError");
  });

  it("returns null for a human-only phrasing (caller falls back to DEFAULT_COOLDOWN_MS)", () => {
    expect(parseUsageLimitReset("You've hit your session limit · resets 10:40pm (Europe/Berlin)")).toBeNull();
    expect(new UsageLimitError("resets 10:40pm").resetsAtMs).toBeNull();
  });
});

describe("isTokenGated", () => {
  it("treats an unknown (never-seen) token as NOT gated — optimistic until it streams", () => {
    expect(isTokenGated(undefined, NOW, 85)).toBe(false);
    expect(isTokenGated(EMPTY_USAGE, NOW, 85)).toBe(false);
  });

  it("is gated when over threshold or in cooldown", () => {
    expect(isTokenGated(util(85), NOW, 85)).toBe(true);
    expect(isTokenGated(util(84), NOW, 85)).toBe(false);
    expect(isTokenGated({ windows: {}, cooldownUntilMs: NOW + 1_000 }, NOW, 85)).toBe(true);
  });
});

describe("pickActiveToken", () => {
  const base = { admitBelowPercent: 85, rotateEveryMs: null as number | null, lastRotateMs: NOW };

  it("keeps a single token regardless of triggers", () => {
    const r = pickActiveToken({ ...base, ids: ["a"], states: { a: util(99) }, activeId: "a", nowMs: NOW });
    expect(r.activeId).toBe("a");
  });

  it("keeps the active token while it has headroom and no timer", () => {
    const r = pickActiveToken({ ...base, ids: ["a", "b"], states: { a: util(40), b: util(10) }, activeId: "a", nowMs: NOW });
    expect(r.activeId).toBe("a");
  });

  it("flips to a token with headroom when the active one is gated (safety)", () => {
    const r = pickActiveToken({ ...base, ids: ["a", "b"], states: { a: util(90), b: util(20) }, activeId: "a", nowMs: NOW });
    expect(r.activeId).toBe("b");
    expect(r.lastRotateMs).toBe(NOW); // clock reset on flip
  });

  it("keeps the active (gated) token when NO other has headroom → daemon will defer", () => {
    const r = pickActiveToken({ ...base, ids: ["a", "b"], states: { a: util(90), b: util(95) }, activeId: "a", nowMs: NOW });
    expect(r.activeId).toBe("a");
  });

  it("rotates on the timer even when the active token is healthy", () => {
    const r = pickActiveToken({
      ...base,
      ids: ["a", "b"],
      states: { a: util(30), b: util(30) },
      activeId: "a",
      rotateEveryMs: 60_000,
      lastRotateMs: NOW - 60_000,
      nowMs: NOW,
    });
    expect(r.activeId).toBe("b");
    expect(r.lastRotateMs).toBe(NOW);
  });

  it("does not spin the rotation when the timer fired but only the active token is eligible", () => {
    const r = pickActiveToken({
      ...base,
      ids: ["a", "b"],
      states: { a: util(30), b: util(99) }, // b gated
      activeId: "a",
      rotateEveryMs: 60_000,
      lastRotateMs: NOW - 60_000,
      nowMs: NOW,
    });
    expect(r.activeId).toBe("a");
    expect(r.lastRotateMs).toBe(NOW); // clock advanced so it won't re-fire next tick
  });
});
