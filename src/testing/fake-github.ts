/**
 * In-memory {@link GitHubClient} for tests. Models the slice of GitHub the
 * daemon touches: issues with labels and bodies, dependency satisfaction, and
 * PRs opened from branches. Label mutations and pickups are recorded so tests
 * can assert "no double pickup" and "ready-for-agent removed on pickup".
 */

import type {
  AwaitChecksOptions,
  ChecksResult,
  ChecksSnapshot,
  DraftPullRequest,
  GitHubClient,
  Issue,
  LabelPatch,
  MergeMethod,
  MergeOptions,
  MergeStatusSnapshot,
  PrComment,
  PullRequest,
} from "../github/types";

export interface SeedIssue extends Partial<Omit<Issue, "number">> {
  number: number;
}

/** A recorded direct merge, for assertions. */
export interface RecordedMerge {
  prNumber: number;
  method: MergeMethod;
  deleteBranch: boolean;
}

export class FakeGitHub implements GitHubClient {
  readonly issues = new Map<number, Issue>();
  readonly pulls: PullRequest[] = [];
  /** Dependency issue numbers considered closed-with-merged-PR. */
  private readonly satisfiedDeps = new Set<number>();
  /** Audit trail of label removals, for assertions. */
  readonly removedLabels: Array<{ issue: number; label: string }> = [];
  /** Audit trail of label additions, for assertions. */
  readonly addedLabels: Array<{ issue: number; label: string }> = [];
  /** Audit trail of label patches, for assertions. */
  readonly labelPatches: Array<{ issue: number; remove: string[]; add: string[] }> = [];
  /** Comments posted by the daemon, keyed by issue/PR number. */
  readonly comments = new Map<number, PrComment[]>();
  /** Direct merges, in order, for assertions. */
  readonly merges: RecordedMerge[] = [];
  /** PR numbers closed via {@link closePullRequest}, in order, for assertions. */
  readonly closedPulls: number[] = [];
  /** Issue numbers closed via {@link closeIssue}, in order, for assertions. */
  readonly closedIssues: number[] = [];
  /** PR numbers opened as drafts via {@link ensureDraftPullRequest}. */
  readonly draftPulls: number[] = [];
  /** PR numbers, in order, that {@link awaitChecks} was polled for. */
  readonly checkPolls: number[] = [];
  /** PR numbers, in order, that the non-blocking {@link readChecks} read (one per poll tick). */
  readonly readCheckPolls: number[] = [];
  /** The current CI verdict per PR (defaults to `none` — the dogfood repo). */
  private readonly checksState = new Map<number, ChecksResult>();
  /** Scripted CI verdict sequences per PR, consumed in order (last repeats). */
  private readonly checksQueue = new Map<number, ChecksResult[]>();
  /** The current non-blocking {@link readChecks} snapshot per PR (can be `pending`). */
  private readonly readSnapshotState = new Map<number, ChecksSnapshot>();
  /** Scripted {@link readChecks} snapshot sequences per PR, consumed in order (last repeats). */
  private readonly readSnapshotQueue = new Map<number, ChecksSnapshot[]>();
  /** The current merge-state snapshot per PR (defaults to `CLEAN` — nothing blocks a merge). */
  private readonly mergeStatusState = new Map<number, MergeStatusSnapshot>();
  /** Scripted {@link readMergeStatus} sequences per PR, consumed in order (last repeats). */
  private readonly mergeStatusQueue = new Map<number, MergeStatusSnapshot[]>();
  /** PR numbers, in order, that {@link readMergeStatus} was read for (one per merge poll). */
  readonly mergeStatusReads: number[] = [];
  private nextPrNumber = 1001;
  private nextCommentId = 5001;

  seed(seed: SeedIssue): Issue {
    const issue: Issue = {
      title: `Issue ${seed.number}`,
      body: "",
      state: "OPEN",
      labels: ["ready-for-agent", "afk", "mode:tdd"],
      createdAt: "2026-01-01T00:00:00Z",
      ...seed,
    };
    this.issues.set(issue.number, issue);
    return issue;
  }

  setDependencySatisfied(issueNumber: number, satisfied = true): void {
    if (satisfied) {
      this.satisfiedDeps.add(issueNumber);
    } else {
      this.satisfiedDeps.delete(issueNumber);
    }
  }

  async listOpenIssues(): Promise<Issue[]> {
    return [...this.issues.values()]
      .filter((i) => i.state === "OPEN")
      .map((i) => ({ ...i, labels: [...i.labels] }));
  }

  async getIssue(issueNumber: number): Promise<Issue | null> {
    const issue = this.issues.get(issueNumber);
    return issue ? { ...issue, labels: [...issue.labels] } : null;
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    this.removedLabels.push({ issue: issueNumber, label });
    const issue = this.issues.get(issueNumber);
    if (issue) {
      issue.labels = issue.labels.filter((l) => l !== label);
    }
  }

  async addLabel(issueNumber: number, label: string): Promise<void> {
    this.addedLabels.push({ issue: issueNumber, label });
    const issue = this.issues.get(issueNumber);
    if (issue && !issue.labels.includes(label)) {
      issue.labels.push(label);
    }
  }

