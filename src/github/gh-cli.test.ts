import { describe, expect, it } from "vitest";
import {
  classifyChecks,
  classifyInaccessible,
  commentIdFromUrl,
  GhCliClient,
  isGitHubRateLimitError,
  isPermissionError,
  parseMergeStateStatus,
  parseMergeStatusSnapshot,
  parseReviewThreadsPage,
  type RawCheck,
  REVIEW_THREAD_MAX_PAGES,
} from "./gh-cli";
import { Logger } from "../log/logger";

/**
 * `classifyChecks` is the pure core of `awaitChecks` (issue #41): it turns one
 * snapshot of `gh pr checks --json name,state,bucket` rows into a CI verdict. The
 * polling/timeout wrapper is exercised against real `gh` during the pilot.
 */
describe("classifyChecks", () => {
  it("reports `none` when the repo has no checks (the dogfood repo)", () => {
    expect(classifyChecks([])).toEqual({ verdict: "none", failures: [] });
  });

  it("reports `green` when every check passed or was skipped", () => {
    const checks: RawCheck[] = [
      { name: "build", bucket: "pass" },
      { name: "lint", bucket: "skipping" },
    ];
    expect(classifyChecks(checks)).toEqual({ verdict: "green", failures: [] });
  });

  it("reports `red` and names the failing/cancelled checks", () => {
    const checks: RawCheck[] = [
      { name: "build", bucket: "pass" },
      { name: "test", bucket: "fail" },
      { name: "deploy", bucket: "cancel" },
    ];
    expect(classifyChecks(checks)).toEqual({ verdict: "red", failures: ["test", "deploy"] });
  });

  it("stays `pending` while any check is still running (poller keeps waiting)", () => {
    const checks: RawCheck[] = [
      { name: "build", bucket: "pass" },
      { name: "integration", bucket: "pending" },
    ];
    expect(classifyChecks(checks)).toEqual({ verdict: "pending", failures: ["integration"] });
  });

  it("treats an unknown/absent bucket as not-yet-terminal", () => {
    expect(classifyChecks([{ name: "mystery" }])).toEqual({
      verdict: "pending",
      failures: ["mystery"],
    });
  });

  // ---- latest-run collapse (issue #125, AC2/AC3) -------------------------
  //
  // A check name can carry multiple runs (a failed run + a passing re-run). Only the
  // *latest* run — by `startedAt`/`completedAt` — reflects the check's current state,
  // so an earlier failure must never outvote a passing re-run (the example-monorepo #2113
  // incident: the gate counted a stale failed `.NET Tests` while a passing re-run of
  // the same name existed).

  it("collapses duplicate check names to the latest run: a passing re-run supersedes an earlier failure", () => {
    const checks: RawCheck[] = [
      // The prior failed run (the only red at the wire when the gate first read).
      { name: ".NET Tests", bucket: "fail", startedAt: "2026-06-21T12:30:00Z", completedAt: "2026-06-21T12:40:00Z" },
      // The passing re-run of the SAME name, started later and now green.
      { name: ".NET Tests", bucket: "pass", startedAt: "2026-06-21T12:44:00Z", completedAt: "2026-06-21T12:50:45Z" },
      { name: "CI Gate", bucket: "pass", startedAt: "2026-06-21T12:50:00Z", completedAt: "2026-06-21T12:50:52Z" },
    ];
    expect(classifyChecks(checks)).toEqual({ verdict: "green", failures: [] });
  });

  it("collapses to the latest even when the failed run appears AFTER the pass in the row order", () => {
    const checks: RawCheck[] = [
      { name: ".NET Tests", bucket: "pass", startedAt: "2026-06-21T12:44:00Z", completedAt: "2026-06-21T12:50:45Z" },
      { name: ".NET Tests", bucket: "fail", startedAt: "2026-06-21T12:30:00Z", completedAt: "2026-06-21T12:40:00Z" },
    ];
    expect(classifyChecks(checks)).toEqual({ verdict: "green", failures: [] });
  });

  it("a later failing re-run supersedes an earlier pass (a genuine regression is still caught)", () => {
    const checks: RawCheck[] = [
      { name: "build", bucket: "pass", startedAt: "2026-06-21T12:30:00Z", completedAt: "2026-06-21T12:35:00Z" },
      { name: "build", bucket: "fail", startedAt: "2026-06-21T12:40:00Z", completedAt: "2026-06-21T12:45:00Z" },
    ];
    expect(classifyChecks(checks)).toEqual({ verdict: "red", failures: ["build"] });
  });

  it("a still-running re-run of a previously-failed check stays pending (keep waiting, never red)", () => {
    const checks: RawCheck[] = [
      { name: ".NET Tests", bucket: "fail", startedAt: "2026-06-21T12:30:00Z", completedAt: "2026-06-21T12:40:00Z" },
      // The re-run is in flight: started later, no terminal completion yet.
      { name: ".NET Tests", bucket: "pending", startedAt: "2026-06-21T12:44:00Z" },
    ];
    expect(classifyChecks(checks)).toEqual({ verdict: "pending", failures: [".NET Tests"] });
  });

  it("a pending combined commit-status keeps the verdict pending (never red) while all workflow checks pass", () => {
    // PR #2136 carried a `state=pending` external commit-status context that never
    // reported. A never-completing pending status must keep the gate waiting (up to
    // ciTimeoutMinutes), not flip it to a hard red.
    const checks: RawCheck[] = [
      { name: "build", bucket: "pass", startedAt: "2026-06-21T12:30:00Z", completedAt: "2026-06-21T12:35:00Z" },
      { name: ".NET Tests", bucket: "pass", startedAt: "2026-06-21T12:44:00Z", completedAt: "2026-06-21T12:50:45Z" },
      { name: "license/cla", bucket: "pending" },
    ];
    expect(classifyChecks(checks)).toEqual({ verdict: "pending", failures: ["license/cla"] });
  });

  it("ignores gh's zero-time (`0001-01-01…`) timestamps when ordering runs", () => {
    const checks: RawCheck[] = [
      // A real failed run, vs a passing re-run gh reports with a real start but a zero
      // completed-time (still settling) — the real timestamp must win.
      { name: "test", bucket: "fail", startedAt: "2026-06-21T12:30:00Z", completedAt: "2026-06-21T12:40:00Z" },
      { name: "test", bucket: "pass", startedAt: "2026-06-21T12:44:00Z", completedAt: "0001-01-01T00:00:00Z" },
    ];
    expect(classifyChecks(checks)).toEqual({ verdict: "green", failures: [] });
  });
});

/**
 * `readChecks` is the non-blocking snapshot the off-slot CI poller takes (issue #88
 * / ADR-0022): exactly ONE `gh pr checks` read, classified through `classifyChecks`,
 * with `pending` preserved (the poller, not a single read, decides a timeout). The
 * injected `exec` seam stands in for gh so the call count and verdict are exercised.
 */
describe("GhCliClient.readChecks (off-slot CI poller, ADR-0022 stage 1)", () => {
  function makeClient(stdout: string, opts: { fail?: boolean } = {}) {
    let calls = 0;
    const argv: string[][] = [];
    const exec = async (args: string[]): Promise<string> => {
      calls++;
      argv.push(args);
      if (opts.fail) {
        throw Object.assign(new Error("gh exited 1"), { stdout });
      }
      return stdout;
    };
    const client = new GhCliClient("owner/repo", {
      logger: new Logger({ write: () => {} }),
      exec,
    });
    return { client, argv, calls: () => calls };
  }

  it("reads checks once (no polling) and maps a still-running bucket to pending", async () => {
    const rows: RawCheck[] = [{ name: "build", bucket: "pending" }];
    const { client, argv, calls } = makeClient(JSON.stringify(rows));

    expect(await client.readChecks(42)).toEqual({ state: "pending", failures: ["build"] });
    expect(calls()).toBe(1); // exactly one lean read, no loop
    // The field set carries `startedAt`/`completedAt` so classifyChecks can collapse
    // duplicate-name runs to the latest (issue #125, AC2).
    expect(argv[0]).toEqual([
      "pr",
      "checks",
      "42",
      "--repo",
      "owner/repo",
      "--json",
      "name,state,bucket,startedAt,completedAt",
    ]);
  });

  it("reports green / red / none verdicts straight from classifyChecks", async () => {
    const green = makeClient(JSON.stringify([{ name: "build", bucket: "pass" }]));
    expect(await green.client.readChecks(1)).toEqual({ state: "green", failures: [] });

    const red = makeClient(JSON.stringify([{ name: "test", bucket: "fail" }]));
    expect(await red.client.readChecks(2)).toEqual({ state: "red", failures: ["test"] });

    const none = makeClient("[]");
    expect(await none.client.readChecks(3)).toEqual({ state: "none", failures: [] });
  });

  it("reads stdout tolerantly when gh exits non-zero on a red/pending PR", async () => {
    // gh exits non-zero while checks fail/pend, but still prints the JSON rows.
    const { client } = makeClient(JSON.stringify([{ name: "deploy", bucket: "fail" }]), { fail: true });
    expect(await client.readChecks(7)).toEqual({ state: "red", failures: ["deploy"] });
  });
});

