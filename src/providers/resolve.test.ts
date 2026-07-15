import { describe, expect, it, vi } from "vitest";
import { parseConfig, resolveTargets } from "../config/load";
import type { Account, ProviderName } from "../config/schema";
import { resolveDispatchRoute, resolveEffectiveRouting, resolveRoute, type RouteWorld, type RoutingConfig } from "./resolve";

const REPO = "a/b";

/** Build a fully-defaulted routing bundle (agent + providers) from partial inputs. */
function routing(agent: Record<string, unknown> = {}, providers: Record<string, unknown> = {}): RoutingConfig {
  const cfg = parseConfig({ targets: [{ repo: REPO, commands: { build: "x", test: "y" } }], agent, providers });
  return { agent: cfg.agent, providers: cfg.providers };
}

const CLAUDE: Account = { id: "c1", provider: "claude", configDir: "/c" };
const ZAI: Account = { id: "z1", provider: "zai", authTokenEnv: "ZAI_KEY" };
const OPENAI: Account = { id: "o1", provider: "openai", codexHome: "/o" };

/**
 * A pure fake of the headroom port: each named provider hands back a fixed account
 * (its pool has headroom); any unnamed provider returns null (fully gated / empty).
 */
function world(headroom: Partial<Record<ProviderName, Account>>): RouteWorld {
  return { acquireAccount: (_repo, provider) => headroom[provider] ?? null };
}

describe("resolveRoute (ADR-0037 P2.1)", () => {
  it("returns the most-preferred capability-allowed provider that has headroom", () => {
    const r = routing({ types: { review: [{ provider: "zai", model: "glm-5.2" }, { provider: "openai", model: "gpt-5.5" }] } });
    const route = resolveRoute(r, REPO, "review", world({ zai: ZAI, openai: OPENAI }));
    expect(route).toEqual({ provider: "zai", model: "glm-5.2", account: ZAI });
  });

  it("falls through to the next entry when the preferred pool is fully gated", () => {
    const r = routing({ types: { review: [{ provider: "zai", model: "glm-5.2" }, { provider: "claude" }] } });
    // zai pool has no headroom (world returns null); claude does → claude wins.
    const route = resolveRoute(r, REPO, "review", world({ claude: CLAUDE }));
    expect(route).toEqual({ provider: "claude", account: CLAUDE });
  });

  it("returns no-provider when every allowed pool is gated", () => {
    const r = routing({ types: { review: [{ provider: "zai" }, { provider: "claude" }] } });
    expect(resolveRoute(r, REPO, "review", world({}))).toEqual({ wait: "no-provider" });
  });

  it("honours the capability gate at resolution: impl skips bare openai (defence in depth)", () => {
    const r = routing({ types: { impl: [{ provider: "openai", model: "gpt-5.5" }, { provider: "claude" }] } });
    // openai HAS headroom, but impl requires in-session tools and bare openai is not
    // tools-capable → the gate skips it and claude wins.
    const route = resolveRoute(r, REPO, "impl", world({ openai: OPENAI, claude: CLAUDE }));
    expect(route).toEqual({ provider: "claude", account: CLAUDE });
  });

  it("returns no-provider when the only headroom pool is capability-blocked for the type", () => {
    const r = routing({ types: { impl: [{ provider: "openai" }] } });
    // Even though openai has an account with headroom, impl may not run on it → no route,
    // never a guess onto the wrong backend.
    expect(resolveRoute(r, REPO, "impl", world({ openai: OPENAI }))).toEqual({ wait: "no-provider" });
  });

  it("lets impl route to a tools-capable openai once its capability flag is flipped", () => {
    const r = routing(
      { types: { impl: [{ provider: "openai", model: "gpt-5.5" }] } },
      { openai: { codexHome: "/o", toolsCapable: true } },
    );
    const route = resolveRoute(r, REPO, "impl", world({ openai: OPENAI }));
    expect(route).toEqual({ provider: "openai", model: "gpt-5.5", account: OPENAI });
  });

  it("resolves the global default provider when a type has no routing override (no model field)", () => {
    const route = resolveRoute(routing(), REPO, "review", world({ claude: CLAUDE }));
    expect(route).toEqual({ provider: "claude", account: CLAUDE });
    expect(route).not.toHaveProperty("model");
  });

  it("carries the entry's model with the chosen entry, not an earlier skipped one", () => {
    const r = routing({
      types: { fix: [{ provider: "zai", model: "glm-5.2" }, { provider: "claude", model: "opus" }] },
    });
    // zai gated, claude wins → claude's model travels, not zai's.
    const route = resolveRoute(r, REPO, "fix", world({ claude: CLAUDE }));
    expect(route).toEqual({ provider: "claude", model: "opus", account: CLAUDE });
  });

  it("threads the repo to the headroom port (per-repo deviation is an additive overlay)", () => {
    const seen: string[] = [];
    const port: RouteWorld = {
      acquireAccount: (repo, provider) => {
        seen.push(repo);
        return provider === "claude" ? CLAUDE : null;
      },
    };
    resolveRoute(routing(), "owner/some-repo", "review", port);
    expect(seen).toContain("owner/some-repo");
  });
});