  async applyLabelPatch(issueNumber: number, patch: LabelPatch): Promise<void> {
    this.labelPatches.push({ issue: issueNumber, remove: [...patch.remove], add: [...patch.add] });
    for (const label of patch.remove) {
      this.removedLabels.push({ issue: issueNumber, label });
    }
    for (const label of patch.add) {
      this.addedLabels.push({ issue: issueNumber, label });
    }
    const issue = this.issues.get(issueNumber);
    if (!issue) {
      return;
    }
    issue.labels = issue.labels.filter((label) => !patch.remove.includes(label));
    for (const label of patch.add) {
      if (!issue.labels.includes(label)) {
        issue.labels.push(label);
      }
    }
  }

  async findPullRequestForBranch(branch: string): Promise<PullRequest | null> {
    const pr = this.pulls.find((p) => p.headRefName === branch);
    return pr ? { ...pr } : null;
  }

  async listOpenPullRequests(): Promise<PullRequest[]> {
    return this.pulls.filter((p) => p.state === "OPEN").map((p) => ({ ...p }));
  }

  async listPullRequestComments(prNumber: number): Promise<PrComment[]> {
    return (this.comments.get(prNumber) ?? []).map((c) => ({ ...c }));
  }

  async listIssueComments(issueNumber: number): Promise<PrComment[]> {
    return (this.comments.get(issueNumber) ?? []).map((c) => ({ ...c }));
  }

  async ensureDraftPullRequest(branch: string, draft: DraftPullRequest): Promise<PullRequest> {
    const existing = this.pulls.find((p) => p.headRefName === branch);
    if (existing) {
      return { ...existing };
    }
    const pr: PullRequest = {
      number: this.nextPrNumber++,
      body: draft.body,
      headRefName: branch,
      state: "OPEN",
    };
    this.pulls.push(pr);
    this.draftPulls.push(pr.number);
    return { ...pr };
  }

  async postComment(issueNumber: number, body: string): Promise<{ id: number }> {
    const comment: PrComment = { id: this.nextCommentId++, author: "ralph-autopilot", body };
    const existing = this.comments.get(issueNumber) ?? [];
    existing.push(comment);
    this.comments.set(issueNumber, existing);
    return { id: comment.id };
  }

  async updateComment(commentId: number, body: string): Promise<void> {
    // Edit the comment in place wherever it lives (issue/PR thread), mirroring the
    // REST PATCH the real client makes. Editing an id that does not exist is a fault
    // (the loop only ever edits an id it just posted or recovered from the PR), so
    // surface it rather than silently no-op.
    for (const list of this.comments.values()) {
      const comment = list.find((c) => c.id === commentId);
      if (comment) {
        comment.body = body;
        return;
      }
    }
    throw new Error(`updateComment: no comment with id ${commentId}`);
  }

  async awaitChecks(prNumber: number, _opts: AwaitChecksOptions): Promise<ChecksResult> {
    void _opts;
    this.checkPolls.push(prNumber);
    const queued = this.checksQueue.get(prNumber);
    if (queued && queued.length > 0) {
      return queued.length > 1 ? queued.shift()! : queued[0]!;
    }
    return this.checksState.get(prNumber) ?? { state: "none", failures: [] };
  }

  async readChecks(prNumber: number): Promise<ChecksSnapshot> {
    this.readCheckPolls.push(prNumber);
    const queued = this.readSnapshotQueue.get(prNumber);
    if (queued && queued.length > 0) {
      return queued.length > 1 ? queued.shift()! : queued[0]!;
    }
    const explicit = this.readSnapshotState.get(prNumber);
    if (explicit) {
      return explicit;
    }
    // Fall back to the blocking-poll verdict so a test that only scripted `awaitChecks`
    // state gets a consistent snapshot — the *current* awaitChecks verdict (the head of
    // a scripted sequence, else the steady state), so a snapshot read reflects the same
    // CI a blocking poll would see (e.g. the gate's pre-maxout reconfirm read, issue
    // #125). `timeout` is not a single-read verdict — it is a function of how long a run
    // has been parked — so it maps to `pending`.
    const awaitQueue = this.checksQueue.get(prNumber);
    const result =
      (awaitQueue && awaitQueue.length > 0 ? awaitQueue[0] : undefined) ?? this.checksState.get(prNumber);
    if (!result) {
      return { state: "none", failures: [] };
    }
    return result.state === "timeout"
      ? { state: "pending", failures: result.failures }
      : { state: result.state, failures: result.failures };
  }

  async readMergeStatus(prNumber: number): Promise<MergeStatusSnapshot> {
    this.mergeStatusReads.push(prNumber);
    const queued = this.mergeStatusQueue.get(prNumber);
    if (queued && queued.length > 0) {
      return queued.length > 1 ? queued.shift()! : queued[0]!;
    }
    // Default mergeable: a PR with no scripted merge-state has nothing blocking it, so
    // the rebase-aware merge poll clears on the first read (as it did before #25).
    return this.mergeStatusState.get(prNumber) ?? { state: "CLEAN" };
  }

