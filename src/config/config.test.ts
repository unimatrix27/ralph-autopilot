import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseConfig, resolveAccountPool, resolveTargets } from "./load";
import { configSchema, type RalphConfig } from "./schema";
import {
  PROVIDER_TOOLS_CAPABLE_DEFAULTS,
  providerPreferenceList,
  providerToolsCapable,
} from "../providers/select";

function tmpConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ralph-config-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, contents);
  return path;
}

const minimal = `
targets:
  - repo: acme/example-monorepo
    commands:
      build: npm run build
      test: npm test
`;

describe("config loader", () => {
  it("parses a minimal config and applies defaults", () => {
    const cfg = loadConfig(tmpConfig(minimal));
    expect(cfg.targets[0]!.repo).toBe("acme/example-monorepo");
    expect(cfg.scheduler.maxConcurrentAgents).toBe(5);
    expect(cfg.scheduler.reconcileIntervalSeconds).toBe(30);
    expect(cfg.scheduler.drainTimeoutSeconds).toBe(3600);
    expect(cfg.agent.wallClockSeconds).toBe(3600);
    expect(cfg.agent.heartbeatSeconds).toBe(30);
    expect(cfg.review.maxFixAttempts).toBe(3);
    // Container infra re-dispatch budget (issue #220) defaults to 2.
    expect(cfg.review.maxContainerRetries).toBe(2);
    expect(cfg.merge.method).toBe("squash");
    expect(cfg.merge.waitForChecks).toBe(true);
    expect(cfg.merge.ciTimeoutMinutes).toBe(30);
    expect(cfg.merge.pollIntervalSeconds).toBe(30);
    expect(cfg.merge.deleteBranch).toBe(true);
    expect(cfg.paths.database).toBe(".ralph/ralph.sqlite");
    expect(cfg.agent.mcpServers).not.toContain("memory");
    expect(cfg.logging.level).toBe("info");
    // Self-update (issue #30) is off by default with conservative cadence/drain.
    expect(cfg.selfUpdate.enabled).toBe(false);
    expect(cfg.selfUpdate.checkEveryTicks).toBe(10);
    expect(cfg.selfUpdate.branch).toBe("main");
    expect(cfg.selfUpdate.drainTimeoutSeconds).toBe(1800);
    expect(cfg.selfUpdate.repoDir).toBe(".");
  });

  it("honours explicit overrides", () => {
    const cfg = loadConfig(
      tmpConfig(`
targets:
  - repo: acme/widgets
    commands:
      build: make
      test: make test
scheduler:
  maxConcurrentAgents: 2
  drainTimeoutSeconds: 120
agent:
  wallClockSeconds: 1800
review:
  maxFixAttempts: 1
  maxContainerRetries: 0
merge:
  method: rebase
  waitForChecks: false
  ciTimeoutMinutes: 5
logging:
  level: debug
`),
    );
    expect(cfg.scheduler.maxConcurrentAgents).toBe(2);
    expect(cfg.scheduler.drainTimeoutSeconds).toBe(120);
    // Unset scheduler keys still take their defaults.
    expect(cfg.scheduler.reconcileIntervalSeconds).toBe(30);
    expect(cfg.agent.wallClockSeconds).toBe(1800);
    expect(cfg.review.maxFixAttempts).toBe(1);
    // maxContainerRetries honours an explicit 0 (retry disabled), not the default 2.
    expect(cfg.review.maxContainerRetries).toBe(0);
    expect(cfg.merge.method).toBe("rebase");
    expect(cfg.merge.waitForChecks).toBe(false);
    expect(cfg.merge.ciTimeoutMinutes).toBe(5);
    // Unset merge keys still take their defaults.
    expect(cfg.merge.pollIntervalSeconds).toBe(30);
    expect(cfg.merge.deleteBranch).toBe(true);
    expect(cfg.logging.level).toBe("debug");
  });

  it("fails loud with a useful message when the file is missing", () => {
    expect(() => loadConfig(join(tmpdir(), "definitely-absent-ralph.yaml"))).toThrow(ConfigError);
    try {
      loadConfig(join(tmpdir(), "definitely-absent-ralph.yaml"));
    } catch (err) {
      expect((err as Error).message).toContain("not found");
      expect((err as Error).message).toContain("config.example.yaml");
    }
  });

  it("fails loud on malformed YAML", () => {
    expect(() => loadConfig(tmpConfig("targets: [unterminated\n"))).toThrow(/Malformed YAML/);
  });

  it("fails loud and locates a schema violation", () => {
    try {
      parseConfig(
        { targets: [{ repo: "not-a-slug", commands: { build: "x", test: "y" } }] },
        "test.yaml",
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      // The bad slug is located at its target path and explains the format.
      expect((err as Error).message).toContain("targets.0.repo");
      expect((err as Error).message).toContain("owner/repo");
    }
  });

  it("rejects unknown keys (typo protection)", () => {
    expect(() =>
      parseConfig({
        targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
        scheduler: { maxConcurrentAgent: 5 },
      }),
    ).toThrow(ConfigError);
  });

  it("enables self-update and applies defaults for unset selfUpdate keys", () => {
    const cfg = loadConfig(
      tmpConfig(`
targets:
  - repo: a/b
    commands:
      build: x
      test: y
selfUpdate:
  enabled: true
  checkEveryTicks: 4
`),
    );
    expect(cfg.selfUpdate.enabled).toBe(true);
    expect(cfg.selfUpdate.checkEveryTicks).toBe(4);
    // Unset selfUpdate keys still take their defaults.
    expect(cfg.selfUpdate.branch).toBe("main");
    expect(cfg.selfUpdate.drainTimeoutSeconds).toBe(1800);
    expect(cfg.selfUpdate.repoDir).toBe(".");
  });

  it("rejects an unknown selfUpdate key (typo protection)", () => {
    expect(() =>
      parseConfig({
        targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
        selfUpdate: { enabledd: true },
      }),
    ).toThrow(ConfigError);
  });

  it("rejects a non-positive concurrency cap", () => {
    expect(() =>
      parseConfig({
        targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
        scheduler: { maxConcurrentAgents: 0 },
      }),
    ).toThrow(ConfigError);
  });

  it("requires the build and test commands", () => {
    expect(() => parseConfig({ targets: [{ repo: "a/b" }] })).toThrow(ConfigError);
  });

  it("rejects an empty targets list (at least one required)", () => {
    expect(() => parseConfig({ targets: [] })).toThrow(ConfigError);
  });

  it("accepts the documented example config", () => {
    const examplePath = resolve(__dirname, "../../.ralph/config.example.yaml");
    const text = readFileSync(examplePath, "utf8");
    expect(() => loadConfig(tmpConfig(text))).not.toThrow();
  });
});

describe("resolveTargets", () => {
  it("merges a per-target agent.model override and inherits unset fields from the global default", () => {
    const cfg = parseConfig({
      targets: [
        {
          repo: "acme/widgets",
          commands: { build: "make", test: "make test" },
          agent: { model: "sonnet" },
        },
      ],
    });
    const [target] = resolveTargets(cfg);
    // The per-target override wins for the field it set...
    expect(target!.agent.model).toBe("sonnet");
    // ...and every unset agent field falls back to the global default.
    expect(target!.agent.effort).toBe(cfg.agent.effort);
    expect(target!.agent.wallClockSeconds).toBe(cfg.agent.wallClockSeconds);
    expect(target!.agent.mcpServers).toEqual(cfg.agent.mcpServers);
    // Blocks with no override inherit wholesale.
    expect(target!.merge).toEqual(cfg.merge);
    expect(target!.review).toEqual(cfg.review);
  });

  it("derives slug-based default clone and worktree paths", () => {
    const cfg = parseConfig({
      targets: [{ repo: "acme/example-monorepo", commands: { build: "x", test: "y" } }],
    });
    const [target] = resolveTargets(cfg);
    expect(target!.targetRepo).toBe("acme/example-monorepo");
    expect(target!.paths.targetClone).toBe(".target-repo/acme-example-monorepo");
    expect(target!.paths.worktreeRoot).toBe(".wt/acme-example-monorepo");
  });

  it("throws on two targets with the same repo slug", () => {
    const cfg = parseConfig({
      targets: [
        { repo: "acme/widgets", commands: { build: "x", test: "y" } },
        { repo: "acme/widgets", commands: { build: "a", test: "b" } },
      ],
    });
    expect(() => resolveTargets(cfg)).toThrow(ConfigError);
    expect(() => resolveTargets(cfg)).toThrow(/duplicate target repo/);
  });

  it("throws when two targets resolve to the same targetClone path", () => {
    const cfg = parseConfig({
      targets: [
        { repo: "acme/widgets", commands: { build: "x", test: "y" }, paths: { targetClone: ".shared" } },
        { repo: "acme/gadgets", commands: { build: "a", test: "b" }, paths: { targetClone: ".shared" } },
      ],
    });
    expect(() => resolveTargets(cfg)).toThrow(ConfigError);
    expect(() => resolveTargets(cfg)).toThrow(/clone path/);
  });
});

describe("executionMode is a deprecated, accepted-but-ignored key (#227)", () => {
  it("a clean config (no executionMode) resolves with the key absent", () => {
    // Container is the only execution path: there is no key to set, so a clean config leaves it
    // undefined. The daemon runs every target in a fresh per-target container regardless.
    const cfg = parseConfig({ targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }] });
    const [target] = resolveTargets(cfg);
    expect(target!.executionMode).toBeUndefined();
  });

  it("still BOOTS a config that carries the retired `executionMode: container` (no wedge)", () => {
    // An operator's gitignored config may still pin `container` from before the strangler ended.
    // Rejecting it as an unknown key (strict-zod) would wedge the daemon on restart — it is parsed
    // and carried verbatim (the composition root logs the deprecation), never rejected.
    const cfg = parseConfig({
      targets: [{ repo: "a/b", commands: { build: "x", test: "y" }, executionMode: "container" }],
    });
    const [target] = resolveTargets(cfg);
    expect(target!.executionMode).toBe("container");
  });

  it("still BOOTS a config that carries the legacy `executionMode: in-process` (no wedge)", () => {
    // The legacy value is also accepted-and-ignored — a daemon mid-migration must not wedge on it.
    const cfg = parseConfig({
      targets: [{ repo: "a/b", commands: { build: "x", test: "y" }, executionMode: "in-process" }],
    });
    const [target] = resolveTargets(cfg);
    expect(target!.executionMode).toBe("in-process");
  });

  it("rejects a garbage executionMode value (strict enum still fails loud)", () => {
    expect(() =>
      parseConfig({ targets: [{ repo: "a/b", commands: { build: "x", test: "y" }, executionMode: "microvm" }] }),
    ).toThrow(ConfigError);
  });

  it("the shipped example config no longer documents executionMode", () => {
    // The example drops the key entirely (#227): there is nothing to configure, so documenting it
    // would mislead. It must parse cleanly with the key absent on every target.
    const examplePath = resolve(__dirname, "../../.ralph/config.example.yaml");
    const exampleText = readFileSync(examplePath, "utf8");
    expect(exampleText).not.toMatch(/^\s*executionMode:/m);
    const cfg = loadConfig(tmpConfig(exampleText));
    for (const target of resolveTargets(cfg)) {
      expect(target.executionMode).toBeUndefined();
    }
  });
});

