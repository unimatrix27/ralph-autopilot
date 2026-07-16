import { describe, expect, it } from "vitest";
import {
  buildAccountToggleEdit,
  buildClearRoutingEdit,
  buildPhasedRoutingEdit,
  buildRoutingEditorModel,
  buildSetRoutingEdit,
  phasedPreferenceIsPostable,
  preferenceIsPostable,
  providerDisabledReason,
  providerOptionsFor,
} from "./routing-editor";
import {
  effectiveRoutingResponseSchema,
  isPhasedRoutingValue,
  routingEditRequestBodySchema,
  typeIsPhaseable,
  type EffectiveRoutingResponse,
} from "./routing";

// ── builder ────────────────────────────────────────────────────────────────────

function res(over: Partial<EffectiveRoutingResponse> = {}): EffectiveRoutingResponse {
  const base: EffectiveRoutingResponse = {
    generatedAt: "2026-06-29T00:00:00.000Z",
    repo: null,
    defaultProvider: "claude",
    defaultModel: "opus",
    types: [
      { type: "impl", requiresTools: true, preference: [{ provider: "claude", model: "opus" }] },
      { type: "review", requiresTools: false, preference: [{ provider: "zai", model: "glm-5.2" }] },
      { type: "fix", requiresTools: false, preference: [{ provider: "claude" }] },
      { type: "autoMode", requiresTools: false, preference: [{ provider: "claude" }] },
    ],
    providers: [
      { provider: "claude", configured: true, toolsCapable: true },
      { provider: "openai", configured: true, toolsCapable: false },
      { provider: "zai", configured: true, toolsCapable: true },
    ],
    accounts: [
      { id: "claude-1", provider: "claude", enabled: true },
      { id: "zai-1", provider: "zai", enabled: true },
      { id: "zai-2", provider: "zai", enabled: false },
    ],
  };
  // Parse so the fixture can never drift from the wire shape.
  return effectiveRoutingResponseSchema.parse({ ...base, ...over });
}

// ── buildRoutingEditorModel — renders current effective routing (AC1) ────────────

describe("buildRoutingEditorModel", () => {
  it("carries the global defaults and one row per agent type, in response order", () => {
    const model = buildRoutingEditorModel(res());
    expect(model.defaultProvider).toBe("claude");
    expect(model.defaultModel).toBe("opus");
    expect(model.repo).toBeNull();
    expect(model.rows.map((r) => r.type)).toEqual(["impl", "review", "fix", "autoMode"]);
  });

  it("reflects each type's current preference list verbatim", () => {
    const model = buildRoutingEditorModel(res());
    const impl = model.rows.find((r) => r.type === "impl")!;
    expect(impl.requiresTools).toBe(true);
    expect(impl.preference).toEqual([{ provider: "claude", model: "opus" }]);
    const review = model.rows.find((r) => r.type === "review")!;
    expect(review.requiresTools).toBe(false);
    expect(review.preference).toEqual([{ provider: "zai", model: "glm-5.2" }]);
  });

  it("groups the account pool by provider, including providers with zero accounts (never hidden)", () => {
    const model = buildRoutingEditorModel(res());
    const byProvider = Object.fromEntries(model.pool.map((g) => [g.provider, g]));
    expect(model.pool.map((g) => g.provider)).toEqual(["claude", "openai", "zai"]);
    expect(byProvider.claude!.accounts).toEqual([{ id: "claude-1", enabled: true }]);
    expect(byProvider.zai!.accounts).toEqual([
      { id: "zai-1", enabled: true },
      { id: "zai-2", enabled: false },
    ]);
    // openai is configured but has no accounts — shown as an empty pool, not omitted.
    expect(byProvider.openai!.configured).toBe(true);
    expect(byProvider.openai!.accounts).toEqual([]);
    expect(byProvider.openai!.toolsCapable).toBe(false);
  });
});

// ── disabled-with-reason (AC2) ───────────────────────────────────────────────────

