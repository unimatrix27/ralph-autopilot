/**
 * The `docker run` argv builder (ADR-0038 / issue #185). Per the epic's testing decision, no
 * real image or container runs in the unit suite — but how the daemon *invokes* docker is a
 * pure, testable contract: the run is ephemeral (`--rm`), its stdio is the pipe (`-i`), it
 * carries a kill handle (`--name`), the {@link ContainerDispatch} is pushed in as an env var
 * (the runner "never reads GitHub to learn what to do"), and the agent's credentials are
 * mounted/forwarded so it can call the LLM and push. The process-spawn + stdio-bridge half of
 * {@link DockerRunner} is infra, smoke-tested against a real docker, not here.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  BRANCH_LABEL_KEY,
  buildDockerRunArgs,
  buildPsArgs,
  buildStopArgs,
  containerNameForBranch,
  credentialMountsForRoute,
  DEFAULT_STOP_TIMEOUT_SECONDS,
  DockerCliRunner,
  MODEL_ENV_VAR,
  parsePsContainers,
  PROVIDER_ENV_VAR,
  REPO_LABEL_KEY,
  STDERR_TAIL_BYTES,
  ZAI_TOKEN_ENV_NAME_VAR,
  type DockerRunnerConfig,
  type DockerSpawn,
} from "./docker-runner";
import type { ContainerDispatch, ContainerRoute } from "./assignment";

const dispatch: ContainerDispatch = {
  assignment: { issueNumber: 185, mode: "tdd", branch: "ralph/185-impl", base: "main", prompt: "go" },
  token: { value: "run-token-xyz" },
};

/** A dispatch carrying a resolved route (ADR-0037 / issue #220). */
function dispatchOn(route: ContainerRoute): ContainerDispatch {
  return { ...dispatch, route };
}

/** The `KEY=value` an `-e KEY=value` flag carries, or undefined if the var is not set inline. */
function inlineEnv(args: string[], key: string): string | undefined {
  const v = args.find((a) => a.startsWith(`${key}=`));
  return v?.slice(key.length + 1);
}