describe("multi-provider config (issue #131)", () => {
  it("defaults to the claude provider, no per-type overrides, no providers block", () => {
    const cfg = parseConfig({ targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }] });
    expect(cfg.agent.provider).toBe("claude");
    expect(cfg.agent.types).toEqual({});
    expect(cfg.providers.openai).toBeUndefined();
    const [target] = resolveTargets(cfg);
    // providers is carried onto every resolved target.
    expect(target!.providers).toEqual({});
  });

  it("defaults providers.openai.model to a ChatGPT-subscription model (gpt-5.5), never a -codex id", () => {
    // ADR-0033 is OAuth-only, and a ChatGPT-subscription Codex login 400s every
    // `-codex`-suffixed id ("not supported when using Codex with a ChatGPT account"); the
    // shipped default must be a plain gpt-5.x the login actually serves (issue #138).
    const cfg = parseConfig({
      targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
      providers: { openai: { codexHome: "~/.codex-ralph" } },
    });
    expect(cfg.providers.openai?.model).toBe("gpt-5.5");
    expect(cfg.providers.openai?.model).not.toMatch(/-codex$/);
    // The default is carried, unchanged, onto every resolved target.
    const [target] = resolveTargets(cfg);
    expect(target!.providers.openai?.model).toBe("gpt-5.5");
  });

  it("parses agent.provider, agent.types, and providers.openai (with model default)", () => {
    const cfg = parseConfig({
      targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
      agent: {
        provider: "claude",
        types: {
          review: { provider: "openai" },
          fix: { provider: "openai", model: "gpt-5.5" },
        },
      },
      providers: { openai: { codexHome: "~/.codex-ralph" } },
    });
    expect(cfg.agent.types.review).toEqual({ provider: "openai" });
    expect(cfg.agent.types.fix).toEqual({ provider: "openai", model: "gpt-5.5" });
    expect(cfg.providers.openai).toEqual({ codexHome: "~/.codex-ralph", model: "gpt-5.5" });
    const [target] = resolveTargets(cfg);
    expect(target!.providers.openai).toEqual({ codexHome: "~/.codex-ralph", model: "gpt-5.5" });
  });

  it("rejects an unknown providers key (typo protection)", () => {
    expect(() =>
      parseConfig({
        targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
        providers: { openai: { codexHome: "~/.codex", modell: "x" } },
      }),
    ).toThrow(ConfigError);
  });

  it("rejects an unknown agent.types key (typo protection)", () => {
    expect(() =>
      parseConfig({
        targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
        agent: { types: { revieww: { provider: "openai" } } },
      }),
    ).toThrow(ConfigError);
  });

  it("accepts providers.openai WITHOUT codexHome — kind-only now, creds live in the pool (ADR-0037 P2.2)", () => {
    // codexHome relaxed to optional: a multi-account setup carries the credential in
    // `accounts:` and keeps only kind settings (model/baseUrl/toolsCapable) under providers.
    const cfg = parseConfig({
      targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
      providers: { openai: { model: "gpt-5.5" } },
    });
    expect(cfg.providers.openai).toEqual({ model: "gpt-5.5" });
    // Unselected → no openai account required; resolveTargets is happy.
    expect(() => resolveTargets(cfg)).not.toThrow();
  });

  it("resolveTargets fails loud when openai is selected but the pool has no openai account", () => {
    const cfg = parseConfig({
      targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
      agent: { types: { review: { provider: "openai" } } },
      providers: { openai: { model: "gpt-5.5" } }, // kind block, but no codexHome / accounts
    });
    expect(() => resolveTargets(cfg)).toThrow(/no openai account is in the pool/);
  });

  it("resolveTargets fails loud when a type selects openai without providers.openai", () => {
    const cfg = parseConfig({
      targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
      agent: { types: { review: { provider: "openai" } } },
    });
    expect(() => resolveTargets(cfg)).toThrow(ConfigError);
    expect(() => resolveTargets(cfg)).toThrow(/providers\.openai is not configured/);
  });

  it("resolveTargets accepts an openai selection once providers.openai is configured", () => {
    const cfg = parseConfig({
      targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
      agent: { types: { review: { provider: "openai" }, fix: { provider: "openai" } } },
      providers: { openai: { codexHome: "~/.codex-ralph" } },
    });
    expect(() => resolveTargets(cfg)).not.toThrow();
  });

  it("honours a per-target agent.provider override against the global providers block", () => {
    const cfg = parseConfig({
      targets: [
        {
          repo: "a/b",
          commands: { build: "x", test: "y" },
          agent: { types: { review: { provider: "openai" } } },
        },
      ],
      providers: { openai: { codexHome: "~/.codex-ralph" } },
    });
    const [target] = resolveTargets(cfg);
    expect(target!.agent.types.review).toEqual({ provider: "openai" });
    expect(target!.providers.openai?.codexHome).toBe("~/.codex-ralph");
  });
});

