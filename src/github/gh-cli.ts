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
import type {
  AwaitChecksOptions,
  ChecksResult,
  ChecksSnapshot,
  DraftPullRequest,
  GitHubClient,
  Issue,
  IssueState,
  LabelPatch,
  LabelCreateOptions,
  MergeOptions,
  PrComment,
  PullRequest,
  PullRequestState,
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
}
