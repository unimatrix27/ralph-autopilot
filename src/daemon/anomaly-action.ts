/**
 * **What the operator must actually do** about a surfaced anomaly (issue #43).
 *
 * `daemon-anomaly` survives the triage cutover as the one operator-owned attention state, and
 * the cutover binds it to a stronger contract than it used to carry: it "must name the operator
 * action required". Before this module it did not. The reconciler recorded the bare
 * classification enum (`master-route-unconfigured`, `paused-label-missing-run`, …), the web
 * health view rendered that enum verbatim, and the one piece of genuinely actionable prose in
 * the system — {@link describeMasterRouteDefect} — was reachable only from a code path the
 * queue never took. An operator got a label and a noun.
 *
 * So the mapping lives here, once, and is **total**: an exhaustive `switch` with a `never`
 * guard, so adding a reason to {@link AnomalyReason} without an action is a compile error
 * rather than a blank line on a dashboard at 3am. Two rules shape the text:
 *
 *  1. **Imperative and concrete.** "Set `agent.tiers.\"1\".routes` … then restart the daemon",
 *     not "the master route is misconfigured". The reason already says what is wrong.
 *  2. **Never paraphrase an owner.** Where another module already owns the authoritative fix
 *     text ({@link describeMasterRouteDefect}), it is *reused*, not restated — a paraphrase is
 *     a second source of truth that drifts the moment the real one changes.
 *
 * The map is consumed at both surfaces an operator actually looks at: the `daemon-anomaly`
 * issue itself (the reconciler posts the action when it applies the label) and
 * `/api/health/usage` (`web/health-usage.ts`).
 */

import { describeMasterRouteDefect, type MasterRouteDefect } from "../master/route";
import type { AnomalyReason } from "./completeness";

/**
 * Every {@link AnomalyReason}, in declaration order — the vocabulary the tests iterate so the
 * totality of {@link operatorActionFor} is proven over data, not merely over the type. Kept
 * beside the map (rather than in `completeness.ts`) because it exists for this map's sake.
 */
export const ANOMALY_REASONS: readonly AnomalyReason[] = [
  "run-wedged-past-lifetime",
  "running-row-not-in-flight",
  "non-terminal-run-on-closed-issue",
  "paused-run-unresumable",
  "paused-run-label-missing",
  "answered-pause-stranded",
  "paused-label-missing-run",
  "master-route-unconfigured",
  "unclassified",
];

/** The two configuration defects a master route can carry; both share one config key. */
const MASTER_ROUTE_DEFECTS: readonly MasterRouteDefect[] = [
  "missing-tier-1-profile",
  "tier-1-not-tools-capable",
];

/**
 * The concrete operator action for one anomaly reason. **Total** by construction: the `switch`
 * is exhaustive and the fall-through is a `never` assertion, so the compiler enforces that a
 * new reason arrives with its action.
 *
 * Most reasons are *not* operator-owned any more (ADR-0042 routes them to a master) — but they
 * still reach an operator whenever the master door is unwired, the escalation itself fails, or
 * the daemon is running without a master engine at all, so each one still needs its answer.
 */
