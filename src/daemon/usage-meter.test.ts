import { describe, expect, it } from "vitest";
import { ProviderPoolMeter, UsageMeter } from "./usage-meter";
import type { Account } from "../config/schema";

const NOW = 1_750_000_000_000;

/** A meter at a fixed clock; advance by mutating the returned `clock.now`. */
function meterAt(opts: { tokens?: { id: string; configDir?: string }[]; rotateEveryMs?: number | null }) {
  const clock = { now: NOW };
  const meter = new UsageMeter({ ...opts, now: () => clock.now });
  return { meter, clock };
}

describe("UsageMeter — single login (ADR-0023 behaviour preserved)", () => {
  it("defaults to one box-default token and gates on its window", () => {
    const { meter } = meterAt({});
    expect(meter.acquire(85).configDir).toBeUndefined(); // box default
    meter.record({ status: "allowed", rateLimitType: "five_hour", utilization: 90 });
    expect(meter.gate(85).admit).toBe(false);
  });

  it("trips a cooldown that the gate then refuses", () => {
    const { meter } = meterAt({});
    meter.trip(NOW + 60_000);
    expect(meter.gate(85).admit).toBe(false);
    expect(meter.gate(85).reason).toBe("cooldown");
  });
});

describe("UsageMeter — dual login (ADR-0028)", () => {
  const tokens = [
    { id: "a", configDir: "/home/box/.claude" },
    { id: "b", configDir: "/home/box/.claude-b" },
  ];

  it("acquire() returns the active login's CLAUDE_CONFIG_DIR", () => {
    const { meter } = meterAt({ tokens });
    expect(meter.acquire(85)).toEqual({ id: "a", configDir: "/home/box/.claude" });
  });

  it("routes signals to the bound token and flips when the active one is exhausted", () => {
    const { meter } = meterAt({ tokens });
    const a = meter.acquire(85);
    expect(a.id).toBe("a");
    // a's session reports its window exhausted → record against token a.
    meter.record({ status: "allowed", rateLimitType: "five_hour", utilization: 90 }, "a");
    // Next acquire flips to b (a is gated, b has headroom) and the gate stays open.
    expect(meter.acquire(85).id).toBe("b");
    expect(meter.gate(85).admit).toBe(true);
  });

  it("defers (gate refuses) only when BOTH logins are exhausted", () => {
    const { meter } = meterAt({ tokens });
    meter.record({ status: "allowed", rateLimitType: "five_hour", utilization: 90 }, "a");
    meter.record({ status: "allowed", rateLimitType: "five_hour", utilization: 95 }, "b");
    expect(meter.gate(85).admit).toBe(false); // no login has headroom → whole-daemon defer
  });

  it("a rejected signal on the active token trips its cooldown and frees the other", () => {
    const { meter } = meterAt({ tokens });
    meter.record({ status: "rejected", rateLimitType: "five_hour", resetsAt: (NOW + 300_000) / 1000 }, "a");
    expect(meter.acquire(85).id).toBe("b"); // a in cooldown → bind new sessions to b
    expect(meter.gate(85).admit).toBe(true);
  });

  it("rotates on the timer for even wear", () => {
    const { meter, clock } = meterAt({ tokens, rotateEveryMs: 60_000 });
    expect(meter.acquire(85).id).toBe("a");
    clock.now = NOW + 60_000;
    expect(meter.acquire(85).id).toBe("b"); // timer elapsed → flip even though a is healthy
  });

  it("notifies onActiveChange when (and only when) the active login flips", () => {
    const clock = { now: NOW };
    const flips: { from: string; to: string }[] = [];
    const meter = new UsageMeter({ tokens, now: () => clock.now, onActiveChange: (c) => flips.push(c) });
    meter.acquire(85); // a → a, no flip
    meter.record({ status: "rejected", resetsAt: (NOW + 300_000) / 1000 }, "a");
    expect(meter.acquire(85).id).toBe("b"); // a capped → flip a→b
    expect(flips).toEqual([{ from: "a", to: "b" }]);
  });

  it("acquireIfHeadroom returns a headroom login, or null when the whole pool is gated", () => {
    const { meter } = meterAt({ tokens });
    expect(meter.acquireIfHeadroom(85)?.id).toBe("a");
    meter.record({ status: "allowed", rateLimitType: "five_hour", utilization: 90 }, "a");
    expect(meter.acquireIfHeadroom(85)?.id).toBe("b"); // a gated → flip to b
    meter.record({ status: "allowed", rateLimitType: "five_hour", utilization: 95 }, "b");
    expect(meter.acquireIfHeadroom(85)).toBeNull(); // both gated → no headroom
  });
});

