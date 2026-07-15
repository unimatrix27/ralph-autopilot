/**
 * Pure builders for the Tier-1 power actions (issue #114, ADR-0032). The actions are
 * **on-protocol GitHub label effects**: each maps to a deterministic set of label
 * adds/removes (or, for `close`, a state change) that the reconciler observes next tick.
 *
 * {@link planPowerAction} is the **pure** decision — given the parsed action, the issue's
 * current labels, and the repo's configured priority set, it returns the label effects
 * (or a `bad-request` / the destructive `close`). {@link executePowerAction} owns the live
 * GitHub read, delegates answerable readmit to `RalphAnswerService`, and executes effects;
 * the control-plane composition root only wires its dependencies. Kept here, node-side (it references the
 * label vocabulary in `core/labels` — not browser-safe), mirroring `inbox.ts`.
 *
 * Static read-model affordances live in `power-action-affordance.ts` so pure read
 * serialization does not import this write port.
 *
 * The label effects follow the state machine (DESIGN §9, CONTEXT):
 *   - `readmit` — swap a fresh-restart/daemon-anomaly label back to `ready-for-agent`
 *     (`RalphAnswerService` handles answerable questions before label planning);
 *   - `set-mode` — swap the current `mode:*` for the chosen `tdd`/`infra`/`ui`;
 *   - `set-priority` — swap any configured priority label for the chosen one;
 *   - `pause`/`unpause` — the `afk` ↔ `hitl` duality that holds an issue out of / returns
 *     it to the autonomous gate (CONTEXT: "Its opposite is `hitl`").
 */
import type { RalphAnswer } from "../hitl/answer";
import { RalphAnswerService } from "../hitl/ralph-answer";
import type { GitHubClient } from "../github/types";
import {
  BACKLOG_PAUSED_STATES,
  LABEL_AFK,
  LABEL_HITL,
  LABEL_MODE_INFRA,
  LABEL_MODE_TDD,
  LABEL_MODE_UI,
  LABEL_READY,
  modeLabelFor,
} from "../core/labels";
import type {
  PowerActionRequestBody,
  PowerActionResponse,
} from "./contract";

const WEB_READMIT_ANSWER: RalphAnswer = {
  kind: "free-text",
  text: "Re-admitted from the web control plane without additional guidance.",
};

/**
 * The pure outcome of planning one action against the live issue: the label effects to
 * apply, the destructive close, or a rejected plan. `close` is *not* a label effect (it
 * flips issue state) and is signalled separately so the port performs the right call.
 */
export type PowerActionPlan =
  | { kind: "labels"; remove: string[]; add: string[] }
  | { kind: "close" }
  | { kind: "bad-request"; error: string };

/**
 * The domain outcome of a power action — the HTTP adapter maps each branch to a status:
 *   - `applied` → 200 (the action was written back);
 *   - `bad-request` → 400 (unknown repo, a priority not in the configured set, …);
 *   - `not-found` → 404 (no such issue).
 */
export type PowerActionPortResult =
  | { kind: "applied"; response: PowerActionResponse }
  | { kind: "bad-request"; error: string }
  | { kind: "not-found"; error: string };

export interface ExecutePowerActionDeps {
  now: () => Date;
  isConfiguredRepo: (repo: string) => boolean;
  githubFor: (repo: string) => GitHubClient;
  priorityLabelsFor: (repo: string) => readonly string[];
  reconcileIntervalSeconds: number;
}

function appliedResponse(
  body: PowerActionRequestBody,
  deps: Pick<ExecutePowerActionDeps, "now" | "reconcileIntervalSeconds">,
): PowerActionPortResult {
  return {
    kind: "applied",
    response: {
      generatedAt: deps.now().toISOString(),
      repo: body.repo,
      issue: body.issue,
      action: body.kind,
      appliesNextTickSeconds: deps.reconcileIntervalSeconds,
    },
  };
}