describe("providerDisabledReason — the capability gate, surfaced", () => {
  it("disables a non-tools-capable provider for a type that requires tools, naming the reason", () => {
    const impl = res().types.find((t) => t.type === "impl")!;
    const openai = res().providers.find((p) => p.provider === "openai")!;
    const reason = providerDisabledReason(impl, openai);
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/escalate\/stuck/);
    expect(reason).toMatch(/openai/);
  });

  it("leaves a tools-capable provider selectable for a type that requires tools", () => {
    const impl = res().types.find((t) => t.type === "impl")!;
    const zai = res().providers.find((p) => p.provider === "zai")!;
    expect(providerDisabledReason(impl, zai)).toBeNull();
  });

  it("does not apply the tools gate to a type that does not require tools", () => {
    const review = res().types.find((t) => t.type === "review")!;
    const openai = res().providers.find((p) => p.provider === "openai")!;
    // review doesn't need in-session tools, so a non-tools-capable provider is still selectable.
    expect(providerDisabledReason(review, openai)).toBeNull();
  });

  it("disables an unconfigured provider with a distinct reason (no account)", () => {
    const r = res({
      providers: [
        { provider: "claude", configured: true, toolsCapable: true },
        { provider: "openai", configured: false, toolsCapable: false },
        { provider: "zai", configured: false, toolsCapable: true },
      ],
    });
    const review = r.types.find((t) => t.type === "review")!;
    const zai = r.providers.find((p) => p.provider === "zai")!;
    const reason = providerDisabledReason(review, zai);
    expect(reason).not.toBeNull();
    expect(reason).toMatch(/account/i);
  });

  it("prefers the capability reason over the unconfigured reason when both apply", () => {
    const r = res({
      providers: [
        { provider: "claude", configured: true, toolsCapable: true },
        { provider: "openai", configured: false, toolsCapable: false },
        { provider: "zai", configured: true, toolsCapable: true },
      ],
    });
    const impl = r.types.find((t) => t.type === "impl")!;
    const openai = r.providers.find((p) => p.provider === "openai")!;
    // impl requires tools AND openai is unconfigured — the principled capability gate wins.
    expect(providerDisabledReason(impl, openai)).toMatch(/escalate\/stuck/);
  });
});

describe("providerOptionsFor / model providerOptions", () => {
  it("renders every provider as an option (disabled-with-reason, never hidden)", () => {
    const r = res();
    const impl = r.types.find((t) => t.type === "impl")!;
    const opts = providerOptionsFor(impl, r.providers);
    expect(opts.map((o) => o.provider)).toEqual(["claude", "openai", "zai"]);
    const openai = opts.find((o) => o.provider === "openai")!;
    expect(openai.disabled).toBe(true);
    expect(openai.reason).toMatch(/escalate\/stuck/);
    const claude = opts.find((o) => o.provider === "claude")!;
    expect(claude.disabled).toBe(false);
    expect(claude.reason).toBeNull();
  });

  it("is carried on each editor row by buildRoutingEditorModel", () => {
    const model = buildRoutingEditorModel(res());
    const impl = model.rows.find((r) => r.type === "impl")!;
    expect(impl.providerOptions.find((o) => o.provider === "openai")!.disabled).toBe(true);
    const review = model.rows.find((r) => r.type === "review")!;
    // review tolerates openai (no tools needed) — selectable.
    expect(review.providerOptions.find((o) => o.provider === "openai")!.disabled).toBe(false);
  });
});

// ── postable edits (AC1: posts valid edits) ──────────────────────────────────────

describe("preferenceIsPostable", () => {
  const model = buildRoutingEditorModel(res());
  const impl = model.rows.find((r) => r.type === "impl")!;

  it("accepts a non-empty list of selectable providers", () => {
    expect(preferenceIsPostable(impl, [{ provider: "claude", model: "opus" }, { provider: "zai" }])).toBe(true);
  });

  it("rejects an empty list", () => {
    expect(preferenceIsPostable(impl, [])).toBe(false);
  });

  it("rejects a list containing a disabled (capability-incompatible) provider", () => {
    expect(preferenceIsPostable(impl, [{ provider: "openai" }])).toBe(false);
  });

  it("rejects an entry whose model is present but blank", () => {
    expect(preferenceIsPostable(impl, [{ provider: "claude", model: "   " }])).toBe(false);
  });
});

