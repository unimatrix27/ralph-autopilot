import { describe, expect, it } from "vitest";
import { parseConfig } from "../config/load";
import type { AgentSettings, ProvidersSettings } from "../config/schema";
import {
  allPreferenceLists,
  capabilityOk,
  perPhasePreferenceLists,
  providerForAgentType,
  providerPreferenceList,
  requiresTools,
  tierProfile,
} from "./select";

/** Build a fully-defaulted global agent settings block from a partial `agent` input. */
function agentSettings(agent: Record<string, unknown> = {}): AgentSettings {
  return parseConfig({
    targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
    agent,
  }).agent;
}

/** Build a fully-defaulted providers block from a partial `providers` input. */
function providers(providersInput: Record<string, unknown> = {}): ProvidersSettings {
  return parseConfig({
    targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
    providers: providersInput,
  }).providers;
}

describe("providerForAgentType", () => {
  it("defaults every agent type to the claude provider with no model override", () => {
    const agent = agentSettings();
    for (const type of ["impl", "review", "fix", "autoMode"] as const) {
      expect(providerForAgentType(agent, type)).toEqual({ provider: "claude" });
    }
  });

  it("applies the global agent.provider to every type lacking an override", () => {
    const agent = agentSettings({ provider: "openai" });
    expect(providerForAgentType(agent, "review").provider).toBe("openai");
    expect(providerForAgentType(agent, "impl").provider).toBe("openai");
  });

  it("a per-type provider override wins over the global default (per type)", () => {
    const agent = agentSettings({ types: { review: { provider: "openai" } } });
    expect(providerForAgentType(agent, "review")).toEqual({ provider: "openai" });
    // Untouched types still resolve to the global default.
    expect(providerForAgentType(agent, "fix")).toEqual({ provider: "claude" });
    expect(providerForAgentType(agent, "impl")).toEqual({ provider: "claude" });
  });

  it("a per-type claude override beats a global openai default", () => {
    const agent = agentSettings({ provider: "openai", types: { impl: { provider: "claude" } } });
    expect(providerForAgentType(agent, "impl").provider).toBe("claude");
    expect(providerForAgentType(agent, "review").provider).toBe("openai");
  });

  it("surfaces a per-type model override as modelOverride (independent of provider)", () => {
    const agent = agentSettings({
      types: {
        review: { provider: "openai", model: "gpt-5.5" },
        impl: { model: "sonnet" },
      },
    });
    expect(providerForAgentType(agent, "review")).toEqual({ provider: "openai", modelOverride: "gpt-5.5" });
    // A claude-provider per-type model override is still surfaced.
    expect(providerForAgentType(agent, "impl")).toEqual({ provider: "claude", modelOverride: "sonnet" });
  });

  it("returns the HEAD of a preference list (slice-3 fallback is out of scope here)", () => {
    const agent = agentSettings({
      types: {
        review: [
          { provider: "zai", model: "glm-5.2" },
          { provider: "openai", model: "gpt-5.5" },
        ],
      },
    });
    // The composition root wires the first preference entry today; resolution that
    // falls through to later entries is ADR-0037 slice 3+.
    expect(providerForAgentType(agent, "review")).toEqual({ provider: "zai", modelOverride: "glm-5.2" });
  });
});

describe("providerPreferenceList (ADR-0037 P1.2)", () => {
  it("normalises an absent override to a one-entry list of the global provider", () => {
    const agent = agentSettings();
    expect(providerPreferenceList(agent, "impl")).toEqual([{ provider: "claude" }]);
    const openaiGlobal = agentSettings({ provider: "openai" });
    expect(providerPreferenceList(openaiGlobal, "review")).toEqual([{ provider: "openai" }]);
  });

  it("normalises the legacy single-object form to a one-entry list", () => {
    const agent = agentSettings({ types: { review: { provider: "openai", model: "gpt-5.5" } } });
    expect(providerPreferenceList(agent, "review")).toEqual([
      { provider: "openai", modelOverride: "gpt-5.5" },
    ]);
  });

  it("inherits the global provider for a legacy single-object form that sets only a model", () => {
    const agent = agentSettings({ provider: "zai", types: { impl: { model: "glm-5.2[1m]" } } });
    expect(providerPreferenceList(agent, "impl")).toEqual([
      { provider: "zai", modelOverride: "glm-5.2[1m]" },
    ]);
  });

  it("preserves the order of a preference list, model travelling with each entry", () => {
    const agent = agentSettings({
      types: {
        review: [
          { provider: "zai", model: "glm-5.2" },
          { provider: "openai", model: "gpt-5.5" },
          { provider: "claude" },
        ],
      },
    });
    expect(providerPreferenceList(agent, "review")).toEqual([
      { provider: "zai", modelOverride: "glm-5.2" },
      { provider: "openai", modelOverride: "gpt-5.5" },
      { provider: "claude" },
    ]);
  });
});

