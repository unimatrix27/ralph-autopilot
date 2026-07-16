import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../config/load";
import type { RalphConfig } from "../config/schema";
import { createLogger } from "../log/logger";
import { buildRateLimitRecorder, buildUsageRouting, implProviderResetsAt } from "./daemon";
import { UsageMeter } from "./usage-meter";

const silent = createLogger({ write: () => {} });
const REPO = "acme/widgets";

const tmpDirs: string[] = [];

/** A CLAUDE_CONFIG_DIR store carrying a real `.credentials.json` — what `claude login` writes. */
function loggedInConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ralph-claude-"));
  writeFileSync(join(dir, ".credentials.json"), "{}");
  tmpDirs.push(dir);
  return dir;
}

/** A CLAUDE_CONFIG_DIR store that exists but was never logged into (no `.credentials.json`). */
function emptyConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ralph-claude-empty-"));
  tmpDirs.push(dir);
  return dir;
}

function configWith(raw: Record<string, unknown>): RalphConfig {
  return parseConfig({
    targets: [{ repo: REPO, commands: { build: "x", test: "y" } }],
    ...raw,
  });
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildUsageRouting — the pool is the single credential source for claude (ADR-0037 P2.2)", () => {
  it("routes a claude account declared ONLY under accounts: to its configDir (#162 P0)", () => {
    const configDir = loggedInConfigDir();
    // The documented migration: claude logins under `accounts:`, NOT usageLimit.subscriptions.
    const config = configWith({ accounts: [{ id: "alice", provider: "claude", configDir }] });

    const { routeWorld } = buildUsageRouting(config, silent);

    // Before the fix the meter was built from usageLimit.subscriptions alone, so an
    // accounts:-only claude login was silently dropped to the box default (id "default",
    // empty configDir). It must now route to the login's own configDir.
    expect(routeWorld.acquireAccount(REPO, "claude")).toEqual({
      id: "alice",
      provider: "claude",
      configDir,
    });
  });

  it("still routes legacy usageLimit.subscriptions logins (back-compat fold)", () => {
    const configDir = loggedInConfigDir();
    const config = configWith({ usageLimit: { subscriptions: [{ id: "legacy", configDir }] } });

    const { routeWorld } = buildUsageRouting(config, silent);

    expect(routeWorld.acquireAccount(REPO, "claude")).toEqual({
      id: "legacy",
      provider: "claude",
      configDir,
    });
  });

  it("falls back to the single box-default login when no claude account is configured", () => {
    const { routeWorld } = buildUsageRouting(configWith({}), silent);

    expect(routeWorld.acquireAccount(REPO, "claude")).toEqual({
      id: "default",
      provider: "claude",
      configDir: "",
    });
  });

  it("fails loud when configured claude accounts have no valid login (.credentials.json)", () => {
    const config = configWith({ accounts: [{ id: "alice", provider: "claude", configDir: emptyConfigDir() }] });

    expect(() => buildUsageRouting(config, silent)).toThrow(/none have a valid login/);
  });
});

