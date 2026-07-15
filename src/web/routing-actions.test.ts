import { describe, expect, it } from "vitest";
import { effectiveRoutingResponseSchema, routingEditRequestBodySchema, routingEditResponseSchema } from "./contract";
import { executeRoutingEdit, getEffectiveRouting, type RoutingControlPort } from "./routing-actions";
import type { RoutingEdit, RoutingEditOutcome, RoutingSnapshot } from "../config/routing-store";
import { parseConfig, resolveAccountPool } from "../config/load";

const NOW = new Date("2026-06-29T12:00:00.000Z");

function snapshot(cfg: { agent?: Record<string, unknown>; providers?: Record<string, unknown>; accounts?: unknown[] } = {}): RoutingSnapshot {
  const config = parseConfig({
    targets: [{ repo: "owner/a", commands: { build: "b", test: "t" } }],
    agent: cfg.agent ?? {},
    providers: cfg.providers ?? {},
    accounts: (cfg.accounts ?? []) as never,
  });
  return { agent: config.agent, providers: config.providers, accounts: resolveAccountPool(config) };
}

function fakePort(snap: RoutingSnapshot, applyEdit?: (edit: RoutingEdit) => RoutingEditOutcome): RoutingControlPort {
  return { snapshot: () => snap, applyEdit: applyEdit ?? (() => ({ ok: true, cleared: false })) };
}

const deps = (port: RoutingControlPort) => ({ now: () => NOW, reconcileIntervalSeconds: 30, routing: port });

describe("getEffectiveRouting (ADR-0037 P4.1)", () => {
  it("serialises a contract-valid effective routing with every type's resolved preference list", () => {
    const port = fakePort(
      snapshot({
        agent: { types: { review: [{ provider: "claude", model: "sonnet" }, { provider: "claude" }] } },
        accounts: [{ id: "c", provider: "claude", configDir: "/c" }],
      }),
    );
    const res = getEffectiveRouting({}, deps(port));
    expect(effectiveRoutingResponseSchema.safeParse(res).success).toBe(true);
    expect(res.repo).toBeNull();
    expect(res.defaultProvider).toBe("claude");
    expect(res.defaultModel).toBe("opus");

    const review = res.types.find((t) => t.type === "review");
    expect(review?.preference).toEqual([{ provider: "claude", model: "sonnet" }, { provider: "claude" }]);
    // An un-overridden type resolves to a one-entry list of the global default provider.
    expect(res.types.find((t) => t.type === "fix")?.preference).toEqual([{ provider: "claude" }]);
    // Only impl requires the in-session tools.
    expect(res.types.find((t) => t.type === "impl")?.requiresTools).toBe(true);
    expect(res.types.find((t) => t.type === "review")?.requiresTools).toBe(false);
  });

  it("reports the provider capability matrix and account pool the editor needs", () => {
    const port = fakePort(snapshot({ accounts: [{ id: "c", provider: "claude", configDir: "/c" }] }));
    const res = getEffectiveRouting({ repo: "owner/a" }, deps(port));
    expect(res.repo).toBe("owner/a"); // echoed (forward-compat #170; v1 resolves global anyway)
    const byProvider = Object.fromEntries(res.providers.map((p) => [p.provider, p]));
    expect(byProvider.claude).toEqual({ provider: "claude", configured: true, toolsCapable: true });
    expect(byProvider.openai).toEqual({ provider: "openai", configured: false, toolsCapable: false });
    expect(byProvider.zai).toEqual({ provider: "zai", configured: false, toolsCapable: true });
    expect(res.accounts).toEqual([{ id: "c", provider: "claude" }]);
  });
});

