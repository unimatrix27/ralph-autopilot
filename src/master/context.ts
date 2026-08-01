/**
 * The **master context packet** (ADR-0041, building on ADR-0040). A master session is fresh
 * every time (ADR-0008), so everything it is allowed to reason from must be assembled here,
 * once, deterministically. The packet is the difference between a master that can genuinely
 * zoom out and a worker with a bigger model.
 *
 * Four layers, each answering a question the worker could not:
 *
 *  1. **What the worker saw** — its payload, recommendation, attempted fixes, uncertainty.
 *     Carried verbatim and explicitly labelled as *evidence*: the master must reach its own
 *     conclusion, and a packet that presented the recommendation as an answer would make the
 *     master a rubber stamp (the one failure mode this slice exists to prevent).
 *  2. **What the run actually is** — issue, phase, branch, head SHA, WIP status/diff, PR and
 *     checks, fix counts, recent log events. The ground truth the worker's account is
 *     checked against.
 *  3. **Where the issue sits** — the ADR-0040 hierarchy map, the budgeted context packet over
 *     the nodes worth reading, and the inherited **active** decision ledger along the
 *     root→issue path. This is the zoom-out.
 *  4. **What has already been tried** — prior interventions for this run/phase with their
 *     resolutions, whether this failure signature is a *repeat*, and the remaining budget.
 *     Shown prominently because the loop budget is enforced mechanically either way; a master
 *     that cannot see it would propose moves the harness then silently refuses.
 *
 * Assembly is I/O at the edges behind narrow ports; every read degrades to a stated
 * diagnostic rather than failing the intervention — a master with a partial packet still
 * adjudicates better than no master at all, and it can *see* what it could not read.
 */

import { assembleContextPacket, type ContextPacket, type ContextReader } from "../hierarchy/context-packet";
import { readDecisionLedger } from "../ledger/ledger";
import type { LedgerFold, StoredDecision } from "../ledger/fold";
import { buildHierarchyMap, type HierarchyMap } from "../hierarchy/map";
import type { ChecksSnapshot, GitHubClient, Issue, IssueRef, PrComment, PullRequest } from "../github/types";
import type { RunLogEntry } from "../store/types";
import type { EscalationQuestion } from "../review/escalation";
import type { MasterBudgetVerdict } from "./budget";
import type { MasterInterventionRecord } from "./history";
import type { MasterRequestPayload } from "./request";

/** A read of the master's exclusive WIP worktree — what the branch actually holds right now. */
export interface MasterWorkspaceRead {
  /** The branch's local head SHA, or null when it could not be read. */
  headSha: string | null;
  /** `git status --short` — uncommitted work the worker left behind. */
  status: string;
  /** `git diff --stat` against the base — the shape of the change under adjudication. */
  diffStat: string;
}

/** The port that reads the WIP worktree. Injected so the assembler stays testable with no git. */
export interface MasterWorkspaceReader {
  read(worktreePath: string, branch: string, base: string): Promise<MasterWorkspaceRead>;
}

/** One thing the assembler could not read, stated rather than silently omitted. */
export interface MasterContextDiagnostic {
  what: string;
  detail: string;
}

/** The fully-assembled master context packet. */
export interface MasterContext {
  /** The repo/issue this master adjudicates. */
  ref: IssueRef;
  /** The interrupted run's correlation id and phase. */
  runId: number;
  phase: string;
  attempt: number;
  /** The worker's durable request — payload, recommendation, evidence, signature. */
  request: MasterRequestPayload;
  /** The live issue (body + labels), or null when it could not be read. */
  issue: Issue | null;
  /** The issue's comment thread, newest last. */
  issueComments: PrComment[];
  /** The checkpoint PR, or null when none exists. */
  pr: PullRequest | null;
  /** A single CI snapshot for that PR, or null when unavailable. */
  checks: ChecksSnapshot | null;
  /** Per-phase fix-attempt counts for the run (`{ 0, 1, 2 }`). */
  fixAttempts: Record<number, number>;
  /** The WIP worktree read. */
  workspace: MasterWorkspaceRead | null;
  /** Recent structured run-log events, oldest first. */
  recentEvents: RunLogEntry[];
  /** The ADR-0040 compact hierarchy map (pass one), or null when the climb failed entirely. */
  hierarchy: HierarchyMap | null;
  /** The budgeted context packet (pass two) over the nodes worth reading. */
  packet: ContextPacket | null;
  /** The inherited **active** decisions along the root→issue path, plus unresolved conflicts. */
  ledger: LedgerFold | null;
  /** Prior interventions for THIS run, oldest first. */
  priorInterventions: MasterInterventionRecord[];
  /** The loop-budget verdict governing this intervention. */
  budget: MasterBudgetVerdict;
  /**
   * The operator's answer, when this session is a **human-answer resumption** of a
   * checkpointed master (ADR-0041). Present ⇒ the master already asked a question and is
   * continuing the same numbered attempt with the reply injected.
   */
  answer: MasterHumanAnswer | null;
  /** Everything the assembler could not read. */
  diagnostics: MasterContextDiagnostic[];
}