describe("buildRateLimitRecorder — fold a container-reported signal into the right meter (ADR-0037/0038 / issue #228)", () => {
  const HOUR_MS = 3_600_000;
  const future = (): number => Date.now() + HOUR_MS;

  /** A two-claude pool + the daemon's two meters (claude OAuth + the separate z.ai cooldown). */
  function twoClaudePool(): {
    usageMeter: UsageMeter;
    routeWorld: ReturnType<typeof buildUsageRouting>["routeWorld"];
    providerUsageMeter: UsageMeter;
    recorder: ReturnType<typeof buildRateLimitRecorder>;
    admitBelowPercent: number;
  } {
    const config = configWith({
      accounts: [
        { id: "c1", provider: "claude", configDir: loggedInConfigDir() },
        { id: "c2", provider: "claude", configDir: loggedInConfigDir() },
      ],
    });
    const { usageMeter, routeWorld } = buildUsageRouting(config, silent);
    const providerUsageMeter = new UsageMeter({ tokens: [{ id: "zai" }] });
    return {
      usageMeter,
      routeWorld,
      providerUsageMeter,
      recorder: buildRateLimitRecorder(usageMeter, providerUsageMeter),
      admitBelowPercent: config.usageLimit.admitBelowPercent,
    };
  }

  it("moves the NAMED claude account's headroom in the OAuth meter, leaving the other login + z.ai untouched", () => {
    const { usageMeter, providerUsageMeter, recorder } = twoClaudePool();

    recorder("claude", "c1", { status: "rejected", resetsAt: future(), utilization: 100, rateLimitType: "five_hour" });

    const claude = usageMeter.snapshot();
    expect(claude.states["c1"]?.cooldownUntilMs).not.toBeNull();
    expect(claude.states["c1"]?.windows["five_hour"]?.utilization).toBe(100);
    // The other claude login is untouched, and the z.ai cooldown meter never saw it (no cross-feed).
    expect(claude.states["c2"]).toBeUndefined();
    expect(providerUsageMeter.snapshot().states["zai"]).toBeUndefined();
  });

  it("a z.ai signal moves ONLY the z.ai cooldown meter, never the Claude plan window (ADR-0034)", () => {
    const { usageMeter } = buildUsageRouting(configWith({}), silent); // box-default claude login
    const providerUsageMeter = new UsageMeter({ tokens: [{ id: "zai" }] });
    const recorder = buildRateLimitRecorder(usageMeter, providerUsageMeter);

    recorder("zai", "zai", { status: "rejected", resetsAt: future() });

    expect(providerUsageMeter.snapshot().states["zai"]?.cooldownUntilMs).not.toBeNull();
    // No cross-contamination: the Claude OAuth meter is completely untouched.
    expect(usageMeter.snapshot().states["default"]).toBeUndefined();
  });

  it("after a reported exhaustion, route resolution rotates off that account; defers only when ALL are exhausted (ADR-0028)", () => {
    const { usageMeter, routeWorld, recorder, admitBelowPercent } = twoClaudePool();

    // Both logins fresh → route resolution hands back a claude account, and admission is open.
    const first = routeWorld.acquireAccount(REPO, "claude");
    expect(first).not.toBeNull();
    expect(usageMeter.gate(admitBelowPercent).admit).toBe(true);

    // That account reports exhaustion from inside its container (the relayed rate-limit signal).
    recorder("claude", first!.id, { status: "rejected", resetsAt: future() });

    // Route resolution rotates onto the login that still has headroom — never the throttled one —
    // and admission is NOT yet deferred (the other login is fine): the ADR-0028 invariant.
    const second = routeWorld.acquireAccount(REPO, "claude");
    expect(second?.id).not.toBe(first!.id);
    expect(usageMeter.gate(admitBelowPercent).admit).toBe(true);

    // The second login also reports exhaustion → now EVERY claude login is gated → admission defers
    // (the reconciler raises `no-provider`), only now that all accounts are exhausted.
    recorder("claude", second!.id, { status: "rejected", resetsAt: future() });
    expect(usageMeter.gate(admitBelowPercent).admit).toBe(false);
  });

  it("a dropped/unattributable signal leaves both meters unchanged and never throws (best-effort)", () => {
    const { usageMeter, providerUsageMeter, recorder } = twoClaudePool();
    const before = JSON.stringify({ c: usageMeter.snapshot().states, z: providerUsageMeter.snapshot().states });

    // A claude signal with no account id (a route-less dispatch / a dropped accountId) must no-op
    // rather than trip the wrong login; an openai signal has no meter at all. Neither throws.
    expect(() => recorder("claude", undefined, { status: "rejected", resetsAt: future() })).not.toThrow();
    expect(() => recorder("openai", "o1", { status: "rejected", resetsAt: future() })).not.toThrow();

    expect(JSON.stringify({ c: usageMeter.snapshot().states, z: providerUsageMeter.snapshot().states })).toBe(before);
  });
});

