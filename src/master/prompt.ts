/**
 * The master session prompt (ADR-0041, DESIGN §13). Pure: a {@link MasterContext} in, a
 * string out, so the whole packet — evidence, zoom-out, prior attempts, remaining budget —
 * is exhaustively testable without an SDK.
 *
 * Three things this prompt does that a worker prompt must not:
 *
 *  - It presents the worker's recommendation **as evidence under a heading that says so**,
 *    immediately followed by the instruction to reach an independent conclusion. Ordering
 *    matters: a recommendation read last reads as a conclusion.
 *  - It states the loop budget as a *fact about the harness*, not a request. The engine
 *    enforces it either way; a master that proposes a forbidden repeat has simply wasted its
 *    one remaining intervention.
 *  - It names the five outcomes and demands exactly one. There is no free-text tail to hedge
 *    into (the no-deferral rule, enforced by the outcome schema rather than by exhortation).
 */

import { decisionSummary } from "../ledger/decision";
import { absoluteRoot } from "../hierarchy/map";
import { MASTER_RESOLUTIONS } from "./outcome";
import { MAX_MASTER_INTERVENTIONS_PER_PHASE } from "./budget";
import { normalizeFailureText } from "./signature";
import { activeDecisions, type MasterContext } from "./context";

/** Appended to the system prompt of every master session. */
export const MASTER_SYSTEM_APPEND = [
  "You are the MASTER escalation agent in the ralph-autopilot daemon — the highest-tier model in the system.",
  "A lower-tier worker could not finish and handed its decision up to you. You run with fresh context: derive",
  "truth from the code, the run's evidence, and GitHub — never from memory of past runs.",
  "",
  "Your job is to ADJUDICATE, not to relay. The worker's recommendation is evidence, never an answer: investigate",
  "it independently and state your own conclusion and rationale, even when you end up agreeing.",
  "",
  "Rules that bind you exactly as they bind a worker:",
  "- Design-authority rule: the design of record (ADRs, DESIGN.md, CONTEXT.md, the repo's conventions) and every",
  "  ACTIVE decision on this issue's ancestor path are binding, not advisory. Resolve obstacles in the direction",
  "  the design already committed to. If design authority is genuinely silent, you may publish a new scoped",
  "  decision. To CONTRADICT or supersede an existing binding decision you must use `ask-human` — never do it",
  "  autonomously.",
  "- No-deferral rule: there is no 'deferred items' outcome. Either it matters and you act, or it does not and it",
  "  is not worth mentioning.",
  "",
  "Harness invariants you cannot bypass (they are enforced mechanically; attempting them wastes your budget):",
  "- You never merge a pull request and never close a PR or issue. Repaired work re-enters the ordinary",
  "  CI/review/merge pipeline.",
  "- You never bypass CI (no admin merge, no cancelling runs, no editing branch protection).",
  "- You never force-push, rewrite history, hard-reset, or `git clean -f`; you may push ONLY this issue's branch.",
  "- You never control the host, the daemon, or the supervisor.",
  "",
  "What you CAN do, and should: read and edit the exclusive WIP worktree, run commands and tests, commit and push",
  "the issue branch, inspect GitHub/CI, publish scoped decisions, and delegate a fresh tier-1 worker.",
  "",
  "Single-shot: this session runs to a stop in ONE pass. Run verification in the FOREGROUND and wait for it here.",
  "Before you stop you MUST declare exactly one outcome.",
].join("\n");

function block(title: string, body: string[]): string[] {
  return body.length === 0 ? [] : [`## ${title}`, "", ...body, ""];
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (truncated)`;
}

/** The worker's evidence — labelled as evidence, before any instruction to act on it. */
function evidenceBlock(context: MasterContext): string[] {
  const { request } = context;
  const e = request.evidence;
  const body = [
    `- **Signal:** \`${request.source}\` from the \`${request.lane}\` lane, phase \`${request.phase}\`.`,
    `- **What stopped the worker:** ${e.headline}`,
    `- **Worker's RECOMMENDATION (evidence — not a decision, and not binding on you):** ${e.recommendation}`,
  ];
  if (e.attemptedFixes) {
    body.push(`- **Already attempted:** ${e.attemptedFixes}`);
  }
  if (e.uncertainty) {
    body.push(`- **Worker's stated uncertainty:** ${e.uncertainty}`);
  }
  if (e.question) {
    body.push(
      "",
      "The worker framed it as a question:",
      `> **${e.question.headline}** — ${e.question.decision}`,
      `> Stakes: ${e.question.stakes}`,
    );
  }
  if (e.stuck) {
    body.push("", `The worker self-stopped on \`${e.stuck.category}\`: ${e.stuck.reason}`);
  }
  body.push(
    "",
    "Investigate this independently. Confirm or refute it against the code, the diff, and CI before you decide.",
  );
  return block("The worker's evidence", body);
}

