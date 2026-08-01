/**
 * The fix session's structured-output contract (issue #43, ADR-0042 §12).
 *
 * The interesting half is what the schema makes UNREPRESENTABLE: a hosted-review disposition
 * that dismisses (or accepts) a bot's finding without the agent's own reasoning and the
 * verification behind it. "A bot finding is never accepted nor dismissed because a bot raised
 * it" has to be enforced by the contract, not by a line in a prompt — an agent that returns
 * `{"disposition":"reasoned-invalid"}` and nothing else must fail the parse rather than quietly
 * close a real reviewer's thread.
 */
import { describe, expect, it } from "vitest";
import { fixOutcomeSchema, hostedDispositionSchema } from "./structured";

const disposition = {
  threadId: "PRRT_codex",
  disposition: "reasoned-invalid" as const,
  rationale: "The poll is already bounded by maxPolls.",
  verification: "Traced every exit; the bound is asserted by an existing test.",
};

describe("hostedDispositionSchema", () => {
  it("accepts a disposition carrying its own rationale and verification", () => {
    expect(hostedDispositionSchema.parse(disposition)).toEqual(disposition);
  });

  it.each(["rationale", "verification", "threadId"] as const)("rejects a %s that is missing", (field) => {
    const { [field]: _dropped, ...rest } = disposition;
    expect(() => hostedDispositionSchema.parse(rest)).toThrow();
  });

  it.each(["rationale", "verification"] as const)("rejects an EMPTY %s — a blank is not a reason", (field) => {
    expect(() => hostedDispositionSchema.parse({ ...disposition, [field]: "" })).toThrow();
  });

  it("rejects a disposition outside the two the harness can act on", () => {
    expect(() => hostedDispositionSchema.parse({ ...disposition, disposition: "wontfix" })).toThrow();
  });
});

describe("fixOutcomeSchema", () => {
  it("still accepts a bare `fixed` — an ordinary fix answers no thread", () => {
    expect(fixOutcomeSchema.parse({ outcome: "fixed" })).toEqual({ outcome: "fixed" });
  });

  it("carries dispositions on a hosted fix", () => {
    const parsed = fixOutcomeSchema.parse({ outcome: "fixed", dispositions: [disposition] });
    expect(parsed).toEqual({ outcome: "fixed", dispositions: [disposition] });
  });

  it("rejects an unknown key rather than silently dropping it (a typo must fail loud)", () => {
    expect(() => fixOutcomeSchema.parse({ outcome: "fixed", disposition: [disposition] })).toThrow();
  });

  it("rejects a `fixed` whose disposition is missing its verification", () => {
    const { verification: _dropped, ...partial } = disposition;
    expect(() => fixOutcomeSchema.parse({ outcome: "fixed", dispositions: [partial] })).toThrow();
  });

  it("keeps the escalate arm exclusive of dispositions", () => {
    expect(() =>
      fixOutcomeSchema.parse({ outcome: "escalate", dispositions: [disposition] }),
    ).toThrow();
  });
});
