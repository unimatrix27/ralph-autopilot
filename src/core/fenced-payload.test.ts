import { describe, expect, it } from "vitest";
import {
  extractFencedPayload,
  hasFencedPayload,
  parseFencedPayload,
  renderFencedPayload,
} from "./fenced-payload";

const FENCE = "ralph-question";

describe("fenced-payload codec", () => {
  it("round-trips a value through render → extract → parse", () => {
    const value = { headline: "Drop the adapter?", options: ["a", "b"] };
    const body = `## Summary\n\nsome prose\n\n${renderFencedPayload(FENCE, value)}`;

    expect(hasFencedPayload(body, FENCE)).toBe(true);
    expect(JSON.parse(extractFencedPayload(body, FENCE)!)).toEqual(value);
    expect(parseFencedPayload(body, FENCE, (v) => v)).toEqual(value);
  });

  it("returns null / false when the fence is absent", () => {
    expect(extractFencedPayload("just prose", FENCE)).toBeNull();
    expect(hasFencedPayload("just prose", FENCE)).toBe(false);
    expect(parseFencedPayload("just prose", FENCE, (v) => v)).toBeNull();
  });

  it("anchors on the fence tag, not a bare ``` in the prose (regex-anchored)", () => {
    // The human-readable summary mentions a bare triple-backtick fence in passing,
    // before the real payload block. A naive split on bare ``` would grab the wrong
    // span; the regex anchored on the language tag must still extract the payload.
    const value = { headline: "real one" };
    const body = [
      "Here is some prose with a bare ``` fence mentioned ``` in passing.",
      "",
      renderFencedPayload(FENCE, value),
    ].join("\n");

    expect(JSON.parse(extractFencedPayload(body, FENCE)!)).toEqual(value);
  });

  it("does not confuse a different fence tag's block", () => {
    const body = renderFencedPayload("ralph-answer", { kind: "free-text", text: "hi" });
    expect(extractFencedPayload(body, "ralph-question")).toBeNull();
    expect(extractFencedPayload(body, "ralph-answer")).toContain('"free-text"');
  });

  it("returns null from parse when the payload is not valid JSON", () => {
    const body = ["```" + FENCE, "{ not json", "```"].join("\n");
    expect(parseFencedPayload(body, FENCE, (v) => v)).toBeNull();
  });

  it("returns null from parse when the validator rejects the value", () => {
    const body = renderFencedPayload(FENCE, { wrong: true });
    const result = parseFencedPayload(body, FENCE, (v) => {
      if (typeof (v as { headline?: unknown }).headline !== "string") {
        throw new Error("missing headline");
      }
      return v;
    });
    expect(result).toBeNull();
  });
});
