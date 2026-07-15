/**
 * The in-container git cloner (ADR-0038 / issues #185, #188). On a fresh impl run it clones the
 * assignment's **base** branch and forks the WIP branch on top; on a **resume** (the assignment
 * carries the operator's answer) it clones the **WIP branch directly** — the prior work is
 * already committed there, so resume continues it rather than restarting from a clean base
 * (DESIGN §6, resume-not-restart). These tests assert the git invocations the cloner issues;
 * the real `git` + temp-dir factory are injected, so no clone touches the network or disk.
 */
import { describe, expect, it } from "vitest";
import {
  createFixSessionHost,
  createGitCloner,
  createImplSessionHost,
  createReviewSessionHost,
  readContainerRoute,
  resolveZaiEndpoint,
  structuredBackendForRoute,
  withModelOverride,
  withProfileOverride,
  type EnvReader,
  type RunGit,
} from "./in-container-session";
import type { Assignment } from "./assignment";
import { MODEL_ENV_VAR, PROVIDER_ENV_VAR, ZAI_TOKEN_ENV_NAME_VAR } from "./docker-runner";
import { parseConfig, resolveTargets } from "../config/load";
import type { TargetConfig } from "../config/schema";
import { ClaudeSessionBackend } from "../providers/claude-backend";
import { CodexSessionBackend } from "../providers/codex-backend";
import type { TranscriptSink } from "../executor/transcript-sink";

/** Build a target config from partial provider overrides (for the in-container backend selection). */
function config(providers: Record<string, unknown> = {}): TargetConfig {
  return resolveTargets(
    parseConfig({ targets: [{ repo: "acme/widgets", commands: { build: "b", test: "t" } }], providers }),
  )[0]!;
}

/** A fixed-map env reader (no process.env). */
function env(map: Record<string, string>): EnvReader {
  return (name) => map[name];
}

const noopSink: TranscriptSink = { capture: () => {}, flush: async () => {} };

const base: Assignment = {
  issueNumber: 188,
  mode: "tdd",
  branch: "ralph/188-resume",
  base: "main",
  prompt: "implement issue #188",
};

/** Records every git invocation (args + cwd) so a test can assert what the cloner ran. */
function recordingGit(): { runGit: RunGit; calls: { args: string[]; cwd?: string }[] } {
  const calls: { args: string[]; cwd?: string }[] = [];
  return {
    calls,
    runGit: (args, cwd) => {
      calls.push({ args, cwd });
      return "";
    },
  };
}

describe("in-container git cloner (ADR-0038 / issues #185, #188)", () => {
  it("clones the base branch and forks the WIP branch on a fresh impl run (no answer)", async () => {
    const { runGit, calls } = recordingGit();
    const cloner = createGitCloner({ repo: "acme/widgets", token: "t", runGit, makeWorkDir: () => "/tmp/run" });

    const ws = await cloner.clone(base);

    expect(ws.path).toBe("/tmp/run/clone");
    expect(calls[0]?.args).toEqual(["clone", "--branch", "main", "--single-branch", expect.any(String), "/tmp/run/clone"]);
    expect(calls[1]?.args).toEqual(["checkout", "-B", "ralph/188-resume"]);
  });

  it("clones the WIP branch directly on a resume — the prior work is committed there (#188)", async () => {
    const { runGit, calls } = recordingGit();
    const cloner = createGitCloner({ repo: "acme/widgets", token: "t", runGit, makeWorkDir: () => "/tmp/run" });

    // A resume assignment carries the operator's answer.
    await cloner.clone({ ...base, answer: "Use sqlite." });

    expect(calls).toHaveLength(1); // no base-clone + fork; just the WIP-branch clone
    expect(calls[0]?.args).toEqual([
      "clone",
      "--branch",
      "ralph/188-resume",
      "--single-branch",
      expect.any(String),
      "/tmp/run/clone",
    ]);
  });

  // #273: a rebase-conflict fix agent runs in a fresh single-branch clone of the PR branch, where
  // `git fetch origin <base>` would NOT create `refs/remotes/origin/<base>` — so it could not
  // `git rebase origin/<base>`. The cloner must pre-fetch base with an explicit refspec.
  it("pre-fetches the base ref for a rebase-conflict fix so the agent can rebase onto it (#273)", async () => {
    const { runGit, calls } = recordingGit();
    const cloner = createGitCloner({ repo: "acme/widgets", token: "t", runGit, makeWorkDir: () => "/tmp/run" });

    await cloner.clone({ ...base, kind: "fix", rebaseConflict: true });

    expect(calls[0]?.args[0]).toBe("clone"); // single-branch clone of the PR branch
    // Then the explicit-refspec fetch of base (a plain `fetch origin main` would be a no-op for
    // the tracking ref in a single-branch clone).
    expect(calls[1]).toEqual({
      args: ["fetch", "origin", "main:refs/remotes/origin/main"],
      cwd: "/tmp/run/clone",
    });
  });

  it("does not pre-fetch base for a normal (non-rebase) fix or a review pass", async () => {
    const { runGit, calls } = recordingGit();
    const cloner = createGitCloner({ repo: "acme/widgets", token: "t", runGit, makeWorkDir: () => "/tmp/run" });

    await cloner.clone({ ...base, kind: "fix" }); // no rebase
    await cloner.clone({ ...base, kind: "review" });

    expect(calls.filter((c) => c.args[0] === "fetch")).toHaveLength(0);
  });
});