/** The ground truth the worker's account is checked against. */
function runStateBlock(context: MasterContext): string[] {
  const body: string[] = [
    `- Issue: \`${context.ref.repo}#${context.ref.number}\`${context.issue ? ` — ${context.issue.title}` : ""}`,
    `- Run ${context.runId}, phase \`${context.phase}\`, branch \`${context.request.branch}\``,
  ];
  if (context.workspace) {
    body.push(`- Head SHA: \`${context.workspace.headSha ?? "unknown"}\``);
  }
  if (context.pr) {
    body.push(`- Pull request #${context.pr.number} (${context.pr.state}) from \`${context.pr.headRefName}\``);
  } else {
    body.push("- No pull request found for this branch.");
  }
  if (context.checks) {
    const failures = context.checks.failures.length > 0 ? ` — ${context.checks.failures.join(", ")}` : "";
    body.push(`- CI: **${context.checks.state}**${failures}`);
  }
  const fixes = Object.entries(context.fixAttempts)
    .map(([phase, n]) => `phase ${phase}: ${n}`)
    .join(", ");
  body.push(`- Fix attempts so far — ${fixes}`);
  if (context.workspace) {
    if (context.workspace.status.trim().length > 0) {
      body.push("", "Uncommitted work in the WIP worktree:", "```", clamp(context.workspace.status, 2000), "```");
    }
    if (context.workspace.diffStat.trim().length > 0) {
      body.push("", "Diff against base:", "```", clamp(context.workspace.diffStat, 4000), "```");
    }
  }
  return block("The run's actual state", body);
}

/** The ADR-0040 zoom-out: hierarchy, selected node content, inherited decisions. */
function zoomOutBlock(context: MasterContext): string[] {
  const body: string[] = [];
  const map = context.hierarchy;
  if (map) {
    const path = map.path.map((n) => `${n.ref.repo}#${n.ref.number} (${n.title})`).join(" → ");
    body.push(`- Ancestor path (root-most first): ${path || "(this issue is the root)"}`);
    const root = absoluteRoot(map);
    body.push(
      root
        ? `- Absolute root: \`${root.ref.repo}#${root.ref.number}\` — ${root.title}`
        : `- Absolute root: **unresolved** (${map.root.kind}) — treat initiative-wide claims with suspicion.`,
    );
    for (const branch of map.branches) {
      if (branch.children.length === 0) {
        continue;
      }
      const kids = branch.children.map((c) => `#${c.ref.number} ${c.title} [${c.state}]`).join("; ");
      const omitted = branch.omitted > 0 ? ` (+${branch.omitted} more not listed)` : "";
      body.push(`- Children of \`${branch.parent.repo}#${branch.parent.number}\`: ${kids}${omitted}`);
    }
  } else {
    body.push("- The hierarchy could not be read; treat this issue as unanchored and say so if it matters.");
  }

  if (context.packet) {
    for (const node of context.packet.nodes) {
      if (node.role === "origin" || node.body.trim().length === 0) {
        continue;
      }
      body.push(
        "",
        `### ${node.role}: ${node.ref.repo}#${node.ref.number} — ${node.title} [${node.state}]`,
        clamp(node.body, 4000),
      );
      if (node.designRefs.length > 0) {
        body.push(`Design references: ${node.designRefs.join(", ")}`);
      }
    }
    if (context.packet.truncation.truncated) {
      body.push(
        "",
        `_Context budget bound: trimmed ${context.packet.truncation.trimmed.length} node(s), ` +
          `dropped ${context.packet.truncation.dropped.length}._`,
      );
    }
  }
  return block("Where this issue sits (native hierarchy, ADR-0040)", body);
}