describe("resolveRoute — per-phase routing key (ADR-0037 #169)", () => {
  it("a flat list resolves identically for every phase (backward compat)", () => {
    const r = routing({ types: { review: [{ provider: "zai", model: "glm-5.2" }] } });
    for (const phase of [undefined, 1, 2] as const) {
      expect(resolveRoute(r, REPO, "review", world({ zai: ZAI }), phase)).toEqual({
        provider: "zai",
        model: "glm-5.2",
        account: ZAI,
      });
    }
  });

  it("the object form sends phase 2 (thermo) to a different provider than phase 1 — the headline use case", () => {
    // normal review → cheap GLM, nuclear thermo review → opus on claude.
    const r = routing({
      types: {
        review: {
          base: [{ provider: "zai", model: "glm-5.2" }],
          phase2: [{ provider: "claude", model: "opus" }],
        },
      },
    });
    const headroom = world({ zai: ZAI, claude: CLAUDE });
    expect(resolveRoute(r, REPO, "review", headroom, 1)).toEqual({ provider: "zai", model: "glm-5.2", account: ZAI });
    expect(resolveRoute(r, REPO, "review", headroom, 2)).toEqual({ provider: "claude", model: "opus", account: CLAUDE });
  });

  it("a phase with no override falls back to base; phase 0 (CI-gate fix) uses base too", () => {
    const r = routing({
      types: { fix: { base: [{ provider: "claude", model: "opus" }], phase2: [{ provider: "zai" }] } },
    });
    const headroom = world({ claude: CLAUDE, zai: ZAI });
    expect(resolveRoute(r, REPO, "fix", headroom, 0)).toEqual({ provider: "claude", model: "opus", account: CLAUDE });
    expect(resolveRoute(r, REPO, "fix", headroom, 1)).toEqual({ provider: "claude", model: "opus", account: CLAUDE });
    expect(resolveRoute(r, REPO, "fix", headroom, 2)).toEqual({ provider: "zai", account: ZAI });
  });

  it("the per-phase list is the WHOLE fallback chain for that phase (self-contained)", () => {
    const r = routing({
      types: {
        review: {
          base: [{ provider: "claude" }],
          phase2: [{ provider: "zai", model: "glm-5.2" }, { provider: "claude", model: "opus" }],
        },
      },
    });
    // phase2's preferred zai is gated → falls through to phase2's own claude entry, NOT base.
    expect(resolveRoute(r, REPO, "review", world({ claude: CLAUDE }), 2)).toEqual({
      provider: "claude",
      model: "opus",
      account: CLAUDE,
    });
  });

  it("impl/autoMode ignore phase entirely (single-phase types)", () => {
    const r = routing({ types: { impl: [{ provider: "claude", model: "opus" }] } });
    for (const phase of [undefined, 1, 2] as const) {
      expect(resolveRoute(r, REPO, "impl", world({ claude: CLAUDE }), phase)).toEqual({
        provider: "claude",
        model: "opus",
        account: CLAUDE,
      });
    }
  });
});

describe("resolveEffectiveRouting (ADR-0037 P4.1 — resolve(globalRouting, repoPatch?))", () => {
  it("returns the global routing verbatim when the per-repo patch is empty (v1)", () => {
    const global = routing({ types: { review: [{ provider: "zai", model: "glm-5.2" }] } });
    expect(resolveEffectiveRouting(global)).toEqual(global);
    // The patch seam exists (per-repo deviation is #170) but is empty in v1 — still identity.
    expect(resolveEffectiveRouting(global, {})).toEqual(global);
  });

  it("is the resolution route resolution can read directly (preference list preserved)", () => {
    const global = routing({ types: { fix: [{ provider: "claude", model: "opus" }] } });
    const route = resolveRoute(resolveEffectiveRouting(global), REPO, "fix", world({ claude: CLAUDE }));
    expect(route).toEqual({ provider: "claude", model: "opus", account: CLAUDE });
  });
});