describe("buildDockerRunArgs (ADR-0038 / issue #185)", () => {
  const base: DockerRunnerConfig = { image: "ralph/agent-acme:1", credentials: {} };

  it("runs the target image ephemerally, stdio attached, with a kill-handle name", () => {
    const args = buildDockerRunArgs(base, dispatch, "ralph-run-185");
    expect(args[0]).toBe("run");
    expect(args).toContain("--rm");
    // PID-1 init so the in-container process-group reaper's SIGKILLs don't leave zombies (#213).
    expect(args).toContain("--init");
    expect(args).toContain("-i");
    expect(args).toContain("--name");
    expect(args).toContain("ralph-run-185");
    // The image is the last positional (no command override — the image's runner is the entrypoint).
    expect(args.at(-1)).toBe("ralph/agent-acme:1");
  });

  it("pushes the whole dispatch in as an env var so the runner needs no GitHub read to begin", () => {
    const args = buildDockerRunArgs(base, dispatch, "n");
    const raw = inlineEnv(args, "RALPH_CONTAINER_DISPATCH");
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual(dispatch);
  });

  it("mounts the Claude OAuth dir and Codex home read-WRITE (the SDK writes session-env there)", () => {
    const args = buildDockerRunArgs(
      { image: "img", credentials: { claudeConfigDir: "/host/.claude", codexHome: "/host/.codex" } },
      dispatch,
      "n",
    );
    // :rw, not :ro — a read-only `~/.claude` makes the SDK's `session-env/<uuid>` mkdir EROFS-fail.
    expect(args).toContain("/host/.claude:/home/ralph/.claude:rw");
    expect(args).toContain("/host/.codex:/home/ralph/.codex:rw");
  });

  it("forwards the GitHub + z.ai token env vars by name (the secret never enters argv)", () => {
    const args = buildDockerRunArgs(
      { image: "img", credentials: { githubTokenEnv: "GH_TOKEN", zaiTokenEnv: "ZAI_API_KEY" } },
      dispatch,
      "n",
    );
    // `-e NAME` (no `=value`) forwards the daemon's own env var into the container.
    expect(args).toContain("GH_TOKEN");
    expect(args).toContain("ZAI_API_KEY");
    expect(inlineEnv(args, "GH_TOKEN")).toBeUndefined();
  });

  it("tells the runner which repo it works and mounts the daemon config it resolves the target from", () => {
    const args = buildDockerRunArgs(
      { image: "img", credentials: {}, targetRepo: "owner/repo", configPath: "/abs/.ralph/config.yaml" },
      dispatch,
      "n",
    );
    // RALPH_TARGET_REPO=<repo> — without it the runner fails fast ("does not know which repo it works").
    expect(args).toContain("RALPH_TARGET_REPO=owner/repo");
    // the daemon config is bind-mounted :ro and RALPH_CONFIG_PATH points the runner at it.
    expect(args).toContain("/abs/.ralph/config.yaml:/home/ralph/ralph-config.yaml:ro");
    expect(args).toContain("RALPH_CONFIG_PATH=/home/ralph/ralph-config.yaml");
  });

  it("labels the container with its repo so the orphan sweep can scope to its own fleet (issue #256)", () => {
    const args = buildDockerRunArgs(
      { image: "img", credentials: {}, targetRepo: "owner/repo" },
      dispatch,
      "n",
    );
    // `--label ralph.repo=<repo>` is the per-container scoping handle the repo-scoped sweep filters on.
    expect(args).toContain("--label");
    expect(args).toContain(`${REPO_LABEL_KEY}=owner/repo`);
    // It is a `docker run` flag → before the image positional.
    expect(args.indexOf(`${REPO_LABEL_KEY}=owner/repo`)).toBeLessThan(args.indexOf("img"));
  });

  it("omits the repo label when targetRepo is unset, but still stamps the branch label (issue #256/#259)", () => {
    const args = buildDockerRunArgs({ image: "img", credentials: {} }, dispatch, "n");
    // No repo label without a targetRepo ...
    expect(args.some((a) => a.startsWith(`${REPO_LABEL_KEY}=`))).toBe(false);
    // ... but the branch label is ALWAYS stamped (the sweep's live-run handle, issue #259).
    expect(args).toContain(`${BRANCH_LABEL_KEY}=${dispatch.assignment.branch}`);
  });

  it("stamps the run's branch as a label so the sweep can spare a live run by it (issue #259)", () => {
    const args = buildDockerRunArgs(base, dispatch, "ralph-185-x");
    expect(args).toContain("--label");
    expect(args).toContain(`${BRANCH_LABEL_KEY}=${dispatch.assignment.branch}`);
    // It is a `docker run` flag → before the image positional.
    expect(args.indexOf(`${BRANCH_LABEL_KEY}=${dispatch.assignment.branch}`)).toBeLessThan(args.indexOf(base.image));
  });

  it("mounts the route-selected claude account's configDir + injects PROVIDER/MODEL (issue #220)", () => {
    // The daemon resolved this run onto a specific claude login; its configDir — not the static
    // box-default — is what mounts at ~/.claude, and PROVIDER/MODEL tell the in-container runner
    // which SessionBackend + model to instantiate.
    const args = buildDockerRunArgs(
      { image: "img", credentials: { claudeConfigDir: "/host/box-default", githubTokenEnv: "GH_TOKEN" } },
      dispatchOn({ provider: "claude", model: "opus", account: { id: "c2", provider: "claude", configDir: "/host/login-2" } }),
      "n",
    );
    expect(args).toContain("/host/login-2:/home/ralph/.claude:rw");
    // The static box-default dir is NOT mounted — the per-run account wins.
    expect(args).not.toContain("/host/box-default:/home/ralph/.claude:rw");
    expect(inlineEnv(args, PROVIDER_ENV_VAR)).toBe("claude");
    expect(inlineEnv(args, MODEL_ENV_VAR)).toBe("opus");
    // The shared GitHub token forwarding survives the per-run cred swap.
    expect(args).toContain("GH_TOKEN");
  });

  it("mounts the route-selected codex account's CODEX_HOME for an openai route (issue #220)", () => {
    const args = buildDockerRunArgs(
      { image: "img", credentials: {} },
      dispatchOn({ provider: "openai", model: "gpt-5.5", account: { id: "o1", provider: "openai", codexHome: "/host/codex-1" } }),
      "n",
    );
    expect(args).toContain("/host/codex-1:/home/ralph/.codex:rw");
    // No stray claude mount for a codex run (the per-run cred is exactly the selected account's).
    expect(args.some((a) => a.endsWith(":/home/ralph/.claude:rw"))).toBe(false);
    expect(inlineEnv(args, PROVIDER_ENV_VAR)).toBe("openai");
    expect(inlineEnv(args, MODEL_ENV_VAR)).toBe("gpt-5.5");
  });

  it("forwards the route-selected z.ai account's token env + names it for the runner (issue #220)", () => {
    const args = buildDockerRunArgs(
      { image: "img", credentials: {} },
      dispatchOn({ provider: "zai", model: "glm-5.2", account: { id: "z1", provider: "zai", authTokenEnv: "GLM_KEY_1" } }),
      "n",
    );
    // `-e NAME` forwards the daemon's own key env (the secret never enters argv) ...
    expect(args).toContain("GLM_KEY_1");
    expect(inlineEnv(args, "GLM_KEY_1")).toBeUndefined();
    // ... and the runner is told which env var holds it (the NAME is not a secret).
    expect(inlineEnv(args, ZAI_TOKEN_ENV_NAME_VAR)).toBe("GLM_KEY_1");
    expect(inlineEnv(args, PROVIDER_ENV_VAR)).toBe("zai");
    expect(inlineEnv(args, MODEL_ENV_VAR)).toBe("glm-5.2");
  });

  it("falls back to the box-default claude dir for a box-default login (empty configDir)", () => {
    // buildRouteWorld hands back an empty configDir for the box-default claude login; the run
    // still mounts a real dir — the box-default one from config.credentials.
    const args = buildDockerRunArgs(
      { image: "img", credentials: { claudeConfigDir: "/host/box-default", githubTokenEnv: "GH_TOKEN" } },
      dispatchOn({ provider: "claude", account: { id: "default", provider: "claude", configDir: "" } }),
      "n",
    );
    expect(args).toContain("/host/box-default:/home/ralph/.claude:rw");
    expect(inlineEnv(args, PROVIDER_ENV_VAR)).toBe("claude");
    // No model entry → no MODEL env (the provider default, resolved in-container).
    expect(inlineEnv(args, MODEL_ENV_VAR)).toBeUndefined();
  });

  it("two routes to different accounts mount different dirs (AC: pool steers per run)", () => {
    const one = buildDockerRunArgs(
      { image: "img", credentials: {} },
      dispatchOn({ provider: "claude", account: { id: "a", provider: "claude", configDir: "/host/a" } }),
      "n",
    );
    const two = buildDockerRunArgs(
      { image: "img", credentials: {} },
      dispatchOn({ provider: "claude", account: { id: "b", provider: "claude", configDir: "/host/b" } }),
      "n",
    );
    expect(one).toContain("/host/a:/home/ralph/.claude:rw");
    expect(two).toContain("/host/b:/home/ralph/.claude:rw");
    expect(one).not.toContain("/host/b:/home/ralph/.claude:rw");
  });

  it("does not serialize the route into the container dispatch env (the container reads PROVIDER/MODEL)", () => {
    const args = buildDockerRunArgs(
      { image: "img", credentials: {} },
      dispatchOn({ provider: "claude", model: "opus", account: { id: "c", provider: "claude", configDir: "/host/c" } }),
      "n",
    );
    const raw = inlineEnv(args, "RALPH_CONTAINER_DISPATCH");
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!);
    // Only the runner's marching orders ride in the dispatch JSON — not the host cred path.
    expect(parsed).toEqual({ assignment: dispatch.assignment, token: dispatch.token });
    expect(parsed.route).toBeUndefined();
  });

  it("forwards the always-forward env vars into a claude-routed container (issue #270)", () => {
    // The in-container runner validates the FULL mounted config at startup, so a configured z.ai
    // key var must be present even in a run that never uses z.ai — else the container dies at
    // config load before emitting a result frame and the review loop maxes the run out.
    const args = buildDockerRunArgs(
      { image: "img", credentials: { githubTokenEnv: "GH_TOKEN", alwaysForwardEnv: ["ZAI_API_KEY"] } },
      dispatchOn({ provider: "claude", account: { id: "c", provider: "claude", configDir: "/host/c" } }),
      "n",
    );
    // Forwarded by name (`-e NAME`, no value in argv) ...
    expect(args).toContain("ZAI_API_KEY");
    expect(inlineEnv(args, "ZAI_API_KEY")).toBeUndefined();
    // ... WITHOUT the zai steering var — only a zai route names the key var for the session.
    expect(inlineEnv(args, ZAI_TOKEN_ENV_NAME_VAR)).toBeUndefined();
  });

  it("does not double-forward a var the route already forwards (issue #270)", () => {
    const args = buildDockerRunArgs(
      { image: "img", credentials: { githubTokenEnv: "GH_TOKEN", alwaysForwardEnv: ["GLM_KEY", "GH_TOKEN"] } },
      dispatchOn({ provider: "zai", account: { id: "z", provider: "zai", authTokenEnv: "GLM_KEY" } }),
      "n",
    );
    expect(args.filter((a) => a === "GLM_KEY")).toHaveLength(1);
    expect(args.filter((a) => a === "GH_TOKEN")).toHaveLength(1);
    // The zai route still names the key var for its own session.
    expect(inlineEnv(args, ZAI_TOKEN_ENV_NAME_VAR)).toBe("GLM_KEY");
  });

  it("appends operator-supplied extra args (resource limits, etc.) before the image", () => {
    const args = buildDockerRunArgs(
      { image: "img", credentials: {}, extraArgs: ["--memory", "4g"] },
      dispatch,
      "n",
    );
    expect(args).toContain("--memory");
    expect(args.indexOf("--memory")).toBeLessThan(args.indexOf("img"));
  });
});