describe("ProviderPoolMeter — generalised per-provider pool (ADR-0037 P2.1)", () => {
  const accounts: Account[] = [
    { id: "claude-a", provider: "claude", configDir: "/c/a" },
    { id: "claude-b", provider: "claude", configDir: "/c/b" },
    { id: "claude-c", provider: "claude", configDir: "/c/c" },
    { id: "zai-1", provider: "zai", authTokenEnv: "ZAI_KEY_1" },
  ];

  /** A pool meter at a fixed, advanceable clock. */
  function poolAt(opts: { accounts?: Account[]; rotateEveryMs?: number | null } = {}) {
    const clock = { now: NOW };
    const meter = new ProviderPoolMeter({ accounts, ...opts, now: () => clock.now });
    return { meter, clock };
  }

  it("a provider with >=1 ungated account has headroom; acquireAccount returns one of its accounts", () => {
    const { meter } = poolAt();
    expect(meter.hasHeadroom("claude", 85)).toBe(true);
    expect(meter.hasHeadroom("zai", 85)).toBe(true);
    const claude = meter.acquireAccount("claude", 85);
    expect(claude?.provider).toBe("claude");
    expect(accounts.map((a) => a.id)).toContain(claude?.id);
    expect(meter.acquireAccount("zai", 85)).toEqual({ id: "zai-1", provider: "zai", authTokenEnv: "ZAI_KEY_1" });
  });

  it("a provider with zero accounts in the pool is simply unavailable", () => {
    const { meter } = poolAt();
    expect(meter.hasHeadroom("openai", 85)).toBe(false);
    expect(meter.acquireAccount("openai", 85)).toBeNull();
  });

  it("'provider has headroom' iff >=1 of its accounts is not gated", () => {
    const { meter } = poolAt();
    // Gate two of three claude accounts: the third still gives the pool headroom.
    meter.record({ status: "allowed", rateLimitType: "five_hour", utilization: 90 }, "claude-a");
    meter.record({ status: "allowed", rateLimitType: "five_hour", utilization: 90 }, "claude-b");
    expect(meter.hasHeadroom("claude", 85)).toBe(true);
    expect(meter.acquireAccount("claude", 85)?.id).toBe("claude-c"); // skips the two gated
    // Gate the last one too → the whole claude pool is gated.
    meter.record({ status: "allowed", rateLimitType: "five_hour", utilization: 90 }, "claude-c");
    expect(meter.hasHeadroom("claude", 85)).toBe(false);
    expect(meter.acquireAccount("claude", 85)).toBeNull();
  });

  it("per-provider isolation: gating every claude account never gates zai", () => {
    const { meter } = poolAt();
    for (const id of ["claude-a", "claude-b", "claude-c"]) {
      meter.record({ status: "allowed", rateLimitType: "five_hour", utilization: 99 }, id);
    }
    expect(meter.hasHeadroom("claude", 85)).toBe(false);
    expect(meter.hasHeadroom("zai", 85)).toBe(true); // a different pool's signals never crossed over
    expect(meter.acquireAccount("zai", 85)?.id).toBe("zai-1");
  });

  it("rotates round-robin within a pool for even wear, skipping gated accounts", () => {
    const { meter, clock } = poolAt({ rotateEveryMs: 60_000 });
    // claude-b is gated; rotation must skip it.
    meter.record({ status: "allowed", rateLimitType: "five_hour", utilization: 90 }, "claude-b");
    expect(meter.acquireAccount("claude", 85)?.id).toBe("claude-a");
    clock.now = NOW + 60_000;
    expect(meter.acquireAccount("claude", 85)?.id).toBe("claude-c"); // timer flip a→(skip b)→c
    clock.now = NOW + 120_000;
    expect(meter.acquireAccount("claude", 85)?.id).toBe("claude-a"); // c→(wrap, skip b)→a
  });

  it("a rejected signal trips only that account's pool cooldown and frees the other accounts", () => {
    const { meter } = poolAt();
    meter.trip(NOW + 300_000, "claude-a");
    expect(meter.acquireAccount("claude", 85)?.id).not.toBe("claude-a"); // a in cooldown → another claude account
    expect(meter.hasHeadroom("zai", 85)).toBe(true); // unrelated pool untouched
  });
});