/** The operator's reply to a master `ask-human`, injected on resumption. */
export interface MasterHumanAnswer {
  /** The question the master asked. */
  question: EscalationQuestion;
  /** The operator's resolved answer text. */
  text: string;
}

/** The ports the assembler needs. `github` covers the ADR-0040 hierarchy/ledger reads too. */
export interface MasterContextDeps {
  github: GitHubClient;
  workspace?: MasterWorkspaceReader;
  /** Recent run-log entries for the run (the daemon's own observability tier). */
  recentEvents?: (runId: number, limit: number) => RunLogEntry[];
  /** Per-phase fix-attempt counts for the run. */
  fixAttempts?: (runId: number) => Record<number, number>;
}

export interface MasterContextInput {
  repo: string;
  issueNumber: number;
  runId: number;
  phase: string;
  attempt: number;
  branch: string;
  base: string;
  worktreePath: string | null;
  prNumber: number | null;
  request: MasterRequestPayload;
  priorInterventions: MasterInterventionRecord[];
  budget: MasterBudgetVerdict;
  answer?: MasterHumanAnswer | null;
}

/** How many recent run-log events the packet carries. */
export const MASTER_RECENT_EVENT_LIMIT = 40;

/**
 * Run one read, folding any failure into a stated diagnostic and a null. The master is far
 * better served by "I could not read CI" than by an intervention that never happened.
 */
async function tolerant<T>(
  what: string,
  diagnostics: MasterContextDiagnostic[],
  read: () => Promise<T>,
): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    diagnostics.push({ what, detail: String(err) });
    return null;
  }
}

/** Assemble the master's context packet. Every read is independent and tolerant. */
export async function assembleMasterContext(
  deps: MasterContextDeps,
  input: MasterContextInput,
): Promise<MasterContext> {
  const diagnostics: MasterContextDiagnostic[] = [];
  const ref: IssueRef = { repo: input.repo, number: input.issueNumber };
  const reader = deps.github as unknown as ContextReader;

  const issue = await tolerant("issue", diagnostics, () => deps.github.getIssue(input.issueNumber));
  const issueComments =
    (await tolerant("issue-comments", diagnostics, () => deps.github.listIssueComments(input.issueNumber))) ?? [];
  const pr =
    input.prNumber !== null
      ? await tolerant("pull-request", diagnostics, () => deps.github.findPullRequestForBranch(input.branch))
      : null;
  const checks =
    pr !== null
      ? await tolerant("checks", diagnostics, () => deps.github.readChecks(pr.number))
      : null;
  const workspace =
    deps.workspace && input.worktreePath
      ? await tolerant("workspace", diagnostics, () =>
          deps.workspace!.read(input.worktreePath!, input.branch, input.base),
        )
      : null;

  // Pass one then pass two (ADR-0040): the compact map makes sibling branches visible for one
  // line's cost, and the budgeted packet pays only for the nodes it selects.
  const hierarchy = await tolerant("hierarchy", diagnostics, () => buildHierarchyMap(reader, ref));
  const packet = await tolerant("context-packet", diagnostics, () => assembleContextPacket(reader, ref));
  const ledger =
    hierarchy !== null
      ? await tolerant("decision-ledger", diagnostics, () => readDecisionLedger(reader, hierarchy))
      : null;

  return {
    ref,
    runId: input.runId,
    phase: input.phase,
    attempt: input.attempt,
    request: input.request,
    issue,
    issueComments,
    pr,
    checks,
    fixAttempts: deps.fixAttempts?.(input.runId) ?? { 0: 0, 1: 0, 2: 0 },
    workspace,
    recentEvents: deps.recentEvents?.(input.runId, MASTER_RECENT_EVENT_LIMIT) ?? [],
    hierarchy,
    packet,
    ledger,
    priorInterventions: input.priorInterventions,
    budget: input.budget,
    answer: input.answer ?? null,
    diagnostics,
  };
}

/**
 * The active decisions a master must honour — the fold along the issue's ancestor path. A
 * decision governing the issue is **binding on the master**, exactly as it is on a worker
 * (the design-authority rule does not weaken with model strength).
 */
export function activeDecisions(context: MasterContext): StoredDecision[] {
  return context.ledger?.active ?? [];
}

/**
 * Whether a decision key already has an active binding record. Publishing a *new* decision
 * for such a key would contradict standing design authority, which the master may not do
 * autonomously — it must route to `ask-human` (ADR-0041).
 */
export function hasActiveDecisionFor(context: MasterContext, key: string): boolean {
  return activeDecisions(context).some((d) => d.record.key === key);
}