/**
 * `parseMergeStateStatus` is the pure core of `readMergeStatus` (#25): it lifts the
 * authoritative `mergeStateStatus` out of `gh pr view --json mergeStateStatus`, mapping
 * every unrecognised / blank / unparseable read to `UNKNOWN` so the merge-readiness poll
 * keeps waiting rather than treating a blank as mergeable.
 */
describe("parseMergeStateStatus (merge-race gate, #25)", () => {
  it("lifts each recognised mergeStateStatus verbatim (case-normalised)", () => {
    for (const s of ["CLEAN", "UNSTABLE", "HAS_HOOKS", "BLOCKED", "BEHIND", "DIRTY", "DRAFT", "UNKNOWN"] as const) {
      expect(parseMergeStateStatus(JSON.stringify({ mergeStateStatus: s }))).toBe(s);
    }
    expect(parseMergeStateStatus(JSON.stringify({ mergeStateStatus: "clean" }))).toBe("CLEAN");
  });

  it("maps a blank, unparseable, missing, or unrecognised value to UNKNOWN (keep waiting)", () => {
    expect(parseMergeStateStatus("")).toBe("UNKNOWN");
    expect(parseMergeStateStatus("   ")).toBe("UNKNOWN");
    expect(parseMergeStateStatus("not json")).toBe("UNKNOWN");
    expect(parseMergeStateStatus(JSON.stringify({}))).toBe("UNKNOWN");
    expect(parseMergeStateStatus(JSON.stringify({ mergeStateStatus: "WAT" }))).toBe("UNKNOWN");
  });
});

describe("GhCliClient.readMergeStatus (merge-race gate, #25)", () => {
  it("reads mergeStateStatus once and tolerates a non-zero gh exit", async () => {
    const argv: string[][] = [];
    const exec = async (args: string[]): Promise<string> => {
      argv.push(args);
      // gh can exit non-zero yet still print the JSON we want to stdout.
      throw Object.assign(new Error("gh exited 1"), {
        stdout: JSON.stringify({ mergeStateStatus: "BLOCKED" }),
      });
    };
    const client = new GhCliClient("owner/repo", { logger: new Logger({ write: () => {} }), exec });

    expect(await client.readMergeStatus(42)).toEqual({
      state: "BLOCKED",
      reviewDecision: null,
      headSha: null,
    });
    expect(argv[0]).toEqual([
      "pr",
      "view",
      "42",
      "--repo",
      "owner/repo",
      "--json",
      // `reviewDecision` + `headRefOid` ride along on the same read (issue #43): they turn
      // an opaque BLOCKED into a typed cause and anchor the hosted-review observation.
      "mergeStateStatus,reviewDecision,headRefOid",
    ]);
  });
});

/**
 * The rolling `ralph-review` comment (issue #47) is edited in place by its numeric
 * REST id. `gh … --json comments` reports each comment's `id` as a GraphQL node-id
 * *string* (e.g. `IC_kwDO…`), not that REST id — the numeric id lives only in the
 * comment's `#issuecomment-<n>` URL — so the listing derives the id from the URL.
 */
describe("comment id recovery from gh JSON (issue #47)", () => {
  it("derives the numeric REST id from a comment URL, rejecting bad inputs", () => {
    expect(commentIdFromUrl("https://github.com/o/r/pull/47#issuecomment-2222")).toBe(2222);
    expect(commentIdFromUrl("https://github.com/o/r/issues/3#issuecomment-9")).toBe(9);
    expect(commentIdFromUrl(undefined)).toBe(0);
    expect(commentIdFromUrl("https://github.com/o/r/pull/47")).toBe(47);
    expect(commentIdFromUrl("not a url")).toBe(0);
  });

  it("listPullRequestComments maps the URL's REST id, not gh's node-id string", async () => {
    // gh's actual shape: `id` is a node-id string; the numeric REST id lives only in
    // the URL. Recovery must yield a finite, positive number to PATCH by.
    const exec = async (_args: string[]): Promise<string> =>
      JSON.stringify({
        comments: [
          {
            id: "IC_kwDONODEID0001",
            author: { login: "chatgpt-codex-connector" },
            body: "Consider tightening the retry backoff.",
            url: "https://github.com/owner/repo/pull/47#issuecomment-2222",
          },
          {
            id: "IC_kwDONODEID0002",
            author: { login: "ralph-autopilot" },
            body: "```ralph-review\n{}\n```",
            url: "https://github.com/owner/repo/pull/47#issuecomment-3333",
          },
        ],
      });
    const client = new GhCliClient("owner/repo", { exec });

    const comments = await client.listPullRequestComments(47);

    expect(comments.map((c) => c.id)).toEqual([2222, 3333]);
    expect(comments.every((c) => Number.isFinite(c.id) && c.id > 0)).toBe(true);
  });
});

/**
 * `updateComment` edits a PR/issue comment in place (issue #47): the daemon keeps
 * one rolling `ralph-review` comment per phase current as fix attempts resolve
 * items. gh has no first-class edit-comment verb, so it PATCHes the REST API.
 */
describe("updateComment (issue #47)", () => {
  it("PATCHes the comment by its REST id with the body as a raw field", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]): Promise<string> => {
      calls.push(args);
      return "";
    };
    const client = new GhCliClient("owner/repo", { exec });

    await client.updateComment(2222, "## ralph-review\nupdated body");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "api",
      "--method",
      "PATCH",
      "/repos/owner/repo/issues/comments/2222",
      "-f",
      "body=## ralph-review\nupdated body",
    ]);
  });
});

/**
 * Every gh call funnels through the one retry choke point so a *transient* GitHub
 * rate-limit rejection is retried with bounded backoff instead of cascading into
 * `tick-failed` storms or flipping a succeeded run to `agent-stuck` (issue 2071).
 * A non-rate-limit fault, or a rate-limit past the budget, still propagates.
 */