describe("resolveDispatchRoute — effective default model fill (route visibility)", () => {
  function target(agent: Record<string, unknown> = {}, providers: Record<string, unknown> = {}) {
    return resolveTargets(
      parseConfig({ targets: [{ repo: REPO, commands: { build: "x", test: "y" } }], agent, providers }),
    )[0]!;
  }
  const deps = (config: ReturnType<typeof target>, headroom: Partial<Record<ProviderName, Account>>) => ({
    config,
    routing: () => ({ agent: config.agent, providers: config.providers }),
    routeWorld: world(headroom),
  });

  it("fills agent.model on a claude route with no per-type override — the recorded route names its model", () => {
    const config = target({ model: "opus", types: { impl: [{ provider: "claude" }] } });
    const route = resolveDispatchRoute(deps(config, { claude: CLAUDE }), "impl");
    expect(route).toEqual({ provider: "claude", model: "opus", account: CLAUDE });
  });

  it("keeps a per-type model override verbatim (no double-fill)", () => {
    const config = target({ model: "opus", types: { impl: [{ provider: "claude", model: "claude-opus-4-8" }] } });
    const route = resolveDispatchRoute(deps(config, { claude: CLAUDE }), "impl");
    expect(route).toEqual({ provider: "claude", model: "claude-opus-4-8", account: CLAUDE });
  });

  it("fills the zai provider block's model for a default zai route", () => {
    vi.stubEnv("ZAI_KEY", "k"); // resolveTargets fail-louds on an unset zai auth env var
    const config = target(
      { types: { review: [{ provider: "zai" }] } },
      { zai: { model: "glm-5.2", authTokenEnv: "ZAI_KEY" } },
    );
    const route = resolveDispatchRoute(deps(config, { zai: ZAI }), "review");
    expect(route).toEqual({ provider: "zai", model: "glm-5.2", account: ZAI });
  });

  it("passes a no-provider wait through untouched", () => {
    const config = target({ types: { review: [{ provider: "claude" }] } });
    expect(resolveDispatchRoute(deps(config, {}), "review")).toEqual({ wait: "no-provider" });
  });

  it("returns null when routing/routeWorld are unwired (box-default dispatch)", () => {
    const config = target();
    expect(resolveDispatchRoute({ config }, "impl")).toBeNull();
  });
});

describe("per-tier impl route resolution (issue #278)", () => {
  const TIERED = {
    types: { impl: [{ provider: "zai", model: "glm-5.2" }] },
    tiers: { "1": { routes: [{ provider: "claude", model: "claude-fable-5" }] } },
  };

  it("a complexity:1 issue resolves the tier-1 routes, replacing types.impl whole", () => {
    const r = routing(TIERED);
    const route = resolveRoute(r, REPO, "impl", world({ claude: CLAUDE, zai: ZAI }), undefined, 1);
    expect(route).toEqual({ provider: "claude", model: "claude-fable-5", account: CLAUDE });
  });

  it("an unlabeled issue resolves types.impl exactly as before", () => {
    const r = routing(TIERED);
    const route = resolveRoute(r, REPO, "impl", world({ claude: CLAUDE, zai: ZAI }), undefined, null);
    expect(route).toEqual({ provider: "zai", model: "glm-5.2", account: ZAI });
  });

  it("a gated tier pool is a no-provider wait — whole-list replacement, no silent fallback to base", () => {
    const r = routing(TIERED);
    // claude (the tier-1 route) has no headroom; zai does — but the tier REPLACED the list,
    // so the run defers (`limited` at dispatch) rather than silently downgrading to zai.
    expect(resolveRoute(r, REPO, "impl", world({ zai: ZAI }), undefined, 1)).toEqual({ wait: "no-provider" });
  });

  it("the capability gate applies to tier routes (defence in depth)", () => {
    const r = routing({ tiers: { "1": { routes: [{ provider: "openai", model: "gpt-5.5" }] } } });
    // impl may not run on bare openai even when the tier names it and it has headroom.
    expect(resolveRoute(r, REPO, "impl", world({ openai: OPENAI }), undefined, 1)).toEqual({ wait: "no-provider" });
  });

  it("resolveDispatchRoute threads the tier and fills the effective default model", () => {
    const cfg = parseConfig({
      targets: [{ repo: REPO, commands: { build: "x", test: "y" } }],
      agent: { tiers: { "2": { routes: [{ provider: "claude" }] } } },
    });
    const target = resolveTargets(cfg)[0]!;
    const deps = {
      routing: () => ({ agent: target.agent, providers: target.providers }),
      routeWorld: world({ claude: CLAUDE }),
      config: target,
    };
    // Tier 2 routes to claude with no per-entry model → the effective default (agent.model) fills in.
    const route = resolveDispatchRoute(deps, "impl", undefined, 2);
    expect(route).toEqual({ provider: "claude", model: target.agent.model, account: CLAUDE });
  });
});
