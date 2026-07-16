import { describe, expect, it } from "vitest";
import type { Issue } from "../github/types";
import type { Worklist } from "./worklist";
import { buildFixPrompt, buildHealGuidance, buildReviewPrompt } from "./prompts";

const issue: Issue = {
  number: 6,
  title: "Hardening",
  body: "body",
  state: "OPEN",
  labels: [],
  createdAt: "2026-06-19T00:00:00Z",
};

const worklist: Worklist = { items: [{ severity: "P0", title: "fix the thing" }] };

describe("buildReviewPrompt — mode-aware lenses (AC4)", () => {
  it("tdd phase 1 applies the tests lens", () => {
    const prompt = buildReviewPrompt(issue, "tdd", 1, 10, []);
    expect(prompt).toContain("Tests lens");
  });

  it("infra phase 1 drops the tests lens", () => {
    const prompt = buildReviewPrompt(issue, "infra", 1, 10, []);
    expect(prompt).toContain("tests lens does NOT apply");
  });

  it("ui phase 1 narrows the tests lens to where tests are sensible and demands rendered evidence", () => {
    const prompt = buildReviewPrompt(issue, "ui", 1, 10, []);
    expect(prompt).toContain("mode:ui");
    expect(prompt.toLowerCase()).toContain("never a gate on pixel");
    expect(prompt.toLowerCase()).toContain("screenshots");
  });
});

describe("buildReviewPrompt — hardcoded, target-independent rubrics", () => {
  it("phase 1 carries the correctness rubric and needs no target review-guidelines file", () => {
    const prompt = buildReviewPrompt(issue, "tdd", 1, 10, []);
    expect(prompt).toContain("PHASE 1");
    expect(prompt).toContain("Correctness");
    expect(prompt).toContain("self-contained review spec");
    // the rubric is hardcoded — it must not depend on the target shipping a spec
    expect(prompt).not.toContain("AGENTS.md ## Review guidelines");
  });

  it("phase 2 embeds the thermo-nuclear structural lens (guards against a no-op review)", () => {
    const prompt = buildReviewPrompt(issue, "tdd", 2, 10, []);
    expect(prompt).toContain("thermo-nuclear");
    expect(prompt).toContain("code-judo");
    expect(prompt).toContain("behaviour-preserving");
  });
});

describe("buildReviewPrompt — P0/P1-only output discipline (no nits, no padding)", () => {
  it("phase 1 forbids nits/strengths and treats an empty clean pass as correct", () => {
    const prompt = buildReviewPrompt(issue, "tdd", 1, 10, []);
    expect(prompt).toContain("emit ONLY `P0` blockers");
    expect(prompt).toContain("Never invent, pad, or inflate");
    expect(prompt.toLowerCase()).toContain("empty worklist");
  });

  it("phase 2 raises a HIGH P1 bar and blesses an empty result over a manufactured one", () => {
    const prompt = buildReviewPrompt(issue, "tdd", 2, 10, []);
    expect(prompt).toContain("The P1 bar is HIGH");
    expect(prompt).toContain("When in doubt, it is not a P1");
    expect(prompt).toContain("Never manufacture, pad, or inflate");
  });

  it("the output contract offers only P0/P1/escalate — nit and out-of-scope are gone", () => {
    const prompt = buildReviewPrompt(issue, "tdd", 1, 10, []);
    expect(prompt).toContain("Emit NOTHING else");
    expect(prompt).not.toContain("`nit`: a minor suggestion");
    expect(prompt).not.toContain("out-of-scope`: a real point");
  });
});

describe("buildFixPrompt — mode-aware gate (AC4)", () => {
  it("tdd keeps the build and tests green", () => {
    const prompt = buildFixPrompt(
      { issue, mode: "tdd", phase: 1, worklist, behaviourPreserving: false },
      "npm run build",
      "npm test",
    );
    expect(prompt).toContain("npm test");
    expect(prompt).toContain("build and tests green");
  });

  it("infra drops the test gate, keeping only the build green", () => {
    const prompt = buildFixPrompt(
      { issue, mode: "infra", phase: 1, worklist, behaviourPreserving: false },
      "npm run build",
      "npm test",
    );
    expect(prompt).not.toContain("npm test");
    expect(prompt).toContain("npm run build");
    expect(prompt).toContain("test gate does not apply");
  });
});

