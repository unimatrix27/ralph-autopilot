import { describe, expect, it } from "vitest";
import {
  buildHealCardQuestion,
  buildPhaseMarker,
  evaluateEscalationBar,
  formatHealCard,
  formatRalphQuestion,
  parseEscalationQuestion,
  parsePhaseMarker,
  parseRalphQuestionComment,
  RALPH_QUESTION_FENCE,
} from "./escalation";

const question = {
  headline: "Drop the legacy adapter?",
  feature: "Payment ingestion",
  whereWeStand: "Review flagged the adapter as dead, but removing it touches three call sites.",
  decision: "Should the legacy adapter be deleted now or kept behind a flag?",
  options: ["Delete it", "Keep behind a flag"],
  stakes: "Deleting it is a one-way door for any consumer still on the old path.",
  recommendation: "Keep behind a flag this cycle.",
};

describe("escalation question schema", () => {
  it("accepts a fully-populated question", () => {
    expect(parseEscalationQuestion(question).headline).toBe("Drop the legacy adapter?");
  });

  it("rejects a question missing the required stakes field", () => {
    const { stakes, ...withoutStakes } = question;
    void stakes;
    expect(() => parseEscalationQuestion(withoutStakes)).toThrow();
  });

  it("rejects an empty stakes field", () => {
    expect(() => parseEscalationQuestion({ ...question, stakes: "" })).toThrow();
  });
});

describe("formatRalphQuestion", () => {
  it("renders the headline, stakes, and a parseable fenced payload", () => {
    const body = formatRalphQuestion(question);
    expect(body).toContain("Drop the legacy adapter?");
    expect(body).toContain("Stakes");
    expect(body).toContain("```" + RALPH_QUESTION_FENCE);

    const fence = body.split("```" + RALPH_QUESTION_FENCE)[1]!.split("```")[0]!;
    const parsed = parseEscalationQuestion(JSON.parse(fence));
    expect(parsed).toEqual(question);
  });

  it("round-trips through parseRalphQuestionComment (one shared codec)", () => {
    expect(parseRalphQuestionComment(formatRalphQuestion(question))).toEqual(question);
  });

  it("parses the payload even when the prose mentions a bare ``` fence", () => {
    // Regex-anchored extraction: a stray triple-backtick in the human summary must
    // not be mistaken for the payload boundary.
    const body = "A note about ``` fences in passing.\n\n" + formatRalphQuestion(question);
    expect(parseRalphQuestionComment(body)).toEqual(question);
  });

  it("returns null for a comment with no question fence", () => {
    expect(parseRalphQuestionComment("just a normal comment")).toBeNull();
  });
});

describe("evaluateEscalationBar — the escalation bar (issue #22)", () => {
  // AC3: a behaviour-preserving, design-resolvable internal structure/layering
  // decision (the live #9 store↔review case) must be DECIDED + ADR'd, not escalated.
  const layeringRefactor = {
    headline: "Which way should the store ↔ review dependency point?",
    feature: "Internal module layering",
    whereWeStand:
      "A behaviour-preserving, build-green internal layering refactor leaves the store and review modules with a dependency-direction choice; one has to depend on the other.",
    decision: "Should the store layer depend on the review module, or the review module on the store?",
    options: ["Store depends on review", "Review depends on store"],
    stakes:
      "Either direction keeps the build green and changes no behaviour; it only sets which module owns the boundary.",
    recommendation: "Point review at the store so the store stays the canonical lower layer.",
  };

  // AC4: an escalation whose stakes/where-we-stand only parse once you've read the
  // diff (bare file + symbol names) fails the zero-context readability bar.
  const diffOnlyStakes = {
    headline: "Charge customers on signup or at cycle end?",
    feature: "Billing",
    whereWeStand:
      "applyCharge() in src/billing/charge.ts currently fires from onSignup(); deferring it changes when persistInvoice() runs.",
    decision: "Should the charge fire on signup, or be deferred to the billing-cycle job?",
    options: ["Charge on signup", "Charge at cycle end"],
    stakes:
      "If we keep calling applyCharge() from onSignup(), Invoice.finalize() runs before the cycle closes.",
    recommendation: "Defer to the cycle job.",
  };

  // A genuine escalation: a human is better-positioned (irreversible + external +
  // user-facing), and the stakes read in plain language with no bare symbols.
  const genuineEscalation = {
    headline: "Delete the legacy import path now, or keep it behind a flag?",
    feature: "Data ingestion",
    whereWeStand:
      "Two ingestion paths exist; external partners are still pointed at the old one and we cannot see who.",
    decision: "Remove the legacy ingestion path now, or keep it behind a flag for a deprecation window?",
    options: ["Remove now", "Keep behind a flag"],
    stakes:
      "Removing it now is a one-way door: any external partner still sending data the old way would silently stop being ingested, and a user would notice missing records.",
    recommendation: "Keep it behind a flag for one deprecation cycle.",
  };

  it("fails a behaviour-preserving, design-resolvable layering decision and points at decide + ADR (AC3)", () => {
    const verdict = evaluateEscalationBar(layeringRefactor);
    expect(verdict.pass).toBe(false);
    const kinds = verdict.failures.map((f) => f.kind);
    expect(kinds).toContain("design-resolvable");
    // The corrective action names the design-authority rule (ADR-0011) + ADR.
    const message = verdict.failures.find((f) => f.kind === "design-resolvable")!.message;
    expect(message).toContain("ADR-0011");
    expect(message.toLowerCase()).toContain("adr");
  });

  it("fails an escalation whose stakes only parse if you've read the diff (AC4)", () => {
    const verdict = evaluateEscalationBar(diffOnlyStakes);
    expect(verdict.pass).toBe(false);
    expect(verdict.failures.map((f) => f.kind)).toContain("requires-code-context");
  });

  it("passes a genuine, zero-context-readable escalation a human is better-positioned to rule on", () => {
    const verdict = evaluateEscalationBar(genuineEscalation);
    expect(verdict.pass).toBe(true);
    expect(verdict.failures).toHaveLength(0);
  });

  it("does not flag a behaviour-preserving structural call that carries a genuine human stake", () => {
    // structure + behaviour-preserving signals are present, but the one-way-door /
    // external-partner stake makes a human genuinely better-positioned: not design-resolvable.
    const structuralButIrreversible = {
      ...layeringRefactor,
      stakes:
        "The refactor is behaviour-preserving, but collapsing the boundary is a one-way door: an external partner reading the old module path would break and a user would see errors.",
    };
    expect(evaluateEscalationBar(structuralButIrreversible).pass).toBe(true);
  });
});