describe("credentialMountsForRoute — per-run cred derivation (issue #220 / ADR-0037)", () => {
  const fallback = { claudeConfigDir: "/box/.claude", githubTokenEnv: "GH_TOKEN" };

  it("derives the claude account's configDir and keeps the shared github token forwarding", () => {
    const m = credentialMountsForRoute(
      { provider: "claude", account: { id: "c", provider: "claude", configDir: "/host/c" } },
      fallback,
    );
    expect(m).toEqual({ claudeConfigDir: "/host/c", githubTokenEnv: "GH_TOKEN" });
  });

  it("falls back to the box-default claude dir when the account's configDir is empty (box login)", () => {
    const m = credentialMountsForRoute(
      { provider: "claude", account: { id: "default", provider: "claude", configDir: "" } },
      fallback,
    );
    expect(m.claudeConfigDir).toBe("/box/.claude");
  });

  it("derives codexHome for an openai account and drops the claude/zai creds", () => {
    const m = credentialMountsForRoute(
      { provider: "openai", account: { id: "o", provider: "openai", codexHome: "/host/codex" } },
      fallback,
    );
    expect(m).toEqual({ codexHome: "/host/codex", githubTokenEnv: "GH_TOKEN" });
  });

  it("names the z.ai account's token env and drops the claude/codex creds", () => {
    const m = credentialMountsForRoute(
      { provider: "zai", account: { id: "z", provider: "zai", authTokenEnv: "GLM_KEY" } },
      fallback,
    );
    expect(m).toEqual({ zaiTokenEnv: "GLM_KEY", githubTokenEnv: "GH_TOKEN" });
  });

  it("carries the always-forward set through the per-run cred swap, like the github token (issue #270)", () => {
    const m = credentialMountsForRoute(
      { provider: "claude", account: { id: "c", provider: "claude", configDir: "/host/c" } },
      { ...fallback, alwaysForwardEnv: ["ZAI_API_KEY"] },
    );
    expect(m).toEqual({ claudeConfigDir: "/host/c", githubTokenEnv: "GH_TOKEN", alwaysForwardEnv: ["ZAI_API_KEY"] });
  });
});