describe("per-phase routing key (ADR-0037 #169) — providerPreferenceList(agent, type, phase)", () => {
  it("a flat list applies to every phase (list form ≡ base-for-all-phases, backward compat)", () => {
    const agent = agentSettings({ types: { review: [{ provider: "zai", model: "glm-5.2" }] } });
    for (const phase of [undefined, 1, 2] as const) {
      expect(providerPreferenceList(agent, "review", phase)).toEqual([{ provider: "zai", modelOverride: "glm-5.2" }]);
    }
  });

  it("the object form resolves phaseN ?? base per phase (whole-list replacement)", () => {
    const agent = agentSettings({
      types: {
        review: {
          base: [{ provider: "zai", model: "glm-5.2" }],
          phase2: [{ provider: "claude", model: "opus" }],
        },
      },
    });
    // No phase / phase 1 (no override) → base.
    expect(providerPreferenceList(agent, "review")).toEqual([{ provider: "zai", modelOverride: "glm-5.2" }]);
    expect(providerPreferenceList(agent, "review", 1)).toEqual([{ provider: "zai", modelOverride: "glm-5.2" }]);
    // Phase 2 has an override → the per-phase list REPLACES base (not concatenation).
    expect(providerPreferenceList(agent, "review", 2)).toEqual([{ provider: "claude", modelOverride: "opus" }]);
  });

  it("phase 0 (CI-gate/merge fix — no per-phase key) resolves to base", () => {
    const agent = agentSettings({
      types: { fix: { base: [{ provider: "zai" }], phase2: [{ provider: "claude" }] } },
    });
    expect(providerPreferenceList(agent, "fix", 0)).toEqual([{ provider: "zai" }]);
  });

  it("each phase's fallback chain is self-contained (per-phase list is the whole preference list)", () => {
    const agent = agentSettings({
      types: {
        fix: {
          base: [{ provider: "claude" }],
          phase1: [{ provider: "zai", model: "glm-5.2" }, { provider: "claude" }],
        },
      },
    });
    expect(providerPreferenceList(agent, "fix", 1)).toEqual([
      { provider: "zai", modelOverride: "glm-5.2" },
      { provider: "claude" },
    ]);
    // phase2 has no override → base.
    expect(providerPreferenceList(agent, "fix", 2)).toEqual([{ provider: "claude" }]);
  });

  it("the base may itself be the legacy single form (normalised to a one-entry list)", () => {
    const agent = agentSettings({
      types: { review: { base: { provider: "zai", model: "glm-5.2" }, phase2: { provider: "claude" } } },
    });
    expect(providerPreferenceList(agent, "review", 1)).toEqual([{ provider: "zai", modelOverride: "glm-5.2" }]);
    expect(providerPreferenceList(agent, "review", 2)).toEqual([{ provider: "claude" }]);
  });
});

describe("perPhasePreferenceLists (ADR-0037 #169) — the explicitly-overridden phase lists for the read API", () => {
  it("returns {} for a single-phase / unphased type (flat list, legacy, or absent)", () => {
    expect(perPhasePreferenceLists(agentSettings(), "review")).toEqual({});
    expect(perPhasePreferenceLists(agentSettings({ types: { review: [{ provider: "zai" }] } }), "review")).toEqual({});
    expect(perPhasePreferenceLists(agentSettings({ types: { impl: { provider: "claude" } } }), "impl")).toEqual({});
  });

  it("returns only the explicitly-overridden phases of an object form", () => {
    const agent = agentSettings({
      types: {
        review: {
          base: [{ provider: "zai", model: "glm-5.2" }],
          phase2: [{ provider: "claude", model: "opus" }],
        },
      },
    });
    expect(perPhasePreferenceLists(agent, "review")).toEqual({
      phase2: [{ provider: "claude", modelOverride: "opus" }],
    });
  });
});

describe("requiresTools (ADR-0037 P1.2 capability gate)", () => {
  it("only impl requires in-session host-callback tools", () => {
    expect(requiresTools("impl")).toBe(true);
    expect(requiresTools("review")).toBe(false);
    expect(requiresTools("fix")).toBe(false);
    expect(requiresTools("autoMode")).toBe(false);
  });

  it("defaults an unknown type to NOT requiring tools (open list — additive later)", () => {
    expect(requiresTools("phase2review" as never)).toBe(false);
  });
});