describe("GhCliClient rate-limit retry (issue 2071)", () => {
  const RATE_LIMIT = "GraphQL: API rate limit already exceeded for user ID 8167862.";

  function makeClient(handler: (n: number) => string | Promise<string>, opts: { rateLimitRetries?: number } = {}) {
    let calls = 0;
    const sleeps: number[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const logger = new Logger({ write: (line) => logs.push(JSON.parse(line)) });
    const exec = async (_args: string[]): Promise<string> => handler(calls++);
    const client = new GhCliClient("owner/repo", {
      logger,
      exec,
      sleep: async (ms) => void sleeps.push(ms),
      ...opts,
    });
    return { client, sleeps, logs, calls: () => calls };
  }

  it("classifies gh's primary and secondary rate-limit messages, not unrelated faults", () => {
    // Primary core limit, secondary limit, and the abuse/403 wording (issue #101 AC1).
    expect(isGitHubRateLimitError(new Error(RATE_LIMIT))).toBe(true);
    expect(isGitHubRateLimitError({ stderr: "You have exceeded a secondary rate limit." })).toBe(true);
    expect(isGitHubRateLimitError({ stderr: "abuse detection mechanism triggered" })).toBe(true);
    expect(isGitHubRateLimitError({ stderr: "HTTP 403: You have triggered an abuse detection mechanism" })).toBe(true);
    expect(isGitHubRateLimitError({ stderr: "GraphQL: API rate limit already exceeded" })).toBe(true);
    // Unrelated gh faults must NOT be swallowed as rate limits (scoped predicate).
    expect(isGitHubRateLimitError(new Error("unknown JSON field: closedByPullRequestsReferences"))).toBe(false);
    expect(isGitHubRateLimitError(new Error("ENOENT: no such file"))).toBe(false);
    expect(isGitHubRateLimitError(null)).toBe(false);
  });

  it("retries a rate-limited call with bounded backoff, then returns once it clears", async () => {
    const { client, sleeps, logs, calls } = makeClient((n) => {
      if (n < 3) throw new Error(RATE_LIMIT);
      return "[]";
    });

    expect(await client.listOpenIssues()).toEqual([]);
    expect(calls()).toBe(4); // 3 rate-limited attempts + 1 success
    expect(sleeps).toHaveLength(3); // slept before each retry
    // Exponential off the 2s base, capped at 60s, with up to +50% jitter.
    expect(sleeps.every((ms) => ms >= 2_000 && ms <= 90_000)).toBe(true);
    expect(logs.filter((l) => l.event === "github.rate-limited")).toHaveLength(3);
  });

  it("propagates a non-rate-limit error immediately (no retry, no sleep)", async () => {
    const { client, sleeps, calls } = makeClient(() => {
      throw new Error("unknown JSON field: closedByPullRequestsReferences");
    });

    await expect(client.listOpenIssues()).rejects.toThrow(/unknown JSON field/);
    expect(calls()).toBe(1);
    expect(sleeps).toHaveLength(0);
  });

  it("gives up after the retry budget and rethrows the rate-limit error", async () => {
    const { client, sleeps, calls } = makeClient(
      () => {
        throw new Error(RATE_LIMIT);
      },
      { rateLimitRetries: 2 },
    );

    await expect(client.listOpenIssues()).rejects.toThrow(/rate limit/i);
    expect(calls()).toBe(3); // initial attempt + 2 retries
    expect(sleeps).toHaveLength(2);
  });
});

/**
 * `isDependencySatisfied` is the binding dependency gate (DESIGN §2): a
 * `## Blocked by #n` blocker is satisfied iff it is CLOSED *and* was closed by a
 * merged PR. A failed `gh` query must fail **closed** — never silently degrade
 * "CLOSED with a merged PR" to "merely CLOSED" (ADR-0011, issue #11). The single
 * `gh issue view --json state,closedByPullRequestsReferences` call is faked here
 * via the injected `exec` seam so both fields and the gh-call count are exercised.
 */
describe("GhCliClient.isDependencySatisfied", () => {
  type ExecHandler = (args: string[]) => string | Promise<string>;

  function makeClient(handler: ExecHandler) {
    const calls: string[][] = [];
    const logs: Array<Record<string, unknown>> = [];
    const logger = new Logger({ write: (line) => logs.push(JSON.parse(line)) });
    const exec = async (args: string[]): Promise<string> => {
      calls.push(args);
      return handler(args);
    };
    const client = new GhCliClient("owner/repo", { logger, exec });
    return { client, calls, logs };
  }

  it("fails CLOSED and warns `dependency.query-failed` when the query errors", async () => {
    const { client, calls, logs } = makeClient(() => {
      throw new Error("unknown JSON field: closedByPullRequestsReferences");
    });
    expect(await client.isDependencySatisfied(7)).toBe(false);
    // One collapsed query, then it bails — no degrade to "merely CLOSED".
    expect(calls).toHaveLength(1);
    const warn = logs.find((l) => l.event === "dependency.query-failed");
    expect(warn).toBeDefined();
    expect(warn?.level).toBe("warn");
    expect(warn?.issue).toBe(7);
  });

  it("uses a single gh call fetching both state and the closing PRs", async () => {
    const { client, calls } = makeClient(() =>
      JSON.stringify({ state: "CLOSED", closedByPullRequestsReferences: [{ state: "MERGED" }] }),
    );
    await client.isDependencySatisfied(7);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "issue",
      "view",
      "7",
      "--repo",
      "owner/repo",
      "--json",
      "state,closedByPullRequestsReferences",
    ]);
  });

  it("is satisfied when CLOSED with a merged closing PR", async () => {
    const { client } = makeClient(() =>
      JSON.stringify({ state: "CLOSED", closedByPullRequestsReferences: [{ state: "MERGED" }] }),
    );
    expect(await client.isDependencySatisfied(7)).toBe(true);
  });

  it("is unsatisfied when the blocker is still OPEN", async () => {
    const { client } = makeClient(() =>
      JSON.stringify({ state: "OPEN", closedByPullRequestsReferences: [] }),
    );
    expect(await client.isDependencySatisfied(7)).toBe(false);
  });

  it("keeps a CLOSED-but-not-merged blocker ineligible (closed with no closing PR)", async () => {
    const { client } = makeClient(() =>
      JSON.stringify({ state: "CLOSED", closedByPullRequestsReferences: [] }),
    );
    expect(await client.isDependencySatisfied(7)).toBe(false);
  });

  it("keeps a CLOSED blocker ineligible when its closing PR was closed unmerged", async () => {
    const { client } = makeClient(() =>
      JSON.stringify({ state: "CLOSED", closedByPullRequestsReferences: [{ state: "CLOSED" }] }),
    );
    expect(await client.isDependencySatisfied(7)).toBe(false);
  });

  it("treats a squash-merged closer with null state as satisfied (merge can't be disproven)", async () => {
    // Observed: #7's squash-merge closer #17 reported `state: null` though #7 is
    // closed and merged into main. A null/unknown merge state must not false-block.
    const { client, logs } = makeClient(() =>
      JSON.stringify({ state: "CLOSED", closedByPullRequestsReferences: [{ state: null }] }),
    );
    expect(await client.isDependencySatisfied(7)).toBe(true);
    expect(logs.some((l) => l.event === "dependency.merge-unconfirmed")).toBe(true);
  });
});

describe("GhCliClient.closePullRequest", () => {
  it("closes the PR with an explanatory comment and keeps the branch (#34)", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]): Promise<string> => {
      calls.push(args);
      return "";
    };
    const client = new GhCliClient("owner/repo", { exec });

    await client.closePullRequest(31, "orphaned by a mid-run failure");

    // `gh pr close --comment` flags *and* closes; no `--delete-branch` so the
    // work on the branch survives for a re-admitted run or a human.
    expect(calls).toEqual([
      ["pr", "close", "31", "--repo", "owner/repo", "--comment", "orphaned by a mid-run failure"],
    ]);
    expect(calls[0]).not.toContain("--delete-branch");
  });
});

describe("GhCliClient.closeIssue", () => {
  it("closes the issue with an explanatory comment when given (#114)", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]): Promise<string> => {
      calls.push(args);
      return "";
    };
    const client = new GhCliClient("owner/repo", { exec });

    await client.closeIssue(77, "closed from the control plane — out of scope");

    expect(calls).toEqual([
      ["issue", "close", "77", "--repo", "owner/repo", "--comment", "closed from the control plane — out of scope"],
    ]);
  });

  it("closes with no comment arg when none is supplied (#114)", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]): Promise<string> => {
      calls.push(args);
      return "";
    };
    const client = new GhCliClient("owner/repo", { exec });

    await client.closeIssue(77);

    expect(calls).toEqual([["issue", "close", "77", "--repo", "owner/repo"]]);
  });
});

describe("GhCliClient.removeLabel", () => {
  function makeClient(handler: (args: string[]) => string | Promise<string>) {
    const calls: string[][] = [];
    const exec = async (args: string[]): Promise<string> => {
      calls.push(args);
      return handler(args);
    };
    return { client: new GhCliClient("owner/repo", { exec }), calls };
  }

  it("treats a missing label as an idempotent no-op", async () => {
    const { client, calls } = makeClient(() => {
      throw Object.assign(new Error("could not remove label: 'agent-stuck' not found"), {
        stderr: "could not remove label: 'agent-stuck' not found",
      });
    });

    await client.removeLabel(42, "agent-stuck");

    expect(calls).toEqual([["issue", "edit", "42", "--repo", "owner/repo", "--remove-label", "agent-stuck"]]);
  });

  it("propagates real gh failures instead of swallowing the removal side of a swap", async () => {
    const { client, calls } = makeClient(() => {
      throw Object.assign(new Error("HTTP 500: something went wrong"), { stderr: "HTTP 500: something went wrong" });
    });

    await expect(client.removeLabel(42, "agent-stuck")).rejects.toThrow(/500/);
    expect(calls).toEqual([["issue", "edit", "42", "--repo", "owner/repo", "--remove-label", "agent-stuck"]]);
  });
});

/**
 * `addLabel` must be able to apply a daemon-owned label the target repo has not
 * pre-created — notably `daemon-anomaly` (issue #27). When gh reports the label is
 * not found, it self-creates the label (idempotent `--force`) and retries; any
 * other failure is real and propagates without a spurious create. The adapter holds
 * no per-label knowledge: a label's cosmetics are supplied by its owner via `opts`
 * and threaded straight into `label create`, with neutral defaults when absent.
 */
