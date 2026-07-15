import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig, resolveTargets } from "../config/load";
import type { TargetConfig } from "../config/schema";
import {
  buildAgentOptions,
  loadBoxMcpServers,
  resolveMcpServerDefs,
  selectCuratedMcpServers,
  toRateLimitSignal,
  toUtilizationPercent,
} from "./agent";

function config(): TargetConfig {
  return resolveTargets(
    parseConfig({
      targets: [{ repo: "acme/widgets", commands: { build: "npm run build", test: "npm test" } }],
    }),
  )[0]!;
}

// The box's MCP registry includes `memory` — the agent must never receive it.
const registry = {
  serena: { command: "serena", args: [] },
  "codebase-memory": { command: "codebase-memory-mcp", args: [] },
  "morph-mcp": { command: "morph", args: [] },
  context7: { type: "http" as const, url: "https://context7.example" },
  github: { command: "gh-mcp", args: [] },
  "sequential-thinking": { command: "seq", args: [] },
  memory: { command: "memory-server", args: [] },
};

describe("selectCuratedMcpServers", () => {
  it("includes the curated servers and excludes memory even if configured", () => {
    const selected = selectCuratedMcpServers(registry, [
      "serena",
      "morph-mcp",
      "context7",
      "github",
      "sequential-thinking",
      "memory",
    ]);
    expect(Object.keys(selected).sort()).toEqual(
      ["context7", "github", "morph-mcp", "sequential-thinking", "serena"].sort(),
    );
    expect(selected).not.toHaveProperty("memory");
  });

  it("skips curated names with no config on the box", () => {
    const selected = selectCuratedMcpServers({ serena: { command: "s", args: [] } }, ["serena", "github"]);
    expect(Object.keys(selected)).toEqual(["serena"]);
  });
});

describe("resolveMcpServerDefs (config-owned definitions, issue #264)", () => {
  it("materializes stdio configs, substituting ${workspace} in args and env values", () => {
    const resolved = resolveMcpServerDefs(
      {
        serena: {
          command: "uvx",
          args: ["serena", "start-mcp-server", "--project", "${workspace}"],
          env: { SERENA_LOG_DIR: "${workspace}/.serena" },
        },
        "morph-mcp": { command: "npx", args: ["-y", "@morphllm/morphmcp"], env: { MORPH_API_KEY: "k" } },
      },
      "/tmp/ralph-run-x/clone",
    );
    expect(resolved["serena"]).toEqual({
      type: "stdio",
      command: "uvx",
      args: ["serena", "start-mcp-server", "--project", "/tmp/ralph-run-x/clone"],
      env: { SERENA_LOG_DIR: "/tmp/ralph-run-x/clone/.serena" },
    });
    // no token → passes through untouched; env keys are never substituted, only values
    expect(resolved["morph-mcp"]).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@morphllm/morphmcp"],
      env: { MORPH_API_KEY: "k" },
    });
  });
});

describe("config-owned mcpServerDefs reach the session (issue #264)", () => {
  function configWithDefs(): TargetConfig {
    return resolveTargets(
      parseConfig({
        targets: [{ repo: "acme/widgets", commands: { build: "npm run build", test: "npm test" } }],
        agent: {
          // memory is curated on purpose here: the exclusion must hold even for config defs
          mcpServers: ["serena", "memory"],
          mcpServerDefs: {
            serena: { command: "uvx", args: ["serena", "--project", "${workspace}"] },
            memory: { command: "memory-server" },
          },
        },
      }),
    )[0]!;
  }

  it("resolves curated names from config defs when the box registry is empty (the container case)", () => {
    const options = buildAgentOptions(configWithDefs(), { worktreePath: "/wt/2-x" }, {});
    expect(options.mcpServers).toHaveProperty("serena");
    const serena = options.mcpServers!["serena"] as { args: string[] };
    expect(serena.args).toEqual(["serena", "--project", "/wt/2-x"]);
  });

  it("a config def wins over the box registry on a name collision", () => {
    const options = buildAgentOptions(configWithDefs(), { worktreePath: "/wt/2-x" }, registry);
    const serena = options.mcpServers!["serena"] as { command: string };
    expect(serena.command).toBe("uvx"); // the registry's box def says "serena"
  });

  it("still excludes memory even when it is defined in config", () => {
    const options = buildAgentOptions(configWithDefs(), { worktreePath: "/wt/2-x" }, registry);
    expect(options.mcpServers).not.toHaveProperty("memory");
  });
});