describe("buildUsageRouting — operator-disabled accounts are invisible to dispatch (issue #10)", () => {
  it("claude: a disabled login is never dispatched; selection lands on the enabled sibling, live", () => {
    const config = configWith({
      accounts: [
        { id: "c1", provider: "claude", configDir: loggedInConfigDir() },
        { id: "c2", provider: "claude", configDir: loggedInConfigDir() },
      ],
    });
    const disabled = new Set<string>();
    const { routeWorld } = buildUsageRouting(config, silent, (id) => disabled.has(id));

    expect(routeWorld.acquireAccount(REPO, "claude")?.id).toBe("c1");
    disabled.add("c1"); // the web edit lands in the overlay — no rebuild, next dispatch sees it
    expect(routeWorld.acquireAccount(REPO, "claude")?.id).toBe("c2");
    disabled.delete("c1");
    disabled.add("c2");
    expect(routeWorld.acquireAccount(REPO, "claude")?.id).toBe("c1");
  });

  it("claude: every pool login disabled → no route (never a parked credential, never the box default)", () => {
    const config = configWith({
      accounts: [{ id: "c1", provider: "claude", configDir: loggedInConfigDir() }],
    });
    const { routeWorld } = buildUsageRouting(config, silent, (id) => id === "c1");
    expect(routeWorld.acquireAccount(REPO, "claude")).toBeNull();
  });

  it("zai/openai: the first ENABLED pool account backs the route; all-disabled → null (walk on / wait)", () => {
    const config = configWith({
      providers: { zai: {}, openai: { codexHome: "~/.codex" } },
      accounts: [
        { id: "z1", provider: "zai", authTokenEnv: "K1" },
        { id: "z2", provider: "zai", authTokenEnv: "K2" },
      ],
    });
    const disabled = new Set<string>(["z1"]);
    const { routeWorld } = buildUsageRouting(config, silent, (id) => disabled.has(id));

    expect(routeWorld.acquireAccount(REPO, "zai")?.id).toBe("z2");
    disabled.add("z2");
    expect(routeWorld.acquireAccount(REPO, "zai")).toBeNull();
    // The back-compat openai slice account is addressable by its synthetic pool id too.
    expect(routeWorld.acquireAccount(REPO, "openai")?.id).toBe("openai");
    disabled.add("openai");
    expect(routeWorld.acquireAccount(REPO, "openai")).toBeNull();
  });
});

describe("implProviderResetsAt — a disabled login's windows never shape the ETA (issue #10)", () => {
  it("ignores the disabled login's earlier reset; the enabled gated login's reset is the honest ETA", () => {
    const NOW = 1_750_000_000_000;
    const disabled = new Set<string>(["c1"]);
    const meter = new UsageMeter({
      tokens: [{ id: "c1" }, { id: "c2" }],
      now: () => NOW,
      isDisabled: (id) => disabled.has(id),
    });
    // c1 (disabled) would reset SOONER; c2 (enabled) is gated with a later reset.
    meter.record({ status: "allowed", rateLimitType: "five_hour", utilization: 99, resetsAt: NOW + 60_000 }, "c1");
    meter.record({ status: "allowed", rateLimitType: "five_hour", utilization: 99, resetsAt: NOW + 600_000 }, "c2");
    expect(implProviderResetsAt(meter, 85, NOW)).toBe(new Date(NOW + 600_000).toISOString());
    // With every gating login disabled and the enabled sibling un-gated, there is no ETA at all.
    disabled.add("c2");
    disabled.delete("c1");
    meter.record({ status: "allowed", rateLimitType: "five_hour", utilization: 10 }, "c1");
    expect(implProviderResetsAt(meter, 85, NOW)).toBeNull();
  });
});