describe("z.ai (GLM) provider config (issue #149, ADR-0034)", () => {
  const ENV = "RALPH_ZAI_TEST_KEY";
  beforeEach(() => {
    delete process.env[ENV];
  });
  afterEach(() => {
    delete process.env[ENV];
  });

  it("parses providers.zai, defaulting baseUrl + model (GLM-5.2)", () => {
    const cfg = parseConfig({
      targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
      providers: { zai: { authTokenEnv: ENV } },
    });
    expect(cfg.providers.zai).toEqual({
      authTokenEnv: ENV,
      baseUrl: "https://api.z.ai/api/anthropic",
      model: "glm-5.2",
    });
    // Carried, unchanged, onto every resolved target — but only with the key present.
    process.env[ENV] = "sk-test";
    const [target] = resolveTargets(cfg);
    expect(target!.providers.zai?.baseUrl).toBe("https://api.z.ai/api/anthropic");
  });

  it("accepts providers.zai WITHOUT authTokenEnv — kind-only now, creds live in the pool (ADR-0037 P2.2)", () => {
    const cfg = parseConfig({
      targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
      providers: { zai: { model: "glm-5.2" } },
    });
    // baseUrl/model defaults still apply; authTokenEnv simply absent (no back-compat fold).
    expect(cfg.providers.zai).toEqual({ baseUrl: "https://api.z.ai/api/anthropic", model: "glm-5.2" });
    expect(() => resolveTargets(cfg)).not.toThrow();
  });

  it("resolveTargets fails loud when zai is selected but the pool has no zai account", () => {
    const cfg = parseConfig({
      targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
      agent: { types: { review: { provider: "zai" } } },
      providers: { zai: { model: "glm-5.2" } }, // kind block, but no authTokenEnv / accounts
    });
    expect(() => resolveTargets(cfg)).toThrow(/no zai account is in the pool/);
  });

  it("rejects an unknown providers.zai key (typo protection)", () => {
    expect(() =>
      parseConfig({
        targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
        providers: { zai: { authTokenEnv: ENV, baseUrll: "x" } },
      }),
    ).toThrow(ConfigError);
  });

  it("never accepts an inline API key — only the env var name (no `authToken` field)", () => {
    expect(() =>
      parseConfig({
        targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
        providers: { zai: { authTokenEnv: ENV, authToken: "sk-leaked" } },
      }),
    ).toThrow(ConfigError);
  });

  it("resolveTargets fails loud when a type selects zai without providers.zai", () => {
    process.env[ENV] = "sk-test";
    const cfg = parseConfig({
      targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
      agent: { types: { review: { provider: "zai" } } },
    });
    expect(() => resolveTargets(cfg)).toThrow(/providers\.zai is not configured/);
  });

  it("resolveTargets fails loud when the authTokenEnv var is unset", () => {
    const cfg = parseConfig({
      targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
      agent: { types: { review: { provider: "zai" } } },
      providers: { zai: { authTokenEnv: ENV } },
    });
    expect(() => resolveTargets(cfg)).toThrow(/env var '.*' .* is unset or empty/);
  });

  it("resolveTargets fails loud when the authTokenEnv var is empty", () => {
    process.env[ENV] = "";
    const cfg = parseConfig({
      targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
      agent: { types: { fix: { provider: "zai" } } },
      providers: { zai: { authTokenEnv: ENV } },
    });
    expect(() => resolveTargets(cfg)).toThrow(/unset or empty/);
  });

  it("resolveTargets accepts a zai selection once the block + env var are present", () => {
    process.env[ENV] = "sk-test";
    const cfg = parseConfig({
      targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
      agent: { types: { review: { provider: "zai" }, fix: { provider: "zai", model: "glm-5.2[1m]" } } },
      providers: { zai: { authTokenEnv: ENV } },
    });
    expect(() => resolveTargets(cfg)).not.toThrow();
    const [target] = resolveTargets(cfg);
    expect(target!.agent.types.fix).toEqual({ provider: "zai", model: "glm-5.2[1m]" });
  });
});

