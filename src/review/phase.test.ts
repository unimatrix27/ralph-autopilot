import { describe, expect, it } from "vitest";
import {
  CI_GATE,
  MERGE,
  MERGE_CONFLICT,
  decodeAgentPhase,
  fixPhase,
  phaseLabel,
  reviewPhase,
  reviewPhaseNumber,
  type AgentPhase,
} from "./phase";

describe("phaseLabel", () => {
  it("serialises each phase to its canonical stored/display token", () => {
    expect(phaseLabel({ kind: "impl" })).toBe("impl");
    expect(phaseLabel(CI_GATE)).toBe("ci-gate");
    expect(phaseLabel(reviewPhase(1))).toBe("review-1");
    expect(phaseLabel(reviewPhase(2))).toBe("review-2");
    expect(phaseLabel(fixPhase(0))).toBe("fix-0");
    expect(phaseLabel(fixPhase(1))).toBe("fix-1");
    expect(phaseLabel(fixPhase(2))).toBe("fix-2");
    expect(phaseLabel(MERGE)).toBe("merge");
    expect(phaseLabel(MERGE_CONFLICT)).toBe("merge-conflict");
  });
});

describe("decodeAgentPhase", () => {
  it("treats null / empty / 'impl' as the impl phase", () => {
    expect(decodeAgentPhase(null)).toEqual({ kind: "impl" });
    expect(decodeAgentPhase("")).toEqual({ kind: "impl" });
    expect(decodeAgentPhase("impl")).toEqual({ kind: "impl" });
  });

  it("round-trips every produced label without a regex (full ADR-0017 phase set)", () => {
    const phases: AgentPhase[] = [
      CI_GATE,
      reviewPhase(1),
      reviewPhase(2),
      fixPhase(0),
      fixPhase(1),
      fixPhase(2),
      MERGE,
      MERGE_CONFLICT,
    ];
    for (const phase of phases) {
      expect(decodeAgentPhase(phaseLabel(phase))).toEqual(phase);
    }
  });

  it("decodes an unrecognised label to `other` (displayed verbatim, no crash)", () => {
    expect(decodeAgentPhase("review:1")).toEqual({ kind: "other", raw: "review:1" });
    expect(phaseLabel(decodeAgentPhase("review:1"))).toBe("review:1");
  });
});

describe("reviewPhaseNumber", () => {
  it("maps numbered review/fix phases to their fix-attempt counter key", () => {
    expect(reviewPhaseNumber(reviewPhase(1))).toBe(1);
    expect(reviewPhaseNumber(fixPhase(1))).toBe(1);
    expect(reviewPhaseNumber(reviewPhase(2))).toBe(2);
    expect(reviewPhaseNumber(fixPhase(2))).toBe(2);
  });

  it("is null for impl, the CI gate (phase 0), merge, and unknowns", () => {
    expect(reviewPhaseNumber({ kind: "impl" })).toBeNull();
    expect(reviewPhaseNumber(fixPhase(0))).toBeNull();
    expect(reviewPhaseNumber(CI_GATE)).toBeNull();
    expect(reviewPhaseNumber(MERGE)).toBeNull();
    expect(reviewPhaseNumber({ kind: "other", raw: "x" })).toBeNull();
  });
});