describe("GhCliClient.addLabel — self-creates a missing daemon label", () => {
  function makeClient(handler: (args: string[]) => string | Promise<string>) {
    const calls: string[][] = [];
    const logger = new Logger({ write: () => {} });
    const exec = async (args: string[]): Promise<string> => {
      calls.push(args);
      return handler(args);
    };
    return { client: new GhCliClient("owner/repo", { logger, exec }), calls };
  }

  /** A handler that fails the first `--add-label` edit as "label not found", then succeeds. */
  function failFirstEdit(): (args: string[]) => string {
    let firstEditSeen = false;
    return (args) => {
      if (args[0] === "issue" && args.includes("--add-label") && !firstEditSeen) {
        firstEditSeen = true;
        const err = new Error("failed to run git: could not add label: 'daemon-anomaly' not found");
        throw Object.assign(err, { stderr: "could not add label: 'daemon-anomaly' not found" });
      }
      return "";
    };
  }

  function createArg(create: string[], flag: string): string {
    return create[create.indexOf(flag) + 1]!;
  }

  it("creates the label then retries the edit when gh reports it not found", async () => {
    const { client, calls } = makeClient(failFirstEdit());

    await client.addLabel(42, "daemon-anomaly");

    expect(calls.map((c) => c[0])).toEqual(["issue", "label", "issue"]);
    const create = calls[1]!;
    expect(create.slice(0, 3)).toEqual(["label", "create", "daemon-anomaly"]);
    expect(create).toContain("--force");
  });

  it("threads owner-supplied color/description into the self-create", async () => {
    const { client, calls } = makeClient(failFirstEdit());

    await client.addLabel(42, "daemon-anomaly", {
      color: "B60205",
      description: "needs human attention",
    });

    const create = calls[1]!;
    expect(createArg(create, "--color")).toBe("B60205");
    expect(createArg(create, "--description")).toBe("needs human attention");
  });

  it("self-creates with neutral defaults when the caller supplies no cosmetics", async () => {
    const { client, calls } = makeClient(failFirstEdit());

    await client.addLabel(42, "daemon-anomaly");

    const create = calls[1]!;
    expect(createArg(create, "--color")).toBe("ededed");
    expect(createArg(create, "--description")).toBe("Managed by ralph-autopilot");
  });

  it("propagates a non-not-found failure without creating a label", async () => {
    const { client, calls } = makeClient(() => {
      throw new Error("HTTP 500: something went wrong");
    });
    await expect(client.addLabel(42, "agent-stuck")).rejects.toThrow(/500/);
    expect(calls.map((c) => c[0])).toEqual(["issue"]); // no label-create attempt
  });
});

describe("GhCliClient.applyLabelPatch", () => {
  function makeClient(handler: (args: string[]) => string | Promise<string>) {
    const calls: string[][] = [];
    const logger = new Logger({ write: () => {} });
    const exec = async (args: string[]): Promise<string> => {
      calls.push(args);
      return handler(args);
    };
    return { client: new GhCliClient("owner/repo", { logger, exec }), calls };
  }

  it("applies removals and additions in one issue edit", async () => {
    const { client, calls } = makeClient(() => "");

    await client.applyLabelPatch(42, { remove: ["agent-stuck", "afk"], add: ["ready-for-agent"] });

    expect(calls).toEqual([
      [
        "issue",
        "edit",
        "42",
        "--repo",
        "owner/repo",
        "--remove-label",
        "agent-stuck,afk",
        "--add-label",
        "ready-for-agent",
      ],
    ]);
  });

  it("keeps add-wins semantics when a label appears in both sides of the patch", async () => {
    const { client, calls } = makeClient(() => "");

    await client.applyLabelPatch(42, { remove: ["priority:p0", "priority:p1"], add: ["priority:p0"] });

    expect(calls).toEqual([
      [
        "issue",
        "edit",
        "42",
        "--repo",
        "owner/repo",
        "--remove-label",
        "priority:p1",
        "--add-label",
        "priority:p0",
      ],
    ]);
  });

  it("treats an absent removed label as an idempotent no-op and retries the remaining patch", async () => {
    let firstEditSeen = false;
    const { client, calls } = makeClient((args) => {
      if (args[0] === "issue" && !firstEditSeen) {
        firstEditSeen = true;
        throw Object.assign(new Error("could not remove label: 'agent-stuck' not found"), {
          stderr: "could not remove label: 'agent-stuck' not found",
        });
      }
      return "";
    });

    await client.applyLabelPatch(42, { remove: ["agent-stuck", "afk"], add: ["ready-for-agent"] });

    expect(calls).toEqual([
      [
        "issue",
        "edit",
        "42",
        "--repo",
        "owner/repo",
        "--remove-label",
        "agent-stuck,afk",
        "--add-label",
        "ready-for-agent",
      ],
      ["issue", "edit", "42", "--repo", "owner/repo", "--remove-label", "afk", "--add-label", "ready-for-agent"],
    ]);
  });

  it("self-creates a missing added label and retries the whole patch", async () => {
    let firstEditSeen = false;
    const { client, calls } = makeClient((args) => {
      if (args[0] === "issue" && !firstEditSeen) {
        firstEditSeen = true;
        throw Object.assign(new Error("could not add label: 'daemon-anomaly' not found"), {
          stderr: "could not add label: 'daemon-anomaly' not found",
        });
      }
      return "";
    });

    await client.applyLabelPatch(42, { remove: ["agent-stuck"], add: ["daemon-anomaly"] });

    expect(calls.map((c) => c[0])).toEqual(["issue", "label", "issue"]);
    expect(calls[1]!.slice(0, 3)).toEqual(["label", "create", "daemon-anomaly"]);
    expect(calls[2]).toEqual([
      "issue",
      "edit",
      "42",
      "--repo",
      "owner/repo",
      "--remove-label",
      "agent-stuck",
      "--add-label",
      "daemon-anomaly",
    ]);
  });

  it("propagates non-label-not-found failures without creating labels", async () => {
    const { client, calls } = makeClient(() => {
      throw new Error("HTTP 500: something went wrong");
    });

    await expect(client.applyLabelPatch(42, { remove: ["agent-stuck"], add: ["ready-for-agent"] })).rejects.toThrow(
      /500/,
    );
    expect(calls.map((c) => c[0])).toEqual(["issue"]);
  });
});

/**
 * `listPullRequestComments` and `listIssueComments` were byte-identical except the
 * `pr`/`issue` subcommand. They now share one helper, so both must request the
 * same `--json comments` field set off the right subcommand and map rows identically.
 */
describe("GhCliClient comment listing", () => {
  function makeClient(handler: (args: string[]) => string) {
    const calls: string[][] = [];
    const exec = async (args: string[]): Promise<string> => {
      calls.push(args);
      return handler(args);
    };
    return { client: new GhCliClient("owner/repo", { exec }), calls };
  }

  // gh's actual shape: `id` is a GraphQL node-id string; the numeric REST id lives
  // only in the comment's `#issuecomment-<n>` URL (issue #47). The first comment
  // carries a URL (mapped to its REST id); the second omits it (last-ditch fallback
  // to the listing index — never used to edit a comment).
  const commentsJson = JSON.stringify({
    comments: [
      {
        id: "IC_kwDO0001",
        author: { login: "octocat" },
        body: "hello",
        url: "https://github.com/owner/repo/pull/42#issuecomment-11",
      },
      { author: null, body: "" },
    ],
  });

  it("lists PR comments off `pr view --json comments` and maps rows", async () => {
    const { client, calls } = makeClient(() => commentsJson);
    const comments = await client.listPullRequestComments(42);
    expect(calls[0]).toEqual(["pr", "view", "42", "--repo", "owner/repo", "--json", "comments"]);
    expect(comments).toEqual([
      { id: 11, author: "octocat", body: "hello" },
      { id: 1, author: "", body: "" },
    ]);
  });

  it("lists issue comments off `issue view --json comments` and maps rows identically", async () => {
    const { client, calls } = makeClient(() => commentsJson);
    const comments = await client.listIssueComments(7);
    expect(calls[0]).toEqual(["issue", "view", "7", "--repo", "owner/repo", "--json", "comments"]);
    // Same mapping as the PR path — they share one helper.
    expect(comments).toEqual([
      { id: 11, author: "octocat", body: "hello" },
      { id: 1, author: "", body: "" },
    ]);
  });
});