describe("per-type preference list + capability gate (ADR-0037 P1.2, issue #160)", () => {
  const ENV = "RALPH_ZAI_P12_TEST_KEY";

  beforeEach(() => {
    process.env[ENV] = "sk-test";
  });
  afterEach(() => {
    delete process.env[ENV];
  });

  it("parses an ordered (provider, model) preference list, preserving order", () => {
    const cfg = parseConfig({
      targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
      agent: {
        types: {
          review: [
            { provider: "zai", model: "glm-5.2" },
            { provider: "openai", model: "gpt-5.5" },
            { provider: "claude" },
          ],
        },
      },
      providers: { openai: { codexHome: "~/.codex" }, zai: { authTokenEnv: ENV } },
    });
    expect(cfg.agent.types.review).toEqual([
      { provider: "zai", model: "glm-5.2" },
      { provider: "openai", model: "gpt-5.5" },
      { provider: "claude" },
    ]);
    // The list is carried, in order, onto every resolved target.
    const [target] = resolveTargets(cfg);
    expect(providerPreferenceList(target!.agent, "review")).toEqual([
      { provider: "zai", modelOverride: "glm-5.2" },
      { provider: "openai", modelOverride: "gpt-5.5" },
      { provider: "claude" },
    ]);
  });

  it("normalises the legacy single-provider form to a one-entry preference list", () => {
    const cfg = parseConfig({
      targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
      agent: { types: { fix: { provider: "openai", model: "gpt-5.5" } } },
      providers: { openai: { codexHome: "~/.codex" } },
    });
    // Legacy single-object shape still parses (back-compat).
    expect(cfg.agent.types.fix).toEqual({ provider: "openai", model: "gpt-5.5" });
    const [target] = resolveTargets(cfg);
    expect(providerPreferenceList(target!.agent, "fix")).toEqual([
      { provider: "openai", modelOverride: "gpt-5.5" },
    ]);
  });

  it("rejects an empty preference list", () => {
    expect(() =>
      parseConfig({
        targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
        agent: { types: { review: [] } },
      }),
    ).toThrow(ConfigError);
  });

  it("rejects an unknown key inside a preference-list entry (typo protection)", () => {
    expect(() =>
      parseConfig({
        targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
        agent: { types: { review: [{ provider: "openai", modell: "x" }] } },
      }),
    ).toThrow(ConfigError);
  });

  it("resolveTargets REJECTS a non-tools-capable provider in impl's list (capability gate)", () => {
    // impl requires the in-session escalate/stuck tools; bare openai (Codex) is not
    // tools-capable, so this must fail loud at LOAD even though providers.openai is wired.
    const cfg = parseConfig({
      targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
      agent: { types: { impl: { provider: "openai" } } },
      providers: { openai: { codexHome: "~/.codex" } },
    });
    expect(() => resolveTargets(cfg)).toThrow(ConfigError);
    expect(() => resolveTargets(cfg)).toThrow(/impl.*openai.*tools-capable/);
  });

  it("rejects a non-tools-capable provider anywhere in impl's preference list, not just the head", () => {
    const cfg = parseConfig({
      targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
      agent: { types: { impl: [{ provider: "zai" }, { provider: "openai" }] } },
      providers: { openai: { codexHome: "~/.codex" }, zai: { authTokenEnv: ENV } },
    });
    expect(() => resolveTargets(cfg)).toThrow(/impl.*openai.*tools-capable/);
  });

  it("rejects impl inheriting a non-tools-capable GLOBAL provider", () => {
    const cfg = parseConfig({
      targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
      agent: { provider: "openai" },
      providers: { openai: { codexHome: "~/.codex" } },
    });
    expect(() => resolveTargets(cfg)).toThrow(/impl.*openai.*tools-capable/);
  });

  it("ACCEPTS review/fix/autoMode on any provider (capability-open)", () => {
    const cfg = parseConfig({
      targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
      agent: {
        types: {
          review: { provider: "openai" },
          fix: [{ provider: "openai" }, { provider: "zai" }],
          autoMode: { provider: "openai" },
        },
      },
      providers: { openai: { codexHome: "~/.codex" }, zai: { authTokenEnv: ENV } },
    });
    expect(() => resolveTargets(cfg)).not.toThrow();
  });

  it("ACCEPTS an impl preference list of only tools-capable providers", () => {
    const cfg = parseConfig({
      targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
      agent: { types: { impl: [{ provider: "claude" }, { provider: "zai" }] } },
      providers: { zai: { authTokenEnv: ENV } },
    });
    expect(() => resolveTargets(cfg)).not.toThrow();
  });

  it("honours a toolsCapable override: impl on openai is accepted once openai is flagged tools-capable", () => {
    const cfg = parseConfig({
      targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
      agent: { types: { impl: { provider: "openai" } } },
      providers: { openai: { codexHome: "~/.codex", toolsCapable: true } },
    });
    expect(() => resolveTargets(cfg)).not.toThrow();
  });

  it("honours a toolsCapable override: impl on claude is rejected when claude is barred from tools", () => {
    const cfg = parseConfig({
      targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
      providers: { claude: { toolsCapable: false } },
    });
    expect(() => resolveTargets(cfg)).toThrow(/impl.*claude.*tools-capable/);
  });
});

