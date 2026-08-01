import { describe, expect, it } from "vitest";
import { renderFencedPayload } from "../core/fenced-payload";
import { decisionFixture as decision } from "../testing/fake-decisions";
import {
  DECISION_SCOPES,
  formatDecisionComment,
  isDecisionComment,
  parseDecisionComment,
  parseDecisionRecord,
  RALPH_DECISION_FENCE,
  sanitizeDecisionRecord,
} from "./decision";

describe("the `ralph-decision` fenced payload", () => {
  it("names the three scopes, narrowest first", () => {
    expect(DECISION_SCOPES).toEqual(["issue", "subtree", "initiative"]);
  });

  it("round-trips a record through the shared fenced-payload codec", () => {
    const record = decision();
    const body = formatDecisionComment(record);

    expect(body).toContain("```" + RALPH_DECISION_FENCE);
    expect(isDecisionComment(body)).toBe(true);
    expect(parseDecisionComment(body)).toEqual(record);
  });

  it("renders a human-readable summary outside the fence", () => {
    const body = formatDecisionComment(decision());
    const summary = body.slice(0, body.indexOf("```"));

    expect(summary).toContain("hierarchy-authority");
    expect(summary).toContain("subtree");
    expect(summary).toContain("only hierarchy authority");
    expect(summary).toContain("Prose headings");
  });

  it("tolerates additive fields (ADR-0026) and preserves them", () => {
    const withExtra = { ...decision(), futureField: "added by a later slice" };
    const body = renderFencedPayload(RALPH_DECISION_FENCE, withExtra);

    expect(parseDecisionComment(body)).toEqual(withExtra);
  });

  it("rejects a record missing a required field", () => {
    const { decision: _dropped, ...rest } = decision();
    expect(() => parseDecisionRecord(rest)).toThrow();
    expect(parseDecisionComment(renderFencedPayload(RALPH_DECISION_FENCE, rest))).toBeNull();
  });

  it("rejects an unknown scope rather than guessing the narrowest node", () => {
    expect(() => parseDecisionRecord({ ...decision(), scope: "programme" })).toThrow();
  });

  it("never parses an ordinary comment that merely mentions a decision", () => {
    const prose = [
      "I think the ralph-decision ledger should record this: scope subtree,",
      "key hierarchy-authority. Here is what it would look like:",
      renderFencedPayload("json", decision()),
    ].join("\n");

    expect(isDecisionComment(prose)).toBe(false);
    expect(parseDecisionComment(prose)).toBeNull();
  });

  it("treats a fenced-but-malformed payload as unparseable, not as state", () => {
    const malformed = "## ralph-decision\n\n```" + RALPH_DECISION_FENCE + "\n{ not json ]\n```";

    expect(isDecisionComment(malformed)).toBe(true);
    expect(parseDecisionComment(malformed)).toBeNull();
  });

  it("keeps a supersedes pointer when one is present", () => {
    const record = decision({ id: "dec-0002", supersedes: "dec-0001" });
    expect(parseDecisionComment(formatDecisionComment(record))?.supersedes).toBe("dec-0001");
  });

  it("neutralises backticks anywhere in a record so the fence cannot be closed early", () => {
    const raw = decision({ decision: "use ``` fences everywhere", rationale: "because `code`" });
    const body = formatDecisionComment(raw);

    // Read back: the canonical (sanitised) record, and nothing lost to a broken fence.
    expect(parseDecisionComment(body)).toEqual(sanitizeDecisionRecord(raw));
    expect(parseDecisionComment(body)?.decision).toBe("use ´´´ fences everywhere");
    // Exactly one fence opens and one closes — the payload is intact.
    expect(body.split("```")).toHaveLength(3);
  });
});
