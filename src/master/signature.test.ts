import { describe, expect, it } from "vitest";
import type { ReviewThread, ReviewThreadComment } from "../github/types";
import { buildHostedWorklist, hostedFailureDetail } from "../review/hosted-review";
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

/**
 * The END-TO-END hosted-review signature (issue #43, ADR-0042 §16). Asserting
 * {@link hostedFailureDetail} alone is not enough: the detail is only the raw material the
 * master's budget hashes through {@link normalizeFailureSignature}, and the whole defect this
 * pins is that the normalizer used to erase the finding's content hash as if it were an
 * incidental SHA — leaving thread-id + path, so a *materially new* comment on the same thread
 * signed identically and `repeatedSignature` forced a final adjudication instead of a fresh
 * recovery.
 */
describe("hosted-review failure signature, end to end", () => {
  const comment = (over: Partial<ReviewThreadComment> = {}): ReviewThreadComment => ({
    id: "PRRC_1",
    author: "chatgpt-codex-connector",
    authorIsBot: true,
    body: "P1: the retry loop can spin forever when the head never changes.",
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  });
  const thread = (over: Partial<ReviewThread> = {}): ReviewThread => ({
    id: "PRRT_1",
    isResolved: false,
    isOutdated: false,
    path: "src/review/review-loop.ts",
    line: 1204,
    side: "RIGHT",
    reviewedSha: "abc1234",
    resolvedBy: null,
    comments: [comment()],
    ...over,
  });
  const signature = (threads: ReviewThread[], verification?: string): string =>
    normalizeFailureSignature({
      source: "hosted-review",
      phase: "review-0",
      detail: hostedFailureDetail({
        findings: buildHostedWorklist(threads, null).findings,
        ...(verification !== undefined ? { verification } : {}),
      }),
    });

  it("a push that changes ONLY the head SHA is the SAME signature", () => {
    expect(signature([thread({ reviewedSha: "aaaaaaa" })])).toBe(signature([thread({ reviewedSha: "9911bbeed4" })]));
  });

  it("a materially changed finding on the same thread is a DIFFERENT signature", () => {
    const before = signature([thread()]);
    const after = signature([
      thread({ comments: [comment(), comment({ id: "PRRC_2", body: "P0: and now the resolve mutation races too." })] }),
    ]);
    expect(after).not.toBe(before);
  });

  it("a reflowed but identical finding is still the SAME signature", () => {
    expect(signature([thread({ comments: [comment({ body: "P1:  The retry\n loop can spin FOREVER when the head never changes." })] })])).toBe(
      signature([thread()]),
    );
  });

  it("the verification result is part of the identity — the same finding after a different repair is new", () => {
    const claimedFixed = signature([thread()], "attempt 1: fix pushed on head abc1234; finding unchanged");
    const claimedInvalid = signature([thread()], "attempt 1: disposed reasoned-invalid; finding unchanged");
    expect(claimedFixed).not.toBe(claimedInvalid);
    // …and the verification's own head SHA is still incidental.
    expect(claimedFixed).toBe(signature([thread()], "attempt 1: fix pushed on head deadbeef99; finding unchanged"));
  });
});