describe("per-phase routing key — review/fix object form (ADR-0037 #169)", () => {
  const ENV = "RALPH_ZAI_P169_TEST_KEY";
  beforeEach(() => {
    process.env[ENV] = "sk-test";
  });
  afterEach(() => {
    delete process.env[ENV];
  });

  it("parses the per-phase object form for review (base required, phaseN optional)", () => {
    const cfg = parseConfig({
      targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
      agent: {
        types: {
          review: {
            base: [{ provider: "zai", model: "glm-5.2" }],
            phase1: [{ provider: "zai", model: "glm-5.2" }],
            phase2: [{ provider: "claude", model: "opus" }],
          },
        },
      },
      providers: { zai: { authTokenEnv: ENV } },
    });
    expect(cfg.agent.types.review).toEqual({
      base: [{ provider: "zai", model: "glm-5.2" }],
      phase1: [{ provider: "zai", model: "glm-5.2" }],
      phase2: [{ provider: "claude", model: "opus" }],
    });
    // The phased shape survives resolveTargets onto every target unchanged.
    const [target] = resolveTargets(cfg);
    expect(providerPreferenceList(target!.agent, "review", 2)).toEqual([{ provider: "claude", modelOverride: "opus" }]);
    expect(providerPreferenceList(target!.agent, "review", 1)).toEqual([{ provider: "zai", modelOverride: "glm-5.2" }]);
  });

  it("accepts the legacy/list form for review/fix unchanged (base-for-all-phases back-compat)", () => {
    const cfg = parseConfig({
      targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
      agent: { types: { fix: [{ provider: "zai" }, { provider: "claude" }] } },
      providers: { zai: { authTokenEnv: ENV } },
    });
    expect(cfg.agent.types.fix).toEqual([{ provider: "zai" }, { provider: "claude" }]);
  });

  it("REJECTS an object form whose base is missing (a phaseN-only config would strand the other phase)", () => {
    expect(() =>
      parseConfig({
        targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
        agent: { types: { review: { phase2: [{ provider: "claude" }] } } },
        providers: { zai: { authTokenEnv: ENV } },
      }),
    ).toThrow(ConfigError);
  });

  it("REJECTS a per-phase object form on impl (single-phase — fail loud via strict)", () => {
    expect(() =>
      parseConfig({
        targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
        agent: { types: { impl: { base: [{ provider: "claude" }], phase2: [{ provider: "claude" }] } } },
      }),
    ).toThrow(ConfigError);
  });

  it("REJECTS a per-phase object form on autoMode (single-phase — fail loud via strict)", () => {
    expect(() =>
      parseConfig({
        targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
        agent: { types: { autoMode: { base: [{ provider: "claude" }] } } },
      }),
    ).toThrow(ConfigError);
  });

  it("REJECTS an unknown phase key inside the object form (typo protection — phase3)", () => {
    expect(() =>
      parseConfig({
        targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
        agent: { types: { review: { base: [{ provider: "claude" }], phase3: [{ provider: "claude" }] } } },
      }),
    ).toThrow(ConfigError);
  });

  it("validates a per-phase entry's provider at LOAD (phase2 → openai with no providers.openai fails loud)", () => {
    const cfg = () =>
      resolveTargets(
        parseConfig({
          targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }],
          agent: {
            types: {
              review: { base: [{ provider: "claude" }], phase2: [{ provider: "openai" }] },
            },
          },
        }),
      );
    expect(cfg).toThrow(/openai is not configured/);
  });
});