describe("buildSetRoutingEdit / buildClearRoutingEdit produce wire-valid bodies", () => {
  it("builds a set edit that parses through the request schema, normalised to a list", () => {
    const body = buildSetRoutingEdit("impl", [{ provider: "zai", model: "glm-5.2" }, { provider: "claude" }]);
    const parsed = routingEditRequestBodySchema.parse(body);
    expect(parsed.target).toBe("type");
    expect(parsed.type).toBe("impl");
    expect(parsed.routing).toEqual([{ provider: "zai", model: "glm-5.2" }, { provider: "claude" }]);
  });

  it("drops blank models so an entry falls back to the provider default", () => {
    const body = buildSetRoutingEdit("review", [{ provider: "zai", model: "  " }]);
    const parsed = routingEditRequestBodySchema.parse(body);
    expect(parsed.routing).toEqual([{ provider: "zai" }]);
  });

  it("builds a clear edit (routing: null) that parses through the request schema", () => {
    const body = buildClearRoutingEdit("autoMode");
    const parsed = routingEditRequestBodySchema.parse(body);
    expect(parsed.type).toBe("autoMode");
    expect(parsed.routing).toBeNull();
  });
});

// ── per-phase editor (#250) ──────────────────────────────────────────────────────

/** A response whose `review` carries a Phase-2 override (the common "bump only thermo" case). */
function resWithPhases(): EffectiveRoutingResponse {
  return res({
    types: [
      { type: "impl", requiresTools: true, preference: [{ provider: "claude", model: "opus" }] },
      {
        type: "review",
        requiresTools: false,
        preference: [{ provider: "zai", model: "glm-5.2" }],
        phases: { phase2: [{ provider: "claude", model: "opus" }] },
      },
      { type: "fix", requiresTools: false, preference: [{ provider: "claude" }] },
      { type: "autoMode", requiresTools: false, preference: [{ provider: "claude" }] },
    ],
  });
}

describe("typeIsPhaseable", () => {
  it("is true only for review/fix (the numbered-phase types)", () => {
    expect(typeIsPhaseable("review")).toBe(true);
    expect(typeIsPhaseable("fix")).toBe(true);
    expect(typeIsPhaseable("impl")).toBe(false);
    expect(typeIsPhaseable("autoMode")).toBe(false);
  });
});

describe("buildRoutingEditorModel — per-phase rows", () => {
  it("flags review/fix as phaseable and impl/autoMode as not", () => {
    const byType = Object.fromEntries(buildRoutingEditorModel(res()).rows.map((r) => [r.type, r]));
    expect(byType.review!.phaseable).toBe(true);
    expect(byType.fix!.phaseable).toBe(true);
    expect(byType.impl!.phaseable).toBe(false);
    expect(byType.autoMode!.phaseable).toBe(false);
  });

  it("carries only the overridden phases on the row (base stays in preference)", () => {
    const byType = Object.fromEntries(buildRoutingEditorModel(resWithPhases()).rows.map((r) => [r.type, r]));
    const review = byType.review!;
    // base is the all-phases fallback; phase2 deviates (a stronger model for the thermo pass).
    expect(review.preference).toEqual([{ provider: "zai", model: "glm-5.2" }]);
    expect(review.phases.phase2).toEqual([{ provider: "claude", model: "opus" }]);
    expect(review.phases.phase1).toBeUndefined();
    // A phaseable type with no override yet carries an empty phases map, never undefined.
    expect(byType.fix!.phases).toEqual({});
  });

  it("leaves single-phase types with an empty phases map", () => {
    const byType = Object.fromEntries(buildRoutingEditorModel(res()).rows.map((r) => [r.type, r]));
    expect(byType.impl!.phases).toEqual({});
    expect(byType.autoMode!.phases).toEqual({});
  });
});