/**
 * The **native** parent/sub-issue contract on the real adapter (ADR-0040), driven
 * entirely through the injected `exec` — the unit suite makes no network call. Two
 * things are proved here: the argv gh is actually asked to run (so the GraphQL
 * query, not a REST guess, is what carries the hierarchy), and the pure mapping
 * from GitHub's payload to a typed {@link HierarchyRead}.
 */
describe("GhCliClient native hierarchy reads", () => {
  const issuePayload = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      data: {
        repository: {
          issue: {
            id: "I_leaf",
            number: 41,
            title: "the leaf",
            state: "OPEN",
            repository: { nameWithOwner: "owner/repo" },
            parent: {
              id: "I_mid",
              number: 12,
              title: "the middle",
              state: "OPEN",
              repository: { nameWithOwner: "owner/repo" },
            },
            subIssues: {
              nodes: [
                {
                  id: "I_kid",
                  number: 77,
                  title: "a sub-issue",
                  state: "CLOSED",
                  repository: { nameWithOwner: "owner/repo" },
                },
              ],
            },
            ...over,
          },
        },
      },
    });

  function makeClient(out: string) {
    const calls: string[][] = [];
    const exec = async (args: string[]): Promise<string> => {
      calls.push(args);
      return out;
    };
    return { client: new GhCliClient("owner/repo", { exec }), calls };
  }

  it("asks GraphQL for the native parent and sub-issues in one call", async () => {
    const { client, calls } = makeClient(issuePayload());

    const read = await client.readIssueHierarchy({ repo: "owner/repo", number: 41 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 2)).toEqual(["api", "graphql"]);
    const query = calls[0]!.find((a) => a.startsWith("query="))!;
    expect(query).toContain("parent{");
    expect(query).toContain("subIssues(");
    expect(calls[0]).toContain("owner=owner");
    expect(calls[0]).toContain("name=repo");
    expect(calls[0]).toContain("number=41");
    if (read.kind !== "node") throw new Error("expected a node");
    expect(read.node).toEqual({
      ref: { repo: "owner/repo", number: 41 },
      id: "I_leaf",
      title: "the leaf",
      state: "OPEN",
    });
    expect(read.parent).toEqual({
      kind: "node",
      node: {
        ref: { repo: "owner/repo", number: 12 },
        id: "I_mid",
        title: "the middle",
        state: "OPEN",
      },
    });
    expect(read.children.map((c) => c.ref.number)).toEqual([77]);
    expect(read.children[0]!.state).toBe("CLOSED");
  });

  it("represents a cross-repository parent from the node's own repository field", async () => {
    const { client } = makeClient(
      issuePayload({
        parent: {
          id: "I_prog",
          number: 3,
          title: "programme",
          state: "OPEN",
          repository: { nameWithOwner: "owner/programme" },
        },
      }),
    );

    const read = await client.readIssueHierarchy({ repo: "owner/repo", number: 41 });

    if (read.kind !== "node" || read.parent.kind !== "node") throw new Error("expected a parent node");
    expect(read.parent.node.ref).toEqual({ repo: "owner/programme", number: 3 });
  });

  it("reports a parentless issue as `none` — the only value that means absolute root", async () => {
    const { client } = makeClient(issuePayload({ parent: null }));

    const read = await client.readIssueHierarchy({ repo: "owner/repo", number: 41 });

    if (read.kind !== "node") throw new Error("expected a node");
    expect(read.parent).toEqual({ kind: "none" });
  });

  it("never turns a masked parent into `none`", async () => {
    const out = JSON.stringify({
      data: { repository: { issue: { ...JSON.parse(issuePayload()).data.repository.issue, parent: null } } },
      errors: [{ type: "FORBIDDEN", message: "Resource not accessible", path: ["repository", "issue", "parent"] }],
    });
    const { client } = makeClient(out);

    const read = await client.readIssueHierarchy({ repo: "owner/repo", number: 41 });

    if (read.kind !== "node") throw new Error("expected a node");
    expect(read.parent).toMatchObject({ kind: "inaccessible", reason: "unauthorized" });
  });

  it("classifies a missing issue as deleted and a masked one as unauthorized", async () => {
    const deleted = JSON.stringify({
      data: { repository: { issue: null } },
      errors: [{ type: "NOT_FOUND", message: "Could not resolve to an Issue with the number 99." }],
    });
    const masked = JSON.stringify({
      data: { repository: null },
      errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }],
    });

    expect(await makeClient(deleted).client.readIssueHierarchy({ repo: "owner/repo", number: 99 })).toMatchObject({
      kind: "inaccessible",
      reason: "deleted",
    });
    expect(await makeClient(masked).client.readIssueHierarchy({ repo: "private/vault", number: 5 })).toMatchObject({
      kind: "inaccessible",
      reason: "unauthorized",
    });
  });

  it("fails closed to `error` on an empty or unparseable payload", async () => {
    expect(await makeClient("").client.readIssueHierarchy({ repo: "owner/repo", number: 1 })).toMatchObject({
      kind: "inaccessible",
      reason: "error",
    });
    expect(await makeClient("<html>").client.readIssueHierarchy({ repo: "owner/repo", number: 1 })).toMatchObject({
      kind: "inaccessible",
      reason: "error",
    });
  });

  it("classifies inaccessibility from gh's own wording", () => {
    expect(classifyInaccessible("Could not resolve to an Issue with the number 99.")).toBe("deleted");
    expect(classifyInaccessible("HTTP 403: Resource not accessible by integration")).toBe("unauthorized");
    expect(classifyInaccessible("dial tcp: lookup api.github.com: no such host")).toBe("error");
  });
});

/**
 * The cross-repo content + comment surface the context assembler and the decision
 * ledger read through: `--repo` comes off the ref, so a node in another repository
 * costs the same one call as a local one.
 */
describe("GhCliClient cross-repo node reads and writes", () => {
  function makeClient(out: (args: string[]) => string) {
    const calls: string[][] = [];
    const exec = async (args: string[]): Promise<string> => {
      calls.push(args);
      return out(args);
    };
    return { client: new GhCliClient("owner/repo", { exec }), calls };
  }

  it("reads a cross-repo node's body and comments in one `issue view`", async () => {
    const { client, calls } = makeClient(() =>
      JSON.stringify({
        id: "I_other",
        number: 3,
        title: "programme",
        state: "OPEN",
        body: "the programme body",
        comments: [
          {
            id: "IC_x",
            author: { login: "octocat" },
            body: "a decision",
            url: "https://github.com/owner/programme/issues/3#issuecomment-99",
          },
        ],
      }),
    );

    const read = await client.readIssueContent({ repo: "owner/programme", number: 3 });

    expect(calls[0]).toEqual([
      "issue",
      "view",
      "3",
      "--repo",
      "owner/programme",
      "--json",
      "id,number,title,body,state,comments",
    ]);
    if (read.kind !== "content") throw new Error("expected content");
    expect(read.body).toBe("the programme body");
    expect(read.comments).toEqual([{ id: 99, author: "octocat", body: "a decision" }]);
    expect(read.node.ref).toEqual({ repo: "owner/programme", number: 3 });
  });

  it("maps a failed content read to a typed inaccessible result, not a throw", async () => {
    const exec = async (): Promise<string> => {
      throw Object.assign(new Error("gh failed"), { stderr: "HTTP 404: Not Found" });
    };
    const client = new GhCliClient("owner/repo", { exec });

    expect(await client.readIssueContent({ repo: "owner/gone", number: 1 })).toMatchObject({
      kind: "inaccessible",
      reason: "deleted",
    });
  });

  it("posts and edits a comment on the node's own repo", async () => {
    const { client, calls } = makeClient(
      () => "https://github.com/owner/programme/issues/3#issuecomment-4242\n",
    );

    expect(await client.postNodeComment({ repo: "owner/programme", number: 3 }, "body")).toEqual({
      id: 4242,
    });
    await client.updateNodeComment({ repo: "owner/programme", number: 3 }, 4242, "new body");

    expect(calls[0]).toEqual([
      "issue",
      "comment",
      "3",
      "--repo",
      "owner/programme",
      "--body",
      "body",
    ]);
    expect(calls[1]).toEqual([
      "api",
      "--method",
      "PATCH",
      "/repos/owner/programme/issues/comments/4242",
      "-f",
      "body=new body",
    ]);
  });
});

/**
 * The false-root class of defect on the real adapter: a partial GraphQL response —
 * `parent: null` alongside an error — must never read as "this issue has no
 * parent". A rate-limited read that manufactured a root would let an
 * initiative-scoped decision, or the derived index, land on the wrong node.
 */