describe("buildStopArgs — graceful-then-hard kill backstop (issue #219 / ADR-0038)", () => {
  it("shells `docker stop -t <timeout> <name>` (SIGTERM, grace, then SIGKILL)", () => {
    expect(buildStopArgs("ralph-ralph-185-impl", 10)).toEqual(["stop", "-t", "10", "ralph-ralph-185-impl"]);
  });
});

describe("buildPsArgs / parsePsContainers — orphan-sweep fleet enumeration (issue #219/#259)", () => {
  // The format now carries the branch LABEL alongside the name (issue #259): the sweep spares a live
  // run by its branch, and per-dispatch-unique names no longer encode the branch it matches on.
  const fmt = `{{.Names}}\t{{.Label "${BRANCH_LABEL_KEY}"}}`;

  it("lists each ralph-managed container's name AND branch label by filtered `docker ps`", () => {
    expect(buildPsArgs()).toEqual(["ps", "--filter", "name=ralph-", "--format", fmt]);
  });

  it("scopes the fleet to its own repo via a `label=ralph.repo=<repo>` filter (issue #256)", () => {
    // The name prefix is global across targets; the repo label is what isolates one repo's fleet.
    expect(buildPsArgs("owner/repo")).toEqual([
      "ps",
      "--filter",
      "name=ralph-",
      "--filter",
      `label=${REPO_LABEL_KEY}=owner/repo`,
      "--format",
      fmt,
    ]);
  });

  it("parses name + branch-label rows, tolerating blank lines and re-anchoring on the ralph- prefix", () => {
    // The `--filter name=` match is an unanchored substring, so a coincidental non-ralph match is dropped.
    const stdout =
      "ralph-ralph-185-impl-tok-1\tralph/185-impl\n\n  ralph-ralph-186-review-tok-2\tralph/186-review  \nother-ralph-thing\tnope\n";
    expect(parsePsContainers(stdout)).toEqual([
      { name: "ralph-ralph-185-impl-tok-1", branch: "ralph/185-impl" },
      { name: "ralph-ralph-186-review-tok-2", branch: "ralph/186-review" },
    ]);
  });

  it("normalises an absent branch label (empty / `<no value>`) to an unmatchable empty string", () => {
    const stdout = "ralph-orphan-a\t<no value>\nralph-orphan-b\t\n";
    expect(parsePsContainers(stdout)).toEqual([
      { name: "ralph-orphan-a", branch: "" },
      { name: "ralph-orphan-b", branch: "" },
    ]);
  });
});