describe("notification sink config (issue #117)", () => {
  const base = { targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }] };

  it("defaults to disabled with no endpoints and a 5-minute stall probe", () => {
    const cfg = parseConfig(base);
    expect(cfg.notifications).toEqual({
      enabled: false,
      endpoints: [],
      stallSeconds: 300,
      webpush: { enabled: false },
    });
  });

  it("parses an ntfy + webhook endpoint set and keeps the env-var name (never a secret)", () => {
    const cfg = parseConfig({
      ...base,
      notifications: {
        enabled: true,
        endpoints: [
          { kind: "ntfy", url: "https://ntfy.sh/ralph-alerts", tokenEnv: "NTFY_TOKEN" },
          { kind: "webhook", url: "https://example.com/hook" },
        ],
        stallSeconds: 120,
      },
    });
    expect(cfg.notifications.enabled).toBe(true);
    expect(cfg.notifications.endpoints).toHaveLength(2);
    expect(cfg.notifications.endpoints[0]).toEqual({
      kind: "ntfy",
      url: "https://ntfy.sh/ralph-alerts",
      tokenEnv: "NTFY_TOKEN",
    });
    expect(cfg.notifications.stallSeconds).toBe(120);
  });

  it("rejects an unknown notifications key (typo protection)", () => {
    expect(() =>
      parseConfig({ ...base, notifications: { enabled: true, endpointz: [] } }),
    ).toThrow(ConfigError);
  });

  it("webpush requires a subject + privateKeyEnv when enabled (issue #119)", () => {
    // Enabled but missing both identity fields → rejected.
    expect(() =>
      parseConfig({ ...base, notifications: { enabled: true, webpush: { enabled: true } } }),
    ).toThrow(ConfigError);
    // Enabled with both fields → accepted.
    const cfg = parseConfig({
      ...base,
      notifications: {
        enabled: true,
        webpush: { enabled: true, subject: "mailto:o@x", privateKeyEnv: "RALPH_VAPID_PRIVATE_KEY" },
      },
    });
    expect(cfg.notifications.webpush.enabled).toBe(true);
    expect(cfg.notifications.webpush.subject).toBe("mailto:o@x");
    expect(cfg.notifications.webpush.privateKeyEnv).toBe("RALPH_VAPID_PRIVATE_KEY");
  });

  it("webpush requires the notification sink to be enabled (ADR-0036 sink channel)", () => {
    expect(() =>
      parseConfig({
        ...base,
        notifications: {
          webpush: { enabled: true, subject: "mailto:o@x", privateKeyEnv: "RALPH_VAPID_PRIVATE_KEY" },
        },
      }),
    ).toThrow(/notifications.enabled: must be true when notifications.webpush.enabled is true/);
  });

  it("webpush subject must be a mailto: or https: URL (RFC 8292 — a bare address 403s every push)", () => {
    for (const subject of ["operator@example.com", "http://ralph.example", "https:", "mailto:", "mailto:not-email"]) {
      expect(() =>
        parseConfig({
          ...base,
          notifications: { enabled: true, webpush: { enabled: true, subject, privateKeyEnv: "K" } },
        }),
      ).toThrow(ConfigError);
    }
    for (const subject of ["mailto:o@x", "https://ralph.example"]) {
      expect(() =>
        parseConfig({
          ...base,
          notifications: { enabled: true, webpush: { enabled: true, subject, privateKeyEnv: "K" } },
        }),
      ).not.toThrow();
    }
  });

  it("rejects an unknown endpoint key (typo protection)", () => {
    expect(() =>
      parseConfig({
        ...base,
        notifications: { endpoints: [{ kind: "ntfy", url: "https://ntfy.sh/x", tokn: "X" }] },
      }),
    ).toThrow(ConfigError);
  });

  it("rejects an endpoint url that is not a fully-qualified URL", () => {
    expect(() =>
      parseConfig({
        ...base,
        notifications: { endpoints: [{ kind: "ntfy", url: "ntfy.sh/x" }] },
      }),
    ).toThrow(ConfigError);
  });

  it("rejects notification endpoint urls that are not HTTP(S)", () => {
    for (const url of ["file:///tmp/topic", "ftp://example.com/topic", "mailto:ops@example.com", "javascript:alert(1)"]) {
      expect(() =>
        parseConfig({
          ...base,
          notifications: { endpoints: [{ kind: "webhook", url }] },
        }),
      ).toThrow(ConfigError);
    }
  });

  it("rejects notification endpoint urls with embedded credentials", () => {
    for (const url of ["https://user@hooks.example.com/topic", "https://user:pass@hooks.example.com/topic"]) {
      expect(() =>
        parseConfig({
          ...base,
          notifications: { endpoints: [{ kind: "webhook", url }] },
        }),
      ).toThrow(ConfigError);
    }
  });

  it("rejects an unknown endpoint kind", () => {
    expect(() =>
      parseConfig({
        ...base,
        notifications: { endpoints: [{ kind: "slack", url: "https://example.com/x" }] },
      }),
    ).toThrow(ConfigError);
  });

  it("rejects a negative stallSeconds", () => {
    expect(() => parseConfig({ ...base, notifications: { stallSeconds: -1 } })).toThrow(ConfigError);
  });

  it("rejects an enabled stall probe that cannot outlive the reconcile interval", () => {
    expect(() =>
      parseConfig({
        ...base,
        scheduler: { reconcileIntervalSeconds: 30 },
        notifications: { enabled: true, stallSeconds: 30 },
      }),
    ).toThrow(/notifications.stallSeconds: must be 0 or greater than scheduler.reconcileIntervalSeconds/);
    expect(() =>
      parseConfig({
        ...base,
        scheduler: { reconcileIntervalSeconds: 30 },
        notifications: { enabled: true, stallSeconds: 5 },
      }),
    ).toThrow(/notifications.stallSeconds: must be 0 or greater than scheduler.reconcileIntervalSeconds/);
  });

  it("allows stallSeconds 0 as the documented disabled stall probe", () => {
    const cfg = parseConfig({
      ...base,
      scheduler: { reconcileIntervalSeconds: 30 },
      notifications: { enabled: true, stallSeconds: 0 },
    });
    expect(cfg.notifications.stallSeconds).toBe(0);
  });
});