describe("GhCliClient never manufactures a root from a partial response", () => {
  const withParentNull = (errors: unknown[]) =>
    JSON.stringify({
      data: {
        repository: {
          issue: {
            id: "I_leaf",
            number: 41,
            title: "the leaf",
            state: "OPEN",
            repository: { nameWithOwner: "owner/repo" },
            parent: null,
            subIssues: { totalCount: 0, nodes: [] },
          },
        },
      },
      errors,
    });

  const read = async (out: string) =>
    new GhCliClient("owner/repo", { exec: async () => out }).readIssueHierarchy({
      repo: "owner/repo",
      number: 41,
    });

  it("fails closed on an unpathed error (rate limit, node limit, generic fault)", async () => {
    for (const err of [
      { type: "RATE_LIMITED", message: "API rate limit exceeded for installation" },
      { type: "MAX_NODE_LIMIT_EXCEEDED", message: "the query exceeded the node limit" },
      { message: "Something went wrong while executing your query" },
    ]) {
      const result = await read(withParentNull([err]));
      if (result.kind !== "node") throw new Error("expected a node");
      expect(result.parent.kind).toBe("inaccessible");
    }
  });

  it("fails closed on an error pathed at a prefix of `parent`", async () => {
    const result = await read(
      withParentNull([{ type: "FORBIDDEN", message: "Resource not accessible", path: ["repository", "issue"] }]),
    );
    if (result.kind !== "node") throw new Error("expected a node");
    expect(result.parent).toMatchObject({ kind: "inaccessible", reason: "unauthorized" });
  });

  it("still reports `none` for a clean response with no parent", async () => {
    const result = await read(withParentNull([]));
    if (result.kind !== "node") throw new Error("expected a node");
    expect(result.parent).toEqual({ kind: "none" });
  });
});

/**
 * A sub-issue page tops out server-side, so the adapter must report GitHub's own
 * total. Without it a node with more children than one page looks complete, and the
 * compact map's `omitted` count reads 0 while descendants are missing.
 */
describe("GhCliClient reports the true sub-issue count", () => {
  it("asks for `totalCount` and carries it through", async () => {
    const calls: string[][] = [];
    const client = new GhCliClient("owner/repo", {
      exec: async (args) => {
        calls.push(args);
        return JSON.stringify({
          data: {
            repository: {
              issue: {
                id: "I_root",
                number: 1,
                title: "root",
                state: "OPEN",
                repository: { nameWithOwner: "owner/repo" },
                parent: null,
                subIssues: {
                  totalCount: 120,
                  nodes: [
                    { id: "I_a", number: 2, title: "a", state: "OPEN", repository: { nameWithOwner: "owner/repo" } },
                  ],
                },
              },
            },
          },
        });
      },
    });

    const result = await client.readIssueHierarchy({ repo: "owner/repo", number: 1 });

    expect(calls[0]!.find((a) => a.startsWith("query="))).toContain("totalCount");
    if (result.kind !== "node") throw new Error("expected a node");
    expect(result.childCount).toBe(120);
    expect(result.children).toHaveLength(1);
  });
});

// ── hosted-review GraphQL adapter contract (issue #43) ────────────────────────
//
// The real adapter — `parseReviewThreadsPage`, the `readReviewThreads` pagination loop,
// `replyToReviewThread`/`resolveReviewThread`, `parseMergeStatusSnapshot`, `isPermissionError`
// — is the SOLE translation from GitHub's live GraphQL payload into the `ReviewThread` domain
// type every fail-closed hosted-review decision depends on. The FakeGitHub-based suites
// (hosted-review/hosted-gate.test.ts) never invoke this parser and cannot model real cursoring,
// so a wire-format regression here (a bot misclassified as human, a dropped `reviewedSha`, a
// mis-read `pageInfo` that stops paging early or overruns the cap) would silently defeat the gate
// with no test failing. These contract tests drive it directly against recorded payloads.

/** One `reviewThreads` GraphQL page, exactly as `gh api graphql` prints it to stdout. */
function reviewThreadsPage(opts: {
  headRefOid?: string | null;
  hasNextPage?: boolean;
  endCursor?: string | null;
  nodes?: unknown[];
}): string {
  const pullRequest: Record<string, unknown> = {
    reviewThreads: {
      pageInfo: { hasNextPage: opts.hasNextPage ?? false, endCursor: opts.endCursor ?? null },
      nodes: opts.nodes ?? [],
    },
  };
  if (opts.headRefOid !== undefined) {
    pullRequest.headRefOid = opts.headRefOid;
  }
  return JSON.stringify({ data: { repository: { pullRequest } } });
}

/** A minimal well-formed thread node with a single bot comment — for pagination-shape tests. */
function threadNode(id: string, comments?: { hasNextPage?: boolean; endCursor?: string | null; nodes?: unknown[] }): unknown {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    path: "src/x.ts",
    line: 1,
    diffSide: "RIGHT",
    resolvedBy: null,
    comments: {
      pageInfo: { hasNextPage: comments?.hasNextPage ?? false, endCursor: comments?.endCursor ?? null },
      nodes: comments?.nodes ?? [
        {
          id: `${id}_c`,
          databaseId: 1,
          body: "b",
          createdAt: "2026-08-01T00:00:00Z",
          commit: { oid: "sha" },
          author: { login: "chatgpt-codex-connector", __typename: "Bot" },
        },
      ],
    },
  };
}

/** One `node(id:…){ … comments }` follow-up page, as `gh api graphql` prints it. */
function threadCommentsPage(opts: { hasNextPage?: boolean; endCursor?: string | null; nodes?: unknown[] }): string {
  return JSON.stringify({
    data: {
      node: {
        comments: {
          pageInfo: { hasNextPage: opts.hasNextPage ?? false, endCursor: opts.endCursor ?? null },
          nodes: opts.nodes ?? [],
        },
      },
    },
  });
}

/** A comment node on the wire. */
function commentNode(id: string, body: string): unknown {
  return {
    id,
    databaseId: 2,
    body,
    createdAt: "2026-08-01T00:00:00Z",
    author: { login: "chatgpt-codex-connector", __typename: "Bot" },
  };
}

