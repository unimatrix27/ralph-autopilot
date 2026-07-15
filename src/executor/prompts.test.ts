import { describe, expect, it } from "vitest";
import { parseConfig, resolveTargets } from "../config/load";
import type { Issue } from "../github/types";
import { buildImplPrompt } from "./prompts";
import { buildStuckCardQuestion } from "./stuck";
import type { StuckHealGuidance } from "../hitl/heal-readmit";

const config = resolveTargets(
  parseConfig({
    targets: [{ repo: "acme/widgets", commands: { build: "npm run build", test: "npm test" } }],
  }),
)[0]!;

const issue: Issue = {
  number: 6,
  title: "Do the thing",
  body: "Some body",
  state: "OPEN",
  labels: [],
  createdAt: "2026-06-19T00:00:00Z",
};

describe("buildImplPrompt — mode routing (AC4)", () => {
  it("mode:tdd drives red-green-refactor and gates on a green test suite", () => {
    const prompt = buildImplPrompt(issue, "tdd", "ralph/6-x", config);
    expect(prompt).toContain("red");
    expect(prompt).toContain("npm test");
    expect(prompt.toLowerCase()).toContain("test");
  });

  it("mode:infra drops the test gate for a mode-appropriate verification", () => {
    const prompt = buildImplPrompt(issue, "infra", "ralph/6-x", config);
    // No red-green-refactor and no test-suite gate.
    expect(prompt).not.toContain("red → green");
    expect(prompt).not.toContain("npm test");
    expect(prompt.toLowerCase()).toContain("test gate does not apply");
    // Still asks for a mode-appropriate verification.
    expect(prompt.toLowerCase()).toContain("verif");
  });

  it("mode:ui verifies by rendering — chromium screenshots via net-zero branch commits", () => {
    const prompt = buildImplPrompt(issue, "ui", "ralph/6-x", config);
    // No red-green-refactor gate; tests are additive, never a gate on pixels.
    expect(prompt).not.toContain("red → green");
    expect(prompt.toLowerCase()).toContain("never a gate on pixel");
    // The build gate still applies.
    expect(prompt).toContain("npm run build");
    // The rendering contract: headless chromium, pinned-SHA raw URLs, net-zero commits.
    expect(prompt).toContain("chromium --headless");
    expect(prompt).toContain("raw.githubusercontent.com");
    expect(prompt.toLowerCase()).toContain("net-zero");
    expect(prompt.toLowerCase()).toContain("remove the files in a follow-up commit");
    // Blocked rendering escalates — no hedged PR bodies (no-deferral rule).
    expect(prompt.toLowerCase()).toContain("escalate");
  });

  it("every impl prompt offers exactly three terminal outcomes incl. stuck", () => {
    for (const mode of ["tdd", "infra", "ui"] as const) {
      const prompt = buildImplPrompt(issue, mode, "ralph/6-x", config);
      expect(prompt.toLowerCase()).toContain("escalate");
      expect(prompt.toLowerCase()).toContain("stuck");
    }
  });
});

describe("buildImplPrompt — heal re-admission threads operator guidance (#86, AC3)", () => {
  const stuckHeal: StuckHealGuidance = {
    question: buildStuckCardQuestion({
      category: "futility",
      reason: "the spec contradicts the data model",
    }),
    answer: { kind: "free-text", text: "Split the schema migration into its own issue first, then retry" },
  };

  it("a fresh impl prompt without heal carries no previous-attempt block", () => {
    const prompt = buildImplPrompt(issue, "tdd", "ralph/6-x", config);
    expect(prompt).not.toContain("a previous attempt stopped");
  });

  it("with heal, the prompt carries why the last attempt stopped AND the operator's guidance", () => {
    const prompt = buildImplPrompt(issue, "tdd", "ralph/6-x", config, stuckHeal);
    // Why it stopped — the stuck-card category + the agent's reason, verbatim.
    expect(prompt.toLowerCase()).toContain("a previous attempt stopped");
    expect(prompt).toContain("futility");
    expect(prompt).toContain("the spec contradicts the data model");
    // The operator's guidance — the load-bearing part of #86.
    expect(prompt).toContain("Split the schema migration into its own issue first, then retry");
    // It is a fresh start, not a resume — no claim of a WIP branch to continue.
    expect(prompt.toLowerCase()).toContain("no prior wip branch");
    // The issue body and the mode gate are still present (heal augments, not replaces).
    expect(prompt).toContain("Some body");
    expect(prompt).toContain("npm test");
  });
});
