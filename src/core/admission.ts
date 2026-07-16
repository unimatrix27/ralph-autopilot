/**
 * Admission (CONTEXT: eligibility gate). The single decision of *which open
 * issues to launch this tick, and in what order*. One deep module behind one
 * call — {@link admit} — that folds together the three concerns the pickup
 * decision used to be sliced across:
 *
 *   1. the pure label gate (OPEN + `ready-for-agent` + `afk` + not `hitl` +
 *      not paused + not a `[log]` issue + carries a `mode:*` + every
 *      `## Blocked by` dependency satisfied — `#n`, same-repo issue URL, or
 *      `owner/repo#n`; a cross-repo ref fails closed, issue #8) — the {@link gateOne} seam, also
 *      shared by the moding/backlog synthetic-mode gate so they never re-implement it;
 *   2. the in-flight / active-run exclusions — an issue already running, or held
 *      by a still-active run row, is not admittable (a terminal `agent-stuck` /
 *      `merged` row does NOT hold it — re-labelling re-admits it for a fresh run;
 *      eligibility is from GitHub labels, never SQLite presence — ADR-0003);
 *   3. the scheduling order + slot fill (FIFO by issue age, `priority/*` label
 *      tie-break, issue number) capped at the caller's open-slot count.
 *
 * The caller injects everything `admit` needs through {@link World}: the
 * in-flight test, the run lookup, the GitHub dependency port, the open-slot
 * count (computed by the reconciler after resumes consume their slots), and the
 * operator's priority ordering. `admit` owns the per-tick dependency cache, so
 * the cache is exercised through this interface — not re-formed in the caller.
 */

import type { Issue } from "../github/types";
import type { BacklogBlockerRef, Mode, Run, RunStatus } from "../store/types";
import type { PickedIssue } from "../executor/executor";
import { parseBlockedBy } from "../github/blocked";
import { isPausedLabel, LABEL_AFK, LABEL_HITL, LABEL_READY, LOG_LABEL_PREFIX, readMode } from "./labels";

/**
 * Run statuses that no longer hold their issue: a terminal-status row plus a
 * fresh `ready-for-agent` re-admits the issue for a new run (`upsertRun` resets
 * it). Active/paused statuses (`running`, `awaiting-answer`, `review-maxed`)
 * still hold it — `running` is in flight, the paused ones resume via the answer
 * path, never as a fresh impl. `closed` (issue #81) is an effect-neutral terminal
 * like `merged` — the run is done with its branch — so it joins the set. This is
 * admission policy; the reconciler aliases it for branch-pruning so re-admission
 * can never desync from "done with branch".
 */
export const RE_ADMITTABLE_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "agent-stuck",
  "merged",
  "closed",
]);

/**
 * The strict subset of {@link RE_ADMITTABLE_STATUSES} whose run **span is already
 * closed** — a `RunEnded` fact exists (`merged`, plus the effect-neutral `closed`,
 * issue #81). `agent-stuck` is the one re-admittable status whose span is still
 * OPEN: `RunStuck` pins the status but closes no span (issue #274), so it is the
 * sole member of that set excluded here. Derived — not re-literalled — as
 * {@link RE_ADMITTABLE_STATUSES} minus that single named exception, so the "strict
 * subset" claim is executable, `agent-stuck` is the one explicitly-named span-open
 * exclusion, and any future span-ended terminal added above auto-joins this set.
 * The span-closed / span-open distinction (the crux of #274) can never drift;
 * wrapped by {@link import("../daemon/completeness").isSpanClosed}.
 */
export const SPAN_CLOSED_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(
  [...RE_ADMITTABLE_STATUSES].filter((s) => s !== "agent-stuck"),
);

/**
 * Why an issue was dropped from a launch plan. The pure gate reasons
 * (`not-open` … `blocked`) plus the runtime exclusions `admit` owns:
 * `in-flight` (already executing), `held` (an active run row holds it), and
 * `no-provider` (otherwise-[[eligible]] but no allowed provider has a headroom
 * account this tick — a **wait, not a stuck**: it keeps `ready-for-agent`, takes
 * no human-attention label, and is re-resolved next tick; ADR-0037).
 */
export type ExclusionReason = GateReason | "in-flight" | "held" | "no-provider";

/**
 * An issue `admit` dropped, with the reason it was not launchable. A
 * discriminated union on `reason` mirroring {@link GateResult}: the `blocked`
 * variant carries every `## Blocked by` ref with whether it is satisfied, so the
 * web read model can show *which* dependency is unmet (issue #20) without
 * re-resolving it through GitHub; every other reason carries no blockers. The
 * ref/satisfaction pair is the {@link BacklogBlockerRef} the snapshot persists —
 * one canonical type, so `projectBacklog` carries it through without a copy.
 */