describe("parseReviewThreadsPage (the hosted-review wire → domain translation, #43)", () => {
  it("translates a full GraphQL payload into the ReviewThread domain shape", () => {
    const parsed = parseReviewThreadsPage(
      reviewThreadsPage({
        headRefOid: "headsha1",
        hasNextPage: false,
        endCursor: null,
        nodes: [
          {
            id: "PRRT_bot",
            isResolved: false,
            isOutdated: false,
            path: "src/app.ts",
            line: 42,
            diffSide: "RIGHT",
            resolvedBy: null,
            comments: {
              nodes: [
                {
                  id: "PRRC_1",
                  databaseId: 9001,
                  body: "P1: unbounded loop.",
                  createdAt: "2026-08-01T00:00:00Z",
                  originalCommit: { oid: "origsha" },
                  commit: { oid: "reviewedsha" },
                  author: { login: "chatgpt-codex-connector", __typename: "Bot" },
                },
              ],
            },
          },
        ],
      }),
    );
    expect(parsed.headSha).toBe("headsha1");
    expect(parsed.hasNextPage).toBe(false);
    expect(parsed.endCursor).toBe(null);
    expect(parsed.threads).toEqual([
      {
        id: "PRRT_bot",
        isResolved: false,
        isOutdated: false,
        path: "src/app.ts",
        line: 42,
        side: "RIGHT",
        // commit.oid wins over originalCommit.oid — the head the reviewer actually saw.
        reviewedSha: "reviewedsha",
        resolvedBy: null,
        comments: [
          {
            id: "PRRC_1",
            databaseId: 9001,
            author: "chatgpt-codex-connector",
            authorIsBot: true,
            body: "P1: unbounded loop.",
            createdAt: "2026-08-01T00:00:00Z",
          },
        ],
      },
    ]);
  });

  it("classifies the author: __typename Bot, a [bot]-suffixed App login, and a human", () => {
    const [botByTypename, appByLogin, human] = parseReviewThreadsPage(
      reviewThreadsPage({
        nodes: [
          {
            id: "PRRT_a",
            comments: { nodes: [{ id: "c_a", author: { login: "chatgpt-codex-connector", __typename: "Bot" } }] },
          },
          // A GitHub App comment can arrive as a User actor with a `[bot]` login suffix — still a bot.
          { id: "PRRT_b", comments: { nodes: [{ id: "c_b", author: { login: "coderabbitai[bot]", __typename: "User" } }] } },
          { id: "PRRT_c", comments: { nodes: [{ id: "c_c", author: { login: "octocat", __typename: "User" } }] } },
        ],
      }),
    ).threads;
    expect(botByTypename!.comments[0]!.authorIsBot).toBe(true);
    expect(appByLogin!.comments[0]!.authorIsBot).toBe(true);
    expect(human!.comments[0]!.authorIsBot).toBe(false);
  });

  it("anchors reviewedSha to the first commit.oid, else originalCommit.oid, else null", () => {
    const [both, onlyOriginal, neither] = parseReviewThreadsPage(
      reviewThreadsPage({
        nodes: [
          { id: "PRRT_1", comments: { nodes: [{ id: "c1", commit: { oid: "c1oid" }, originalCommit: { oid: "o1oid" } }] } },
          { id: "PRRT_2", comments: { nodes: [{ id: "c2", originalCommit: { oid: "o2oid" } }] } },
          { id: "PRRT_3", comments: { nodes: [{ id: "c3" }] } },
        ],
      }),
    ).threads;
    expect(both!.reviewedSha).toBe("c1oid");
    expect(onlyOriginal!.reviewedSha).toBe("o2oid");
    expect(neither!.reviewedSha).toBe(null);
  });

  it("lifts the resolved/outdated transition state and the resolver login", () => {
    const [resolved, outdated] = parseReviewThreadsPage(
      reviewThreadsPage({
        nodes: [
          {
            id: "PRRT_r",
            isResolved: true,
            isOutdated: false,
            resolvedBy: { login: "maintainer" },
            comments: { nodes: [{ id: "cr", author: { login: "octocat", __typename: "User" } }] },
          },
          { id: "PRRT_o", isResolved: false, isOutdated: true, resolvedBy: null, comments: { nodes: [{ id: "co" }] } },
        ],
      }),
    ).threads;
    expect({ isResolved: resolved!.isResolved, resolvedBy: resolved!.resolvedBy }).toEqual({
      isResolved: true,
      resolvedBy: "maintainer",
    });
    expect({ isResolved: outdated!.isResolved, isOutdated: outdated!.isOutdated }).toEqual({
      isResolved: false,
      isOutdated: true,
    });
  });

  it("lifts pageInfo for the cursor loop: hasNextPage + endCursor, defaulting to false/null", () => {
    const more = parseReviewThreadsPage(reviewThreadsPage({ hasNextPage: true, endCursor: "CURSOR2" }));
    expect({ hasNextPage: more.hasNextPage, endCursor: more.endCursor }).toEqual({ hasNextPage: true, endCursor: "CURSOR2" });
    // A payload with no reviewThreads.pageInfo at all reads as "no more pages".
    const none = parseReviewThreadsPage(JSON.stringify({ data: { repository: { pullRequest: { headRefOid: "h" } } } }));
    expect({ hasNextPage: none.hasNextPage, endCursor: none.endCursor }).toEqual({ hasNextPage: false, endCursor: null });
  });

  it("lifts per-thread comment truncation so a deep thread is never silently half-read (#43)", () => {
    // A thread with more comments than one page holds: the LATEST comment is the finding's
    // current statement and the idempotency key for reply, so a truncated comment list is a
    // wrong "latest comment" — detectable only if `comments.pageInfo` is lifted here.
    const parsed = parseReviewThreadsPage(
      reviewThreadsPage({
        headRefOid: "head1",
        nodes: [
          threadNode("PRRT_deep", { hasNextPage: true, endCursor: "CCUR1" }),
          threadNode("PRRT_shallow"),
        ],
      }),
    );
    expect(parsed.truncatedComments).toEqual([{ threadId: "PRRT_deep", endCursor: "CCUR1" }]);
  });

  it("is tolerant: blank / unparseable / missing PR / id-less nodes never throw or fabricate", () => {
    const empty = { threads: [], headSha: null, hasNextPage: false, endCursor: null, truncatedComments: [] };
    expect(parseReviewThreadsPage("")).toEqual(empty);
    expect(parseReviewThreadsPage("   ")).toEqual(empty);
    expect(parseReviewThreadsPage("not json")).toEqual(empty);
    expect(parseReviewThreadsPage(JSON.stringify({ data: { repository: { pullRequest: null } } }))).toEqual(empty);
    // A node with no string id is skipped; a comment with no string id is skipped but its thread survives.
    const parsed = parseReviewThreadsPage(
      reviewThreadsPage({
        nodes: [
          { isResolved: true, comments: { nodes: [] } },
          { id: "PRRT_ok", comments: { nodes: [{ author: { login: "x" } }, { id: "c_ok", author: { login: "octocat" } }] } },
        ],
      }),
    );
    expect(parsed.threads.map((t) => t.id)).toEqual(["PRRT_ok"]);
    expect(parsed.threads[0]!.comments.map((c) => c.id)).toEqual(["c_ok"]);
    // A missing headRefOid reads as "unknown head", never a bogus value.
    expect(parseReviewThreadsPage(reviewThreadsPage({})).headSha).toBe(null);
  });
});