export function operatorActionFor(reason: AnomalyReason): string {
  switch (reason) {
    case "run-wedged-past-lifetime":
      return (
        "No action while it settles — the sweep has already killed the session and the slot frees " +
        "itself. If it is still here after two ticks, kill the run's container/process group by " +
        "hand and raise `scheduler.maxRunLifetimeMs` only if the session was legitimately long."
      );
    case "running-row-not-in-flight":
      return (
        "No action — the orphan sweep re-drives the run when its PR survives and terminalizes it " +
        "otherwise. If it persists across ticks, check that the run's PR is still OPEN and that " +
        "`gh` can read it from this box."
      );
    case "non-terminal-run-on-closed-issue":
      return (
        "Reopen the issue if the work is not actually done; otherwise no action — the sweep " +
        "terminalizes the run and prunes its worktree."
      );
    case "paused-run-unresumable":
      return (
        "The answer landed but the run's resume context is gone. Re-post the answer as a fresh " +
        "`ralph-answer` comment, or close the PR and re-label the issue `ready-for-agent` to " +
        "restart the run from scratch."
      );
    case "paused-run-label-missing":
      return (
        "A human-attention label was removed while the run was still paused. Re-add the label " +
        "matching the run's status (`awaiting-answer` or `review-maxed`), or re-label the issue " +
        "`ready-for-agent` to re-admit it."
      );
    case "answered-pause-stranded":
      return (
        "No action — this is a GitHub rate limit, not a defect: the answer is durable and the " +
        "daemon re-adds `ready-for-agent` every tick until the write lands. Adding the label by " +
        "hand only races the retry."
      );
    case "paused-label-missing-run":
      return (
        "Rehydrate could not rebuild a run for this pause, so an answer would resume nothing. " +
        "Re-label the issue `ready-for-agent` (removing the pause label) to start a fresh run, " +
        "or close it if the work is obsolete."
      );
    case "master-route-unconfigured":
      // Both defects live behind one config key, and `master/route.ts` owns the authoritative
      // text for each — reuse it verbatim rather than keeping a second copy that can drift.
      return [
        "Fix the tier-1 master route in `.ralph/config.yaml`, then restart the daemon.",
        ...MASTER_ROUTE_DEFECTS.map(describeMasterRouteDefect),
      ].join(" ");
    case "unclassified":
      return (
        "The daemon does not recognise this run's status — a corrupt store row, or a row written " +
        "by a newer build. Capture the run row, then re-label the issue `ready-for-agent` to " +
        "start a fresh run; the stale row is re-admittable and holds nothing."
      );
    default: {
      // Totality guard: a new AnomalyReason without an action fails to compile here.
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

/**
 * Recover the {@link AnomalyReason} from a *logged* reason string. Two forms are in the log:
 * the bare enum (the reconciler's completeness pass) and `"<reason>: <detail>"` (the master
 * engine's route-defect surface, which appends the authoritative fix text). Anything else — a
 * claim park's `claim-failed-after-N-attempts`, a future reason — is `null`, because guessing
 * an action for a reason this build does not know is worse than saying nothing.
 */
export function parseAnomalyReason(logged: string): AnomalyReason | null {
  const head = logged.split(":", 1)[0]?.trim() ?? "";
  return ANOMALY_REASONS.find((r) => r === head) ?? null;
}

/**
 * The operator action for a logged reason string, or `null` when the reason is outside the
 * vocabulary. A logged `": <detail>"` suffix wins: it is already the authoritative, defect-exact
 * text (the master engine logs {@link describeMasterRouteDefect} there), so it beats the generic
 * both-defects action the map has to give when only the enum is known.
 */
export function loggedAnomalyAction(logged: string): string | null {
  const reason = parseAnomalyReason(logged);
  if (!reason) {
    return null;
  }
  const separator = logged.indexOf(":");
  const detail = separator >= 0 ? logged.slice(separator + 1).trim() : "";
  return detail.length > 0 ? detail : operatorActionFor(reason);
}

/**
 * The comment the reconciler posts on an issue at the moment it applies `daemon-anomaly` — the
 * surface an operator actually reads. `detail` carries the live, defect-exact text when the
 * caller holds it (the reconciler can read the master engine's route status); `null` falls back
 * to the map.
 */
export function formatAnomalyActionComment(reason: AnomalyReason, detail: string | null): string {
  return [
    `### Daemon anomaly: \`${reason}\``,
    "",
    "The reconciler cannot classify this issue into any state it acts on, so it is parked here " +
      "rather than dropped. No agent will pick it up until this clears.",
    "",
    `**Operator action:** ${detail && detail.trim().length > 0 ? detail.trim() : operatorActionFor(reason)}`,
  ].join("\n");
}
