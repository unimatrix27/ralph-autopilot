/**
 * {@link GitHubClient} backed by the `gh` CLI, which carries the box's GitHub
 * auth. Read paths request explicit `--json` field sets; write paths edit
 * labels. Output is parsed structurally — never scraped — and secrets are never
 * logged (gh reads its own token from the keyring).
 *
 * Exercised against real GitHub during the pilot; the in-memory
 * {@link import("../testing/fake-github").FakeGitHub} stands in for unit tests.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { createLogger, type Logger } from "../log/logger";
import { splitRepo } from "./ref";
import type {
  AwaitChecksOptions,
  ChecksResult,
  ChecksSnapshot,
  DraftPullRequest,
  GitHubClient,
  HierarchyNode,
  HierarchyRead,
  InaccessibleReason,
  Issue,
  IssueContentRead,
  IssueRef,
  IssueState,
  LabelPatch,
  LabelCreateOptions,
  MergeOptions,
  MergeStateStatus,
  MergeStatusSnapshot,
  ParentEdge,
  PrComment,
  PullRequest,
  PullRequestReviewDecision,
  PullRequestState,
  ReviewThread,
  ReviewThreadComment,
  ReviewThreadsRead,
} from "./types";

const execFileAsync = promisify(execFile);

/**
 * A single check row as returned by `gh pr checks --json
 * name,state,bucket,startedAt,completedAt`. The timestamps let {@link classifyChecks}
 * collapse multiple runs of the same check name to the latest (issue #125).
 */
export interface RawCheck {
  name?: string;
  state?: string;
  /** gh's normalised bucket: `pass` | `fail` | `pending` | `skipping` | `cancel`. */
  bucket?: string;
  /** ISO-8601 start time of this run (gh may emit `""` or a zero time before it starts). */
  startedAt?: string;
  /** ISO-8601 completion time of this run (absent / zero while still running). */
  completedAt?: string;
}

/** Buckets that mean a check has reached a terminal state (no longer running). */
const TERMINAL_BUCKETS = new Set(["pass", "fail", "skipping", "cancel"]);
/** Terminal buckets that mean the check did not pass. */
const FAILING_BUCKETS = new Set(["fail", "cancel"]);

const UNNAMED_CHECK = "(unnamed check)";

/**
 * Whether `ts` is a real timestamp gh actually reports for a run that started, vs the
 * zero time (`0001-01-01T00:00:00Z`) / empty string it emits for a run that has not
 * started or completed yet. A zero/empty time carries no ordering information.
 */
function isRealTimestamp(ts: string | undefined): ts is string {
  return ts !== undefined && ts.length > 0 && !ts.startsWith("0001-01-01");
}

/**
 * A run's recency key: the latest real timestamp it carries (started or completed).
 * ISO-8601 strings sort lexicographically in chronological order, so a re-run — which
 * starts (and completes) after the run it supersedes — has the greater key. Runs with
 * no usable timestamp share the empty key (ordered only by appearance).
 */
function checkRecency(c: RawCheck): string {
  let key = "";
  for (const ts of [c.startedAt, c.completedAt]) {
    if (isRealTimestamp(ts) && ts > key) {
      key = ts;
    }
  }
  return key;
}

/**
 * Collapse multiple runs of the same check name to the **latest** run (issue #125).
 * A check name can carry a failed run *and* a passing re-run (a re-run on the live
 * sha, or a manual retry); only the most recent run reflects the check's current
 * state. Counting a stale failure while a passing re-run of the same name exists is
 * the example-monorepo #2113 defect — the gate maxed on a prior `.NET Tests` red while the
 * live-sha run was green. Latest wins both ways: a passing re-run supersedes an
 * earlier failure, and a fresh failure supersedes a stale pass (a real regression is
 * still caught). Ties (no usable timestamps) keep the last occurrence — deterministic.
 */
function latestRunPerName(checks: RawCheck[]): RawCheck[] {
  const latest = new Map<string, RawCheck>();
  for (const c of checks) {
    const name = c.name ?? UNNAMED_CHECK;
    const prev = latest.get(name);
    if (!prev || checkRecency(c) >= checkRecency(prev)) {
      latest.set(name, c);
    }
  }
  return [...latest.values()];
}

/**
 * Classify one snapshot of a PR's checks into a CI verdict (pure, so it is unit
 * tested directly). Multiple runs of the same check name are first collapsed to the
 * latest run ({@link latestRunPerName}), so a passing re-run supersedes an earlier
 * failure of the same name (issue #125). Returns `pending` while any (latest) check
 * is still running — including an external commit-status context that never reports —
 * so the poller keeps waiting; the caller maps a persistent `pending` to `timeout`. A
 * never-completing `pending` is therefore "keep waiting", never a hard red.
 */
export function classifyChecks(
  checks: RawCheck[],
): { verdict: "green" | "red" | "none" | "pending"; failures: string[] } {
  if (checks.length === 0) {
    return { verdict: "none", failures: [] };
  }
  const latest = latestRunPerName(checks);
  const pending = latest.filter((c) => !TERMINAL_BUCKETS.has(c.bucket ?? "pending"));
  if (pending.length > 0) {
    return { verdict: "pending", failures: pending.map((c) => c.name ?? UNNAMED_CHECK) };
  }
  const failures = latest
    .filter((c) => FAILING_BUCKETS.has(c.bucket ?? ""))
    .map((c) => c.name ?? UNNAMED_CHECK);
  return failures.length > 0
    ? { verdict: "red", failures }
    : { verdict: "green", failures: [] };
}

/** The `mergeStateStatus` values GitHub reports, upper-cased; anything else → UNKNOWN. */
const MERGE_STATE_STATUSES = new Set<MergeStateStatus>([
  "CLEAN",
  "UNSTABLE",
  "HAS_HOOKS",
  "BLOCKED",
  "BEHIND",
  "DIRTY",
  "DRAFT",
  "UNKNOWN",
]);

/**
 * Parse the `mergeStateStatus` out of a `gh pr view --json mergeStateStatus` payload
 * (pure, so it is unit tested directly). An empty read, unparseable JSON, a missing
 * field, or an unrecognised value all map to `UNKNOWN` — "GitHub has not settled" —
 * so the merge-readiness poll keeps waiting rather than treating a blank as mergeable.
 */