describe("containerNameForBranch — the docker-safe branch name stem (issue #219/#259)", () => {
  it("derives a docker-safe name stem from the branch (`/` → `-`)", () => {
    expect(containerNameForBranch("ralph/185-impl")).toBe("ralph-ralph-185-impl");
  });

  it("buildDockerRunArgs names the container with exactly the (now per-dispatch) name it is handed", () => {
    expect(buildDockerRunArgs({ image: "img", credentials: {} }, dispatch, "ralph-custom-1")).toContain("ralph-custom-1");
  });
});

/** A fake `docker run` child with BOTH stdio pipes, so {@link DockerCliRunner.start} bridges it. */
function fakeRunSpawn(): { spawn: DockerSpawn; calls: string[][] } {
  const calls: string[][] = [];
  const spawn = (args: string[]): ChildProcess => {
    calls.push(args);
    const child = new EventEmitter() as unknown as ChildProcess;
    (child as unknown as { stdout: PassThrough }).stdout = new PassThrough();
    (child as unknown as { stdin: PassThrough }).stdin = new PassThrough();
    return child;
  };
  return { spawn, calls };
}

/**
 * A fake `docker` for the start→kill path: a `run` child keeps both stdio pipes open (it "stays
 * running" until the test drives `kill`); any other command (`stop`) gets a stdout that closes
 * immediately, so {@link DockerCliRunner}'s `stopContainer` promise resolves. Records every argv.
 */
function fakeRunAndKillSpawn(): { spawn: DockerSpawn; calls: string[][] } {
  const calls: string[][] = [];
  const spawn = (args: string[]): ChildProcess => {
    calls.push(args);
    const child = new EventEmitter() as unknown as ChildProcess;
    if (args[0] === "run") {
      (child as unknown as { stdout: PassThrough }).stdout = new PassThrough();
      (child as unknown as { stdin: PassThrough }).stdin = new PassThrough();
    } else {
      const stdout = new PassThrough();
      (child as unknown as { stdout: PassThrough }).stdout = stdout;
      queueMicrotask(() => {
        stdout.end();
        child.emit("close", 0);
      });
    }
    return child;
  };
  return { spawn, calls };
}

/** The value the `run` argv carries after its `--name` flag (the concrete container name created). */
function nameOf(runArgs: string[]): string {
  return runArgs[runArgs.indexOf("--name") + 1]!;
}

describe("DockerCliRunner.start — per-dispatch image resolution (issue #190 completion)", () => {
  it("runs the tag returned by resolveImage, not the static image (build-tag == run-tag)", async () => {
    const { spawn, calls } = fakeRunSpawn();
    const runner = new DockerCliRunner(
      // the static `image` must be ignored when a resolver is present
      { image: "ralph/agent/unused:unbuilt", credentials: {}, resolveImage: async () => "ralph/agent/acme:deadbeef" },
      spawn,
    );

    await runner.start(dispatch);

    const runArgs = calls.find((c) => c[0] === "run")!;
    expect(runArgs.at(-1)).toBe("ralph/agent/acme:deadbeef");
  });

  it("falls back to the static image when no resolver is injected (RALPH_AGENT_IMAGE pin)", async () => {
    const { spawn, calls } = fakeRunSpawn();
    const runner = new DockerCliRunner({ image: "registry/pinned:1", credentials: {} }, spawn);

    await runner.start(dispatch);

    expect(calls.find((c) => c[0] === "run")!.at(-1)).toBe("registry/pinned:1");
  });
});