describe("readContainerRoute — the injected route env contract (ADR-0037 / issue #220)", () => {
  it("reads the provider and model the daemon injected", () => {
    expect(readContainerRoute(env({ [PROVIDER_ENV_VAR]: "claude", [MODEL_ENV_VAR]: "opus" }))).toEqual({
      provider: "claude",
      model: "opus",
    });
  });

  it("omits the model when none was injected (the provider default is resolved in-container)", () => {
    expect(readContainerRoute(env({ [PROVIDER_ENV_VAR]: "zai" }))).toEqual({ provider: "zai" });
  });

  it("throws (no box-default fallback) when the provider env is unset", () => {
    expect(() => readContainerRoute(env({}))).toThrow(/unset/);
  });

  it("throws on an unknown provider kind rather than guessing", () => {
    expect(() => readContainerRoute(env({ [PROVIDER_ENV_VAR]: "gemini" }))).toThrow(/not a known provider/);
  });
});

describe("withModelOverride (ADR-0037 / issue #220)", () => {
  it("swaps agent.model for a route with a model", () => {
    expect(withModelOverride(config(), "haiku").agent.model).toBe("haiku");
  });
  it("leaves the config (and its default model) untouched when no model is on the route", () => {
    const c = config();
    expect(withModelOverride(c, undefined)).toBe(c);
  });
});

describe("resolveZaiEndpoint — z.ai endpoint from the mounted config + forwarded key (issue #220)", () => {
  const zaiConfig = config({ zai: { baseUrl: "https://api.z.ai/api/anthropic", authTokenEnv: "GLM_KEY" } });

  it("resolves baseUrl + the key (read from the NAMED env var) + the route model", () => {
    const endpoint = resolveZaiEndpoint(
      zaiConfig,
      "glm-5.2[1m]",
      env({ [ZAI_TOKEN_ENV_NAME_VAR]: "GLM_KEY", GLM_KEY: "secret-glm" }),
    );
    expect(endpoint).toEqual({ baseUrl: "https://api.z.ai/api/anthropic", authToken: "secret-glm", model: "glm-5.2[1m]" });
  });

  it("falls back to the provider-kind default model when the route carries none", () => {
    const endpoint = resolveZaiEndpoint(zaiConfig, undefined, env({ [ZAI_TOKEN_ENV_NAME_VAR]: "GLM_KEY", GLM_KEY: "k" }));
    expect(endpoint.model).toBe("glm-5.2");
  });

  it("throws (fail loud) when the named key env var is empty in the container", () => {
    expect(() => resolveZaiEndpoint(zaiConfig, undefined, env({ [ZAI_TOKEN_ENV_NAME_VAR]: "GLM_KEY" }))).toThrow(/unset or empty/);
  });

  it("throws when the daemon did not name the key env var", () => {
    expect(() => resolveZaiEndpoint(zaiConfig, undefined, env({ GLM_KEY: "k" }))).toThrow(new RegExp(ZAI_TOKEN_ENV_NAME_VAR));
  });
});

describe("structuredBackendForRoute — provider → backend selection (ADR-0037 / issue #220)", () => {
  it("builds a Claude backend for a claude route", () => {
    const backend = structuredBackendForRoute(config(), { provider: "claude", model: "opus" }, noopSink, {});
    expect(backend).toBeInstanceOf(ClaudeSessionBackend);
  });

  it("builds a Claude backend (z.ai endpoint) for a zai route", () => {
    const backend = structuredBackendForRoute(
      config({ zai: { authTokenEnv: "GLM_KEY" } }),
      { provider: "zai", model: "glm-5.2" },
      noopSink,
      { readEnv: env({ [ZAI_TOKEN_ENV_NAME_VAR]: "GLM_KEY", GLM_KEY: "k" }) },
    );
    expect(backend).toBeInstanceOf(ClaudeSessionBackend);
  });

  it("builds a Codex backend for an openai route (re-armed by route injection, #220)", () => {
    const backend = structuredBackendForRoute(
      config({ openai: { codexHome: "/host/codex" } }),
      { provider: "openai", model: "gpt-5.5" },
      noopSink,
      { codexClientFactory: () => ({ run: async () => "" }) },
    );
    expect(backend).toBeInstanceOf(CodexSessionBackend);
  });
});

