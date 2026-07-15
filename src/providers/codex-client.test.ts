import { describe, expect, it } from "vitest";
// Importing this module is safe in node CI: the only `@openai/codex-sdk` reference is a
// type-only import (erased at compile) and a lazy `new Function` import never executed at
// module load — so the optional dependency is not loaded just to test the pure helpers.
import { actionableCodexModelError, mapReasoningEffort } from "./codex-client";

describe("mapReasoningEffort", () => {
  it("clamps max to xhigh and passes the rest through", () => {
    expect(mapReasoningEffort("max")).toBe("xhigh");
    for (const e of ["minimal", "low", "medium", "high", "xhigh"] as const) {
      expect(mapReasoningEffort(e)).toBe(e);
    }
  });
});

describe("actionableCodexModelError (issue #138)", () => {
  it("re-casts a ChatGPT-account model-rejection 400 to an actionable error", () => {
    const raw = new Error(
      "status 400 invalid_request_error: The 'gpt-5.5-codex' model is not supported when " +
        "using Codex with a ChatGPT account.",
    );
    const mapped = actionableCodexModelError(raw, "gpt-5.5-codex");
    expect(mapped).toBeInstanceOf(Error);
    // It names the knob to set and a model that works under a ChatGPT subscription.
    expect(mapped!.message).toContain("providers.openai.model");
    expect(mapped!.message).toContain("gpt-5.5");
    // The configured model and the raw SDK message are preserved for diagnosis.
    expect(mapped!.message).toContain("gpt-5.5-codex");
    expect(mapped!.message).toContain(raw.message);
  });

  it("matches the message regardless of how the model id is spelled", () => {
    const raw = new Error("The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.");
    expect(actionableCodexModelError(raw, "gpt-5-codex")).toBeInstanceOf(Error);
  });

  it("accepts a non-Error throwable (stringifies the message)", () => {
    const mapped = actionableCodexModelError(
      "boom: not supported when using Codex with a ChatGPT account",
      "gpt-5-codex",
    );
    expect(mapped).toBeInstanceOf(Error);
  });

  it("leaves any other error untouched (returns undefined so the caller rethrows as-is)", () => {
    expect(actionableCodexModelError(new Error("ECONNRESET"), "gpt-5.5")).toBeUndefined();
    expect(actionableCodexModelError(new Error("rate limit exceeded"), "gpt-5.5")).toBeUndefined();
  });
});