describe("GhCliClient.readReviewThreads pagination loop (#43)", () => {
  /** A client whose `gh` returns each scripted page in turn (repeating the last), or throws an Error. */
  function pagingClient(pages: Array<string | Error>, opts: { rateLimitRetries?: number } = {}) {
    const calls: string[][] = [];
    let i = 0;
    const exec = async (args: string[]): Promise<string> => {
      calls.push(args);
      const next = pages[Math.min(i, pages.length - 1)];
      i += 1;
      if (next instanceof Error) throw next;
      return next ?? "";
    };
    const client = new GhCliClient("owner/repo", {
      logger: new Logger({ write: () => {} }),
      exec,
      rateLimitRetries: opts.rateLimitRetries ?? 0,
    });
    return { client, calls, count: () => i };
  }

  it("follows the cursor across pages and concatenates every thread once", async () => {
    const { client, calls } = pagingClient([
      reviewThreadsPage({ headRefOid: "head1", hasNextPage: true, endCursor: "CUR1", nodes: [threadNode("PRRT_1")] }),
      reviewThreadsPage({ headRefOid: "head1", hasNextPage: false, endCursor: null, nodes: [threadNode("PRRT_2")] }),
    ]);
    const read = await client.readReviewThreads(50);
    expect(read.kind).toBe("threads");
    expect(read.kind === "threads" && read.threads.map((t) => t.id)).toEqual(["PRRT_1", "PRRT_2"]);
    expect(read.kind === "threads" && read.headSha).toBe("head1");
    expect(calls).toHaveLength(2);
    // The GraphQL reviewThreads query is what is sent; page 0 carries no cursor, page 1 carries after=CUR1.
    expect(calls[0]!.some((a) => a.startsWith("query=") && a.includes("reviewThreads"))).toBe(true);
    expect(calls[0]!.some((a) => a.startsWith("after="))).toBe(false);
    expect(calls[1]!).toContain("after=CUR1");
  });

  it("stops at exactly the cap when the final page completes — no false fail-closed", async () => {
    const pages = Array.from({ length: REVIEW_THREAD_MAX_PAGES }, (_, i) =>
      reviewThreadsPage({
        headRefOid: "head1",
        hasNextPage: i < REVIEW_THREAD_MAX_PAGES - 1,
        endCursor: i < REVIEW_THREAD_MAX_PAGES - 1 ? `CUR${i}` : null,
        nodes: [threadNode(`PRRT_${i}`)],
      }),
    );
    const { client, calls } = pagingClient(pages);
    const read = await client.readReviewThreads(50);
    expect(read.kind).toBe("threads");
    expect(read.kind === "threads" && read.threads).toHaveLength(REVIEW_THREAD_MAX_PAGES);
    expect(calls).toHaveLength(REVIEW_THREAD_MAX_PAGES);
  });

  it("fails closed when the page cap is hit with hasNextPage still true (never a truncated set)", async () => {
    // Every page reports another page — a pathological/hostile PR. Returning the threads gathered
    // so far as kind:"threads" would let the gate merge past a blocker on an unread page.
    const { client, calls } = pagingClient([
      reviewThreadsPage({ headRefOid: "head1", hasNextPage: true, endCursor: "CUR", nodes: [threadNode("PRRT_x")] }),
    ]);
    const read = await client.readReviewThreads(50);
    expect(read.kind).toBe("unavailable");
    expect(read.kind === "unavailable" && read.reason).toBe("error");
    expect(read.kind === "unavailable" && read.detail).toContain("incomplete");
    expect(calls).toHaveLength(REVIEW_THREAD_MAX_PAGES);
  });

  it("fails closed as `permissions` when gh lacks the GraphQL scope (operator-owned)", async () => {
    const err = Object.assign(new Error("gh failed"), { stderr: "Resource not accessible by integration" });
    const { client, calls } = pagingClient([err]);
    const read = await client.readReviewThreads(50);
    expect(read.kind === "unavailable" && read.reason).toBe("permissions");
    expect(calls).toHaveLength(1); // no cursor loop past a hard failure
  });

  it("fails closed as `rate-limited` when gh is throttled (defer, not operator-owned)", async () => {
    const err = Object.assign(new Error("gh failed"), { stderr: "API rate limit already exceeded" });
    const { client } = pagingClient([err], { rateLimitRetries: 0 });
    const read = await client.readReviewThreads(50);
    expect(read.kind === "unavailable" && read.reason).toBe("rate-limited");
  });

  it("fails closed as `error` on an empty first-page read rather than reporting zero threads", async () => {
    const { client } = pagingClient([""]);
    const read = await client.readReviewThreads(50);
    expect(read.kind).toBe("unavailable");
    expect(read.kind === "unavailable" && read.reason).toBe("error");
  });

  // Thread-level pagination is not enough: a thread deeper than one comment page yields a WRONG
  // "latest comment", and the latest comment's id/hash is both the reply idempotency key and the
  // material-change key of the repeat guard (issue #43). So comments are cursored too.
  it("follows the COMMENT cursor so the latest comment is the real latest (#43)", async () => {
    const { client, calls } = pagingClient([
      reviewThreadsPage({
        headRefOid: "head1",
        nodes: [threadNode("PRRT_deep", { hasNextPage: true, endCursor: "CCUR1", nodes: [commentNode("c1", "P1: first statement")] })],
      }),
      threadCommentsPage({ hasNextPage: true, endCursor: "CCUR2", nodes: [commentNode("c2", "still wrong")] }),
      threadCommentsPage({ hasNextPage: false, endCursor: null, nodes: [commentNode("c3", "P0: and now differently wrong")] }),
    ]);

    const read = await client.readReviewThreads(50);

    expect(read.kind).toBe("threads");
    const comments = read.kind === "threads" ? read.threads[0]!.comments : [];
    expect(comments.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(comments[comments.length - 1]!.body).toContain("differently wrong");
    // Page 0 is the threads query; the follow-ups are the per-thread comment cursor.
    expect(calls).toHaveLength(3);
    expect(calls[1]!.some((a) => a.startsWith("query=") && a.includes("PullRequestReviewThread"))).toBe(true);
    expect(calls[1]!).toContain("threadId=PRRT_deep");
    expect(calls[1]!).toContain("after=CCUR1");
    expect(calls[2]!).toContain("after=CCUR2");
  });

  it("fails closed when a thread's comments overrun the page cap — never a wrong 'latest comment'", async () => {
    // Every comment page reports another: consistent with the thread-level cap, a read that
    // cannot prove it saw the newest comment is `unavailable`, not a truncated success.
    const { client } = pagingClient([
      reviewThreadsPage({
        headRefOid: "head1",
        nodes: [threadNode("PRRT_deep", { hasNextPage: true, endCursor: "CCUR", nodes: [commentNode("c1", "first")] })],
      }),
      threadCommentsPage({ hasNextPage: true, endCursor: "CCUR", nodes: [commentNode("cN", "more")] }),
    ]);

    const read = await client.readReviewThreads(50);

    expect(read.kind).toBe("unavailable");
    expect(read.kind === "unavailable" && read.reason).toBe("error");
    expect(read.kind === "unavailable" && read.detail).toContain("incomplete");
  });

  it("surfaces a rate limit hit while cursoring comments as a defer, not a partial thread", async () => {
    const err = Object.assign(new Error("gh failed"), { stderr: "API rate limit already exceeded" });
    const { client } = pagingClient(
      [
        reviewThreadsPage({
          headRefOid: "head1",
          nodes: [threadNode("PRRT_deep", { hasNextPage: true, endCursor: "CCUR1", nodes: [commentNode("c1", "first")] })],
        }),
        err,
      ],
      { rateLimitRetries: 0 },
    );
    const read = await client.readReviewThreads(50);
    expect(read.kind === "unavailable" && read.reason).toBe("rate-limited");
  });
});

describe("GhCliClient thread mutations (reply / resolve, #43)", () => {
  it("replyToReviewThread posts the reply mutation and lifts the new comment id", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]): Promise<string> => {
      calls.push(args);
      return JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { id: "PRRC_new" } } } });
    };
    const client = new GhCliClient("owner/repo", { exec });
    expect(await client.replyToReviewThread({ threadId: "PRRT_1", body: "Fixed in <sha>." })).toEqual({ id: "PRRC_new" });
    expect(calls[0]!.some((a) => a.startsWith("query=") && a.includes("addPullRequestReviewThreadReply"))).toBe(true);
    expect(calls[0]!).toContain("threadId=PRRT_1");
    expect(calls[0]!).toContain("body=Fixed in <sha>.");
  });

  it("replyToReviewThread yields an empty id on a malformed/empty response rather than throwing", async () => {
    const badJson = new GhCliClient("owner/repo", { exec: async () => "not json" });
    expect(await badJson.replyToReviewThread({ threadId: "PRRT_1", body: "x" })).toEqual({ id: "" });
    const noComment = new GhCliClient("owner/repo", { exec: async () => JSON.stringify({ data: {} }) });
    expect(await noComment.replyToReviewThread({ threadId: "PRRT_1", body: "x" })).toEqual({ id: "" });
  });

  it("resolveReviewThread posts the resolve mutation keyed on the thread id", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]): Promise<string> => {
      calls.push(args);
      return JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } } } });
    };
    const client = new GhCliClient("owner/repo", { exec });
    await client.resolveReviewThread("PRRT_1");
    expect(calls[0]!.some((a) => a.startsWith("query=") && a.includes("resolveReviewThread"))).toBe(true);
    expect(calls[0]!).toContain("threadId=PRRT_1");
  });
});

describe("parseMergeStatusSnapshot (typed BLOCKED cause, #43)", () => {
  it("lifts state, the human-review verdict and the anchoring head SHA together", () => {
    expect(
      parseMergeStatusSnapshot(JSON.stringify({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", headRefOid: "abc" })),
    ).toEqual({ state: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", headSha: "abc" });
    // Case-normalised verdict.
    expect(
      parseMergeStatusSnapshot(JSON.stringify({ mergeStateStatus: "CLEAN", reviewDecision: "approved", headRefOid: "def" })),
    ).toEqual({ state: "CLEAN", reviewDecision: "APPROVED", headSha: "def" });
  });

  it("reads a missing / blank / unrecognised field as null (unknown), never as satisfied", () => {
    expect(parseMergeStatusSnapshot(JSON.stringify({ mergeStateStatus: "BLOCKED" }))).toEqual({
      state: "BLOCKED",
      reviewDecision: null,
      headSha: null,
    });
    expect(parseMergeStatusSnapshot(JSON.stringify({ mergeStateStatus: "BLOCKED", reviewDecision: "WAT", headRefOid: "" }))).toEqual({
      state: "BLOCKED",
      reviewDecision: null,
      headSha: null,
    });
    expect(parseMergeStatusSnapshot("")).toEqual({ state: "UNKNOWN", reviewDecision: null, headSha: null });
    expect(parseMergeStatusSnapshot("not json")).toEqual({ state: "UNKNOWN", reviewDecision: null, headSha: null });
  });
});

describe("isPermissionError (operator-owned scope defect vs transient fault, #43)", () => {
  it("matches missing-scope / access-denied wording on stderr or a thrown Error", () => {
    for (const s of [
      "Resource not accessible by integration",
      "GraphQL: must have push access to view review threads",
      "Your token has insufficient scope",
      "requires authentication",
      "HTTP 403: Forbidden",
      "not authorized",
    ]) {
      expect(isPermissionError({ stderr: s })).toBe(true);
      expect(isPermissionError(new Error(s))).toBe(true);
    }
  });

  it("does not swallow a rate limit or an unrelated fault as a permission error", () => {
    expect(isPermissionError(new Error("API rate limit already exceeded"))).toBe(false);
    expect(isPermissionError({ stderr: "You have exceeded a secondary rate limit." })).toBe(false);
    expect(isPermissionError(new Error("ENOENT: no such file"))).toBe(false);
    expect(isPermissionError(null)).toBe(false);
  });
});
