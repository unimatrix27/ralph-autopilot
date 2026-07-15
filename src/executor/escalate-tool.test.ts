import { describe, expect, it, vi } from "vitest";
import {
  createEscalateTool,
  createEscalateServer,
  ESCALATE_DESCRIPTION,
  ESCALATE_TOOL,
} from "./escalate-tool";
import type { EscalationQuestion } from "../review/escalation";

const valid: EscalationQuestion = {
  headline: "Drop the legacy adapter?",
  feature: "Ingestion",
  whereWeStand: "Removing it touches three call sites.",
  decision: "Delete now or keep behind a flag?",
  options: ["Delete it", "Keep behind a flag"],
  stakes: "Deleting it is a one-way door for any consumer still on the old path.",
  recommendation: "Keep behind a flag this cycle.",
};

async function call(tool: ReturnType<typeof createEscalateTool>, args: unknown) {
  return tool.handler(args as never, undefined);
}

describe("escalate tool — boundary validation (AC1)", () => {
  it("rejects a call missing the required stakes field, without running the side effect", async () => {
    const onEscalate = vi.fn(async () => {});
    const tool = createEscalateTool(onEscalate);
    const { stakes, ...withoutStakes } = valid;
    void stakes;

    const result = await call(tool, withoutStakes);

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("stakes");
    expect(onEscalate).not.toHaveBeenCalled();
  });

  it("rejects a call missing any other required field (e.g. headline)", async () => {
    const onEscalate = vi.fn(async () => {});
    const tool = createEscalateTool(onEscalate);
    const { headline, ...withoutHeadline } = valid;
    void headline;

    const result = await call(tool, withoutHeadline);

    expect(result.isError).toBe(true);
    expect(onEscalate).not.toHaveBeenCalled();
  });

  it("rejects an empty required field", async () => {
    const onEscalate = vi.fn(async () => {});
    const tool = createEscalateTool(onEscalate);

    const result = await call(tool, { ...valid, stakes: "" });

    expect(result.isError).toBe(true);
    expect(onEscalate).not.toHaveBeenCalled();
  });

  it("runs the checkpoint side effect on a fully-populated, valid call", async () => {
    const onEscalate = vi.fn(async () => {});
    const tool = createEscalateTool(onEscalate);

    const result = await call(tool, valid);

    expect(result.isError).toBeFalsy();
    expect(onEscalate).toHaveBeenCalledTimes(1);
    expect(onEscalate.mock.calls[0]![0]).toEqual(valid);
  });

  it("accepts a question without the optional options field", async () => {
    const onEscalate = vi.fn(async () => {});
    const tool = createEscalateTool(onEscalate);
    const { options, ...withoutOptions } = valid;
    void options;

    const result = await call(tool, withoutOptions);

    expect(result.isError).toBeFalsy();
    expect(onEscalate).toHaveBeenCalledTimes(1);
  });
});

describe("escalate tool — the escalation bar (issue #22)", () => {
  // AC3: a behaviour-preserving, design-resolvable internal layering decision must
  // be decided + ADR'd by the agent, NOT escalated. The tool rejects it.
  const designResolvable: EscalationQuestion = {
    headline: "Which way should the store ↔ review dependency point?",
    feature: "Internal module layering",
    whereWeStand:
      "A behaviour-preserving, build-green internal layering refactor leaves the store and review modules with a dependency-direction choice; one must depend on the other.",
    decision: "Should the store layer depend on the review module, or the review module on the store?",
    options: ["Store depends on review", "Review depends on store"],
    stakes:
      "Either direction keeps the build green and changes no behaviour; it only sets which module owns the boundary.",
    recommendation: "Point review at the store so the store stays the canonical lower layer.",
  };

  // AC4: an escalation whose stakes only parse once you've read the diff fails the bar.
  const diffOnly: EscalationQuestion = {
    headline: "Charge customers on signup or at cycle end?",
    feature: "Billing",
    whereWeStand:
      "applyCharge() in src/billing/charge.ts fires from onSignup(); deferring it moves when persistInvoice() runs.",
    decision: "Should the charge fire on signup, or be deferred to the billing-cycle job?",
    options: ["Charge on signup", "Charge at cycle end"],
    stakes: "If we keep calling applyCharge() from onSignup(), Invoice.finalize() runs before the cycle closes.",
    recommendation: "Defer to the cycle job.",
  };

  it("rejects a design-resolvable layering decision and points the agent at decide + ADR (AC3)", async () => {
    const onEscalate = vi.fn(async () => {});
    const tool = createEscalateTool(onEscalate);

    const result = await call(tool, designResolvable);

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("ADR-0011");
    expect(onEscalate).not.toHaveBeenCalled();
  });

  it("rejects an escalation whose stakes only parse if you've read the diff (AC4)", async () => {
    const onEscalate = vi.fn(async () => {});
    const tool = createEscalateTool(onEscalate);

    const result = await call(tool, diffOnly);

    expect(result.isError).toBe(true);
    expect(onEscalate).not.toHaveBeenCalled();
  });

  it("lets a genuine, zero-context-readable escalation through to the side effect", async () => {
    const onEscalate = vi.fn(async () => {});
    const tool = createEscalateTool(onEscalate);
    // `valid` is a genuine one-way-door decision written in plain language.
    const result = await call(tool, valid);

    expect(result.isError).toBeFalsy();
    expect(onEscalate).toHaveBeenCalledTimes(1);
  });
});

describe("escalate tool — prompt encodes the bar (issue #22)", () => {
  it("encodes the escalation bar tied to the design-authority rule (ADR-0011) (AC1)", () => {
    expect(ESCALATE_DESCRIPTION).toContain("ADR-0011");
    expect(ESCALATE_DESCRIPTION.toLowerCase()).toContain("design-authority");
    // Names what to decide-and-ADR rather than escalate.
    expect(ESCALATE_DESCRIPTION.toLowerCase()).toContain("layering");
    expect(ESCALATE_DESCRIPTION.toLowerCase()).toContain("adr");
  });

  it("requires whereWeStand/stakes to be readable without the implementation (AC2)", () => {
    const lower = ESCALATE_DESCRIPTION.toLowerCase();
    expect(lower).toContain("stakes");
    expect(lower).toContain("wherewestand");
    // The zero-context readability instruction: no bare symbol/file names.
    expect(lower).toContain("without");
    expect(lower).toMatch(/define every|domain term|bare symbol|bare file/);
  });

  it("includes the pre-send self-check (AC5)", () => {
    const lower = ESCALATE_DESCRIPTION.toLowerCase();
    expect(lower).toContain("self-check");
    // The two self-check questions.
    expect(lower).toContain("can i resolve this from the design");
    expect(lower).toMatch(/non-implementer|would a non-implementer|understand the stakes/);
  });
});

describe("escalate server registration", () => {
  it("registers the escalate tool under the ralph MCP server", () => {
    const server = createEscalateServer(async () => {});
    expect(server.type).toBe("sdk");
    expect(ESCALATE_TOOL).toBe("mcp__ralph__escalate");
  });
});