/** The inherited active decision ledger — binding on the master, not advisory. */
function decisionsBlock(context: MasterContext): string[] {
  const active = activeDecisions(context);
  const body: string[] = [];
  if (active.length === 0) {
    body.push("No active binding decisions govern this issue's ancestor path.");
    body.push(
      "If you settle a question design authority is genuinely silent on, publish it as a scoped decision so the",
      "next session inherits it.",
    );
  } else {
    body.push("These are BINDING on you. Honour them, or route the contradiction to `ask-human`:");
    for (const d of active) {
      body.push(`- \`${d.record.key}\` (${d.record.scope}, on ${d.node.repo}#${d.node.number}): ${decisionSummary(d.record)}`);
    }
  }
  const conflicts = context.ledger?.conflicts ?? [];
  if (conflicts.length > 0) {
    body.push("", "**Unresolved decision conflicts** (the ledger failed closed — nobody won):");
    for (const c of conflicts) {
      const claims = c.claims.map((s) => `${s.node.repo}#${s.node.number}@${s.commentId}`).join(", ");
      body.push(`- \`${c.key}\` claimed by ${claims}. Adjudicating one of these may be the real fix.`);
    }
  }
  return block("Inherited decisions (ADR-0040 ledger)", body);
}

/** Prior attempts and the remaining budget, stated as harness facts. */
function budgetBlock(context: MasterContext): string[] {
  const body: string[] = [];
  const prior = context.priorInterventions.filter((i) => i.phase === context.phase);
  if (prior.length === 0) {
    body.push(`This is master intervention **1 of ${MAX_MASTER_INTERVENTIONS_PER_PHASE}** for phase \`${context.phase}\`.`);
  } else {
    body.push(
      `This is master intervention **${context.attempt} of ${MAX_MASTER_INTERVENTIONS_PER_PHASE}** for phase ` +
        `\`${context.phase}\`. Prior attempts in this phase:`,
    );
    for (const i of prior) {
      body.push(
        `- attempt ${i.attempt}: chose \`${i.resolution ?? "(never decided)"}\`` +
          (i.rationale ? ` — ${i.rationale}` : ""),
      );
    }
  }

  const verdict = context.budget;
  if (verdict.allowed && verdict.repeatedSignature) {
    body.push(
      "",
      "**⚠ THIS IS A REPEATED FAILURE SIGNATURE.** The same normalized failure has already been adjudicated in",
      "this phase. A changed head SHA does not make it new. You may NOT repeat a resolution already tried for it:",
      ...verdict.forbiddenResolutions.map((r) => `- \`${r}\` is forbidden (already tried on this signature).`),
      "Choose a materially different resolution, `ask-human`, or `terminal-stuck`.",
    );
  }
  if (verdict.allowed && verdict.finalAttempt) {
    body.push(
      "",
      "This is the **last** intervention permitted in this phase. No third master session can launch, so if this",
      "one does not resolve the run, the only remaining states are a human question or a terminal stop.",
    );
  }
  body.push(
    "",
    "The normalized failure signature under adjudication is:",
    "```",
    context.request.signature,
    "```",
    `(Normalized from: ${normalizeFailureText(context.request.evidence.detail) || "(empty)"} — SHAs, timestamps,`,
    "paths and line numbers are erased on purpose so a rerun cannot look like a new failure.)",
  );
  return block("Loop budget (enforced by the harness)", body);
}

/**
 * The operator's answer, when this session resumes a checkpointed master. Placed directly
 * after the evidence so the master reads it as the *decision it asked for* — and told, in the
 * same breath, that it may not ask again: a resumed master must conclude.
 */
function answerBlock(context: MasterContext): string[] {
  if (!context.answer) {
    return [];
  }
  return block("The operator's answer to your question", [
    `You asked: **${context.answer.question.headline}**`,
    `> ${context.answer.question.decision}`,
    "",
    "The operator answered:",
    "",
    context.answer.text,
    "",
    "This is a resumption of your own checkpointed adjudication — the same numbered attempt, not a new one.",
    "You may NOT ask another question on this attempt: act on the answer, or stop.",
  ]);
}

/** Recent structured run-log events — the daemon's own view of what happened. */
function timelineBlock(context: MasterContext): string[] {
  if (context.recentEvents.length === 0) {
    return [];
  }
  const body = context.recentEvents.map(
    (e) => `- \`${e.ts}\` [${e.level}] ${e.event}${e.data ? ` ${clamp(JSON.stringify(e.data), 300)}` : ""}`,
  );
  return block("Recent run events", body);
}