describe("createImplSessionHost — capability defence in depth (issue #220)", () => {
  it("constructs without throwing on a bare-openai route (the eager three-host build must be total)", () => {
    // ralph-runner.ts builds session/reviewSession/fixSession in ONE deps literal for EVERY
    // dispatch kind; a review/fix run never runs the impl host but still constructs it, so an
    // openai route must NOT throw at construction — else the container crashes before the runner
    // selects reviewSession/fixSession (#220 regression). The guard is deferred into run().
    expect(() => createImplSessionHost(config({ openai: { codexHome: "/c" } }), { provider: "openai" })).not.toThrow();
  });

  it("refuses a bare-openai impl route only when actually run (it cannot host escalate/stuck)", () => {
    const host = createImplSessionHost(config({ openai: { codexHome: "/c" } }), { provider: "openai" });
    // The impl host throws on run — a wiring fault resolveRoute's capability gate prevents for impl.
    expect(() =>
      host.run({ assignment: { ...base, kind: "impl" }, workspacePath: "/w", transcriptSink: noopSink }),
    ).toThrow(/capability gate/);
  });
});

describe("openai-routed review/fix dispatches onto the Codex backend (issue #220 regression)", () => {
  const openaiConfig = config({ openai: { codexHome: "/host/codex" } });
  const route = { provider: "openai", model: "gpt-5.5" } as const;

  /** A fake Codex client that records each turn and returns the canned final text. */
  function fakeCodex(text: string): { calls: string[]; factory: () => { run: (req: { prompt: string }) => Promise<string> } } {
    const calls: string[] = [];
    return {
      calls,
      factory: () => ({
        run: async (req: { prompt: string }) => {
          calls.push(req.prompt);
          return text;
        },
      }),
    };
  }

  it("builds all three hosts eagerly (as ralph-runner does) without throwing on an openai route", () => {
    expect(() => ({
      session: createImplSessionHost(openaiConfig, route),
      reviewSession: createReviewSessionHost(openaiConfig, route),
      fixSession: createFixSessionHost(openaiConfig, route),
    })).not.toThrow();
  });

  it("runs an openai review pass onto the Codex backend (the re-armed capability, not a crash)", async () => {
    const codex = fakeCodex(JSON.stringify({ items: [] }));
    const host = createReviewSessionHost(openaiConfig, route, { codexClientFactory: codex.factory });

    const worklist = await host.review({
      assignment: { ...base, kind: "review" },
      workspacePath: "/w",
      transcriptSink: noopSink,
    });

    expect(worklist.items).toEqual([]);
    expect(codex.calls).toHaveLength(1); // it dispatched onto Codex, not the (throwing) impl host
  });

  it("runs an openai fix attempt onto the Codex backend", async () => {
    const codex = fakeCodex(JSON.stringify({ outcome: "fixed" }));
    const host = createFixSessionHost(openaiConfig, route, { codexClientFactory: codex.factory });

    const outcome = await host.fix({
      assignment: { ...base, kind: "fix" },
      workspacePath: "/w",
      transcriptSink: noopSink,
    });

    expect(outcome).toEqual({ kind: "fixed" });
    expect(codex.calls).toHaveLength(1);
  });
});