export function parseMergeStateStatus(out: string): MergeStateStatus {
  if (out.trim().length === 0) {
    return "UNKNOWN";
  }
  let raw: string;
  try {
    raw = String((JSON.parse(out) as { mergeStateStatus?: unknown }).mergeStateStatus ?? "").toUpperCase();
  } catch {
    return "UNKNOWN";
  }
  return MERGE_STATE_STATUSES.has(raw as MergeStateStatus) ? (raw as MergeStateStatus) : "UNKNOWN";
}

/**
 * Parse the full merge-status payload — `mergeStateStatus` plus the two fields that turn an
 * opaque `BLOCKED` into a typed cause (issue #43): the human-review verdict and the head SHA
 * every hosted-review observation is anchored to. Tolerant: a missing/unparseable field is
 * `null` ("unknown"), never a value that would read as "satisfied".
 */
export function parseMergeStatusSnapshot(out: string): MergeStatusSnapshot {
  const state = parseMergeStateStatus(out);
  let reviewDecision: PullRequestReviewDecision | null = null;
  let headSha: string | null = null;
  try {
    const raw = JSON.parse(out) as { reviewDecision?: unknown; headRefOid?: unknown };
    const decision = String(raw.reviewDecision ?? "").toUpperCase();
    if (decision === "APPROVED" || decision === "CHANGES_REQUESTED" || decision === "REVIEW_REQUIRED") {
      reviewDecision = decision;
    }
    if (typeof raw.headRefOid === "string" && raw.headRefOid.length > 0) {
      headSha = raw.headRefOid;
    }
  } catch {
    // Fall through with the nulls: `state` above is already the tolerant read.
  }
  return { state, reviewDecision, headSha };
}

// ── review threads (issue #43) ───────────────────────────────────────────────

/** How many review threads one GraphQL page requests. */
const REVIEW_THREAD_PAGE_SIZE = 50;
/** How many comments per thread one page requests (a thread is rarely deep). */
const REVIEW_THREAD_COMMENT_PAGE_SIZE = 30;
/**
 * Hard cap on pages, so a pathological PR cannot spin the reader forever. Exported so the
 * fake models the same bound — a cap that only the real adapter enforces is a cap the tests
 * cannot see (issue #43).
 */
export const REVIEW_THREAD_MAX_PAGES = 20;

/**
 * The thread-aware read the hosted-review gate needs. Flat issue/review comments carry no
 * thread identity, no `isResolved`/`isOutdated` and no resolver, and the repository ruleset
 * that blocks the merge is keyed on exactly those — so this is GraphQL, not REST.
 */