/** What the assembler could not read — stated, never silently omitted. */
function diagnosticsBlock(context: MasterContext): string[] {
  if (context.diagnostics.length === 0) {
    return [];
  }
  return block(
    "Gaps in this packet",
    context.diagnostics.map((d) => `- Could not read **${d.what}**: ${d.detail}`),
  );
}

/** The instruction: investigate, conclude, then declare exactly one of five outcomes. */
function outcomeBlock(context: MasterContext): string[] {
  const verdict = context.budget;
  const forbidden = verdict.allowed ? verdict.forbiddenResolutions : [];
  const allowed = MASTER_RESOLUTIONS.filter((r) => !forbidden.includes(r));
  return block("Your task", [
    "1. Investigate the evidence above independently — read the diff, run what you need, inspect CI and GitHub.",
    "2. Repair the work directly if you can: edit the WIP worktree, run the build/tests in the FOREGROUND, then",
    "   commit and push THIS issue's branch. Repaired work re-enters the ordinary CI/review/merge pipeline.",
    "3. State your own conclusion and the rationale for it — not the worker's.",
    "4. Declare **exactly one** outcome:",
    ...allowed.map((r) => `   - \`${r}\``),
    ...(forbidden.length > 0
      ? ["", `Forbidden on this attempt: ${forbidden.map((r) => `\`${r}\``).join(", ")}.`]
      : []),
    "",
    "`ask-human` is the ONLY way to create a human question, and it exists for decisions only a human can make —",
    "a product/priority call, a contradiction of standing design authority, or an external blocker. Use",
    "`terminal-stuck` only when neither another autonomous action nor a human decision could help.",
    "",
    "Your final message is machine-validated. Return ONLY one JSON object with the exact envelope",
    '`{"outcome": <one outcome object below>, "decisions": []}`. `outcome` MUST be an object, never the',
    "resolution name as a string. Do not add top-level keys. Use exactly the keys shown for the chosen arm:",
    ...allowed.map((resolution) => `- \`${JSON.stringify(masterOutcomeExample(resolution))}\``),
    "",
    "Keep `decisions` as `[]` unless design authority was genuinely silent and you are publishing a binding",
    "decision. A decision object uses exactly: `key`, `scope` (`issue`, `subtree`, or `initiative`), `decision`,",
    "`rationale`, and optional `constraints`, `rejectedAlternatives`, `evidence`, `subtreeRoot`, `supersedes`.",
  ]);
}

/** A minimal, schema-valid example for each strict master outcome arm. */
function masterOutcomeExample(resolution: (typeof MASTER_RESOLUTIONS)[number]): Record<string, unknown> {
  const common = { conclusion: "your independently verified conclusion", rationale: "why this outcome follows" };
  switch (resolution) {
    case "resolved-and-continue":
      return { resolution, ...common, guidance: "authoritative guidance for the resumed phase" };
    case "redispatch-tier-1":
      return { resolution, ...common, brief: "complete brief for the fresh tier-1 worker" };
    case "retry-pipeline":
      return { resolution, ...common, action: "ci" };
    case "ask-human":
      return {
        resolution,
        ...common,
        question: {
          headline: "short decision headline",
          feature: "feature or initiative in plain language",
          whereWeStand: "current state without requiring code context",
          decision: "the specific decision the operator must make",
          stakes: "consequences of the choice",
          recommendation: "the master's recommendation and why",
        },
      };
    case "terminal-stuck":
      return { resolution, ...common, reason: "why neither autonomy nor a human decision can help" };
  }
}

/** Build the full master prompt. Pure. */
export function buildMasterPrompt(context: MasterContext): string {
  const issueBody = context.issue?.body ?? "(issue body unavailable)";
  return [
    `# Master escalation — ${context.ref.repo}#${context.ref.number}`,
    "",
    `A \`${context.request.source}\` from a lower-tier worker has been escalated to you. The work is checkpointed`,
    `on \`${context.request.branch}\` and the issue has been permanently promoted to \`complexity:1\`.`,
    "",
    ...evidenceBlock(context),
    ...answerBlock(context),
    ...block("The issue", [clamp(issueBody, 8000)]),
    ...runStateBlock(context),
    ...timelineBlock(context),
    ...zoomOutBlock(context),
    ...decisionsBlock(context),
    ...budgetBlock(context),
    ...diagnosticsBlock(context),
    ...outcomeBlock(context),
  ].join("\n");
}