// #273: a rebase-conflict fix is owned end-to-end by the runner. The agent rebases + resolves in
// its clone but CANNOT force-push the rewritten history (git-guardrails, DESIGN §8), so once it
// reports `fixed` the runner re-fetches base, enforces the #241 no-net-diff guard, and
// force-with-leases the result — the harness owns the push, now from the container clone.
describe("createFixSessionHost — runner-owned rebase force-push (#273)", () => {
  const openaiConfig = config({ openai: { codexHome: "/host/codex" } });
  const route = { provider: "openai", model: "gpt-5.5" } as const;

  /** A fake Codex client returning the canned final text for every turn. */
  function fakeCodex(text: string): { factory: () => { run: () => Promise<string> } } {
    return { factory: () => ({ run: async () => text }) };
  }

  /** A recording runGit whose `diff` returns `diffOut` and every other subcommand returns "". */
  function recordingGit(diffOut: string): { runGit: RunGit; calls: { args: string[]; cwd?: string }[] } {
    const calls: { args: string[]; cwd?: string }[] = [];
    return {
      calls,
      runGit: (args, cwd) => {
        calls.push({ args, cwd });
        return args[0] === "diff" ? diffOut : "";
      },
    };
  }

  it("force-pushes the resolved rebase after a rebase fix reports fixed", async () => {
    const codex = fakeCodex(JSON.stringify({ outcome: "fixed" }));
    const git = recordingGit("src/a.ts\n");
    const host = createFixSessionHost(openaiConfig, route, { codexClientFactory: codex.factory, runGit: git.runGit });

    const outcome = await host.fix({
      assignment: { ...base, kind: "fix", rebaseConflict: true },
      workspacePath: "/ws",
      transcriptSink: noopSink,
    });

    expect(outcome).toEqual({ kind: "fixed" });
    // re-fetch base → #241 net-diff guard → force-with-lease push, in that order, in the workspace.
    expect(git.calls.map((c) => c.args)).toEqual([
      ["fetch", "origin", "main:refs/remotes/origin/main"],
      ["diff", "--name-only", "origin/main...HEAD"],
      ["push", "--force-with-lease", "origin", "ralph/188-resume"],
    ]);
    expect(git.calls.every((c) => c.cwd === "/ws")).toBe(true);
  });

  it("refuses (#241) to force-push a rebase that left no net diff vs base — never wipes the branch", async () => {
    const codex = fakeCodex(JSON.stringify({ outcome: "fixed" }));
    const git = recordingGit(""); // empty diff → a wipe
    const host = createFixSessionHost(openaiConfig, route, { codexClientFactory: codex.factory, runGit: git.runGit });

    await expect(
      host.fix({
        assignment: { ...base, kind: "fix", rebaseConflict: true },
        workspacePath: "/ws",
        transcriptSink: noopSink,
      }),
    ).rejects.toThrow(/no net diff|#241/);
    // The guard fired before any push landed.
    expect(git.calls.find((c) => c.args[0] === "push")).toBeUndefined();
  });

  it("does not push a normal (non-rebase) fix — the agent pushes runner-direct, as before", async () => {
    const codex = fakeCodex(JSON.stringify({ outcome: "fixed" }));
    const git = recordingGit("x");
    const host = createFixSessionHost(openaiConfig, route, { codexClientFactory: codex.factory, runGit: git.runGit });

    await host.fix({ assignment: { ...base, kind: "fix" }, workspacePath: "/ws", transcriptSink: noopSink });

    expect(git.calls).toHaveLength(0);
  });

  it("does not push when a rebase fix escalates a risky conflict — nothing is force-pushed", async () => {
    const codex = fakeCodex(
      JSON.stringify({
        outcome: "escalate",
        question: {
          headline: "Base rewrote the ledger API this branch targets",
          feature: "ledger",
          whereWeStand: "the conflict is a semantic incompatibility, not a textual one",
          decision: "adapt to base's new API or revert base?",
          options: ["adapt"],
          stakes: "adapting wrong loses the branch's fix",
          recommendation: "adapt",
        },
      }),
    );
    const git = recordingGit("x");
    const host = createFixSessionHost(openaiConfig, route, { codexClientFactory: codex.factory, runGit: git.runGit });

    const outcome = await host.fix({
      assignment: { ...base, kind: "fix", rebaseConflict: true },
      workspacePath: "/ws",
      transcriptSink: noopSink,
    });

    expect(outcome.kind).toBe("escalate");
    expect(git.calls).toHaveLength(0); // escalated, not resolved → the runner pushes nothing
  });
});

describe("withProfileOverride (issue #278)", () => {
  it("swaps the tier's effort and wall-clock over the mounted globals", () => {
    const c = config();
    const profiled = withProfileOverride(c, { effort: "max", wallClockSeconds: 10800 });
    expect(profiled.agent.effort).toBe("max");
    expect(profiled.agent.wallClockSeconds).toBe(10800);
    // Everything else is untouched (model, mcp set, …).
    expect(profiled.agent.model).toBe(c.agent.model);
  });

  it("applies a partial profile — only the set field swaps, the other keeps the global", () => {
    const c = config();
    const effortOnly = withProfileOverride(c, { effort: "medium" });
    expect(effortOnly.agent.effort).toBe("medium");
    expect(effortOnly.agent.wallClockSeconds).toBe(c.agent.wallClockSeconds);
    const clockOnly = withProfileOverride(c, { wallClockSeconds: 1800 });
    expect(clockOnly.agent.effort).toBe(c.agent.effort);
    expect(clockOnly.agent.wallClockSeconds).toBe(1800);
  });

  it("returns the config unchanged (same reference) for an absent or empty profile", () => {
    const c = config();
    expect(withProfileOverride(c, undefined)).toBe(c);
    expect(withProfileOverride(c, {})).toBe(c);
  });
});