describe("DockerCliRunner.start — unique container name per dispatch (issue #259)", () => {
  const cfg: DockerRunnerConfig = { image: "img", credentials: {} };

  it("gives two sequential dispatches for the SAME branch DISTINCT --name handles (no collision)", async () => {
    const { spawn, calls } = fakeRunAndKillSpawn();
    const runner = new DockerCliRunner(cfg, spawn);

    // The review loop dispatches review → fix → review… back-to-back on one branch; each must get
    // its own name so a still-removing `--rm` container can't Conflict with the next `docker run`.
    await runner.start(dispatch);
    await runner.start(dispatch);

    const names = calls.filter((c) => c[0] === "run").map(nameOf);
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
    // Both keep the branch stem (so they stay human-readable) AND the `ralph-` prefix the sweep enumerates on.
    const stem = containerNameForBranch(dispatch.assignment.branch);
    expect(names[0]).toContain(stem);
    expect(names[1]).toContain(stem);
    expect(names.every((n) => n.startsWith("ralph-"))).toBe(true);
    // Neither is the bare branch-derived name a prior phase's lingering container would still hold.
    expect(names).not.toContain(stem);
  });

  it("kills the ACTUAL created name, not a recomputed branch name (abort/wall-clock handle)", async () => {
    const { spawn, calls } = fakeRunAndKillSpawn();
    const runner = new DockerCliRunner(cfg, spawn);

    const container = await runner.start(dispatch);
    const createdName = nameOf(calls.find((c) => c[0] === "run")!);

    await container.kill();

    // The abort/wall-clock stop targets the concrete name the dispatch created — never recomputed
    // from the branch (which would miss this dispatch's container and could hit a prior phase's).
    const stopArgs = calls.find((c) => c[0] === "stop")!;
    expect(stopArgs).toEqual(buildStopArgs(createdName, DEFAULT_STOP_TIMEOUT_SECONDS));
    expect(stopArgs.at(-1)).not.toBe(containerNameForBranch(dispatch.assignment.branch));
  });

  it("stamps the run's branch label on the actual `docker run` so the sweep can spare it (issue #259)", async () => {
    const { spawn, calls } = fakeRunAndKillSpawn();
    const runner = new DockerCliRunner({ ...cfg, targetRepo: "owner/repo" }, spawn);

    await runner.start(dispatch);

    const runArgs = calls.find((c) => c[0] === "run")!;
    // The launched container carries `ralph.branch=<branch>` — the live-run handle the sweep matches.
    expect(runArgs).toContain(`${BRANCH_LABEL_KEY}=${dispatch.assignment.branch}`);
  });
});

/** A fake `docker run` child with stdout/stdin/stderr pipes, exposed so a test can drive stderr + exit. */
function fakeRunSpawnDetailed(): { spawn: DockerSpawn; child: () => ChildProcess & { stderr: PassThrough } } {
  let made: (ChildProcess & { stderr: PassThrough }) | undefined;
  const spawn = (_args: string[]): ChildProcess => {
    const child = new EventEmitter() as unknown as ChildProcess & { stderr: PassThrough };
    (child as unknown as { stdout: PassThrough }).stdout = new PassThrough();
    (child as unknown as { stdin: PassThrough }).stdin = new PassThrough();
    (child as unknown as { stderr: PassThrough }).stderr = new PassThrough();
    made = child;
    return child;
  };
  return { spawn, child: () => made! };
}

/** Run `fn` with `process.stderr.write` captured (the tee target), restoring it afterwards. */
async function withCapturedStderr(fn: (writes: string[]) => Promise<void>): Promise<void> {
  const writes: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    writes.push(String(s));
    return true;
  };
  try {
    await fn(writes);
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }
}

describe("DockerCliRunner.start — failure detail capture (issue #220)", () => {
  const cfg: DockerRunnerConfig = { image: "img", credentials: {} };

  it("captures the docker exit code/signal + a stderr tail into failureDetail(), teed to daemon stderr", async () => {
    await withCapturedStderr(async (writes) => {
      const { spawn, child } = fakeRunSpawnDetailed();
      const container = await new DockerCliRunner(cfg, spawn).start(dispatch);
      // No detail before the child exits.
      expect(container.failureDetail?.()).toBeUndefined();
      child().stderr.write("Error: no such image: ralph/agent\n");
      child().emit("exit", 125, null);
      await new Promise((r) => setImmediate(r)); // let the stderr 'data' handler run

      const detail = container.failureDetail?.();
      expect(detail).toContain("docker exited (code=125 signal=null)");
      expect(detail).toContain("no such image");
      // The tee preserves the old "folded into the daemon log" behaviour.
      expect(writes.join("")).toContain("no such image");
    });
  });

  it("reports the signal when docker is killed, and an empty-stderr marker", async () => {
    await withCapturedStderr(async () => {
      const { spawn, child } = fakeRunSpawnDetailed();
      const container = await new DockerCliRunner(cfg, spawn).start(dispatch);
      child().emit("exit", null, "SIGKILL");
      await new Promise((r) => setImmediate(r));
      expect(container.failureDetail?.()).toBe("docker exited (code=null signal=SIGKILL); stderr tail: <empty>");
    });
  });

  it("bounds the captured stderr tail to STDERR_TAIL_BYTES", async () => {
    await withCapturedStderr(async () => {
      const { spawn, child } = fakeRunSpawnDetailed();
      const container = await new DockerCliRunner(cfg, spawn).start(dispatch);
      child().stderr.write("X".repeat(STDERR_TAIL_BYTES * 3));
      child().emit("exit", 1, null);
      await new Promise((r) => setImmediate(r));
      const tail = container.failureDetail!()!.split("stderr tail: ")[1]!;
      expect(tail.length).toBeLessThanOrEqual(STDERR_TAIL_BYTES);
      expect(tail.length).toBeGreaterThan(STDERR_TAIL_BYTES - 100);
    });
  });
});

