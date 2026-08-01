import { describe, expect, it } from "vitest";
import type { Account, AgentSettings, ProvidersSettings } from "../config/schema";
import type { RoutingConfig, RouteWorld } from "../providers/resolve";
import { providerPreferenceList } from "../providers/select";
import { MASTER_TIER, resolveMasterRoute } from "./route";

const claudeAccount: Account = { id: "claude-a", provider: "claude", configDir: "~/.claude" };
const zaiAccount: Account = { id: "zai-1", provider: "zai", authTokenEnv: "ZAI_API_KEY" };
const openaiAccount: Account = { id: "codex-1", provider: "openai", codexHome: "~/.codex" };

function agent(tiers: AgentSettings["tiers"], types: AgentSettings["types"] = {}): AgentSettings {
  return {
    wallClockSeconds: 3600,
    heartbeatSeconds: 30,
    model: "opus",
    effort: "xhigh",
    mcpServers: [],
    mcpServerDefs: {},
    settingSources: ["project"],
    provider: "zai",
    types,
    tiers,
  };
}

const providers: ProvidersSettings = {};

const worldWith = (accounts: Account[]): RouteWorld => ({
  acquireAccount: (_repo, provider) => accounts.find((a) => a.provider === provider) ?? null,
});

const routing = (a: AgentSettings, p: ProvidersSettings = providers): RoutingConfig => ({
  agent: a,
  providers: p,
});

// The mappings the issue pins as BINDING, not illustrative (ADR-0041).
const TIER_1_ROUTES = [{ provider: "claude" as const, model: "claude-fable-5" }];
const TIER_2_ROUTES = [{ provider: "claude" as const, model: "claude-opus-5" }];

describe("master route resolution (ADR-0041)", () => {
  it("dispatches the master on the tier-1 profile", () => {
    const resolved = resolveMasterRoute(
      routing(agent({ "1": { routes: TIER_1_ROUTES } })),
      "o/r",
      worldWith([claudeAccount]),
    );
    expect(resolved).toEqual({
      kind: "route",
      route: { provider: "claude", model: "claude-fable-5", account: claudeAccount },
    });
    expect(MASTER_TIER).toBe(1);
  });

  it("fails closed — never a cheaper master — when the tier-1 profile is missing", () => {
    const resolved = resolveMasterRoute(routing(agent({})), "o/r", worldWith([claudeAccount, zaiAccount]));
    expect(resolved).toMatchObject({ kind: "unconfigured", defect: "missing-tier-1-profile" });
    expect(resolved.kind === "unconfigured" && resolved.detail).toContain('agent.tiers."1".routes');
  });

  it("fails closed when the tier-1 profile declares an empty route list", () => {
    // A profile that sets only budgets is still "no route" for the master.
    const resolved = resolveMasterRoute(
      routing(agent({ "1": { effort: "max", wallClockSeconds: 10800 } })),
      "o/r",
      worldWith([claudeAccount]),
    );
    expect(resolved).toMatchObject({ kind: "unconfigured", defect: "missing-tier-1-profile" });
  });

  it("fails closed with a NAMED defect when tier 1 is not tools-capable", () => {
    const resolved = resolveMasterRoute(
      routing(agent({ "1": { routes: [{ provider: "openai", model: "gpt-5.5" }] } })),
      "o/r",
      worldWith([openaiAccount, claudeAccount]),
    );
    expect(resolved).toMatchObject({ kind: "unconfigured", defect: "tier-1-not-tools-capable" });
    expect(resolved.kind === "unconfigured" && resolved.detail).toContain("tools-capable");
    // Crucially it did NOT silently fall through to the tools-capable claude account.
    expect(resolved.kind).not.toBe("route");
  });

  it("reports a plain wait (not a defect) when a sound config has no headroom", () => {
    const resolved = resolveMasterRoute(
      routing(agent({ "1": { routes: TIER_1_ROUTES } })),
      "o/r",
      worldWith([]),
    );
    expect(resolved).toEqual({ kind: "wait" });
  });

  it("honours an explicit toolsCapable override on the tier-1 provider", () => {
    const resolved = resolveMasterRoute(
      routing(agent({ "1": { routes: [{ provider: "openai", model: "gpt-5.5" }] } }), {
        openai: { model: "gpt-5.5", toolsCapable: true },
      }),
      "o/r",
      worldWith([openaiAccount]),
    );
    expect(resolved).toMatchObject({ kind: "route" });
  });
});

