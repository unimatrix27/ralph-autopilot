import { describe, expect, it } from "vitest";
import { normalizeFailureSignature, normalizeFailureText } from "./signature";

describe("normalizeFailureSignature (ADR-0041)", () => {
  it("is stable across a changed head SHA — the binding rule", () => {
    const a = normalizeFailureSignature({
      source: "stuck",
      phase: "impl",
      detail: "CI failed on 4f2a91c: build (ubuntu-latest) exited 1",
    });
    const b = normalizeFailureSignature({
      source: "stuck",
      phase: "impl",
      detail: "CI failed on 9911bbeed4: build (ubuntu-latest) exited 1",
    });
    expect(a).toBe(b);
  });

  it("is stable across timestamps, durations, temp paths and line numbers", () => {
    const a = normalizeFailureSignature({
      source: "escalate",
      phase: "review-1",
      detail:
        "2026-08-01T10:04:00Z /tmp/ralph-x1/clone/src/foo.ts:120:8 TypeError: cannot read 'x' (took 3.24s)",
    });
    const b = normalizeFailureSignature({
      source: "escalate",
      phase: "review-1",
      detail:
        "2026-08-02T22:41:07Z /tmp/ralph-q9/clone/src/foo.ts:377:2 TypeError: cannot read 'x' (took 91.5s)",
    });
    expect(a).toBe(b);
  });

  it("distinguishes genuinely different failures", () => {
    const a = normalizeFailureSignature({ source: "stuck", phase: "impl", detail: "typecheck failed" });
    const b = normalizeFailureSignature({ source: "stuck", phase: "impl", detail: "tests failed" });
    expect(a).not.toBe(b);
  });

  it("distinguishes source and phase even when the text coincides", () => {
    const detail = "the same words";
    expect(normalizeFailureSignature({ source: "stuck", phase: "impl", detail })).not.toBe(
      normalizeFailureSignature({ source: "escalate", phase: "impl", detail }),
    );
    expect(normalizeFailureSignature({ source: "stuck", phase: "impl", detail })).not.toBe(
      normalizeFailureSignature({ source: "stuck", phase: "review-1", detail }),
    );
  });

  it("normalizes URLs and uuids away", () => {
    expect(normalizeFailureText("see https://github.com/o/r/actions/runs/12345 for detail")).toBe(
      "see <url> for detail",
    );
    expect(normalizeFailureText("run 3f2504e0-4f89-11d3-9a0c-0305e82c3301 died")).toBe("run <sha> died");
  });

  it("is total and clamped for pathological input", () => {
    const sig = normalizeFailureSignature({ source: "stuck", phase: "impl", detail: "x".repeat(10_000) });
    expect(sig.length).toBeLessThan(600);
    expect(normalizeFailureSignature({ source: "stuck", phase: "impl", detail: "" })).toBe("stuck|impl|");
  });
});
