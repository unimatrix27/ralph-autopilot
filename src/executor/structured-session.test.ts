import { describe, expect, it } from "vitest";
import { extractJsonObject } from "./structured-session";

describe("extractJsonObject", () => {
  it("parses a fenced ```json block", () => {
    const text = 'Here is the worklist:\n```json\n{ "items": [] }\n```\nDone.';
    expect(extractJsonObject(text)).toEqual({ items: [] });
  });

  it("prefers the last fenced block when several are present", () => {
    const text = '```json\n{ "items": [1] }\n```\nthen\n```json\n{ "items": [2] }\n```';
    expect(extractJsonObject(text)).toEqual({ items: [2] });
  });

  it("falls back to the last balanced object when unfenced", () => {
    const text = 'prose { not json here either } result: { "outcome": "fixed" }';
    expect(extractJsonObject(text)).toEqual({ outcome: "fixed" });
  });

  it("throws when there is no JSON object", () => {
    expect(() => extractJsonObject("no json at all")).toThrow();
  });

  it("falls through when the last fenced block is not JSON (a quoted code snippet)", () => {
    const text =
      '```json\n{ "items": [] }\n```\nThe offending method:\n```csharp\npublic async Task<Result> Guard() { return await Run(); }\n```';
    expect(extractJsonObject(text)).toEqual({ items: [] });
  });

  it("finds the unfenced object when every fenced block is code, not JSON", () => {
    const text = 'Verdict below.\n```csharp\nif (a) { b(); }\n```\n{ "outcome": "fixed" }';
    expect(extractJsonObject(text)).toEqual({ outcome: "fixed" });
  });

  it("balances braces that appear inside string values", () => {
    const text = 'result: { "items": [{ "severity": "P0", "title": "replace the { on line 5" }] }';
    expect(extractJsonObject(text)).toEqual({
      items: [{ severity: "P0", title: "replace the { on line 5" }],
    });
  });

  it("repairs bare newlines inside string values and trailing commas", () => {
    const text = '{ "outcome": "escalate", "note": "line one\nline two", }';
    expect(extractJsonObject(text)).toEqual({ outcome: "escalate", note: "line one\nline two" });
  });

  it("recovers the object after a stray unclosed brace in prose", () => {
    const text = 'prose with a stray { opener and then the payload { "outcome": "fixed" }';
    expect(extractJsonObject(text)).toEqual({ outcome: "fixed" });
  });

  it("skips a fenced JSON array in favour of the real object", () => {
    const text = '{ "items": [] }\ntrailing list:\n```json\n[1, 2]\n```';
    expect(extractJsonObject(text)).toEqual({ items: [] });
  });
});