const REVIEW_THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$first:Int!,$comments:Int!,$after:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      headRefOid
      reviewThreads(first:$first,after:$after){
        pageInfo{ hasNextPage endCursor }
        nodes{
          id isResolved isOutdated path line diffSide
          resolvedBy{ login }
          comments(first:$comments){
            nodes{
              id databaseId body createdAt
              originalCommit{ oid }
              commit{ oid }
              author{ login __typename }
            }
          }
        }
      }
    }
  }
}`;

const RESOLVE_THREAD_MUTATION = `mutation($threadId:ID!){
  resolveReviewThread(input:{threadId:$threadId}){ thread{ id isResolved } }
}`;

const REPLY_THREAD_MUTATION = `mutation($threadId:ID!,$body:String!){
  addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){
    comment{ id }
  }
}`;

/** Whether a gh failure names missing GraphQL scopes/permissions rather than a transient fault. */
export function isPermissionError(err: unknown): boolean {
  const text = `${(err as { stderr?: string } | null)?.stderr ?? ""} ${String(err)}`.toLowerCase();
  return (
    text.includes("resource not accessible") ||
    text.includes("must have push access") ||
    text.includes("insufficient scope") ||
    text.includes("requires authentication") ||
    text.includes("forbidden") ||
    text.includes("not authorized")
  );
}

/**
 * Parse one page of the review-threads response into the port's shape. Exported so the
 * adapter contract is testable against recorded GraphQL payloads with no network.
 */
export function parseReviewThreadsPage(out: string): {
  threads: ReviewThread[];
  headSha: string | null;
  hasNextPage: boolean;
  endCursor: string | null;
} {
  const empty = { threads: [] as ReviewThread[], headSha: null, hasNextPage: false, endCursor: null };
  if (out.trim().length === 0) {
    return empty;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return empty;
  }
  const pr = (parsed as { data?: { repository?: { pullRequest?: unknown } } })?.data?.repository?.pullRequest as
    | {
        headRefOid?: unknown;
        reviewThreads?: { pageInfo?: { hasNextPage?: unknown; endCursor?: unknown }; nodes?: unknown[] };
      }
    | undefined;
  if (!pr) {
    return empty;
  }
  const headSha = typeof pr.headRefOid === "string" ? pr.headRefOid : null;
  const pageInfo = pr.reviewThreads?.pageInfo ?? {};
  const nodes = Array.isArray(pr.reviewThreads?.nodes) ? pr.reviewThreads.nodes : [];
  const threads: ReviewThread[] = [];
  for (const node of nodes) {
    const t = node as {
      id?: unknown;
      isResolved?: unknown;
      isOutdated?: unknown;
      path?: unknown;
      line?: unknown;
      diffSide?: unknown;
      resolvedBy?: { login?: unknown } | null;
      comments?: { nodes?: unknown[] };
    } | null;
    if (!t || typeof t.id !== "string") {
      continue;
    }
    const commentNodes = Array.isArray(t.comments?.nodes) ? t.comments.nodes : [];
    const comments: ReviewThreadComment[] = [];
    let reviewedSha: string | null = null;
    for (const raw of commentNodes) {
      const c = raw as {
        id?: unknown;
        databaseId?: unknown;
        body?: unknown;
        createdAt?: unknown;
        author?: { login?: unknown; __typename?: unknown } | null;
        commit?: { oid?: unknown } | null;
        originalCommit?: { oid?: unknown } | null;
      } | null;
      if (!c || typeof c.id !== "string") {
        continue;
      }
      const oid = c.commit?.oid ?? c.originalCommit?.oid;
      if (reviewedSha === null && typeof oid === "string") {
        reviewedSha = oid;
      }
      const login = typeof c.author?.login === "string" ? c.author.login : "";
      comments.push({
        id: c.id,
        databaseId: typeof c.databaseId === "number" ? c.databaseId : null,
        author: login,
        // GitHub reports a bot actor as `__typename: "Bot"`; an App-authored comment can also
        // arrive with a `[bot]` login suffix. Both are checked because mis-reading a bot as a
        // human would make its thread permanently un-resolvable.
        authorIsBot: c.author?.__typename === "Bot" || login.endsWith("[bot]"),
        body: typeof c.body === "string" ? c.body : "",
        createdAt: typeof c.createdAt === "string" ? c.createdAt : "",
      });
    }
    threads.push({
      id: t.id,
      isResolved: t.isResolved === true,
      isOutdated: t.isOutdated === true,
      path: typeof t.path === "string" ? t.path : null,
      line: typeof t.line === "number" ? t.line : null,
      side: t.diffSide === "LEFT" || t.diffSide === "RIGHT" ? t.diffSide : null,
      reviewedSha,
      resolvedBy: typeof t.resolvedBy?.login === "string" ? t.resolvedBy.login : null,
      comments,
    });
  }
  return {
    threads,
    headSha,
    hasNextPage: pageInfo.hasNextPage === true,
    endCursor: typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null,
  };
}

/** Whether a gh error is "the label does not exist in the repo" (vs a real fault). */
function isLabelNotFound(err: unknown): boolean {
  const text = `${(err as { stderr?: string }).stderr ?? ""} ${String(err)}`;
  return /not found/i.test(text) && /label/i.test(text);
}

function labelNotFoundName(err: unknown): string | null {
  const text = `${(err as { stderr?: string }).stderr ?? ""} ${String(err)}`;
  const quoted = /['"]([^'"]+)['"]\s+not found/i.exec(text);
  return quoted?.[1] ?? null;
}

function labelNotFoundOperation(err: unknown): "add" | "remove" | null {
  const text = `${(err as { stderr?: string }).stderr ?? ""} ${String(err)}`;
  if (/add label/i.test(text)) {
    return "add";
  }
  if (/remove label/i.test(text)) {
    return "remove";
  }
  return null;
}

/**
 * Whether a gh error is a GitHub rate-limit / secondary-limit rejection — a
 * *transient* fault that clears on its own (secondary limits in seconds; the
 * primary 5000/hr core limit hourly). The GitHub analog of {@link
 * import("../core/usage").isUsageLimitError} (ADR-0023): a transient external
 * limit must self-heal, never manufacture a terminal human-attention state.
 *
 * It is the single source of truth for "transient GitHub limit" used at two layers:
 *   - the {@link GhCliClient.gh} retry choke point retries it with bounded backoff
 *     (issue 2071); and
 *   - the executor's terminal paths (merge/resume) **defer instead of `agent-stuck`**
 *     when it survives those retries (issue #101) — the same defect class ADR-0023
 *     fixed on the Claude side.
 *
 * Matches the primary + secondary wording GitHub writes to stderr — `API rate limit
 * already exceeded …`, `You have exceeded a secondary rate limit`, and the
 * abuse/`403` form (`You have triggered an abuse detection mechanism`). Scoped to
 * `gh`-command errors (read off `stderr` / the message text), so it never swallows an
 * unrelated fault as a rate limit. Null-safe — a thrown non-object still classifies.
 */
export function isGitHubRateLimitError(err: unknown): boolean {
  const text = `${(err as { stderr?: string } | null)?.stderr ?? ""} ${String(err)}`.toLowerCase();
  return text.includes("rate limit") || text.includes("abuse");
}

/** Retry budget + backoff envelope for a rate-limited gh call (overridable for tests). */
const RATE_LIMIT_MAX_RETRIES = 5;
const RATE_LIMIT_BASE_DELAY_MS = 2_000;
const RATE_LIMIT_MAX_DELAY_MS = 60_000;

/** Neutral cosmetics for a self-created label whose owner supplied no metadata. */
const DEFAULT_LABEL_COLOR = "ededed";
const DEFAULT_LABEL_DESCRIPTION = "Managed by ralph-autopilot";

interface RawLabel {
  name: string;
}
interface RawIssue {
  number: number;
  title: string;
  body: string;
  state?: string;
  labels: RawLabel[];
  createdAt: string;
}
interface RawPull {
  number: number;
  body: string;
  headRefName: string;
  state: string;
}
interface RawComment {
  author?: { login?: string } | null;
  body?: string;
  /**
   * The comment's HTML URL; its `#issuecomment-<n>` tail is the numeric REST id.
   * `gh … --json comments` reports the comment's own `id` as a GraphQL node-id
   * *string* (e.g. `IC_kwDO…`), not the REST id the edit endpoint PATCHes by — so
   * the REST id is read out of this URL, never that node id (issue #47).
   */
  url?: string;
}

/**
 * The numeric REST comment id encoded in a comment's HTML URL
 * (`…#issuecomment-<id>`, or a bare trailing `/<id>`), or 0 if it cannot be parsed.
 * `gh … --json comments` reports each comment's `id` as a GraphQL node-id string,
 * not the numeric REST id the edit endpoint ({@link GhCliClient.updateComment})
 * PATCHes by; the URL is the one listed field carrying that id. Shared by
 * {@link GhCliClient.postComment} (which parses the id from the URL gh prints) and
 * the comment listings, so a restart or the integration re-review can recover the
 * id of the rolling `ralph-review` comment and edit it in place rather than posting
 * a duplicate (issue #47).
 */
export function commentIdFromUrl(url: string | undefined): number {
  if (!url) {
    return 0;
  }
  const match = /#issuecomment-(\d+)/.exec(url) ?? /\/(\d+)$/.exec(url);
  return match ? Number(match[1]) : 0;
}

function toIssueState(raw: string | undefined): IssueState {
  return raw && raw.toUpperCase() === "CLOSED" ? "CLOSED" : "OPEN";
}

// ---- native issue hierarchy (ADR-0040) -----------------------------------

/**
 * How many sub-issues one hierarchy read requests. The compact map caps its own
 * listing well below this; a node with more sub-issues than this reports the ones
 * GitHub returned first rather than paginating on the hot path.
 */