export type ExcludedIssue =
  | { issue: Issue; reason: Exclude<ExclusionReason, "blocked"> }
  | { issue: Issue; reason: "blocked"; blockers: BacklogBlockerRef[] };

/**
 * The output of {@link admit}: the ordered, slot-capped issues to launch, the
 * full ordered eligible queue (uncapped — what the web control plane shows as
 * *waiting*), plus every dropped issue with its reason (for logging and the read model).
 */
export interface LaunchPlan {
  /** Ordered, length ≤ `world.openSlots` — the issues to launch this tick. */
  picked: PickedIssue[];
  /**
   * Every gate-passing, not-held issue in scheduler pick-order, *before* the
   * slot cap — the backlog the web control plane renders. `picked` is its first `openSlots`.
   */
  eligible: PickedIssue[];
  /** Every non-eligible issue and why it was dropped. */
  excluded: ExcludedIssue[];
}

/**
 * Everything {@link admit} needs, injected by the caller. The reconciler wires
 * these to its in-flight Map, the SQLite store, the GitHub client, the open-slot
 * count it computes after resumes, and the operator's priority labels.
 */
export interface World {
  /** Whether an issue is already executing — the reconciler's in-flight Map. */
  isInFlight: (issueNumber: number) => boolean;
  /** The run row for an issue, or `undefined` — `store.getRunByIssue`. */
  getRun: (issueNumber: number) => Run | undefined;
  /** Whether a `## Blocked by` dependency is satisfied (CLOSED + merged PR). */
  isDependencySatisfied: (issueNumber: number) => Promise<boolean>;
  /** Slots free this tick, after resumes consumed theirs (computed by the caller). */
  openSlots: number;
  /** The operator's priority labels, most-urgent first, for the ordering tie-break. */
  priorityLabels: string[];
  /**
   * Whether a fresh impl launch can resolve a route this tick — i.e. some allowed
   * provider in the `impl` type's preference list has an account with headroom
   * (ADR-0037 route resolution; CONTEXT: no-provider). Route resolution for a fresh
   * launch is issue-independent (it depends only on `(repo, type)` + the per-provider
   * meter), so admission folds in a single per-tick verdict rather than routing each
   * issue. When `false` — every allowed pool is gated — the otherwise-eligible queue
   * does not launch this tick: each issue is excluded with reason `no-provider`, a
   * **wait, not a stuck** (no escalation, no human-attention label), and the next tick
   * re-resolves and admits them automatically once a pool regains headroom. A thunk so
   * `admit` evaluates it lazily — only when something is eligible — so a quiet tick
   * never probes the meter. The reconciler backs it with `resolveRoute(…, "impl", …)`.
   */
  hasImplProviderHeadroom: () => boolean;
  /**
   * The `owner/repo` slug this reconciler works. Scopes the `## Blocked by` parse
   * (issue #8): URL / `owner/repo#n` references to this repo gate as local issue
   * numbers; references to any other repo cannot be evaluated and fail closed.
   */
  repo: string;
}

/** Why the pure label gate rejected an issue (the {@link gateOne} seam). */
type GateReason =
  | "not-open"
  | "not-ready"
  | "not-afk"
  | "hitl"
  | "paused"
  | "log-issue"
  | "no-mode"
  | "blocked";

export type GateResult =
  | { eligible: true; mode: Mode }
  | { eligible: false; reason: Exclude<GateReason, "blocked"> }
  | { eligible: false; reason: "blocked"; blockers: BacklogBlockerRef[] };

/**
 * Wrap an async `## Blocked by` dependency-satisfaction lookup in a per-pass memo
 * so each distinct ref is resolved at most once. The three pass-level callers that
 * resolve deps over a set of issues — {@link admit}, the moding-candidate select,
 * and the backlog projection — all build their resolver through this one factory,
 * so the cache shape can never drift between them.
 */
export function createDepCache(
  isDependencySatisfied: (issueNumber: number) => Promise<boolean>,
): (issueNumber: number) => Promise<boolean> {
  const cache = new Map<number, boolean>();
  return async (n: number): Promise<boolean> => {
    const cached = cache.get(n);
    if (cached !== undefined) {
      return cached;
    }
    const satisfied = await isDependencySatisfied(n);
    cache.set(n, satisfied);
    return satisfied;
  };
}

/**
 * Decide which open issues to launch this tick and in what order.
 *
 * Each issue is tested cheapest-first: the in-flight and active-run exclusions
 * and the synchronous label checks before any GitHub call. A `## Blocked by`
 * dependency is resolved through {@link World.isDependencySatisfied} only when an
 * issue survives those checks and reaches the blocked-by test (lazy), and every
 * distinct blocker is resolved at most once per call (cached). Survivors are
 * ordered (FIFO by age, `priority/*` tie-break, issue number) and the first
 * `openSlots` of them are picked.
 */
