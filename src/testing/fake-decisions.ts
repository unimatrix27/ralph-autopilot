/**
 * Test fixtures for the durable decision ledger: one canonical
 * {@link DecisionRecord} builder shared by the ledger's unit tests so the shape
 * lives in exactly one place (sibling to `fake-github.ts` / `fake-agent.ts`).
 */

import type { DecisionRecord } from "../ledger/decision";
import type { IssueRef } from "../github/types";

export const FIXTURE_REPO = "acme/app";

/** A `{ repo, number }` ref in the fixture repo unless another is named. */
export function fixtureRef(number: number, repo = FIXTURE_REPO): IssueRef {
  return { repo, number };
}

/** A complete, valid decision record; `over` replaces any field. */
export function decisionFixture(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "dec-0001",
    key: "hierarchy-authority",
    scope: "subtree",
    storageNode: fixtureRef(2),
    decision: "GitHub's native parent/sub-issue graph is the only hierarchy authority.",
    rationale: "Prose headings such as epic are not a contract and drift silently.",
    constraints: ["never infer a parent from a title, label, or link"],
    rejectedAlternatives: ["parse ## Epic headings", "a labels-based hierarchy"],
    affectedNodes: [fixtureRef(3)],
    affectedPaths: ["src/hierarchy"],
    evidence: ["https://github.com/acme/app/issues/2#issuecomment-11"],
    origin: { repo: FIXTURE_REPO, issue: 3, runId: 42, phase: "impl", headSha: "abc1234" },
    authoredBy: { model: "claude-opus-5" },
    recordedAt: "2026-08-01T00:00:00Z",
    ...over,
  };
}