const SUB_ISSUE_PAGE_SIZE = 100;

/**
 * The one GraphQL query pass one makes per level: the node, its **native** parent,
 * and its **native** sub-issues. REST has no parent field, and `gh issue view` does
 * not expose the sub-issue graph — GraphQL is the only surface that answers
 * "who is this issue's parent?" authoritatively, and it answers cross-repo
 * (`repository { nameWithOwner }` on every node) in the same call.
 */
const HIERARCHY_QUERY = `query($owner:String!,$name:String!,$number:Int!,$children:Int!){
  repository(owner:$owner,name:$name){
    issue(number:$number){
      id number title state
      repository{ nameWithOwner }
      parent{ id number title state repository{ nameWithOwner } }
      subIssues(first:$children){ totalCount nodes{ id number title state repository{ nameWithOwner } } }
    }
  }
}`;

/** One issue node as GitHub's GraphQL returns it. */
interface RawGraphQlNode {
  id?: string;
  number?: number;
  title?: string;
  state?: string;
  repository?: { nameWithOwner?: string } | null;
}

interface RawGraphQlIssue extends RawGraphQlNode {
  parent?: RawGraphQlNode | null;
  subIssues?: { totalCount?: number; nodes?: Array<RawGraphQlNode | null> | null } | null;
}

interface RawGraphQlError {
  type?: string;
  message?: string;
  path?: Array<string | number>;
}

/**
 * Classify a GitHub failure (a GraphQL error, or gh's stderr) into the reason a
 * node is inaccessible. Pure, so the mapping is unit-tested without a network.
 * Fails to `error` — the conservative bucket — rather than guessing `deleted`,
 * because "the node is gone" and "I may not look" are different facts to a human
 * adjudicating a broken hierarchy.
 */
export function classifyInaccessible(text: string): InaccessibleReason {
  const t = text.toLowerCase();
  if (/could not resolve to|not_found|no issue found|not found/.test(t)) {
    return "deleted";
  }
  if (/not accessible|forbidden|permission|must have|bad credentials|unauthorized|401|403/.test(t)) {
    return "unauthorized";
  }
  return "error";
}

function graphQlNode(raw: RawGraphQlNode | null | undefined, fallbackRepo: string): HierarchyNode | null {
  if (!raw || typeof raw.number !== "number") {
    return null;
  }
  return {
    ref: { repo: raw.repository?.nameWithOwner ?? fallbackRepo, number: raw.number },
    id: raw.id ?? "",
    title: raw.title ?? "",
    state: toIssueState(raw.state),
  };
}

/**
 * Turn one `gh api graphql` payload into a {@link HierarchyRead} (pure). The
 * load-bearing case is the *absence* of an issue: a missing node with errors is
 * classified from those errors, and a masked `parent` — GitHub reporting an error
 * on the `parent` path rather than a node — becomes an explicit `inaccessible`
 * edge, never `{ kind: "none" }`. Only a genuinely null parent with no error on
 * that path is "this node has no parent".
 */
export function parseHierarchyResponse(out: string, ref: IssueRef): HierarchyRead {
  let payload: { data?: { repository?: { issue?: RawGraphQlIssue | null } | null } | null; errors?: RawGraphQlError[] };
  try {
    payload = JSON.parse(out) as typeof payload;
  } catch {
    return { kind: "inaccessible", ref, reason: "error", detail: "unparseable gh api graphql output" };
  }
  const errors = payload.errors ?? [];
  const issue = payload.data?.repository?.issue;
  if (!issue) {
    const detail = errors.map((e) => e.message ?? e.type ?? "").join("; ");
    return {
      kind: "inaccessible",
      ref,
      reason: classifyInaccessible(detail),
      ...(detail ? { detail } : {}),
    };
  }
  const node = graphQlNode(issue, ref.repo);
  if (!node) {
    return { kind: "inaccessible", ref, reason: "error", detail: "issue payload carried no number" };
  }
  const children = (issue.subIssues?.nodes ?? [])
    .map((c) => graphQlNode(c, node.ref.repo))
    .filter((c): c is HierarchyNode => c !== null);
  const total = issue.subIssues?.totalCount;
  return {
    kind: "node",
    node,
    parent: parseParentEdge(issue, errors, node.ref.repo),
    children,
    ...(typeof total === "number" ? { childCount: total } : {}),
  };
}

/**
 * The parent edge, erring **towards inaccessible**. A null `parent` only means
 * "absolute root" when the response is otherwise clean: GitHub returns partial data
 * with a null field for a masked parent, and its error entry is not reliably pathed
 * at `parent` (a `RATE_LIMITED` or `MAX_NODE_LIMIT_EXCEEDED` error carries no path at
 * all). Treating any errored response's null parent as `none` is exactly how a
 * transient rate-limit would manufacture a false root and plant an initiative-scoped
 * decision on the wrong node — so a null parent alongside *any* error fails closed.
 */
function parseParentEdge(
  issue: RawGraphQlIssue,
  errors: readonly RawGraphQlError[],
  fallbackRepo: string,
): ParentEdge {
  const parent = graphQlNode(issue.parent, fallbackRepo);
  if (parent) {
    return { kind: "node", node: parent };
  }
  if (errors.length === 0) {
    return { kind: "none" };
  }
  const pathed = errors.filter((e) => (e.path ?? []).includes("parent"));
  const relevant = pathed.length > 0 ? pathed : errors;
  const detail = relevant.map((e) => e.message ?? e.type ?? "").join("; ");
  return {
    kind: "inaccessible",
    reason: classifyInaccessible(detail),
    ...(detail ? { detail } : {}),
  };
}

function toPullState(raw: string): PullRequestState {
  const s = raw.toUpperCase();
  return s === "MERGED" ? "MERGED" : s === "CLOSED" ? "CLOSED" : "OPEN";
}

function mapIssue(raw: RawIssue): Issue {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    state: toIssueState(raw.state),
    labels: (raw.labels ?? []).map((l) => l.name),
    createdAt: raw.createdAt,
  };
}