describe("complexity tier → model routing is binding (ADR-0041)", () => {
  const settings = agent(
    { "1": { routes: TIER_1_ROUTES }, "2": { routes: TIER_2_ROUTES } },
    { impl: { provider: "zai" }, review: { provider: "zai" }, fix: { provider: "zai" } },
  );

  it("complexity:1 selects claude-fable-5 for implementation, with no fallback", () => {
    expect(providerPreferenceList(settings, "impl", undefined, 1)).toEqual([
      { provider: "claude", modelOverride: "claude-fable-5" },
    ]);
  });

  it("complexity:2 selects claude-opus-5 for implementation, with no fallback", () => {
    expect(providerPreferenceList(settings, "impl", undefined, 2)).toEqual([
      { provider: "claude", modelOverride: "claude-opus-5" },
    ]);
  });

  it("complexity:1 selects claude-fable-5 for master dispatch", () => {
    expect(providerPreferenceList(settings, "master", undefined, 1)).toEqual([
      { provider: "claude", modelOverride: "claude-fable-5" },
    ]);
  });

  it("complexity:2 selects claude-opus-5 for master dispatch", () => {
    expect(providerPreferenceList(settings, "master", undefined, 2)).toEqual([
      { provider: "claude", modelOverride: "claude-opus-5" },
    ]);
  });

  it("never silently substitutes one tier's model for the other", () => {
    const one = providerPreferenceList(settings, "impl", undefined, 1);
    const two = providerPreferenceList(settings, "impl", undefined, 2);
    expect(one[0]?.modelOverride).not.toBe(two[0]?.modelOverride);
    for (const list of [one, two]) {
      expect(list).toHaveLength(1);
      expect(list[0]?.provider).toBe("claude");
    }
  });
});

describe("tier-1 governs every agent lane (ADR-0041 amending ADR-0039)", () => {
  const settings = agent(
    { "1": { routes: TIER_1_ROUTES }, "2": { routes: TIER_2_ROUTES } },
    {
      impl: { provider: "zai" },
      review: { base: [{ provider: "zai" }], phase2: [{ provider: "openai" }] },
      fix: { provider: "zai" },
      autoMode: { provider: "zai" },
    },
  );

  it("outranks agent.types for review, fix and autoMode on a promoted issue", () => {
    for (const type of ["review", "fix", "autoMode"] as const) {
      expect(providerPreferenceList(settings, type, undefined, 1)).toEqual([
        { provider: "claude", modelOverride: "claude-fable-5" },
      ]);
    }
  });

  it("outranks per-phase review/fix routes on a promoted issue", () => {
    expect(providerPreferenceList(settings, "review", 2, 1)).toEqual([
      { provider: "claude", modelOverride: "claude-fable-5" },
    ]);
    expect(providerPreferenceList(settings, "review", 1, 1)).toEqual([
      { provider: "claude", modelOverride: "claude-fable-5" },
    ]);
  });

  it("leaves review/fix uniform for an UNpromoted tier-2 issue (ADR-0014)", () => {
    expect(providerPreferenceList(settings, "review", 1, 2)).toEqual([{ provider: "zai" }]);
    expect(providerPreferenceList(settings, "review", 2, 2)).toEqual([{ provider: "openai" }]);
    expect(providerPreferenceList(settings, "fix", undefined, 2)).toEqual([{ provider: "zai" }]);
    // ...while impl and master still take the tier-2 profile.
    expect(providerPreferenceList(settings, "impl", undefined, 2)).toEqual([
      { provider: "claude", modelOverride: "claude-opus-5" },
    ]);
  });

  it("leaves every lane on agent.types when the issue carries no tier", () => {
    expect(providerPreferenceList(settings, "impl", undefined, null)).toEqual([{ provider: "zai" }]);
    expect(providerPreferenceList(settings, "review", 1, null)).toEqual([{ provider: "zai" }]);
  });
});
