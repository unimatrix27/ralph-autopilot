import { describe, expect, it } from "vitest";
import { formatRoute } from "./route-view";

describe("formatRoute (ADR-0037 P3.2, issue #165)", () => {
  it("renders provider · model · account", () => {
    expect(formatRoute({ provider: "claude", model: "opus", account: "A" })).toBe("claude · opus · A");
  });

  it("drops the model segment for a default-model route (null model degrades gracefully)", () => {
    // model === null is the provider's default — render `provider · account`, not an empty middot.
    expect(formatRoute({ provider: "zai", model: null, account: "z3" })).toBe("zai · z3");
  });

  it("always renders the (always-present) provider and account", () => {
    expect(formatRoute({ provider: "openai", model: "gpt-5.5", account: "o1" })).toBe("openai · gpt-5.5 · o1");
  });
});