export async function executePowerAction(
  body: PowerActionRequestBody,
  deps: ExecutePowerActionDeps,
): Promise<PowerActionPortResult> {
  if (!deps.isConfiguredRepo(body.repo)) {
    return { kind: "bad-request", error: `${body.repo} is not a configured target repo` };
  }
  const github = deps.githubFor(body.repo);
  // Re-fetch the live issue so the plan runs against the current labels (a stale client view
  // could otherwise swap a label that was already changed) — the same fresh-read discipline the
  // answer path uses. A missing issue is a 404, not a write.
  const issue = await github.getIssue(body.issue);
  if (!issue) {
    return { kind: "not-found", error: `no such issue ${body.repo}#${body.issue}` };
  }

  if (body.kind === "readmit") {
    const submitted = await new RalphAnswerService(github).submitForIssue(issue, WEB_READMIT_ANSWER);
    if (submitted.kind === "submitted") {
      return appliedResponse(body, deps);
    }
    if (submitted.kind === "missing-open-question") {
      return {
        kind: "bad-request",
        error: `${body.repo}#${body.issue} carries ${submitted.label} but has no open ralph-question to answer`,
      };
    }
  }

  const plan = planPowerAction(body, issue.labels, deps.priorityLabelsFor(body.repo));
  if (plan.kind === "bad-request") {
    return plan;
  }
  if (plan.kind === "close") {
    await github.closeIssue(body.issue);
  } else {
    await github.applyLabelPatch(body.issue, plan);
  }
  return appliedResponse(body, deps);
}

/**
 * Plan one power action's label effects. Pure over the action + current labels + the
 * repo's configured priority set. Removes and adds are returned together as one patch
 * so the GitHub adapter can apply the swap as a single backend edit where supported.
 * A repeated/no-op effect (e.g. pausing an already-`hitl` issue) still returns the
 * swap — the `gh` client's patch semantics are idempotent for absent removals and
 * already-present additions.
 */
export function planPowerAction(
  body: PowerActionRequestBody,
  currentLabels: readonly string[],
  configuredPriorityLabels: readonly string[],
): PowerActionPlan {
  const has = (label: string): boolean => currentLabels.includes(label);
  switch (body.kind) {
    case "readmit":
      return {
        kind: "labels",
        // Drop any non-answerable human-attention label the issue carries (only one should
        // ever be present, but removing all is safe + idempotent), then re-arm the daemon.
        // Answerable open questions are handled by RalphAnswerService before planning so a
        // resumable pause is never re-armed without its ralph-answer correlation payload.
        remove: BACKLOG_PAUSED_STATES.filter(has),
        add: [LABEL_READY],
      };
    case "close":
      // Destructive — `confirm: true` is already enforced at the contract edge (AC2), so a
      // plan reaching here is an affirmed close. Not a label effect: the port calls closeIssue.
      return { kind: "close" };
    case "set-mode": {
      const target = modeLabelFor(body.mode);
      return {
        kind: "labels",
        // Swap whichever mode label is present (at most one) for the chosen one.
        remove: [LABEL_MODE_TDD, LABEL_MODE_INFRA, LABEL_MODE_UI].filter(has),
        add: [target],
      };
    }
    case "set-priority": {
      // The priority must be one the operator configured for the repo — rejecting an
      // arbitrary label here keeps priority meaningful and prevents label injection from a
      // same-origin/CLI caller (the Origin guard already stops cross-site).
      if (!configuredPriorityLabels.includes(body.priority)) {
        return { kind: "bad-request", error: `priority '${body.priority}' is not a configured priority label` };
      }
      return {
        kind: "labels",
        // Swap any configured priority label present for the chosen one (so an issue never
        // carries two competing priorities).
        remove: configuredPriorityLabels.filter(has),
        add: [body.priority],
      };
    }
    case "pause":
      return {
        kind: "labels",
        // afk → hitl: the gate excludes `hitl`, so the issue is held out of admission.
        remove: [LABEL_AFK],
        add: [LABEL_HITL],
      };
    case "unpause":
      return {
        kind: "labels",
        // hitl → afk: the gate now admits it again (it still needs ready-for-agent + a mode).
        remove: [LABEL_HITL],
        add: [LABEL_AFK],
      };
  }
}