/**
 * A fake `docker` whose `ps` honours the `--filter label=ralph.repo=<repo>` scoping (issue #256)
 * AND emits each container's `{{.Names}}\t{{.Label "ralph.branch"}}` (issue #259): the fleet carries
 * name + branch + repo, a `docker ps` returns the repo-matching rows in the new tab format, and the
 * branch label is what the sweep spares a live run by. Without a label filter it returns the whole
 * fleet (the box/single-repo path). `stop` is a no-op that closes. A container with `branch: ""`
 * mimics one that carries no ralph.branch label.
 */
function fakeBranchLabeledFleetSpawn(fleet: ReadonlyArray<{ name: string; branch: string; repo: string }>): {
  spawn: (args: string[]) => ChildProcess;
  calls: string[][];
} {
  const labelPrefix = `label=${REPO_LABEL_KEY}=`;
  const calls: string[][] = [];
  const spawn = (args: string[]): ChildProcess => {
    calls.push(args);
    const child = new EventEmitter() as unknown as ChildProcess & { stdout: PassThrough };
    const stdout = new PassThrough();
    (child as unknown as { stdout: PassThrough }).stdout = stdout;
    queueMicrotask(() => {
      if (args[0] === "ps") {
        const repoFilter = args.find((a) => a.startsWith(labelPrefix));
        const wantRepo = repoFilter?.slice(labelPrefix.length);
        const visible = fleet.filter((c) => wantRepo === undefined || c.repo === wantRepo);
        // Docker emits an empty field for a missing label; the fake mirrors that for branch: "".
        stdout.write(visible.map((c) => `${c.name}\t${c.branch}`).join("\n") + "\n");
      }
      stdout.end();
      child.emit("close", 0);
    });
    return child;
  };
  return { spawn, calls };
}

