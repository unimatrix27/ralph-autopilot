/**
 * GitHub domain types and the client interface the daemon talks through.
 *
 * GitHub is the source of truth (CONTEXT: desired state); everything the daemon
 * reads about an issue — state, labels, the `## Blocked by` graph, the closing
 * PR of a dependency — comes through {@link GitHubClient}. The concrete
 * implementation shells out to `gh`; tests use an in-memory fake.
 */

export type IssueState = "OPEN" | "CLOSED";
export type PullRequestState = "OPEN" | "CLOSED" | "MERGED";

/** A GitHub issue, reduced to the fields the gate and scheduler need. */
export interface Issue {
  number: number;
  title: string;
  body: string;
  state: IssueState;
  /** Bare label names, e.g. `ready-for-agent`, `afk`, `mode:tdd`. */
  labels: string[];
  /** ISO-8601 creation timestamp; the FIFO key for scheduling. */
  createdAt: string;
}

/**
 * A fully-qualified pointer at one issue node — `owner/repo` **plus** number.
 * Issue numbers are not unique across repos, and GitHub's native parent/sub-issue
 * graph may return cross-repository nodes, so every hierarchy/ledger surface keys
 * on this rather than a bare number (ADR-0040).
 */
export interface IssueRef {
  /** `owner/repo`, e.g. `unimatrix27/ralph-autopilot`. */
  repo: string;
  number: number;
}

/**
 * One node in GitHub's native issue hierarchy, reduced to what a *compact*
 * relationship map needs: identity, title, state — and deliberately **no body**.
 * Pass two of the context assembler fetches bodies only for the nodes it selects.
 */
export interface HierarchyNode {
  ref: IssueRef;
  /** GitHub's global node id (GraphQL `id`); stable across renames and transfers. */
  id: string;
  title: string;
  state: IssueState;
}

/**
 * Why a hierarchy node could not be read. Reported explicitly — never collapsed
 * into "this node has no parent", which would manufacture a false root (ADR-0040).
 *
 * - `deleted`      — GitHub would not resolve the node. Note GitHub deliberately
 *   answers `NOT_FOUND` for resources a token may not *see*, so this reads as
 *   "gone, or invisible to this token" — it is not proof of deletion;
 * - `unauthorized` — GitHub said so outright (`FORBIDDEN`, `Resource not
 *   accessible`, bad credentials), e.g. a SAML-protected org in a cross-repo tree;
 * - `error`        — any other read fault; fails closed the same way.
 *
 * All three are equally "not a root": the distinction exists to help a human
 * adjudicate a broken hierarchy, never to gate behaviour.
 */
export type InaccessibleReason = "deleted" | "unauthorized" | "error";

/**
 * The native parent edge of one issue. `none` is the ONLY value that means "this
 * node is an absolute root"; an unreadable parent is `inaccessible`, so a climb
 * can never mistake a permissions failure for the top of the tree.
 */
export type ParentEdge =
  | { kind: "none" }
  | { kind: "node"; node: HierarchyNode }
  | { kind: "inaccessible"; reason: InaccessibleReason; ref?: IssueRef; detail?: string };

/**
 * One native hierarchy read: the node, its parent edge, and its sub-issues. The
 * children are the *compact* listing (no bodies) that makes sibling branches
 * visible in pass one without paying to fetch them.
 */
export type HierarchyRead =
  | {
      kind: "node";
      node: HierarchyNode;
      parent: ParentEdge;
      /** The sub-issues returned; a PREFIX of all of them when `childCount` is larger. */
      children: HierarchyNode[];
      /**
       * How many sub-issues GitHub says the node has, when it reports a total. A
       * single page tops out at 100, so without this a node with more children
       * would look complete — and the compact map's `omitted` count would read 0
       * while sub-issues (and their decision records) were silently missing.
       */
      childCount?: number;
    }
  | { kind: "inaccessible"; ref: IssueRef; reason: InaccessibleReason; detail?: string };

/**
 * One (possibly cross-repo) issue's full content: the body plus its comment
 * thread. Pass two of the context assembler and the decision ledger both read
 * through this, so a cross-repo node costs the same one call as a local one.
 */
export type IssueContentRead =
  | { kind: "content"; node: HierarchyNode; body: string; comments: PrComment[] }
  | { kind: "inaccessible"; ref: IssueRef; reason: InaccessibleReason; detail?: string };