export async function admit(issues: Issue[], world: World): Promise<LaunchPlan> {
  // Resolve each distinct `## Blocked by` dependency at most once per tick.
  const resolveDep = createDepCache(world.isDependencySatisfied);

  const eligible: PickedIssue[] = [];
  const excluded: ExcludedIssue[] = [];

  for (const issue of issues) {
    // Skip issues already in flight or held by a still-active run before any
    // gate work — a terminal run row does not hold the issue (ADR-0003).
    if (world.isInFlight(issue.number)) {
      excluded.push({ issue, reason: "in-flight" });
      continue;
    }
    const run = world.getRun(issue.number);
    if (run && !RE_ADMITTABLE_STATUSES.has(run.status)) {
      excluded.push({ issue, reason: "held" });
      continue;
    }
    const verdict = await gateOne(issue, resolveDep, world.repo);
    if (verdict.eligible) {
      eligible.push({ issue, mode: verdict.mode });
    } else if (verdict.reason === "blocked") {
      excluded.push({ issue, reason: "blocked", blockers: verdict.blockers });
    } else {
      excluded.push({ issue, reason: verdict.reason });
    }
  }

  // Order once (FIFO by age, `priority/*` tie-break, issue number): the read model
  // exposes the whole eligible queue, the launcher takes its first `openSlots`.
  const ordered = [...eligible].sort((a, b) => compare(a.issue, b.issue, world.priorityLabels));

  // No allowed provider has a headroom account → a wait, not a stuck (CONTEXT:
  // no-provider, ADR-0037). Route resolution for a fresh impl launch is
  // issue-independent, so when it yields no route the whole otherwise-eligible queue
  // waits together: launch nothing, and exclude each issue with reason `no-provider`
  // (it keeps `ready-for-agent`, takes no human-attention label — never escalated).
  // The next tick re-resolves and admits them automatically once a pool regains
  // headroom. Checked only when something is eligible (lazy `&&`) so a quiet tick
  // never probes the meter; the per-provider-pool generalisation of ADR-0028's pause.
  if (ordered.length > 0 && !world.hasImplProviderHeadroom()) {
    for (const candidate of ordered) {
      excluded.push({ issue: candidate.issue, reason: "no-provider" });
    }
    return { picked: [], eligible: [], excluded };
  }

  const slots = Math.max(0, world.openSlots);
  return { picked: ordered.slice(0, slots), eligible: ordered, excluded };
}

/**
 * The synchronous, label-only portion of the gate — every cheap check that needs
 * no GitHub call. `{ eligible: true }` here means "passed the labels, pending the
 * `## Blocked by` dependency check"; the two callers ({@link gateOne}, the lazy
 * async path `admit` uses, and {@link evaluateGate}, the sync predicate the
 * completeness pass uses) each finish with their own blocked-by loop. Per DESIGN
 * §2 / ADR-0006 the mode is read from the label.
 */
function gateLabels(issue: Issue): GateResult {
  const labels = issue.labels;

  if (issue.state !== "OPEN") {
    return { eligible: false, reason: "not-open" };
  }
  if (!labels.includes(LABEL_READY)) {
    return { eligible: false, reason: "not-ready" };
  }
  if (!labels.includes(LABEL_AFK)) {
    return { eligible: false, reason: "not-afk" };
  }
  if (labels.includes(LABEL_HITL)) {
    return { eligible: false, reason: "hitl" };
  }
  if (labels.some(isPausedLabel)) {
    return { eligible: false, reason: "paused" };
  }
  if (labels.some((l) => l.startsWith(LOG_LABEL_PREFIX))) {
    return { eligible: false, reason: "log-issue" };
  }

  const mode = readMode(labels);
  if (mode === null) {
    return { eligible: false, reason: "no-mode" };
  }

  return { eligible: true, mode };
}

/**
 * Fold resolved blockers into a final verdict, shared by both gate finishers so
 * the `{ eligible: false, reason: "blocked", blockers }` literal lives once: if
 * any blocker is unsatisfied the issue is `blocked` (carrying every ref + its
 * satisfaction, so the read model can show *which* dependency is unmet — issue #20),
 * otherwise the passed-through label verdict. Empty blockers → `[].some()` is
 * false → `pass`, so callers need no `refs.length > 0` guard.
 */
function blockedVerdict(blockers: BacklogBlockerRef[], pass: GateResult): GateResult {
  return blockers.some((b) => !b.satisfied) ? { eligible: false, reason: "blocked", blockers } : pass;
}