  async mergePullRequest(prNumber: number, opts: MergeOptions): Promise<void> {
    this.merges.push({ prNumber, method: opts.method, deleteBranch: opts.deleteBranch });
    this.landMerge(prNumber);
  }

  async closePullRequest(prNumber: number, comment: string): Promise<void> {
    this.closedPulls.push(prNumber);
    const pr = this.pulls.find((p) => p.number === prNumber);
    if (pr && pr.state === "OPEN") {
      pr.state = "CLOSED";
    }
    const existing = this.comments.get(prNumber) ?? [];
    existing.push({ id: this.nextCommentId++, author: "ralph-autopilot", body: comment });
    this.comments.set(prNumber, existing);
  }

  async closeIssue(issueNumber: number, comment?: string): Promise<void> {
    this.closedIssues.push(issueNumber);
    const issue = this.issues.get(issueNumber);
    if (issue) {
      issue.state = "CLOSED";
    }
    if (comment !== undefined && comment.length > 0) {
      const existing = this.comments.get(issueNumber) ?? [];
      existing.push({ id: this.nextCommentId++, author: "ralph-autopilot", body: comment });
      this.comments.set(issueNumber, existing);
    }
  }

  async isDependencySatisfied(issueNumber: number): Promise<boolean> {
    return this.satisfiedDeps.has(issueNumber);
  }

  /** Test helper: simulate the impl agent opening a PR from `branch`. */
  openPullRequest(branch: string, body: string): PullRequest {
    const pr: PullRequest = {
      number: this.nextPrNumber++,
      body,
      headRefName: branch,
      state: "OPEN",
    };
    this.pulls.push(pr);
    return pr;
  }

  /** Test helper: seed an automated PR comment for the review agent to ingest. */
  seedPullRequestComment(prNumber: number, comment: Omit<PrComment, "id">): PrComment {
    const full: PrComment = { id: this.nextCommentId++, ...comment };
    const existing = this.comments.get(prNumber) ?? [];
    existing.push(full);
    this.comments.set(prNumber, existing);
    return full;
  }

  /** Test helper: set the CI verdict {@link awaitChecks} returns for a PR. */
  setChecks(prNumber: number, result: ChecksResult): void {
    this.checksState.set(prNumber, result);
  }

  /**
   * Test helper: script a sequence of CI verdicts for a PR — each {@link awaitChecks}
   * call returns the next, the last repeating. Models CI going red then green
   * across a fix loop, or a branch that moved on rebase needing a re-await.
   */
  setChecksSequence(prNumber: number, results: ChecksResult[]): void {
    this.checksQueue.set(prNumber, [...results]);
  }

  /** Test helper: mark a PR's CI green. */
  setCiGreen(prNumber: number): void {
    this.setChecks(prNumber, { state: "green", failures: [] });
  }

  /** Test helper: mark a PR's CI red, with the named failing checks. */
  setCiRed(prNumber: number, failures: string[] = ["pr-checks"]): void {
    this.setChecks(prNumber, { state: "red", failures });
  }

  /** Test helper: set the snapshot the non-blocking {@link readChecks} returns for a PR. */
  setReadChecks(prNumber: number, snapshot: ChecksSnapshot): void {
    this.readSnapshotState.set(prNumber, snapshot);
  }

  /**
   * Test helper: script a sequence of {@link readChecks} snapshots — each read
   * returns the next, the last repeating. Models CI still running for a few poller
   * ticks then settling green/red.
   */
  setReadChecksSequence(prNumber: number, snapshots: ChecksSnapshot[]): void {
    this.readSnapshotQueue.set(prNumber, [...snapshots]);
  }

  /** Test helper: set the merge-state {@link readMergeStatus} returns for a PR. */
  setMergeStatus(prNumber: number, snapshot: MergeStatusSnapshot): void {
    this.mergeStatusState.set(prNumber, snapshot);
  }

  /**
   * Test helper: script a sequence of merge-state snapshots for a PR — each
   * {@link readMergeStatus} call returns the next, the last repeating. Models a
   * required check re-queued by the pre-merge force-push (BLOCKED) then re-passing
   * (CLEAN), so the merge poll must wait rather than park on the first not-mergeable.
   */
  setMergeStatusSequence(prNumber: number, snapshots: MergeStatusSnapshot[]): void {
    this.mergeStatusQueue.set(prNumber, [...snapshots]);
  }

  /** Mark a PR merged and close the issue its body says it `Closes`. */
  private landMerge(prNumber: number): void {
    const pr = this.pulls.find((p) => p.number === prNumber);
    if (!pr || pr.state === "MERGED") {
      return;
    }
    pr.state = "MERGED";
    const closes = /\bCloses #(\d+)\b/i.exec(pr.body);
    if (closes) {
      const issue = this.issues.get(Number(closes[1]));
      if (issue) {
        issue.state = "CLOSED";
      }
    }
  }
}