describe("buildAgentOptions", () => {
  it("never hands the agent the memory MCP (fresh context)", () => {
    const options = buildAgentOptions(config(), { worktreePath: "/wt/2-x" }, registry);
    expect(options.mcpServers).toBeDefined();
    expect(options.mcpServers).not.toHaveProperty("memory");
    expect(Object.keys(options.mcpServers!)).toContain("codebase-memory");
  });

  it("runs fresh-context: no inherited settings sources", () => {
    const options = buildAgentOptions(config(), { worktreePath: "/wt/2-x" }, registry);
    expect(options.settingSources).toEqual(["project"]);
  });

  it("forces OAuth login, never an API key", () => {
    const options = buildAgentOptions(config(), { worktreePath: "/wt/2-x" }, registry);
    expect(options.settings).toMatchObject({ forceLoginMethod: "claudeai" });
  });

  it("runs in the issue's worktree", () => {
    const options = buildAgentOptions(config(), { worktreePath: "/wt/2-x" }, registry);
    expect(options.cwd).toBe("/wt/2-x");
  });

  it("wires the git-guardrails PreToolUse hook on every session (AC3)", () => {
    const options = buildAgentOptions(config(), { worktreePath: "/wt/2-x" }, registry);
    const preToolUse = options.hooks?.PreToolUse;
    expect(preToolUse).toBeDefined();
    expect(preToolUse!.some((m) => m.matcher === "Bash")).toBe(true);
  });

  it("routes the session credential via CLAUDE_CONFIG_DIR when a configDir is given (ADR-0028)", () => {
    const routed = buildAgentOptions(config(), { worktreePath: "/wt/2-x", configDir: "/home/box/.claude-b" }, registry);
    expect(routed.env?.CLAUDE_CONFIG_DIR).toBe("/home/box/.claude-b");
    // No configDir → no env override (single-login default).
    const def = buildAgentOptions(config(), { worktreePath: "/wt/2-x" }, registry);
    expect(def.env).toBeUndefined();
  });

  it("drives an Anthropic-compatible endpoint via env injection when given one (ADR-0034)", () => {
    const endpoint = { baseUrl: "https://api.z.ai/api/anthropic", authToken: "sk-zai", model: "glm-5.2" };
    const options = buildAgentOptions(config(), { worktreePath: "/wt/2-x", endpoint }, registry);
    // Model is overridden to the endpoint's (not config.agent.model / opus).
    expect(options.model).toBe("glm-5.2");
    // Base URL + bearer token injected; NO CLAUDE_CONFIG_DIR (no OAuth store on this path).
    expect(options.env?.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(options.env?.ANTHROPIC_AUTH_TOKEN).toBe("sk-zai");
    expect(options.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    // forceLoginMethod is dropped — it would force the OAuth login method and conflict.
    expect(options.settings).toBeUndefined();
    // PATH etc. are still inherited (env REPLACES the child env, so process.env is spread).
    expect(options.env?.PATH).toBe(process.env.PATH);
  });

  it("an endpoint override takes precedence over a configDir (mutually exclusive)", () => {
    const endpoint = { baseUrl: "https://api.z.ai/api/anthropic", authToken: "sk-zai", model: "glm-5.2" };
    const options = buildAgentOptions(config(), { worktreePath: "/wt/2-x", endpoint, configDir: "/home/box/.claude-b" }, registry);
    expect(options.env?.ANTHROPIC_AUTH_TOKEN).toBe("sk-zai");
    expect(options.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
  });
});

describe("loadBoxMcpServers", () => {
  it("reads mcpServers from a claude config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-mcp-"));
    const path = join(dir, ".claude.json");
    writeFileSync(path, JSON.stringify({ mcpServers: { serena: { command: "s", args: [] } } }));
    expect(loadBoxMcpServers(path)).toEqual({ serena: { command: "s", args: [] } });
  });

  it("returns {} when the file is absent", () => {
    expect(loadBoxMcpServers(join(tmpdir(), "definitely-absent-claude.json"))).toEqual({});
  });
});

describe("toUtilizationPercent (streaming 0–1 fraction → 0–100 the usage core expects)", () => {
  it("scales a 0–1 fraction up to a percentage", () => {
    // The bug: a weekly window at 87% streams as 0.87 and must read as 87, not 0.87,
    // so usageGate (>= admitBelowPercent, e.g. 85) actually trips.
    expect(toUtilizationPercent(0.87)).toBe(87);
    expect(toUtilizationPercent(0.85)).toBe(85);
    expect(toUtilizationPercent(0)).toBe(0);
    expect(toUtilizationPercent(1)).toBe(100);
  });

  it("passes a value already on the 0–100 scale through unchanged", () => {
    // Forward-safe: if the SDK ever unifies units to 0–100, we must not re-scale.
    expect(toUtilizationPercent(87)).toBe(87);
    expect(toUtilizationPercent(100)).toBe(100);
  });

  it("clamps to 0–100 and maps unknown/non-finite to undefined", () => {
    expect(toUtilizationPercent(150)).toBe(100);
    expect(toUtilizationPercent(undefined)).toBeUndefined();
    expect(toUtilizationPercent(NaN)).toBeUndefined();
  });

  it("normalizes the fraction when reducing a streamed SDKRateLimitInfo", () => {
    expect(toRateLimitSignal({ status: "allowed", utilization: 0.87, rateLimitType: "seven_day" })).toEqual({
      status: "allowed",
      utilization: 87,
      resetsAt: undefined,
      rateLimitType: "seven_day",
    });
  });
});
