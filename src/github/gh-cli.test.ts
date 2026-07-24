import { describe, expect, it } from "vitest";
import {
  classifyChecks,
  commentIdFromUrl,
  GhCliClient,
  isGitHubRateLimitError,
  parseMergeStateStatus,
  type RawCheck,
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

    expect(await client.readMergeStatus(42)).toEqual({ state: "BLOCKED" });
    expect(argv[0]).toEqual([
      "pr",
      "view",
      "42",
      "--repo",
      "owner/repo",
      "--json",
      "mergeStateStatus",
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
