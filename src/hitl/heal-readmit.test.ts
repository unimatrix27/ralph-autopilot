/**
 * Heal re-admission detection (#86). When a stuck issue is healed via `ralph-answer`
 * (`agent-stuck` → `ready-for-agent`), the next fresh run must begin knowing why the
 * last attempt stopped and what the operator wants done differently. The single
 * GitHub-only signal for that is the issue's own comments: an open stuck-card
 * (`ralph-question`) followed by the operator's `ralph-answer`. This proves the
 * detector reads exactly that, and stays GitHub-only (no SQLite / daemon).
 */

import { describe, expect, it } from "vitest";
import { FakeGitHub } from "../testing/fake-github";
import { formatRalphQuestion, type EscalationQuestion } from "../review/escalation";
import { buildStuckCardQuestion } from "../executor/stuck";
import { formatRalphAnswer } from "./answer";
import { findStuckHealGuidance } from "./heal-readmit";

const escalateQuestion: EscalationQuestion = {
  headline: "Delete the legacy adapter?",
  feature: "Ingestion",
  whereWeStand: "Review wants it gone.",
  decision: "Remove it or keep it behind a flag?",
  options: ["Delete it", "Keep behind a flag"],
  stakes: "One-way door for old consumers.",
  recommendation: "Keep behind a flag.",
};

describe("findStuckHealGuidance (#86 — GitHub-only)", () => {
  it("returns the stuck-card + operator answer when a stuck issue has been answered", async () => {
    const github = new FakeGitHub();
    github.seed({ number: 7, title: "Flaky thing", labels: ["ready-for-agent", "afk", "mode:tdd"] });
    // The prior attempt posted a stuck-card, then the operator answered it.
    void github.postComment(
      7,
      formatRalphQuestion(buildStuckCardQuestion({ category: "futility", reason: "the spec contradicts the data model" })),
    );
    void github.postComment(7, formatRalphAnswer({ kind: "free-text", text: "Split the schema migration into two issues first" }));

    const heal = await findStuckHealGuidance(github, 7);
    expect(heal).not.toBeNull();
    // The stuck-card carries why the attempt stopped...
    expect(heal!.question.feature).toBe("Bounded-effort run (no PR opened)");
    expect(heal!.question.whereWeStand).toContain("the spec contradicts the data model");
    // ...and the answer carries the operator's guidance.
    expect(heal!.answer.text).toBe("Split the schema migration into two issues first");
  });

  it("returns null for a stuck-card that has NOT been answered yet (stays terminal)", async () => {
    const github = new FakeGitHub();
    github.seed({ number: 7 });
    void github.postComment(7, formatRalphQuestion(buildStuckCardQuestion({ category: "fix-iterations", reason: "looped" })));

    expect(await findStuckHealGuidance(github, 7)).toBeNull();
  });

  it("returns null when the issue has no ralph comments at all (a normal first run)", async () => {
    const github = new FakeGitHub();
    github.seed({ number: 7 });
    expect(await findStuckHealGuidance(github, 7)).toBeNull();
  });

  it("does NOT misfire on an answered escalate/heal-card — only a stuck-card is heal guidance", async () => {
    // A reopened/re-run issue whose prior cycle answered an escalation must not be
    // treated as a stuck heal: the latest answered ralph-question is an escalate, not
    // a stuck-card.
    const github = new FakeGitHub();
    github.seed({ number: 8 });
    void github.postComment(8, formatRalphQuestion(escalateQuestion));
    void github.postComment(8, formatRalphAnswer({ kind: "free-text", text: "Keep it behind a flag" }));

    expect(await findStuckHealGuidance(github, 8)).toBeNull();
  });

  it("correlates the answer to the LATEST stuck-card across an earlier answered cycle", async () => {
    const github = new FakeGitHub();
    github.seed({ number: 9 });
    // An earlier escalate cycle, fully resolved.
    void github.postComment(9, formatRalphQuestion(escalateQuestion));
    void github.postComment(9, formatRalphAnswer({ kind: "free-text", text: "stale answer" }));
    // Then the run went stuck and the operator healed it.
    void github.postComment(9, formatRalphQuestion(buildStuckCardQuestion({ category: "no-green-build", reason: "typecheck never went green" })));
    void github.postComment(9, formatRalphAnswer({ kind: "free-text", text: "regenerate the lockfile, then retry" }));

    const heal = await findStuckHealGuidance(github, 9);
    expect(heal!.question.whereWeStand).toContain("typecheck never went green");
    expect(heal!.answer.text).toBe("regenerate the lockfile, then retry");
  });
});
