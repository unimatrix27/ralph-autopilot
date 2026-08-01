import { describe, expect, it } from "vitest";
import { buildMasterPrompt } from "./prompt";
import type { MasterContext } from "./context";

describe("buildMasterPrompt output contract", () => {
  it("shows the strict session envelope and an object-shaped redispatch outcome", () => {
    const context = {
      ref: { repo: "acme/widgets", number: 42 },
      runId: 7,
      phase: "impl",
      attempt: 1,
      request: {
        source: "session-failed",
        lane: "impl",
        phase: "impl",
        issueNumber: 42,
        runId: 7,
        branch: "ralph/42-fix",
        signature: "sig",
        evidence: {
          headline: "worker stopped",
          recommendation: "retry with context",
          detail: "failure detail",
        },
      },
      issue: { number: 42, title: "Fix it", body: "body", state: "OPEN", labels: ["complexity:1"] },
      issueComments: [],
      pr: null,
      checks: null,
      recentEvents: [],
      fixAttempts: {},
      workspace: null,
      hierarchy: null,
      packet: null,
      ledger: null,
      priorInterventions: [],
      diagnostics: [],
      answer: null,
      budget: {
        allowed: true,
        attempt: 1,
        spent: 0,
        remaining: 1,
        repeatedSignature: false,
        forbiddenResolutions: [],
        finalAttempt: false,
      },
    } as unknown as MasterContext;

    const prompt = buildMasterPrompt(context);
    expect(prompt).toContain('{"outcome": <one outcome object below>, "decisions": []}');
    expect(prompt).toContain(
      '{"resolution":"redispatch-tier-1","conclusion":"your independently verified conclusion",' +
        '"rationale":"why this outcome follows","brief":"complete brief for the fresh tier-1 worker"}',
    );
    expect(prompt).toContain("`outcome` MUST be an object");
  });
});