/** A pull request, reduced to the fields the executor needs to record. */
export interface PullRequest {
  number: number;
  body: string;
  /** The branch the PR is opened from, e.g. `ralph/2-core-loop`. */
  headRefName: string;
  state: PullRequestState;
}

/**
 * A comment on a PR — an issue comment or a review comment. The review agent
 * ingests these (Codex, `@claude`, etc.) into its worklist (DESIGN §4); the
 * daemon never *waits* on them, it folds in whatever is already present.
 */
export interface PrComment {
  id: number;
  /** Login of the comment's author, e.g. `chatgpt-codex-connector`. */
  author: string;
  body: string;
}

/** How a PR is merged. The daemon always squashes (DESIGN §5 / ADR-0014). */
export type MergeMethod = "squash" | "merge" | "rebase";

/**
 * The terminal verdict of a PR's CI checks (issue #41):
 * - `green`  — every check reached a terminal pass/skip state;
 * - `red`    — at least one check failed/was cancelled (`failures` names them);
 * - `none`   — the repo reports no checks at all (a no-op on the dogfood repo);
 * - `timeout`— checks never reached a terminal state within the CI timeout.
 */
export type CheckState = "green" | "red" | "none" | "timeout";

/** The outcome of awaiting a PR's CI: the verdict plus the failing check names. */
export interface ChecksResult {
  state: CheckState;
  /** Names of the failing (or, on timeout, still-pending) checks; empty otherwise. */
  failures: string[];
}

/**
 * A single, non-blocking snapshot of a PR's CI — what one `gh pr checks` read sees
 * right now, with no polling (issue #88 / ADR-0022). Unlike {@link ChecksResult} it
 * carries `pending` (checks still running): the off-slot CI poller reads one snapshot
 * per parked run per tick and decides whether to keep waiting (`pending`, under the
 * CI-timeout budget), advance (`green` / `none` / `red`), or time out (`pending`
 * beyond the budget). There is no `timeout` here — that verdict is a function of how
 * long the run has been parked, which the poller (not a single read) decides.
 */
export interface ChecksSnapshot {
  state: "green" | "red" | "none" | "pending";
  /** Names of the failing checks (`red`) or the still-running ones (`pending`); empty otherwise. */
  failures: string[];
}

/**
 * GitHub's computed merge-state for a PR (GraphQL `mergeStateStatus`) — the
 * AUTHORITATIVE "will branch protection let this PR merge right now?" signal. Unlike
 * `gh pr checks` (which reads raw check runs and can miss a required check GitHub has
 * re-queued as EXPECTED after a force-push), this reflects required-status-check state
 * directly. The rebase-aware merge polls it to a mergeable value before firing
 * `gh pr merge`, so a required check re-queued by the pre-merge force-push is waited
 * out rather than raced into a rejection (the merge-race that false-terminalizes a good
 * PR to `agent-stuck` with the PR auto-closed, issue #25).
 *
 * - `CLEAN`     — mergeable; all required checks passed and the branch is current.
 * - `UNSTABLE`  — mergeable; only NON-required checks are failing/pending.
 * - `HAS_HOOKS` — mergeable; pre-receive hooks are configured and pass.
 * - `BLOCKED`   — a REQUIRED check is pending/failing, or a required review is missing.
 * - `BEHIND`    — the head is behind the base and must be updated first.
 * - `DIRTY`     — the PR has a merge conflict with the base.
 * - `DRAFT`     — the PR is a draft and cannot merge.
 * - `UNKNOWN`   — GitHub has not finished (re)computing mergeability (e.g. just pushed).
 */
export type MergeStateStatus =
  | "CLEAN"
  | "UNSTABLE"
  | "HAS_HOOKS"
  | "BLOCKED"
  | "BEHIND"
  | "DIRTY"
  | "DRAFT"
  | "UNKNOWN";

/** A single, non-blocking read of a PR's {@link MergeStateStatus}. */
export interface MergeStatusSnapshot {
  state: MergeStateStatus;
}

/** Bounds for {@link GitHubClient.awaitChecks}: how long to wait and how often to poll. */
export interface AwaitChecksOptions {
  /** Give up (→ `timeout`) after this many minutes without a terminal verdict. */
  ciTimeoutMinutes: number;
  /** Seconds between polls of `gh pr checks`. */
  pollIntervalSeconds: number;
}

/** Options for the harness-owned direct merge (issue #41 / ADR-0014). */
export interface MergeOptions {
  /** Merge strategy; the daemon squashes by default. */
  method: MergeMethod;
  /** Delete the head branch after merging. */
  deleteBranch: boolean;
}