describe("buildPhasedRoutingEdit", () => {
  it("collapses a base-only draft to the flat list form (config stays unphased)", () => {
    const body = buildPhasedRoutingEdit("review", { base: [{ provider: "zai", model: "glm-5.2" }] });
    const parsed = routingEditRequestBodySchema.parse(body);
    expect(parsed.routing).toEqual([{ provider: "zai", model: "glm-5.2" }]);
    expect(isPhasedRoutingValue(parsed.routing!)).toBe(false);
  });

  it("emits the per-phase object form when a phase override is present, normalising each list", () => {
    const body = buildPhasedRoutingEdit("review", {
      base: [{ provider: "zai", model: "glm-5.2" }],
      phase2: [{ provider: "claude", model: "  " }],
    });
    const parsed = routingEditRequestBodySchema.parse(body);
    expect(isPhasedRoutingValue(parsed.routing!)).toBe(true);
    expect(parsed.routing).toEqual({
      base: [{ provider: "zai", model: "glm-5.2" }],
      // blank model dropped → falls back to the provider default, like the single-list path.
      phase2: [{ provider: "claude" }],
    });
  });

  it("carries a phase1 override too when set", () => {
    const body = buildPhasedRoutingEdit("fix", {
      base: [{ provider: "claude" }],
      phase1: [{ provider: "zai", model: "glm-5.2" }],
    });
    const parsed = routingEditRequestBodySchema.parse(body);
    expect(parsed.routing).toEqual({
      base: [{ provider: "claude" }],
      phase1: [{ provider: "zai", model: "glm-5.2" }],
    });
  });

  it("accepts the value the editor would build for the round-tripped Phase-2 override", () => {
    const body = buildPhasedRoutingEdit("review", {
      base: [{ provider: "zai", model: "glm-5.2" }],
      phase2: [{ provider: "claude", model: "opus" }],
    });
    // The whole edit body must satisfy the per-phase refine for review/fix.
    expect(() => routingEditRequestBodySchema.parse(body)).not.toThrow();
  });
});

describe("phasedPreferenceIsPostable", () => {
  const review = buildRoutingEditorModel(res()).rows.find((r) => r.type === "review")!;

  it("accepts a postable base with no overrides", () => {
    expect(phasedPreferenceIsPostable(review, { base: [{ provider: "claude" }] })).toBe(true);
  });

  it("accepts a postable base plus a postable phase override", () => {
    expect(
      phasedPreferenceIsPostable(review, {
        base: [{ provider: "zai", model: "glm-5.2" }],
        phase2: [{ provider: "claude", model: "opus" }],
      }),
    ).toBe(true);
  });

  it("rejects when the base is empty", () => {
    expect(phasedPreferenceIsPostable(review, { base: [] })).toBe(false);
  });

  it("rejects when a phase override is empty", () => {
    expect(phasedPreferenceIsPostable(review, { base: [{ provider: "claude" }], phase1: [] })).toBe(false);
  });

  it("rejects when a phase override names a blank model", () => {
    expect(
      phasedPreferenceIsPostable(review, {
        base: [{ provider: "claude" }],
        phase2: [{ provider: "claude", model: "   " }],
      }),
    ).toBe(false);
  });
});

// ── account enable/disable toggle (issue #10) ───────────────────────────────────

describe("buildAccountToggleEdit — the per-account park/un-park body", () => {
  it("builds a wire-valid disable body addressed by resolved pool id", () => {
    const body = buildAccountToggleEdit("zai-2", false);
    expect(body).toEqual({ target: "account", id: "zai-2", enabled: false });
    expect(routingEditRequestBodySchema.safeParse(body).success).toBe(true);
  });

  it("builds a wire-valid re-enable body", () => {
    const body = buildAccountToggleEdit("openai", true);
    expect(body).toEqual({ target: "account", id: "openai", enabled: true });
    expect(routingEditRequestBodySchema.safeParse(body).success).toBe(true);
  });
});