export interface GhCliOptions {
  /** Max issues fetched per poll. */
  issueLimit?: number;
  /**
   * Sink for diagnostics (e.g. a failed dependency query). Defaults to a
   * stdout logger so warnings surface in production.
   */
  logger?: Logger;
  /**
   * Runs `gh` with the given argv and resolves its stdout. Defaults to the real
   * `execFile("gh", …)`; injected in tests to fake/observe gh invocations.
   */
  exec?: (args: string[]) => Promise<string>;
  /**
   * How many times to retry a rate-limited gh call before giving up. Defaults to
   * {@link RATE_LIMIT_MAX_RETRIES}; set to 0 to disable retries (tests).
   */
  rateLimitRetries?: number;
  /**
   * Sleeps `ms` between rate-limit retries. Defaults to a real timer; injected in
   * tests so the backoff is observed without actually waiting.
   */
  sleep?: (ms: number) => Promise<void>;
}

export class GhCliClient implements GitHubClient {
  private readonly repo: string;
  private readonly issueLimit: number;
  private readonly logger: Logger;
  private readonly exec: (args: string[]) => Promise<string>;
  private readonly rateLimitRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(targetRepo: string, options: GhCliOptions = {}) {
    this.repo = targetRepo;
    this.issueLimit = options.issueLimit ?? 200;
    this.logger = options.logger ?? createLogger();
    this.exec =
      options.exec ??
      (async (args) => {
        const { stdout } = await execFileAsync("gh", args, { maxBuffer: 32 * 1024 * 1024 });
        return stdout;
      });
    this.rateLimitRetries = options.rateLimitRetries ?? RATE_LIMIT_MAX_RETRIES;
    this.sleep = options.sleep ?? ((ms) => sleep(ms));
  }

  /**
   * Backoff before the `attempt`-th (0-based) rate-limit retry: exponential off
   * {@link RATE_LIMIT_BASE_DELAY_MS}, capped at {@link RATE_LIMIT_MAX_DELAY_MS},
   * with up to +50% jitter so concurrent callers (both repos, every tick) don't
   * resynchronise into a second burst against the same limit.
   */
  private rateLimitDelayMs(attempt: number): number {
    const base = Math.min(RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt, RATE_LIMIT_MAX_DELAY_MS);
    return Math.round(base * (1 + Math.random() * 0.5));
  }