/** The title and body used when opening a draft PR to checkpoint WIP. */
export interface DraftPullRequest {
  title: string;
  body: string;
}

/**
 * Creation metadata for a label the daemon may need to self-create on a target
 * repo that has not pre-created it. Supplied by the label's owner (the module
 * that defines the label constant) so the GitHub adapter carries no per-label
 * knowledge; absent, the adapter self-creates with neutral defaults.
 */
export interface LabelCreateOptions {
  /** Hex color (no leading `#`) for the label if it must be self-created. */
  color: string;
  /** Human-readable description for the label if it must be self-created. */
  description: string;
}

/**
 * One issue-label mutation expressed as a patch. Removes and adds are carried
 * together so adapters that can apply them in one backend operation do so, while
 * retaining the same idempotent semantics as {@link removeLabel} / {@link addLabel}.
 */
export interface LabelPatch {
  /** Labels to remove; an absent label is a no-op. */
  remove: readonly string[];
  /**
   * Labels to add; an already-present label is a no-op. A missing repo label is
   * self-created by the adapter with neutral defaults before retrying the patch.
   */
  add: readonly string[];
}

/**
 * The daemon's window onto GitHub. Every method is async (the real client makes
 * network calls). Implementations must never echo secrets.
 */
export interface GitHubClient {
  /** All open issues in the target repo, with labels and bodies. */
  listOpenIssues(): Promise<Issue[]>;

  /** A single issue by number, or `null` if it does not exist. */
  getIssue(issueNumber: number): Promise<Issue | null>;

  /** Remove a label from an issue. A no-op if the label is absent. */
  removeLabel(issueNumber: number, label: string): Promise<void>;

  /**
   * Add a label to an issue. A no-op if already present. If the label does not
   * exist in the repo, the adapter self-creates it (using `opts` for color and
   * description when given, neutral defaults otherwise) and retries.
   */
  addLabel(issueNumber: number, label: string, opts?: LabelCreateOptions): Promise<void>;

  /**
   * Apply one remove/add label patch to an issue. A no-op if a removed label is
   * absent; added labels reuse the adapter's self-create-on-missing semantics.
   */
  applyLabelPatch(issueNumber: number, patch: LabelPatch): Promise<void>;

  /** The PR opened from `branch`, or `null` if none exists. */
  findPullRequestForBranch(branch: string): Promise<PullRequest | null>;

  /**
   * Every open pull request in the target repo. Used at startup to re-derive
   * in-flight runs from the PRs carrying a `<!-- ralph-launch: … -->` marker when
   * the SQLite store was lost (DESIGN §1/§7, ADR-0003) — GitHub is the source of
   * truth, the store is rebuildable.
   */
  listOpenPullRequests(): Promise<PullRequest[]>;

  /**
   * Comments already present on a PR — the automated review bots' findings the
   * review agent ingests opportunistically (never waited on).
   */
  listPullRequestComments(prNumber: number): Promise<PrComment[]>;

  /**
   * Comments on an issue, oldest first. The `ralph-answer` CLI reads back the
   * `ralph-question` / `ralph-answer` thread this way — GitHub is the whole wire,
   * no SQLite (ADR-0007).
   */
  listIssueComments(issueNumber: number): Promise<PrComment[]>;

  /** Post a comment on an issue/PR (a `ralph-question` or heal-card); resolve its id. */
  postComment(issueNumber: number, body: string): Promise<{ id: number }>;

  /**
   * Edit an existing issue/PR comment in place by its numeric REST id. Used to keep
   * **one rolling `ralph-review` comment per phase** current as fix attempts resolve
   * items, rather than posting one comment per iteration — and so a phase that
   * reviews twice (build review + integration re-review, ADR-0017) converges on the
   * one comment instead of duplicating it (issue #47). The `id` is the REST comment
   * id {@link postComment} resolves and the comment listings derive from each
   * comment's URL.
   */
  updateComment(commentId: number, body: string): Promise<void>;

  /**
   * Ensure a (draft) PR exists for `branch`, creating one if absent. Used to
   * checkpoint an agent's WIP on `escalate` so the work is durable in GitHub
   * before the slot frees (DESIGN §6). Returns the existing or new PR.
   */
  ensureDraftPullRequest(branch: string, draft: DraftPullRequest): Promise<PullRequest>;