describe("buildFixPrompt — rebase-conflict prompt (ADR-0014, containerised by #273)", () => {
  const conflicts: Worklist = {
    items: [{ severity: "P0", title: "Resolve rebase conflict in src/a.ts" }],
  };

  it("teaches the agent to START the rebase onto base and defer the push to the runner", () => {
    const prompt = buildFixPrompt(
      { issue, mode: "tdd", phase: 1, worklist: conflicts, behaviourPreserving: false, rebaseConflict: true, baseBranch: "main" },
      "npm run build",
      "npm test",
    );
    expect(prompt).toContain("rebase");
    // Under the container model the fix agent starts its OWN rebase in its fresh clone — it is
    // NOT continuing one already in progress (#273). It rebases onto the named base.
    expect(prompt).toContain("git rebase origin/main");
    expect(prompt).toContain("git rebase --continue");
    expect(prompt).not.toContain("already in progress");
    expect(prompt).not.toContain("ALREADY IN PROGRESS");
    // The runner owns the force-push (guardrails block it in agent sessions): the prompt must
    // tell the agent NOT to push, and must not instruct a force-push.
    expect(prompt).toContain("Do NOT push");
    expect(prompt).toContain("runner force-pushes");
    expect(prompt).not.toContain("git push --force-with-lease");
    // The generic "commit and push to the PR branch" gate must NOT leak in.
    expect(prompt).not.toContain("commit and push to the PR branch");
    // Still lists the conflicted files and keeps the escalate path.
    expect(prompt).toContain("src/a.ts");
    expect(prompt).toContain("escalate");
  });

  it("defaults to the generic fix prompt when rebaseConflict is omitted", () => {
    const prompt = buildFixPrompt(
      { issue, mode: "tdd", phase: 1, worklist, behaviourPreserving: false },
      "npm run build",
      "npm test",
    );
    expect(prompt).not.toContain("git rebase --continue");
    expect(prompt).toContain("commit and push to the PR branch");
  });
});

describe("buildFixPrompt — operator guidance on a heal (issue #9)", () => {
  it("embeds the guidance when a heal resumes the fix loop", () => {
    const prompt = buildFixPrompt(
      {
        issue,
        mode: "tdd",
        phase: 1,
        worklist,
        behaviourPreserving: false,
        guidance: "Operator ruling: keep the adapter behind a flag.",
      },
      "npm run build",
      "npm test",
    );
    expect(prompt).toContain("Operator guidance");
    expect(prompt).toContain("keep the adapter behind a flag.");
  });

  it("omits the guidance block on a normal (non-heal) fix attempt", () => {
    const prompt = buildFixPrompt(
      { issue, mode: "tdd", phase: 1, worklist, behaviourPreserving: false },
      "npm run build",
      "npm test",
    );
    expect(prompt).not.toContain("Operator guidance");
  });
});

describe("buildFixPrompt — sources findings from the PR (issue #47)", () => {
  it("a review-phase fix reads the latest ralph-review comment on the PR", () => {
    const prompt = buildFixPrompt(
      { issue, mode: "tdd", phase: 1, worklist, behaviourPreserving: false, reviewComment: { prNumber: 42, phase: 1 } },
      "npm run build",
      "npm test",
    );
    // The authoritative worklist is the rolling ralph-review comment on the PR.
    expect(prompt).toContain("ralph-review");
    expect(prompt).toContain("#42");
    expect(prompt).toContain("source of truth");
  });

  it("a CI-gate/conflict fix (no PR reference) keeps its inline worklist", () => {
    const prompt = buildFixPrompt(
      { issue, mode: "tdd", phase: 0, worklist, behaviourPreserving: false },
      "npm run build",
      "npm test",
    );
    expect(prompt).not.toContain("ralph-review");
    // The inline gating items are still embedded.
    expect(prompt).toContain("fix the thing");
  });
});

describe("buildHealGuidance (issue #9)", () => {
  it("combines the heal-card decision with the operator's answer", () => {
    const guidance = buildHealGuidance(
      {
        headline: "h",
        feature: "f",
        whereWeStand: "w",
        decision: "Delete the adapter or keep it behind a flag?",
        stakes: "s",
        recommendation: "r",
      },
      { kind: "free-text", text: "Keep it behind a flag this cycle." },
    );
    expect(guidance).toContain("Delete the adapter or keep it behind a flag?");
    expect(guidance).toContain("Keep it behind a flag this cycle.");
  });
});