describe("heal-card", () => {
  it("frames phase-1 maxout as a correctness concern", () => {
    const q = buildHealCardQuestion({
      phase: 1,
      attempts: 3,
      worklist: { items: [{ severity: "P0", title: "race on retry" }] },
    });
    expect(q.headline).toContain("correctness");
    expect(q.whereWeStand).toContain("race on retry");
    expect(q.stakes.toLowerCase()).toContain("correctness");
  });

  it("frames phase-2 maxout as a quality concern that is still mergeable", () => {
    const q = buildHealCardQuestion({
      phase: 2,
      attempts: 3,
      worklist: { items: [{ severity: "P1", title: "god object" }] },
    });
    expect(q.headline).toContain("quality");
    expect(q.stakes.toLowerCase()).toContain("mergeable");
  });

  it("carries a blocker's detail so diagnostics reach the operator", () => {
    const q = buildHealCardQuestion({
      phase: 2,
      attempts: 0,
      worklist: {
        items: [
          {
            severity: "P0",
            title: "A review/fix agent did not return parseable JSON after 3 attempts",
            detail: "Parser error: no parseable JSON object found. Last output tail: ...trailing prose",
          },
        ],
      },
    });
    expect(q.whereWeStand).toContain("Parser error: no parseable JSON object found");
    expect(q.whereWeStand).toContain("trailing prose");
  });

  it("renders to a valid ralph-question comment", () => {
    const body = formatHealCard({
      phase: 1,
      attempts: 3,
      worklist: { items: [{ severity: "P0", title: "boom" }] },
    });
    expect(body).toContain("```" + RALPH_QUESTION_FENCE);
  });

  it("frames a cause:'infra' maxout as an infrastructure fault, not a correctness/JSON problem (issue #220)", () => {
    const q = buildHealCardQuestion({
      phase: 1,
      attempts: 2,
      cause: "infra",
      worklist: {
        items: [
          {
            severity: "P0",
            title: "A review/fix container failed to produce a result after repeated retries (daemon infra fault)",
            detail: "Container failure: docker exited (code=137 signal=SIGKILL); stderr tail: OOM",
          },
        ],
      },
    });
    expect(q.headline).toContain("infrastructure fault");
    expect(q.headline).not.toContain("correctness");
    // Carries the real docker detail and frames the action as "fix the box & re-run".
    expect(q.whereWeStand).toContain("docker exited (code=137");
    expect(q.stakes.toLowerCase()).toContain("no code defect");
    expect(q.recommendation.toLowerCase()).toContain("re-enable");
    // Never the misleading JSON guidance.
    const all = `${q.headline}\n${q.whereWeStand}\n${q.stakes}\n${q.recommendation}`;
    expect(all).not.toContain("parseable JSON");
  });
});

describe("phase marker round-trip (issue #9 — review-origin pause cold-store)", () => {
  it("round-trips the review phase through a hidden comment marker", () => {
    for (const phase of [0, 1, 2] as const) {
      const body = `${formatRalphQuestion(question)}\n${buildPhaseMarker(phase)}`;
      expect(parsePhaseMarker(body)).toBe(phase);
    }
  });

  it("is invisible to the question parse (the JSON payload still round-trips)", () => {
    const body = `${formatRalphQuestion(question)}\n${buildPhaseMarker(1)}`;
    const fence = body.split("```" + RALPH_QUESTION_FENCE)[1]!.split("```")[0]!;
    expect(parseEscalationQuestion(JSON.parse(fence))).toEqual(question);
  });

  it("returns null when no phase marker is present (an impl-agent escalation)", () => {
    expect(parsePhaseMarker(formatRalphQuestion(question))).toBeNull();
  });
});