describe("DockerCliRunner.sweepOrphans — kill containers with no live run (issue #219/#259)", () => {
  const base: DockerRunnerConfig = { image: "ralph/agent-acme:1", credentials: {} };
  // A live run's container now carries a per-dispatch-unique name (issue #259), so it deliberately
  // does NOT equal containerNameForBranch(branch) — the sweep must spare it by its branch label.
  const dispatchedName = (branch: string, token: string) => `${containerNameForBranch(branch)}-${token}`;

  it("spares a live container by its branch LABEL even though its name ≠ containerNameForBranch (issue #259)", async () => {
    // The example-monorepo regression: review/fix dispatches share a branch but get fresh names. A name-based
    // spare (the old sweep) would see the live container's unfamiliar name and wrongly reap it.
    const liveBranch = "ralph/185-impl";
    const liveName = dispatchedName(liveBranch, "ph2-1"); // a later phase/attempt → not the bare branch name
    const orphanBranch = "ralph/999-crashed";
    const orphanName = dispatchedName(orphanBranch, "ph0-1");
    const fleet = [
      { name: liveName, branch: liveBranch, repo: "owner/repo" },
      { name: orphanName, branch: orphanBranch, repo: "owner/repo" },
    ];
    const { spawn, calls } = fakeBranchLabeledFleetSpawn(fleet);
    const runner = new DockerCliRunner({ ...base, targetRepo: "owner/repo" }, spawn);

    const killed = await runner.sweepOrphans(new Set([liveBranch]));

    // The live run is spared by its branch label; only the truly dead branch's container is reaped.
    expect(killed).toEqual([orphanName]);
    const stops = calls.filter((c) => c[0] === "stop").map((c) => c.at(-1));
    expect(stops).toEqual([orphanName]);
    expect(stops).not.toContain(liveName);
  });

  it("scopes the sweep to its own repo — repo A never sees or kills repo B's containers (issue #256)", async () => {
    const repoA = "owner/repo-a";
    const repoB = "owner/repo-b";
    // The fleet spans BOTH repos (global `ralph-` name prefix). A's reconciler passes only A's
    // live branches; the repo label is what stops A's sweep from reaching B's in-flight container.
    const aOrphan = { name: dispatchedName("ralph/10-a-orphan", "t1"), branch: "ralph/10-a-orphan", repo: repoA };
    const bLive = { name: dispatchedName("ralph/20-b-live", "t1"), branch: "ralph/20-b-live", repo: repoB };
    const { spawn, calls } = fakeBranchLabeledFleetSpawn([aOrphan, bLive]);
    const runner = new DockerCliRunner({ ...base, targetRepo: repoA }, spawn);

    // Repo A has no live runs this tick → its own container is an orphan to be reaped.
    const killed = await runner.sweepOrphans(new Set());

    // A's sweep enumerated ONLY A's container, so it killed its own orphan and never touched B's run.
    expect(killed).toEqual([aOrphan.name]);
    const stops = calls.filter((c) => c[0] === "stop").map((c) => c.at(-1));
    expect(stops).toEqual([aOrphan.name]);
    expect(stops).not.toContain(bLive.name);
    // The enumeration `docker ps` was scoped by the repo label.
    expect(calls.find((c) => c[0] === "ps")).toContain(`label=${REPO_LABEL_KEY}=${repoA}`);
  });

  it("stops containers whose branch label is not live, and spares the live ones", async () => {
    const liveBranch = "ralph/185-impl";
    const orphanBranch = "ralph/999-crashed";
    const orphanName = dispatchedName(orphanBranch, "x");
    const fleet = [
      { name: dispatchedName(liveBranch, "y"), branch: liveBranch, repo: "r" },
      { name: orphanName, branch: orphanBranch, repo: "r" },
    ];
    const { spawn, calls } = fakeBranchLabeledFleetSpawn(fleet);
    const runner = new DockerCliRunner(base, spawn);

    const killed = await runner.sweepOrphans(new Set([liveBranch]));

    expect(killed).toEqual([orphanName]);
    // Exactly one `docker stop`, targeting the orphan with the graceful-then-hard timeout.
    expect(calls.filter((c) => c[0] === "stop")).toEqual([buildStopArgs(orphanName, DEFAULT_STOP_TIMEOUT_SECONDS)]);
  });

  it("reaps a container that carries no branch label (unmatchable to any live run)", async () => {
    // An unlabelled ralph- container can't be tied to a live run, so the sweep treats it as an orphan.
    const fleet = [{ name: "ralph-mystery-1", branch: "", repo: "r" }];
    const { spawn, calls } = fakeBranchLabeledFleetSpawn(fleet);
    const runner = new DockerCliRunner(base, spawn);

    const killed = await runner.sweepOrphans(new Set(["ralph/185-impl"]));

    expect(killed).toEqual(["ralph-mystery-1"]);
    expect(calls.filter((c) => c[0] === "stop").map((c) => c.at(-1))).toEqual(["ralph-mystery-1"]);
  });

  it("kills nothing when every running container's branch is live", async () => {
    const fleet = [
      { name: dispatchedName("ralph/1-a", "p"), branch: "ralph/1-a", repo: "r" },
      { name: dispatchedName("ralph/2-b", "q"), branch: "ralph/2-b", repo: "r" },
    ];
    const { spawn, calls } = fakeBranchLabeledFleetSpawn(fleet);
    const runner = new DockerCliRunner(base, spawn);

    const killed = await runner.sweepOrphans(new Set(["ralph/1-a", "ralph/2-b"]));

    expect(killed).toEqual([]);
    expect(calls.filter((c) => c[0] === "stop")).toEqual([]);
  });

  it("honours a configured stop timeout for the orphan kill", async () => {
    const orphanName = dispatchedName("ralph/3-c", "z");
    const fleet = [{ name: orphanName, branch: "ralph/3-c", repo: "r" }];
    const { spawn, calls } = fakeBranchLabeledFleetSpawn(fleet);
    const runner = new DockerCliRunner({ ...base, stopTimeoutSeconds: 3 }, spawn);

    await runner.sweepOrphans(new Set());

    expect(calls.filter((c) => c[0] === "stop")).toEqual([buildStopArgs(orphanName, 3)]);
  });
});