describe("account pool (ADR-0037 P1.1, issue #159)", () => {
  const base = { targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }] };

  it("defaults to an empty pool when nothing is configured", () => {
    const cfg = parseConfig(base);
    expect(cfg.accounts).toEqual([]);
    expect(resolveAccountPool(cfg)).toEqual([]);
  });

  it("parses a pool with multiple providers, N per provider (including zero openai)", () => {
    const cfg = parseConfig({
      ...base,
      accounts: [
        { id: "claude-a", provider: "claude", configDir: "~/.claude" },
        { id: "claude-b", provider: "claude", configDir: "~/.claude-b" },
        { id: "zai-1", provider: "zai", authTokenEnv: "ZAI_KEY_1" },
        { id: "zai-2", provider: "zai", authTokenEnv: "ZAI_KEY_2" },
        { id: "zai-3", provider: "zai", authTokenEnv: "ZAI_KEY_3" },
        // zero openai accounts — the provider is simply absent from the pool
      ],
    });
    const pool = resolveAccountPool(cfg);
    expect(pool).toHaveLength(5);
    expect(pool.filter((a) => a.provider === "claude")).toHaveLength(2);
    expect(pool.filter((a) => a.provider === "zai")).toHaveLength(3);
    expect(pool.filter((a) => a.provider === "openai")).toHaveLength(0);
  });

  it("rejects duplicate explicit account ids on the schema and config load paths", () => {
    const raw = {
      ...base,
      accounts: [
        { id: "dup", provider: "claude", configDir: "~/.claude" },
        { id: "dup", provider: "zai", authTokenEnv: "ZAI_KEY" },
      ],
    };

    expect(configSchema.safeParse(raw).success).toBe(false);
    expect(() => parseConfig(raw)).toThrow(ConfigError);
    expect(() => parseConfig(raw)).toThrow(/duplicate account id: dup/);

    expect(() =>
      loadConfig(
        tmpConfig(`
targets:
  - repo: a/b
    commands:
      build: x
      test: y
accounts:
  - id: dup
    provider: claude
    configDir: ~/.claude
  - id: dup
    provider: zai
    authTokenEnv: ZAI_KEY
`),
      ),
    ).toThrow(/duplicate account id: dup/);
  });

  it("parses each provider's provider-shaped auth and keeps accounts model-free", () => {
    const cfg = parseConfig({
      ...base,
      accounts: [
        { id: "c", provider: "claude", configDir: "~/.claude" },
        { id: "o", provider: "openai", codexHome: "~/.codex-ralph" },
        { id: "z", provider: "zai", authTokenEnv: "ZAI_KEY" },
      ],
    });
    expect(cfg.accounts).toEqual([
      { id: "c", provider: "claude", configDir: "~/.claude" },
      { id: "o", provider: "openai", codexHome: "~/.codex-ralph" },
      { id: "z", provider: "zai", authTokenEnv: "ZAI_KEY" },
    ]);
  });

  it("rejects a model on an account (accounts are model-free)", () => {
    expect(() =>
      parseConfig({
        ...base,
        accounts: [{ id: "c", provider: "claude", configDir: "~/.claude", model: "opus" }],
      }),
    ).toThrow(ConfigError);
  });

  it("rejects provider-mismatched auth (a claude account with codexHome)", () => {
    expect(() =>
      parseConfig({ ...base, accounts: [{ id: "c", provider: "claude", codexHome: "~/.codex" }] }),
    ).toThrow(ConfigError);
  });

  it("rejects an unknown account key (typo protection)", () => {
    expect(() =>
      parseConfig({ ...base, accounts: [{ id: "c", provider: "claude", configDirr: "~/.claude" }] }),
    ).toThrow(ConfigError);
  });

  it("rejects an unknown provider in an account", () => {
    expect(() =>
      parseConfig({ ...base, accounts: [{ id: "c", provider: "gemini", configDir: "~/.x" }] }),
    ).toThrow(ConfigError);
  });

  it("normalises legacy usageLimit.subscriptions into the pool as the claude slice", () => {
    const cfg = parseConfig({
      ...base,
      usageLimit: {
        subscriptions: [
          { id: "a", configDir: "~/.claude" },
          { id: "b", configDir: "~/.claude-b" },
        ],
      },
    });
    // The legacy block still parses (existing consumers read it unchanged)...
    expect(cfg.usageLimit.subscriptions).toHaveLength(2);
    // ...and folds into the resolved pool as model-free claude accounts.
    expect(resolveAccountPool(cfg)).toEqual([
      { id: "a", provider: "claude", configDir: "~/.claude" },
      { id: "b", provider: "claude", configDir: "~/.claude-b" },
    ]);
  });

  it("merges an explicit pool with the legacy claude slice (explicit first)", () => {
    const cfg = parseConfig({
      ...base,
      accounts: [{ id: "zai-1", provider: "zai", authTokenEnv: "ZAI_KEY" }],
      usageLimit: { subscriptions: [{ id: "claude-a", configDir: "~/.claude" }] },
    });
    expect(resolveAccountPool(cfg)).toEqual([
      { id: "zai-1", provider: "zai", authTokenEnv: "ZAI_KEY" },
      { id: "claude-a", provider: "claude", configDir: "~/.claude" },
    ]);
  });

  it("folds providers.openai.codexHome + providers.zai.authTokenEnv as back-compat slices (ADR-0037 P2.2)", () => {
    const cfg = parseConfig({
      ...base,
      providers: {
        openai: { codexHome: "~/.codex-ralph" },
        zai: { authTokenEnv: "ZAI_KEY" },
      },
    });
    // The single-block creds normalise into the pool exactly like the claude subscriptions
    // slice — so the resolved pool is the one credential source for ALL providers.
    expect(resolveAccountPool(cfg)).toEqual([
      { id: "openai", provider: "openai", codexHome: "~/.codex-ralph" },
      { id: "zai", provider: "zai", authTokenEnv: "ZAI_KEY" },
    ]);
  });

  it("does NOT fold a kind-only providers block with no credential (multi-account shape)", () => {
    const cfg = parseConfig({
      ...base,
      // Kind settings only — the credentials live in explicit `accounts:` entries.
      providers: { openai: { model: "gpt-5.5" }, zai: { model: "glm-5.2" } },
      accounts: [
        { id: "codex-1", provider: "openai", codexHome: "~/.codex-a" },
        { id: "codex-2", provider: "openai", codexHome: "~/.codex-b" },
        { id: "zai-1", provider: "zai", authTokenEnv: "ZAI_KEY_1" },
      ],
    });
    expect(resolveAccountPool(cfg)).toEqual([
      { id: "codex-1", provider: "openai", codexHome: "~/.codex-a" },
      { id: "codex-2", provider: "openai", codexHome: "~/.codex-b" },
      { id: "zai-1", provider: "zai", authTokenEnv: "ZAI_KEY_1" },
    ]);
  });

  it("rejects a back-compat openai/zai id colliding with an explicit account", () => {
    const raw = {
      ...base,
      accounts: [{ id: "zai", provider: "claude", configDir: "~/.claude" }],
      providers: { zai: { authTokenEnv: "ZAI_KEY" } },
    };
    expect(() => parseConfig(raw)).toThrow(/duplicate account id: zai/);
  });

  it("fails loud on a duplicate account id across the resolved pool", () => {
    const raw = {
      ...base,
      accounts: [{ id: "dup", provider: "zai", authTokenEnv: "ZAI_KEY" }],
      usageLimit: { subscriptions: [{ id: "dup", configDir: "~/.claude" }] },
    };
    expect(configSchema.safeParse(raw).success).toBe(false);
    expect(() => parseConfig(raw)).toThrow(ConfigError);
    expect(() => parseConfig(raw)).toThrow(/duplicate account id: dup/);
  });

  it("keeps resolveAccountPool as a pure normalizer", () => {
    const parsed = parseConfig(base);
    const cfg = {
      ...parsed,
      accounts: [{ id: "dup", provider: "zai", authTokenEnv: "ZAI_KEY" }],
      usageLimit: { ...parsed.usageLimit, subscriptions: [{ id: "dup", configDir: "~/.claude" }] },
    } as RalphConfig;

    expect(resolveAccountPool(cfg)).toEqual([
      { id: "dup", provider: "zai", authTokenEnv: "ZAI_KEY" },
      { id: "dup", provider: "claude", configDir: "~/.claude" },
    ]);
  });

  it("rejects an unknown top-level accounts key shape", () => {
    expect(() => parseConfig({ ...base, accounts: [{ id: "c", provider: "claude" }] })).toThrow(
      ConfigError,
    );
  });
});