  /**
   * Runs one gh call, retrying transient rate-limit rejections with bounded
   * backoff (issue 2071). A non-rate-limit error, or a rate-limit error past the
   * retry budget, propagates unchanged — so genuine faults still surface and a
   * sustained primary-limit exhaustion eventually gives up rather than freezing
   * the tick (the caller defers and the next tick retries). The single choke
   * point every read/write flows through, so one guard covers all call sites.
   */
  private async gh(args: string[]): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.exec(args);
      } catch (err) {
        if (!isGitHubRateLimitError(err) || attempt >= this.rateLimitRetries) {
          throw err;
        }
        const delayMs = this.rateLimitDelayMs(attempt);
        this.logger.warn("github.rate-limited", {
          op: args.slice(0, 2).join(" "),
          attempt: attempt + 1,
          maxRetries: this.rateLimitRetries,
          delayMs,
        });
        await this.sleep(delayMs);
      }
    }
  }

  /**
   * Like {@link gh}, but tolerant of a non-zero exit: `gh pr checks` exits
   * non-zero when checks are pending or failing yet still writes the JSON we want
   * to stdout. Returns that stdout (empty string if none).
   */
  private async ghAllowFail(args: string[]): Promise<string> {
    try {
      return await this.gh(args);
    } catch (err) {
      const stdout = (err as { stdout?: string }).stdout;
      return typeof stdout === "string" ? stdout : "";
    }
  }

  private async editLabels(issueNumber: number, patch: LabelPatch): Promise<void> {
    const args = ["issue", "edit", String(issueNumber), "--repo", this.repo];
    const add = [...patch.add];
    const addSet = new Set(add);
    const remove = patch.remove.filter((label) => !addSet.has(label));
    if (remove.length > 0) {
      args.push("--remove-label", remove.join(","));
    }
    if (add.length > 0) {
      args.push("--add-label", add.join(","));
    }
    await this.gh(args);
  }

  private async createLabel(label: string, opts?: LabelCreateOptions): Promise<void> {
    this.logger.info("label.create", { label });
    await this.gh([
      "label",
      "create",
      label,
      "--repo",
      this.repo,
      "--force",
      "--color",
      opts?.color ?? DEFAULT_LABEL_COLOR,
      "--description",
      opts?.description ?? DEFAULT_LABEL_DESCRIPTION,
    ]);
  }

  async listOpenIssues(): Promise<Issue[]> {
    const out = await this.gh([
      "issue",
      "list",
      "--repo",
      this.repo,
      "--state",
      "open",
      "--limit",
      String(this.issueLimit),
      "--json",
      "number,title,body,state,labels,createdAt",
    ]);
    return (JSON.parse(out) as RawIssue[]).map(mapIssue);
  }

  async getIssue(issueNumber: number): Promise<Issue | null> {
    try {
      const out = await this.gh([
        "issue",
        "view",
        String(issueNumber),
        "--repo",
        this.repo,
        "--json",
        "number,title,body,state,labels,createdAt",
      ]);
      return mapIssue(JSON.parse(out) as RawIssue);
    } catch {
      return null;
    }
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    // gh errors if the label is absent; only that case is a no-op. Auth,
    // network, rate-limit, and GitHub faults must propagate so callers do not
    // report a label swap as applied when the removal side failed.
    try {
      await this.gh([
        "issue",
        "edit",
        String(issueNumber),
        "--repo",
        this.repo,
        "--remove-label",
        label,
      ]);
    } catch (err) {
      if (!isLabelNotFound(err)) {
        throw err;
      }
      /* label already absent — nothing to do */
    }
  }

  async addLabel(issueNumber: number, label: string, opts?: LabelCreateOptions): Promise<void> {
    const edit = (): Promise<string> =>
      this.gh(["issue", "edit", String(issueNumber), "--repo", this.repo, "--add-label", label]);
    try {
      await edit();
    } catch (err) {
      // gh fails if the label does not exist in the repo. The daemon owns some
      // labels that may not be pre-created on the target — notably `daemon-anomaly`
      // (issue #27), the completeness-invariant's surfacing label. Create it (idempotent
      // with --force) using the owner-supplied cosmetics, then retry. The adapter holds
      // no per-label knowledge: a label's color/description belong to its owner, passed
      // via `opts`; absent, it self-creates with neutral defaults. Any other failure is
      // real and propagates.
      if (!isLabelNotFound(err)) {
        throw err;
      }
      await this.createLabel(label, opts);
      await edit();
    }
  }

  async applyLabelPatch(issueNumber: number, patch: LabelPatch): Promise<void> {
    let remove = [...patch.remove];
    const add = [...patch.add];
    const created = new Set<string>();

    for (;;) {
      if (remove.length === 0 && add.length === 0) {
        return;
      }
      try {
        await this.editLabels(issueNumber, { remove, add });
        return;
      } catch (err) {
        if (!isLabelNotFound(err)) {
          throw err;
        }
        const missing = labelNotFoundName(err);
        const operation = labelNotFoundOperation(err);
        if (operation === "remove" && missing && remove.includes(missing)) {
          remove = remove.filter((label) => label !== missing);
          continue;
        }
        if (operation === "add" && missing && add.includes(missing) && !created.has(missing)) {
          created.add(missing);
          await this.createLabel(missing);
          continue;
        }
        throw err;
      }
    }
  }

  async findPullRequestForBranch(branch: string): Promise<PullRequest | null> {
    const out = await this.gh([
      "pr",
      "list",
      "--repo",
      this.repo,
      "--head",
      branch,
      "--state",
      "all",
      "--limit",
      "1",
      "--json",
      "number,body,headRefName,state",
    ]);
    const pulls = JSON.parse(out) as RawPull[];
    const pr = pulls[0];
    if (!pr) {
      return null;
    }
    return {
      number: pr.number,
      body: pr.body ?? "",
      headRefName: pr.headRefName,
      state: toPullState(pr.state),
    };
  }

  async listOpenPullRequests(): Promise<PullRequest[]> {
    const out = await this.gh([
      "pr",
      "list",
      "--repo",
      this.repo,
      "--state",
      "open",
      "--limit",
      String(this.issueLimit),
      "--json",
      "number,body,headRefName,state",
    ]);
    return (JSON.parse(out) as RawPull[]).map((pr) => ({
      number: pr.number,
      body: pr.body ?? "",
      headRefName: pr.headRefName,
      state: toPullState(pr.state),
    }));
  }

  /**
   * The comment thread on a PR or an issue. `gh pr view --json comments` and
   * `gh issue view --json comments` return the identical shape, so both surfaces
   * share this one helper — only the subcommand differs.
   */
  private async listComments(kind: "pr" | "issue", number: number): Promise<PrComment[]> {
    const out = await this.gh([kind, "view", String(number), "--repo", this.repo, "--json", "comments"]);
    const data = JSON.parse(out) as { comments?: RawComment[] };
    // Derive the numeric REST `id` from each comment's URL — `gh … --json comments`
    // reports `id` as a GraphQL node-id string, useless for an in-place PATCH
    // (issue #47). The listing index is a last-ditch fallback only if gh omits the
    // URL; such an id is never used to edit a comment ({@link usableCommentId}
    // guards on it being a positive REST id in the review loop).
    return (data.comments ?? []).map((c, i) => ({
      id: commentIdFromUrl(c.url) || i,
      author: c.author?.login ?? "",
      body: c.body ?? "",
    }));
  }

  async listPullRequestComments(prNumber: number): Promise<PrComment[]> {
    // The PR issue-comment thread is the surface the automated review bots post on.
    return this.listComments("pr", prNumber);
  }

  async listIssueComments(issueNumber: number): Promise<PrComment[]> {
    return this.listComments("issue", issueNumber);
  }

  async ensureDraftPullRequest(branch: string, draft: DraftPullRequest): Promise<PullRequest> {
    const existing = await this.findPullRequestForBranch(branch);
    if (existing) {
      return existing;
    }
    // The WIP branch is already pushed (the executor checkpoints it before this).
    // `gh pr create --draft` opens against the repo's default base branch.
    await this.gh([
      "pr",
      "create",
      "--repo",
      this.repo,
      "--draft",
      "--head",
      branch,
      "--title",
      draft.title,
      "--body",
      draft.body,
    ]);
    const created = await this.findPullRequestForBranch(branch);
    if (!created) {
      throw new Error(`draft PR for ${branch} was created but could not be read back`);
    }
    return created;
  }

  async postComment(issueNumber: number, body: string): Promise<{ id: number }> {
    // execFile uses no shell, so the (possibly fenced, multiline) body is safe as
    // a single argv element — no interpolation, no quoting hazard.
    const out = await this.gh([
      "issue",
      "comment",
      String(issueNumber),
      "--repo",
      this.repo,
      "--body",
      body,
    ]);
    // gh prints the new comment's URL; the `#issuecomment-<n>` tail encodes its
    // numeric REST id — the same id {@link updateComment} PATCHes by.
    return { id: commentIdFromUrl(out.trim()) };
  }

  async updateComment(commentId: number, body: string): Promise<void> {
    // PR/issue comments are edited through the REST API by their numeric id; gh has
    // no first-class "edit comment <id>" verb. `-f body=…` (raw-field) sends the
    // (possibly fenced, multiline) body verbatim — no shell, no `@file`/type magic
    // (only `-F`/`--field` interprets a leading `@` or coerces types).
    await this.gh([
      "api",
      "--method",
      "PATCH",
      `/repos/${this.repo}/issues/comments/${commentId}`,
      "-f",
      `body=${body}`,
    ]);
  }

  async awaitChecks(prNumber: number, opts: AwaitChecksOptions): Promise<ChecksResult> {
    const pollMs = Math.max(1, opts.pollIntervalSeconds) * 1000;
    const deadline = Date.now() + opts.ciTimeoutMinutes * 60_000;
    for (;;) {
      const snapshot = await this.readChecks(prNumber);
      if (snapshot.state !== "pending") {
        return { state: snapshot.state, failures: snapshot.failures };
      }
      if (Date.now() >= deadline) {
        return { state: "timeout", failures: snapshot.failures };
      }
      await sleep(pollMs);
    }
  }

  async readChecks(prNumber: number): Promise<ChecksSnapshot> {
    // `--json` makes gh emit structured rows even when checks fail or pend; the
    // process exits non-zero in those cases, so read stdout tolerantly. One read,
    // no polling — the lean snapshot the off-slot CI poller takes per tick (#88).
    const out = await this.ghAllowFail([
      "pr",
      "checks",
      String(prNumber),
      "--repo",
      this.repo,
      "--json",
      // `startedAt`/`completedAt` let classifyChecks collapse duplicate-name runs to
      // the latest, so a passing re-run supersedes an earlier failure (issue #125).
      "name,state,bucket,startedAt,completedAt",
    ]);
    let rows: RawCheck[] = [];
    if (out.trim().length > 0) {
      try {
        rows = JSON.parse(out) as RawCheck[];
      } catch {
        rows = [];
      }
    }
    const { verdict, failures } = classifyChecks(rows);
    return { state: verdict, failures };
  }

  async readMergeStatus(prNumber: number): Promise<MergeStatusSnapshot> {
    // `gh pr view --json mergeStateStatus` returns GitHub's GraphQL mergeStateStatus:
    // the branch-protection-aware mergeability view. Unlike `gh pr checks` (raw check
    // runs, which can briefly report no/stale runs after a force-push), this reflects a
    // required check GitHub has re-queued as EXPECTED on the new head — so the merge
    // poll waits it out instead of racing the merge (#25). Read tolerantly: an empty /
    // unparseable payload maps to UNKNOWN ("keep waiting"), never a false-mergeable.
    const out = await this.ghAllowFail([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      this.repo,
      "--json",
      // `reviewDecision` + `headRefOid` ride along free on the same read (issue #43): they
      // are what turn an opaque BLOCKED into a typed cause and anchor every hosted-review
      // observation to the commit the reviewer actually saw.
      "mergeStateStatus,reviewDecision,headRefOid",
    ]);
    return parseMergeStatusSnapshot(out);
  }

  /**
   * Every review thread on a PR, fully paginated (issue #43). Fails **typed**, never by
   * exception: a missing GraphQL permission is an operator-owned defect and a rate limit is a
   * defer, and the merge gate's response to those two differs — collapsing both into a throw
   * would lose the distinction exactly where it decides whether a human gets paged.
   */
  async readReviewThreads(prNumber: number): Promise<ReviewThreadsRead> {
    const { owner, name } = splitRepo(this.repo);
    const threads: ReviewThread[] = [];
    let headSha: string | null = null;
    let after: string | null = null;
    for (let page = 0; page < REVIEW_THREAD_MAX_PAGES; page += 1) {
      const args = [
        "api",
        "graphql",
        "-f",
        `query=${REVIEW_THREADS_QUERY}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-F",
        `number=${prNumber}`,
        "-F",
        `first=${REVIEW_THREAD_PAGE_SIZE}`,
        "-F",
        `comments=${REVIEW_THREAD_COMMENT_PAGE_SIZE}`,
      ];
      if (after) {
        args.push("-f", `after=${after}`);
      }
      let out: string;
      try {
        out = await this.gh(args);
      } catch (err) {
        if (isGitHubRateLimitError(err)) {
          return { kind: "unavailable", reason: "rate-limited", detail: "GitHub rate limit on reviewThreads" };
        }
        if (isPermissionError(err)) {
          return {
            kind: "unavailable",
            reason: "permissions",
            detail: "gh lacks the GraphQL scope to read pull-request review threads",
          };
        }
        return { kind: "unavailable", reason: "error", detail: String(err).slice(0, 300) };
      }
      const parsed = parseReviewThreadsPage(out);
      if (page === 0 && parsed.threads.length === 0 && parsed.headSha === null && out.trim().length === 0) {
        return { kind: "unavailable", reason: "error", detail: "gh api graphql returned nothing" };
      }
      threads.push(...parsed.threads);
      headSha = headSha ?? parsed.headSha;
      if (!parsed.hasNextPage || !parsed.endCursor) {
        return { kind: "threads", threads, headSha };
      }
      after = parsed.endCursor;
    }
    // The page cap ran out while GitHub still reported `hasNextPage: true`: the read is
    // *incomplete*. Returning the threads gathered so far as `kind:"threads"` would let the
    // gate treat "no unresolved thread on the pages I saw" as "no unresolved thread" and merge
    // past a blocker sitting on an unread page — the exact fail-open this gate exists to prevent
    // (issue #43). Fail closed instead: a typed `unavailable` the gate reads as "not clear".
    return {
      kind: "unavailable",
      reason: "error",
      detail: `review threads exceeded ${REVIEW_THREAD_MAX_PAGES} pages; read is incomplete`,
    };
  }

  async replyToReviewThread(input: { threadId: string; body: string }): Promise<{ id: string }> {
    const out = await this.gh([
      "api",
      "graphql",
      "-f",
      `query=${REPLY_THREAD_MUTATION}`,
      "-f",
      `threadId=${input.threadId}`,
      "-f",
      `body=${input.body}`,
    ]);
    try {
      const id = (
        JSON.parse(out) as { data?: { addPullRequestReviewThreadReply?: { comment?: { id?: unknown } } } }
      )?.data?.addPullRequestReviewThreadReply?.comment?.id;
      return { id: typeof id === "string" ? id : "" };
    } catch {
      return { id: "" };
    }
  }

  async resolveReviewThread(threadId: string): Promise<void> {
    // Idempotent at GitHub: resolving an already-resolved thread returns the thread rather
    // than erroring, so a restart-driven repeat is harmless.
    await this.gh(["api", "graphql", "-f", `query=${RESOLVE_THREAD_MUTATION}`, "-f", `threadId=${threadId}`]);
  }

  async mergePullRequest(prNumber: number, opts: MergeOptions): Promise<void> {
    // The merge is a deterministic harness action (issue #41 / ADR-0014), not a
    // delegation to GitHub auto-merge (`--auto` is plan-gated off on free private
    // repos and waits on GitHub rather than the harness). The CI gate and rebase
    // are enforced by the review loop before this is ever called.
    const args = ["pr", "merge", String(prNumber), "--repo", this.repo, `--${opts.method}`];
    if (opts.deleteBranch) {
      args.push("--delete-branch");
    }
    await this.gh(args);
  }

  async closePullRequest(prNumber: number, comment: string): Promise<void> {
    // `gh pr close --comment` flags *and* closes in one call: the comment surfaces
    // why (a mid-run executor failure, issue #34) and the close removes the PR from
    // the open set so it never dangles. The branch is left intact (no
    // `--delete-branch`) so a re-admitted run or a human can recover the work.
    // execFile uses no shell, so the comment body is safe as a single argv element.
    await this.gh([
      "pr",
      "close",
      String(prNumber),
      "--repo",
      this.repo,
      "--comment",
      comment,
    ]);
  }

  async closeIssue(issueNumber: number, comment?: string): Promise<void> {
    // The destructive Tier-1 power action (issue #114, ADR-0032): closing an issue the
    // operator does not want worked. `gh issue close` flags it closed; an optional
    // `--comment` records why in the same call. The caller confirms intent before this
    // point — once closed the reconciler sees `state: CLOSED` and stops acting on it.
    // execFile uses no shell, so a (possibly multiline) comment is safe as one argv.
    const args = ["issue", "close", String(issueNumber), "--repo", this.repo];
    if (comment !== undefined && comment.length > 0) {
      args.push("--comment", comment);
    }
    await this.gh(args);
  }

  async isDependencySatisfied(issueNumber: number): Promise<boolean> {
    // Binding gate (DESIGN §2): a `## Blocked by` dependency is satisfied iff it
    // is CLOSED *and* was closed by a merged PR. One `gh issue view` fetches both
    // fields. A failed query fails **CLOSED** (dependency unsatisfied) with a
    // warning — never silently degrade "CLOSED with a merged PR" to "merely
    // CLOSED" (ADR-0011, issue #11).
    let data: {
      state?: string;
      closedByPullRequestsReferences?: Array<{ state?: string | null }>;
    };
    try {
      const out = await this.gh([
        "issue",
        "view",
        String(issueNumber),
        "--repo",
        this.repo,
        "--json",
        "state,closedByPullRequestsReferences",
      ]);
      data = JSON.parse(out) as typeof data;
    } catch (err) {
      this.logger.warn("dependency.query-failed", {
        issue: issueNumber,
        error: String(err),
      });
      return false;
    }

    if ((data.state ?? "").toUpperCase() !== "CLOSED") {
      return false;
    }
    const closers = data.closedByPullRequestsReferences ?? [];
    if (closers.some((pr) => (pr.state ?? "").toUpperCase() === "MERGED")) {
      return true;
    }
    // No closer is explicitly MERGED. A squash-merged PR can report `state: null`
    // even though it is merged (observed: #7's closer #17). A CLOSED issue with a
    // closing-PR ref whose merge can't be disproven is treated as satisfied (with
    // a logged note) rather than false-blocking the dependent forever. Closers
    // with an explicit non-merged state (e.g. CLOSED/OPEN) do disprove a merge.
    if (closers.some((pr) => (pr.state ?? "").trim() === "")) {
      this.logger.warn("dependency.merge-unconfirmed", {
        issue: issueNumber,
        closerStates: closers.map((pr) => pr.state ?? null),
      });
      return true;
    }
    return false;
  }

  // ---- native issue hierarchy + cross-repo nodes (ADR-0040) ---------------

  async readIssueHierarchy(ref: IssueRef): Promise<HierarchyRead> {
    const { owner, name } = splitRepo(ref.repo);
    // `gh api graphql` exits non-zero when the payload carries `errors`, yet still
    // writes the body we need (partial data + the error list). Read it tolerantly and
    // classify — a permissions failure must surface as `unauthorized`, never as a
    // thrown fault that a climb could mistake for "no parent".
    const out = await this.ghAllowFail([
      "api",
      "graphql",
      // `-f` sends a raw string (the `String!` variables), `-F` a typed literal (the
      // `Int!` ones). Using `-F` for a repo name would let gh coerce an owner literally
      // called `true`/`42` into the wrong JSON type.
      "-f",
      `query=${HIERARCHY_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `number=${ref.number}`,
      "-F",
      `children=${SUB_ISSUE_PAGE_SIZE}`,
    ]);
    if (out.trim().length === 0) {
      return { kind: "inaccessible", ref, reason: "error", detail: "gh api graphql returned nothing" };
    }
    return parseHierarchyResponse(out, ref);
  }

  async readIssueContent(ref: IssueRef): Promise<IssueContentRead> {
    // Cross-repo capable by construction: `--repo` comes off the ref, so a node in
    // another repository costs exactly the same one call as a local one.
    let out: string;
    try {
      out = await this.gh([
        "issue",
        "view",
        String(ref.number),
        "--repo",
        ref.repo,
        "--json",
        "id,number,title,body,state,comments",
      ]);
    } catch (err) {
      const detail = `${(err as { stderr?: string } | null)?.stderr ?? ""} ${String(err)}`.trim();
      return { kind: "inaccessible", ref, reason: classifyInaccessible(detail), detail };
    }
    let raw: { id?: string; title?: string; body?: string; state?: string; comments?: RawComment[] };
    try {
      raw = JSON.parse(out) as typeof raw;
    } catch {
      return { kind: "inaccessible", ref, reason: "error", detail: "unparseable gh issue view output" };
    }
    return {
      kind: "content",
      node: {
        ref,
        id: raw.id ?? "",
        title: raw.title ?? "",
        state: toIssueState(raw.state),
      },
      body: raw.body ?? "",
      comments: (raw.comments ?? []).map((c, i) => ({
        id: commentIdFromUrl(c.url) || i,
        author: c.author?.login ?? "",
        body: c.body ?? "",
      })),
    };
  }

  async postNodeComment(ref: IssueRef, body: string): Promise<{ id: number }> {
    const out = await this.gh([
      "issue",
      "comment",
      String(ref.number),
      "--repo",
      ref.repo,
      "--body",
      body,
    ]);
    return { id: commentIdFromUrl(out.trim()) };
  }

  async updateNodeComment(ref: IssueRef, commentId: number, body: string): Promise<void> {
    // Same REST PATCH as {@link updateComment}, but against the node's own repo so
    // the derived index on a cross-repo root can be kept current.
    await this.gh([
      "api",
      "--method",
      "PATCH",
      `/repos/${ref.repo}/issues/comments/${commentId}`,
      "-f",
      `body=${body}`,
    ]);
  }
}