/**
 * Append each cross-repo `## Blocked by` ref as an unsatisfiable blocker: a
 * dependency the gate cannot evaluate fails CLOSED (issue #8) — mirroring the
 * failed-query rule in `GhCliClient.isDependencySatisfied` — so the issue is
 * excluded as `blocked` with the verbatim ref visible in the read model, never
 * launched past a prerequisite the gate could not check. Shared by both gate
 * finishers so the fail-closed rule lives once.
 */
function withCrossRepoBlockers(blockers: BacklogBlockerRef[], crossRepo: string[]): BacklogBlockerRef[] {
  return [...blockers, ...crossRepo.map((ref) => ({ ref, satisfied: false }))];
}

/**
 * The pure label gate — admit's async gate finisher, and the canonical seam the
 * moding/backlog synthetic-mode gate ({@link import("./moding").gateWithSyntheticMode})
 * delegates to, so neither hand-rolls the parse→resolve dance. Cheap synchronous
 * checks first, so a blocker is resolved (the only async, GitHub-touching step)
 * only when an issue is otherwise eligible and reaches the `## Blocked by` test.
 * Every `## Blocked by` ref is resolved (cached across the tick) so the read model can
 * show each one's status; the issue is blocked if any is unsatisfied. `repo` scopes the
 * parse (issue #8): refs may be `#n`, a same-repo issue URL, or `owner/repo#n`, and a
 * cross-repo ref joins the blockers unsatisfiable ({@link withCrossRepoBlockers}).
 */
export async function gateOne(
  issue: Issue,
  resolveDep: (n: number) => Promise<boolean>,
  repo: string,
): Promise<GateResult> {
  const labelVerdict = gateLabels(issue);
  if (!labelVerdict.eligible) {
    return labelVerdict;
  }
  const parsed = parseBlockedBy(issue.body, repo);
  const blockers: BacklogBlockerRef[] = [];
  for (const ref of parsed.refs) {
    blockers.push({ ref, satisfied: await resolveDep(ref) });
  }
  return blockedVerdict(withCrossRepoBlockers(blockers, parsed.crossRepo), labelVerdict);
}

/**
 * The eligibility gate as a pure, **synchronous** predicate — the same rules
 * {@link admit} applies, with the `## Blocked by` dependencies pre-resolved by the
 * caller into a sync lookup. Exposed for the completeness pass (issue #27), which
 * classifies every open issue each tick and needs to know whether the gate would
 * admit it. The single source of gate logic is {@link gateLabels} and the verdict
 * fold is {@link blockedVerdict}, both shared with the lazy async path; only the
 * blocked-by *resolution* (a sync map here vs the async loop there) differs.
 */
export function evaluateGate(issue: Issue, isDependencySatisfied: (n: number) => boolean, repo: string): GateResult {
  const labelVerdict = gateLabels(issue);
  if (!labelVerdict.eligible) {
    return labelVerdict;
  }
  const parsed = parseBlockedBy(issue.body, repo);
  const blockers = withCrossRepoBlockers(
    parsed.refs.map((ref) => ({ ref, satisfied: isDependencySatisfied(ref) })),
    parsed.crossRepo,
  );
  return blockedVerdict(blockers, labelVerdict);
}

/**
 * The priority rank of an issue: the index of its highest-priority label in the
 * operator's ordered `priorityLabels` list (lower = more urgent). An issue with
 * no priority label ranks last.
 */
function priorityRank(labels: string[], priorityLabels: string[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const label of labels) {
    const idx = priorityLabels.indexOf(label);
    if (idx !== -1 && idx < best) {
      best = idx;
    }
  }
  return best;
}

/**
 * The issue's priority as a 0-based rank in the operator's `priorityLabels` list
 * (0 = most urgent), or `null` when the issue carries no priority label. Exposes
 * the rank {@link priorityRank} selects so display layers (issue #20's backlog
 * colour and priority tag) bucket and label by the same ordering the scheduler
 * ranks by — one priority model. The label form is `priorityLabels[rank]`.
 */
export function priorityRankOf(labels: string[], priorityLabels: string[]): number | null {
  const rank = priorityRank(labels, priorityLabels);
  return rank === Number.POSITIVE_INFINITY ? null : rank;
}

/** Scheduling order (DESIGN §2): FIFO by age, `priority/*` tie-break, issue number. */
function compare(a: Issue, b: Issue, priorityLabels: string[]): number {
  // 1. FIFO by age: older issue first.
  if (a.createdAt < b.createdAt) return -1;
  if (a.createdAt > b.createdAt) return 1;
  // 2. Tie-break by priority label.
  const pa = priorityRank(a.labels, priorityLabels);
  const pb = priorityRank(b.labels, priorityLabels);
  if (pa !== pb) return pa - pb;
  // 3. Final stable tie-break by issue number.
  return a.number - b.number;
}