describe("provider toolsCapable (ADR-0037 P1.1, issue #159)", () => {
  const base = { targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }] };

  it("derives defaults per provider: claude/zai true, openai false", () => {
    expect(PROVIDER_TOOLS_CAPABLE_DEFAULTS).toEqual({ claude: true, openai: false, zai: true });
    const cfg = parseConfig(base);
    expect(providerToolsCapable(cfg.providers, "claude")).toBe(true);
    expect(providerToolsCapable(cfg.providers, "zai")).toBe(true);
    expect(providerToolsCapable(cfg.providers, "openai")).toBe(false);
  });

  it("does not materialise a toolsCapable field on unset provider blocks (shape unchanged)", () => {
    const cfg = parseConfig({
      ...base,
      providers: { openai: { codexHome: "~/.codex-ralph" }, zai: { authTokenEnv: "ZAI_KEY" } },
    });
    expect(cfg.providers.openai).toEqual({ codexHome: "~/.codex-ralph", model: "gpt-5.5" });
    expect(cfg.providers.zai).toEqual({
      authTokenEnv: "ZAI_KEY",
      baseUrl: "https://api.z.ai/api/anthropic",
      model: "glm-5.2",
    });
  });

  it("allows overriding toolsCapable per provider definition (incl. a claude block)", () => {
    const cfg = parseConfig({
      ...base,
      providers: {
        claude: { toolsCapable: false },
        openai: { codexHome: "~/.codex", toolsCapable: true },
        zai: { authTokenEnv: "ZAI_KEY", toolsCapable: false },
      },
    });
    expect(providerToolsCapable(cfg.providers, "claude")).toBe(false);
    expect(providerToolsCapable(cfg.providers, "openai")).toBe(true);
    expect(providerToolsCapable(cfg.providers, "zai")).toBe(false);
  });

  it("rejects a non-boolean toolsCapable", () => {
    expect(() =>
      parseConfig({ ...base, providers: { zai: { authTokenEnv: "K", toolsCapable: "yes" } } }),
    ).toThrow(ConfigError);
  });

  it("rejects an unknown key in the providers.claude block (strict)", () => {
    expect(() =>
      parseConfig({ ...base, providers: { claude: { toolsCapablee: true } } }),
    ).toThrow(ConfigError);
  });
});

describe("agent.tiers — per-complexity-tier agent profiles (issue #278)", () => {
  const BASE = { targets: [{ repo: "a/b", commands: { build: "x", test: "y" } }] };

  it("parses the full tiered form and defaults to an empty block", () => {
    const cfg = parseConfig({
      ...BASE,
      agent: {
        tiers: {
          "1": { routes: [{ provider: "claude", model: "claude-fable-5" }], effort: "max", wallClockSeconds: 10800 },
          "3": { routes: [{ provider: "zai" }], effort: "medium" },
        },
      },
    });
    expect(cfg.agent.tiers["1"]).toEqual({
      routes: [{ provider: "claude", model: "claude-fable-5" }],
      effort: "max",
      wallClockSeconds: 10800,
    });
    expect(cfg.agent.tiers["2"]).toBeUndefined();
    // Absent block → {} (no profiles), so untiered configs are byte-identical.
    expect(parseConfig(BASE).agent.tiers).toEqual({});
  });

  it("rejects an unknown tier key — '4' or a typo fails loud", () => {
    expect(() => parseConfig({ ...BASE, agent: { tiers: { "4": { effort: "low" } } } })).toThrow(ConfigError);
    expect(() => parseConfig({ ...BASE, agent: { tiers: { tier1: { effort: "low" } } } })).toThrow(ConfigError);
  });

  it("rejects unknown profile fields and an empty routes list", () => {
    expect(() => parseConfig({ ...BASE, agent: { tiers: { "1": { model: "opus" } } } })).toThrow(ConfigError);
    expect(() => parseConfig({ ...BASE, agent: { tiers: { "1": { routes: [] } } } })).toThrow(ConfigError);
  });

  it("a per-target tiers override replaces the global block whole (spread-merge convention)", () => {
    const cfg = parseConfig({
      targets: [
        {
          repo: "a/b",
          commands: { build: "x", test: "y" },
          agent: { tiers: { "2": { effort: "high" } } },
        },
      ],
      agent: { tiers: { "1": { effort: "max" } } },
    });
    const target = resolveTargets(cfg)[0]!;
    expect(target.agent.tiers).toEqual({ "2": { effort: "high" } });
  });

  it("load-time validation walks tier routes: a tier naming an account-less provider fails loud", () => {
    const cfg = parseConfig({
      ...BASE,
      agent: { tiers: { "1": { routes: [{ provider: "zai" }] } } },
      providers: {},
    });
    expect(() => resolveTargets(cfg)).toThrow(ConfigError);
    expect(() => resolveTargets(cfg)).toThrow(/providers\.zai is not configured/);
  });

  it("load-time validation applies the capability gate to tier routes (impl semantics)", () => {
    const cfg = parseConfig({
      ...BASE,
      agent: { tiers: { "1": { routes: [{ provider: "openai", model: "gpt-5.5" }] } } },
      providers: { openai: { codexHome: "~/.codex-x" } },
    });
    expect(() => resolveTargets(cfg)).toThrow(/not tools-capable/);
  });
});