describe("UsageMeter — operator-disabled logins (issue #10)", () => {
  const tokens = [
    { id: "a", configDir: "/a" },
    { id: "b", configDir: "/b" },
  ];

  /** A meter whose disabled set is LIVE — mutate `disabled` to park/unpark without a rebuild. */
  function disableableMeter() {
    const clock = { now: NOW };
    const disabled = new Set<string>();
    const meter = new UsageMeter({ tokens, now: () => clock.now, isDisabled: (id) => disabled.has(id) });
    return { meter, clock, disabled };
  }

  it("acquire never binds a disabled login — rotation lands on the enabled sibling", () => {
    const { meter, disabled } = disableableMeter();
    disabled.add("a");
    expect(meter.acquire(85).id).toBe("b");
  });

  it("the predicate is live: parking the ACTIVE login flips the next acquire, no rebuild", () => {
    const { meter, disabled } = disableableMeter();
    expect(meter.acquire(85).id).toBe("a");
    disabled.add("a"); // the operator parks it mid-life
    expect(meter.acquire(85).id).toBe("b");
    // Un-park + gate b: rotation returns to the re-enabled login.
    disabled.delete("a");
    meter.record({ status: "allowed", rateLimitType: "five_hour", utilization: 95 }, "b");
    expect(meter.acquire(85).id).toBe("a");
  });

  it("a GATED disabled sibling never pauses the pool while an enabled login has headroom", () => {
    const { meter, disabled } = disableableMeter();
    disabled.add("a");
    meter.record({ status: "allowed", rateLimitType: "five_hour", utilization: 99 }, "a");
    expect(meter.gate(85).admit).toBe(true); // disabled is operator intent, not a gate state
  });

  it("a disabled login's headroom does NOT count: gate refuses when every ENABLED login is gated", () => {
    const { meter, disabled } = disableableMeter();
    disabled.add("a"); // a has headroom but is parked
    meter.record({ status: "allowed", rateLimitType: "five_hour", utilization: 95 }, "b");
    expect(meter.gate(85).admit).toBe(false);
  });

  it("all-disabled pool: gate ADMITS (never pauses the daemon on operator intent), acquireIfHeadroom is null", () => {
    // Reachable only when claude is selected by no preference list (the config gate rejects it
    // otherwise), so the whole-daemon claude gate must not hold other providers' work back —
    // while the acquire path still never hands out a parked credential.
    const { meter, disabled } = disableableMeter();
    disabled.add("a");
    disabled.add("b");
    expect(meter.gate(85).admit).toBe(true);
    expect(meter.acquireIfHeadroom(85)).toBeNull();
  });

  it("snapshot carries the disabled ids alongside the full configured id list", () => {
    const { meter, disabled } = disableableMeter();
    disabled.add("b");
    const snap = meter.snapshot();
    expect(snap.ids).toEqual(["a", "b"]);
    expect(snap.disabledIds).toEqual(["b"]);
  });
});

describe("ProviderPoolMeter — disabled accounts (issue #10)", () => {
  const accounts: Account[] = [
    { id: "claude-a", provider: "claude", configDir: "/c/a" },
    { id: "claude-b", provider: "claude", configDir: "/c/b" },
    { id: "zai-1", provider: "zai", authTokenEnv: "ZAI_KEY_1" },
  ];

  function disableablePool() {
    const clock = { now: NOW };
    const disabled = new Set<string>();
    const meter = new ProviderPoolMeter({ accounts, now: () => clock.now, isDisabled: (id) => disabled.has(id) });
    return { meter, clock, disabled };
  }

  it("acquireAccount never returns a disabled account — it skips to an enabled sibling", () => {
    const { meter, disabled } = disableablePool();
    disabled.add("claude-a");
    expect(meter.acquireAccount("claude", 85)?.id).toBe("claude-b");
  });

  it("a provider whose only account is disabled reads as no headroom (skipped like the all-gated case)", () => {
    const { meter, disabled } = disableablePool();
    disabled.add("zai-1");
    expect(meter.hasHeadroom("zai", 85)).toBe(false);
    expect(meter.acquireAccount("zai", 85)).toBeNull();
  });

  it("one disabled+gated account plus one enabled-with-headroom keeps the pool available", () => {
    const { meter, disabled } = disableablePool();
    disabled.add("claude-a");
    meter.record({ status: "allowed", rateLimitType: "five_hour", utilization: 99 }, "claude-a");
    expect(meter.hasHeadroom("claude", 85)).toBe(true);
    expect(meter.acquireAccount("claude", 85)?.id).toBe("claude-b");
  });
});