describe("getEffectiveRouting — per-phase shape (ADR-0037 #169)", () => {
  it("serialises the per-phase overrides alongside the base list for a phased review config", () => {
    const port = fakePort(
      snapshot({
        agent: {
          types: {
            review: {
              base: [{ provider: "claude", model: "sonnet" }],
              phase2: [{ provider: "claude", model: "opus" }],
            },
          },
        },
        accounts: [{ id: "c", provider: "claude", configDir: "/c" }],
      }),
    );
    const res = getEffectiveRouting({}, deps(port));
    expect(effectiveRoutingResponseSchema.safeParse(res).success).toBe(true);
    const review = res.types.find((t) => t.type === "review");
    // base is the all-phases default; only the overridden phase is carried.
    expect(review?.preference).toEqual([{ provider: "claude", model: "sonnet" }]);
    expect(review?.phases).toEqual({ phase2: [{ provider: "claude", model: "opus" }] });
  });

  it("omits the phases key for a single-phase / unphased type", () => {
    const port = fakePort(snapshot({ agent: { types: { review: [{ provider: "claude" }] } } }));
    const res = getEffectiveRouting({}, deps(port));
    expect(res.types.find((t) => t.type === "review")?.phases).toBeUndefined();
    expect(res.types.find((t) => t.type === "impl")?.phases).toBeUndefined();
  });
});

describe("executeRoutingEdit (ADR-0037 P4.1)", () => {
  it("threads a per-phase routing body through to the overlay (ADR-0037 #169)", () => {
    let received: RoutingEdit | undefined;
    const port = fakePort(snapshot(), (edit) => {
      received = edit;
      return { ok: true, cleared: false };
    });
    const result = executeRoutingEdit(
      {
        target: "type",
        type: "review",
        routing: { base: [{ provider: "claude" }], phase2: [{ provider: "claude", model: "opus" }] },
      },
      deps(port),
    );
    expect(result.kind).toBe("applied");
    expect(received).toEqual({
      target: "type",
      type: "review",
      routing: { base: [{ provider: "claude" }], phase2: [{ provider: "claude", model: "opus" }] },
    });
  });

  it("maps an applied outcome to a contract-valid 200 response", () => {
    const port = fakePort(snapshot(), () => ({ ok: true, cleared: false }));
    const result = executeRoutingEdit({ target: "type", type: "review", routing: { provider: "claude" } }, deps(port));
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") throw new Error("unreachable");
    expect(routingEditResponseSchema.safeParse(result.response).success).toBe(true);
    expect(result.response.type).toBe("review");
    expect(result.response.cleared).toBe(false);
    expect(result.response.appliesNextDispatchSeconds).toBe(30);
  });

  it("carries the cleared flag from the overlay outcome", () => {
    const port = fakePort(snapshot(), () => ({ ok: true, cleared: true }));
    const result = executeRoutingEdit({ target: "type", type: "review", routing: null }, deps(port));
    expect(result.kind === "applied" && result.response.cleared).toBe(true);
  });

  it("maps a rejected outcome to a bad-request with the overlay's error", () => {
    const port = fakePort(snapshot(), () => ({ ok: false, error: "agent type 'impl' cannot route to provider 'openai': it is not tools-capable" }));
    const result = executeRoutingEdit({ target: "type", type: "impl", routing: { provider: "openai" } }, deps(port));
    expect(result.kind).toBe("bad-request");
    expect(result.kind === "bad-request" && result.error).toMatch(/not tools-capable/i);
  });
});

describe("routingEditRequestBodySchema — per-phase validation (ADR-0037 #169)", () => {
  it("accepts the per-phase object form for review and fix", () => {
    for (const type of ["review", "fix"] as const) {
      const parsed = routingEditRequestBodySchema.safeParse({
        target: "type",
        type,
        routing: { base: [{ provider: "claude" }], phase2: [{ provider: "claude", model: "opus" }] },
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("rejects the per-phase object form for the single-phase types (impl, autoMode)", () => {
    for (const type of ["impl", "autoMode"] as const) {
      const parsed = routingEditRequestBodySchema.safeParse({
        target: "type",
        type,
        routing: { base: [{ provider: "claude" }] },
      });
      expect(parsed.success).toBe(false);
    }
  });

  it("still accepts a single entry / preference list for every type (back-compat)", () => {
    const single = routingEditRequestBodySchema.safeParse({ target: "type", type: "impl", routing: { provider: "claude" } });
    expect(single.success).toBe(true);
    const list = routingEditRequestBodySchema.safeParse({
      target: "type",
      type: "fix",
      routing: [{ provider: "claude" }, { provider: "claude", model: "opus" }],
    });
    expect(list.success).toBe(true);
  });
});