describe("capabilityOk (ADR-0037 P1.2 capability gate)", () => {
  it("gates impl to tools-capable providers, open for the structured types", () => {
    const p = providers();
    // impl requires tools: claude/zai are tools-capable, bare openai (Codex) is not.
    expect(capabilityOk("impl", "claude", p)).toBe(true);
    expect(capabilityOk("impl", "zai", p)).toBe(true);
    expect(capabilityOk("impl", "openai", p)).toBe(false);
    // review/fix/autoMode are capability-open on every provider.
    for (const type of ["review", "fix", "autoMode"] as const) {
      expect(capabilityOk(type, "openai", p)).toBe(true);
      expect(capabilityOk(type, "claude", p)).toBe(true);
      expect(capabilityOk(type, "zai", p)).toBe(true);
    }
  });

  it("respects a per-provider toolsCapable override", () => {
    // openai flipped tools-capable (the future MCP-port maturity flag) → impl OK.
    expect(capabilityOk("impl", "openai", providers({ openai: { codexHome: "~/.codex", toolsCapable: true } }))).toBe(
      true,
    );
    // claude deliberately barred from tools → impl NOT ok.
    expect(capabilityOk("impl", "claude", providers({ claude: { toolsCapable: false } }))).toBe(false);
  });

  it("is open for an unknown type regardless of provider capability (open list)", () => {
    expect(capabilityOk("phase2review" as never, "openai", providers())).toBe(true);
  });
});

describe("per-tier routing key (issue #278) — providerPreferenceList(agent, 'impl', undefined, tier)", () => {
  const TIERED = {
    types: { impl: [{ provider: "zai" as const }] },
    tiers: {
      "1": { routes: [{ provider: "claude" as const, model: "claude-fable-5" }], effort: "max", wallClockSeconds: 10800 },
      "3": { effort: "medium" }, // profile with NO routes — routing falls back to types.impl
    },
  };

  it("a configured tier's routes replace the impl preference list whole", () => {
    const agent = agentSettings(TIERED);
    expect(providerPreferenceList(agent, "impl", undefined, 1)).toEqual([
      { provider: "claude", modelOverride: "claude-fable-5" },
    ]);
  });

  it("an absent tier (unlabeled issue) resolves types.impl unchanged", () => {
    const agent = agentSettings(TIERED);
    expect(providerPreferenceList(agent, "impl")).toEqual([{ provider: "zai" }]);
    expect(providerPreferenceList(agent, "impl", undefined, null)).toEqual([{ provider: "zai" }]);
  });

  it("an unconfigured tier resolves types.impl (no profile for that tier)", () => {
    const agent = agentSettings(TIERED);
    expect(providerPreferenceList(agent, "impl", undefined, 2)).toEqual([{ provider: "zai" }]);
  });

  it("a tier profile without routes re-budgets only — routing falls back to types.impl", () => {
    const agent = agentSettings(TIERED);
    expect(providerPreferenceList(agent, "impl", undefined, 3)).toEqual([{ provider: "zai" }]);
  });

  it("a tier is impl-only: every other type ignores it", () => {
    const agent = agentSettings({ ...TIERED, types: { ...TIERED.types, review: [{ provider: "openai" as const }] } });
    expect(providerPreferenceList(agent, "review", undefined, 1)).toEqual([{ provider: "openai" }]);
    expect(providerPreferenceList(agent, "autoMode", undefined, 1)).toEqual([{ provider: "claude" }]);
  });

  it("with no tiers configured at all the impl list is byte-identical to before", () => {
    const agent = agentSettings({ types: { impl: [{ provider: "zai" }] } });
    expect(providerPreferenceList(agent, "impl", undefined, 1)).toEqual([{ provider: "zai" }]);
  });

  it("tierProfile returns the tier's profile, and undefined for absent/unconfigured tiers", () => {
    const agent = agentSettings(TIERED);
    expect(tierProfile(agent, 1)).toEqual({
      routes: [{ provider: "claude", model: "claude-fable-5" }],
      effort: "max",
      wallClockSeconds: 10800,
    });
    expect(tierProfile(agent, 3)).toEqual({ effort: "medium" });
    expect(tierProfile(agent, 2)).toBeUndefined();
    expect(tierProfile(agent, null)).toBeUndefined();
    expect(tierProfile(agent, undefined)).toBeUndefined();
  });

  it("allPreferenceLists covers every configured tier's routes for impl (load-time validation input)", () => {
    const agent = agentSettings(TIERED);
    const all = allPreferenceLists(agent, "impl");
    // base (zai) + tier-1 routes; tier-3 has no routes and contributes nothing.
    expect(all).toEqual([{ provider: "zai" }, { provider: "claude", modelOverride: "claude-fable-5" }]);
    // Non-impl types are unaffected by tiers.
    expect(allPreferenceLists(agent, "review")).toEqual([{ provider: "claude" }]);
  });
});
