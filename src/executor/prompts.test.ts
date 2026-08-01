import { describe, expect, it } from "vitest";
import { parseConfig, resolveTargets } from "../config/load";
import type { Issue } from "../github/types";
import { buildImplPrompt, SYSTEM_APPEND } from "./prompts";

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

  it("every impl prompt carries the single-shot finalization contract: foreground verify + commit-before-stop", () => {
    for (const mode of ["tdd", "infra", "ui"] as const) {
      const prompt = buildImplPrompt(issue, mode, "ralph/6-x", config);
      const lower = prompt.toLowerCase();
      // Run verification in the foreground; never background a long command and end.
      expect(lower).toContain("foreground");
      expect(lower).toContain("background");
      // The trap named explicitly: no re-invocation on completion; ScheduleWakeup is inert.
      expect(prompt).toContain("ScheduleWakeup");
      // Commit + push before stopping, or the run is lost with no PR.
      expect(lower).toContain("commit and push before you stop");
      // The auto-background trap (the second #3061 failure): the harness backgrounds long
      // commands unasked, and Monitor/wakeup events never fire — poll the output file instead,
      // and if the broad suite can't finish in-session, PR anyway (CI is the authoritative gate).
      expect(lower).toContain("poll");
      expect(lower).toContain("monitor");
      expect(lower).toContain("ci gate");
    }
  });
});

describe("SYSTEM_APPEND — binding rules", () => {
  it("adds the single-shot finalization rule (foreground verify, commit/push before ending)", () => {
    const lower = SYSTEM_APPEND.toLowerCase();
    expect(lower).toContain("single-shot");
    expect(lower).toContain("foreground");
    expect(SYSTEM_APPEND).toContain("ScheduleWakeup");
    // Names the exact consequence so the model weights it: uncommitted work → lost run.
    expect(lower).toContain("committed and pushed");
    expect(lower).toContain("agent-stuck");
  });

  it("adds the auto-background trap rule (distrust Monitor/wakeup promises; poll; PR anyway)", () => {
    const lower = SYSTEM_APPEND.toLowerCase();
    // The harness backgrounds long commands unasked…
    expect(lower).toContain("against your will");
    // …its notification promises are lies in this session…
    expect(SYSTEM_APPEND).toContain("Monitor");
    expect(lower).toContain("never arrive");
    // …so poll the output file in the foreground…
    expect(lower).toContain("poll");
    // …and if the broad suite can't finish, PR anyway — CI is the authoritative gate.
    expect(lower).toContain("ci gate");
  });
});

describe("buildImplPrompt — the #86 heal block is gone (ADR-0042 / #43)", () => {
  it("an impl prompt is built from the issue alone — no previous-attempt guidance block", () => {
    // `agent-stuck` is a terminal only a master may select, so no operator answer can ever
    // post-date a stuck-card and there is no guidance to weave in. The prompt takes no such
    // argument any more; this pins that the block cannot return by any other route either.
    const prompt = buildImplPrompt(issue, "tdd", "ralph/6-x", config);
    expect(prompt.toLowerCase()).not.toContain("a previous attempt stopped");
    expect(prompt.toLowerCase()).not.toContain("operator guidance");
    expect(prompt).toContain("Some body");
  });
});