  /**
   * Poll a PR's CI until every check reaches a terminal state, then report the
   * verdict (issue #41 / ADR-0014). The harness owns the CI gate: it awaits CI
   * *before* review (Phase 0) and again before a rebase-aware merge. A repo with
   * no checks resolves immediately to `none`.
   */
  awaitChecks(prNumber: number, opts: AwaitChecksOptions): Promise<ChecksResult>;

  /**
   * Read a PR's CI checks ONCE, without polling, and report the current snapshot
   * (issue #88 / ADR-0022). The lean read the off-slot CI poller makes for each
   * parked `awaiting-ci` run each tick — at most one `gh pr checks` per run per tick,
   * so a backlog of parked runs cannot stampede the GitHub rate limit. A repo with no
   * checks resolves to `none`; checks still running resolve to `pending` (the poller,
   * not this read, maps a persistent `pending` to a timeout).
   */
  readChecks(prNumber: number): Promise<ChecksSnapshot>;

  /**
   * Read a PR's GitHub-computed merge state ONCE, without polling (issue #25). The
   * authoritative "will branch protection let this merge now?" signal, keyed on
   * required-status-check state — the rebase-aware merge polls this to a mergeable
   * state before firing `gh pr merge`, so a required check re-queued by the pre-merge
   * force-push is waited out instead of racing the merge into a BLOCKED state. `gh`
   * reports `mergeStateStatus` as `UNKNOWN` until it finishes recomputing after a push.
   */
  readMergeStatus(prNumber: number): Promise<MergeStatusSnapshot>;

  /**
   * Merge a PR directly (`gh pr merge <pr> --squash --delete-branch`): a
   * deterministic harness action, not a delegation to GitHub auto-merge. Called
   * only once the harness gate (CI-green + both review phases clean) has passed
   * (issue #41 / ADR-0014). The issue auto-closes via its `Closes #n`.
   */
  mergePullRequest(prNumber: number, opts: MergeOptions): Promise<void>;

  /**
   * Close a PR with an explanatory comment, leaving the branch intact. Used to
   * dispose of the orphaned PR a mid-run executor failure leaves behind (issue
   * #34): a run whose session threw after opening a PR terminalizes to
   * `agent-stuck`, and its dangling PR must be closed (or flagged) so it is never
   * an island — picked up, resumed, and cleaned by nothing. A no-op if already
   * closed/merged.
   */
  closePullRequest(prNumber: number, comment: string): Promise<void>;

  /**
   * Close an issue, optionally leaving an explanatory comment. The destructive arm
   * of the Tier-1 power actions (issue #114, ADR-0032): an operator steering the
   * backlog from the web control plane closes an issue they do not want worked. The
   * call site (the power-action port) confirms intent *before* calling — there is no
   * second chance once the issue is closed (the reconciler sees `state: CLOSED` next
   * tick and stops acting on it). A no-op if already closed.
   */
  closeIssue(issueNumber: number, comment?: string): Promise<void>;

  /**
   * Whether a `## Blocked by` dependency is satisfied: the referenced issue is
   * CLOSED *and* was closed by a merged PR. An open issue, or one closed
   * without a merged closing PR, is unsatisfied.
   */
  isDependencySatisfied(issueNumber: number): Promise<boolean>;

  // ---- native issue hierarchy + cross-repo nodes (ADR-0040) ---------------

  /**
   * One read of GitHub's **native** parent/sub-issue graph for `ref`: the node,
   * its parent edge, and its sub-issues — the whole of pass one's per-node cost.
   * The native graph is the only hierarchy authority; nothing here is inferred
   * from titles, labels, links, or prose. A parent this token cannot read comes
   * back as an explicit `inaccessible` edge, never as "no parent".
   */
  readIssueHierarchy(ref: IssueRef): Promise<HierarchyRead>;

  /**
   * Body + comment thread for one (possibly cross-repo) issue node. The
   * cross-repo-capable sibling of {@link getIssue} / {@link listIssueComments},
   * used by context assembly's pass two and by the decision ledger.
   */
  readIssueContent(ref: IssueRef): Promise<IssueContentRead>;

  /**
   * Post a comment on any (possibly cross-repo) issue node — how an append-only
   * `ralph-decision` record lands on the narrowest node matching its scope.
   */
  postNodeComment(ref: IssueRef, body: string): Promise<{ id: number }>;

  /**
   * Edit a comment on any (possibly cross-repo) issue node. Used for exactly one
   * thing: keeping the single derived `ralph-decision-index` comment on the
   * absolute root current. Canonical decision records are **never** edited.
   */
  updateNodeComment(ref: IssueRef, commentId: number, body: string): Promise<void>;
}
