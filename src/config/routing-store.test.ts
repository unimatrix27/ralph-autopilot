import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseConfig, resolveTargets } from "./load";
import type { Account, ProviderName, RalphConfigInput } from "./schema";
import { RoutingStore, type RoutingStoreDeps } from "./routing-store";
import { resolveRoute, type RouteWorld } from "../providers/resolve";

const REPO = "owner/app";

const CLAUDE: Account = { id: "c", provider: "claude", configDir: "/c" };
const ZAI: Account = { id: "z", provider: "zai", authTokenEnv: "ZAI_KEY" };
const OPENAI: Account = { id: "o", provider: "openai", codexHome: "/o" };

/** A pure headroom port: each named provider hands back a fixed account; others return null. */
function world(headroom: Partial<Record<ProviderName, Account>>): RouteWorld {
  return { acquireAccount: (_repo, provider) => headroom[provider] ?? null };
}

function buildStore(
  cfg: { agent?: Record<string, unknown>; providers?: Record<string, unknown>; accounts?: unknown[] } = {},
  opts: Partial<RoutingStoreDeps> = {},
): RoutingStore {
  const input: RalphConfigInput = {
    targets: [{ repo: REPO, commands: { build: "b", test: "t" } }],
    agent: cfg.agent ?? {},
    providers: cfg.providers ?? {},
    accounts: (cfg.accounts ?? []) as RalphConfigInput["accounts"],
  };
  const config = parseConfig(input);
  const targets = resolveTargets(config);
  return new RoutingStore({ config, targets, ...opts });
}

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
  delete process.env.ZAI_KEY;
});

function writeConfigFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ralph-routing-"));
  tmpDirs.push(dir);
  const path = join(dir, "config.yaml");
  writeFileSync(path, body, "utf8");
  return path;
}

describe("RoutingStore — runtime overlay (ADR-0037 P4.1, AC1)", () => {
  it("a write updates the overlay; the next resolveRoute reflects it, an already-resolved route is unchanged", () => {
    // z.ai key lives in an env var (ADR-0034); set it so the load-time validation the overlay
    // re-runs on the candidate (impl → zai) passes. Not needed at construction — impl is on claude there.
    process.env.ZAI_KEY = "secret";
    const store = buildStore({
      providers: { zai: {} },
      accounts: [{ id: "z", provider: "zai", authTokenEnv: "ZAI_KEY" }],
    }); // overlay-only (no configPath) — the runtime effect is independent of disk.
    const src = store.routingSourceFor(REPO);
    const headroom = world({ claude: CLAUDE, zai: ZAI });

    // Before: impl resolves to the global default (claude). Capture it as the "in-flight" route.
    const inFlight = resolveRoute(src(), REPO, "impl", headroom);
    expect(inFlight).toEqual({ provider: "claude", account: CLAUDE });

    // The web edit lands in the overlay: route impl to zai (tools-capable).
    expect(store.applyEdit({ target: "type", type: "impl", routing: [{ provider: "zai", model: "glm-5.2" }] })).toEqual({
      ok: true,
      cleared: false,
    });

    // The NEXT dispatch reads the overlay and lands on the new route.
    expect(resolveRoute(src(), REPO, "impl", headroom)).toEqual({ provider: "zai", model: "glm-5.2", account: ZAI });

    // The already-resolved route value is untouched — an in-flight container finishes on the
    // route it was dispatched with (one fixed route per container life, ADR-0038).
    expect(inFlight).toEqual({ provider: "claude", account: CLAUDE });
  });

  it("clearing a type's override falls the next dispatch back to the global default", () => {
    const store = buildStore({ agent: { types: { review: { provider: "claude", model: "sonnet" } } } });
    const src = store.routingSourceFor(REPO);
    const headroom = world({ claude: CLAUDE });
    expect(resolveRoute(src(), REPO, "review", headroom)).toEqual({ provider: "claude", model: "sonnet", account: CLAUDE });

    expect(store.applyEdit({ target: "type", type: "review", routing: null })).toEqual({ ok: true, cleared: true });

    // The override is gone → review uses the global default provider with no model override.
    expect(resolveRoute(src(), REPO, "review", headroom)).toEqual({ provider: "claude", account: CLAUDE });
  });
});

describe("RoutingStore — write-through to config.yaml (ADR-0037 P4.1, AC2)", () => {
  it("persists a set edit to config.yaml; reloading config reads it back (round-trip), comments preserved", () => {
    const path = writeConfigFile(
      "# my operator config\ntargets:\n  - { repo: owner/app, commands: { build: b, test: t } }\nagent:\n  model: opus\n",
    );
    const config = loadConfig(path);
    const store = new RoutingStore({ config, targets: resolveTargets(config), configPath: path });

    expect(store.applyEdit({ target: "type", type: "review", routing: { provider: "claude", model: "sonnet" } }).ok).toBe(
      true,
    );

    const reloaded = loadConfig(path);
    expect(reloaded.agent.types.review).toEqual({ provider: "claude", model: "sonnet" });
    expect(readFileSync(path, "utf8")).toContain("# my operator config");
  });

  it("persists a preference-list set + a clear; the reload reflects exactly the overlay", () => {
    const path = writeConfigFile(
      "targets:\n  - { repo: owner/app, commands: { build: b, test: t } }\nagent:\n  types:\n    fix: { provider: claude }\n",
    );
    const config = loadConfig(path);
    const store = new RoutingStore({ config, targets: resolveTargets(config), configPath: path });

    store.applyEdit({
      target: "type",
      type: "review",
      routing: [
        { provider: "claude", model: "opus" },
        { provider: "claude", model: "sonnet" },
      ],
    });
    store.applyEdit({ target: "type", type: "fix", routing: null });

    const reloaded = loadConfig(path);
    expect(reloaded.agent.types.review).toEqual([
      { provider: "claude", model: "opus" },
      { provider: "claude", model: "sonnet" },
    ]);
    // The cleared override is gone from the file.
    expect(reloaded.agent.types.fix).toBeUndefined();
  });

  it("rejects the edit and leaves the overlay unchanged when write-through fails", () => {
    const store = buildStore(
      {},
      {
        configPath: "/no/such/dir/config.yaml",
        readFile: () => {
          throw new Error("ENOENT: no such file");
        },
        writeFile: () => {
          throw new Error("should not be reached");
        },
      },
    );
    const src = store.routingSourceFor(REPO);
    const outcome = store.applyEdit({ target: "type", type: "review", routing: { provider: "claude", model: "sonnet" } });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toMatch(/failed to persist/i);
    // The overlay never committed: review still resolves to the default (no model override).
    expect(resolveRoute(src(), REPO, "review", world({ claude: CLAUDE }))).toEqual({ provider: "claude", account: CLAUDE });
  });
});

describe("RoutingStore — capability gate at the edge (ADR-0037 P4.1, AC3)", () => {
  it("rejects a capability-invalid edit (impl → openai) with a clear error, overlay unchanged", () => {
    const store = buildStore();
    const src = store.routingSourceFor(REPO);
    const outcome = store.applyEdit({ target: "type", type: "impl", routing: { provider: "openai", model: "gpt-5.5" } });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toMatch(/not tools-capable/i);
    // The overlay is untouched: impl still resolves to claude (never a guess onto the wrong backend).
    expect(resolveRoute(src(), REPO, "impl", world({ claude: CLAUDE, openai: OPENAI }))).toEqual({
      provider: "claude",
      account: CLAUDE,
    });
  });

  it("rejects an edit that would make the config un-loadable (review → openai, no providers.openai), guarding the next restart", () => {
    const store = buildStore();
    const outcome = store.applyEdit({ target: "type", type: "review", routing: { provider: "openai" } });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toMatch(/openai is not configured/i);
  });

  it("admits impl → zai (a tools-capable provider) once it is configured with an account", () => {
    process.env.ZAI_KEY = "secret";
    const store = buildStore({
      providers: { zai: {} },
      accounts: [{ id: "z", provider: "zai", authTokenEnv: "ZAI_KEY" }],
    });
    expect(store.applyEdit({ target: "type", type: "impl", routing: { provider: "zai" } }).ok).toBe(true);
  });
});

describe("RoutingStore — per-phase routing edit (ADR-0037 #169)", () => {
  it("a per-phase set edit resolves phase 2 to a different route than phase 1 on the next dispatch", () => {
    const store = buildStore();
    const src = store.routingSourceFor(REPO);
    const headroom = world({ claude: CLAUDE });

    expect(
      store.applyEdit({
        target: "type",
        type: "review",
        routing: { base: [{ provider: "claude", model: "glm-stand-in" }], phase2: [{ provider: "claude", model: "opus" }] },
      }),
    ).toEqual({ ok: true, cleared: false });

    // Phase 1 (no override) → base; phase 2 → its own list — whole-list replacement.
    expect(resolveRoute(src(), REPO, "review", headroom, 1)).toEqual({ provider: "claude", model: "glm-stand-in", account: CLAUDE });
    expect(resolveRoute(src(), REPO, "review", headroom, 2)).toEqual({ provider: "claude", model: "opus", account: CLAUDE });
  });

  it("persists a per-phase edit to config.yaml; reload reads the object form back (round-trip)", () => {
    const path = writeConfigFile(
      "targets:\n  - { repo: owner/app, commands: { build: b, test: t } }\n",
    );
    const config = loadConfig(path);
    const store = new RoutingStore({ config, targets: resolveTargets(config), configPath: path });

    expect(
      store.applyEdit({
        target: "type",
        type: "fix",
        routing: { base: { provider: "claude" }, phase2: [{ provider: "claude", model: "opus" }] },
      }).ok,
    ).toBe(true);

    const reloaded = loadConfig(path);
    expect(reloaded.agent.types.fix).toEqual({ base: { provider: "claude" }, phase2: [{ provider: "claude", model: "opus" }] });
  });

  it("rejects a per-phase edit whose phaseN names an unconfigured provider (guards the next restart)", () => {
    const store = buildStore();
    const outcome = store.applyEdit({
      target: "type",
      type: "review",
      routing: { base: [{ provider: "claude" }], phase2: [{ provider: "openai" }] },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toMatch(/openai is not configured/i);
  });
});

describe("RoutingStore — snapshot for the read", () => {
  it("exposes the global agent, providers, and resolved account pool", () => {
    const store = buildStore({
      agent: { types: { review: { provider: "claude", model: "sonnet" } } },
      accounts: [{ id: "c", provider: "claude", configDir: "/c" }],
    });
    const snap = store.snapshot();
    expect(snap.agent.provider).toBe("claude");
    expect(snap.agent.types.review).toEqual({ provider: "claude", model: "sonnet" });
    expect(snap.accounts).toEqual([{ id: "c", provider: "claude", configDir: "/c" }]);
  });

  it("preserves a per-target agent override in the per-repo routing (global edit does not clobber it)", () => {
    // A target that pins review → claude:sonnet keeps it even as the global review default differs.
    const config = parseConfig({
      targets: [
        {
          repo: REPO,
          commands: { build: "b", test: "t" },
          agent: { types: { review: { provider: "claude", model: "sonnet" } } },
        },
      ],
      agent: { types: { review: { provider: "claude", model: "opus" } } },
    });
    const store = new RoutingStore({ config, targets: resolveTargets(config) });
    const route = resolveRoute(store.routingFor(REPO), REPO, "review", world({ claude: CLAUDE }));
    expect(route).toEqual({ provider: "claude", model: "sonnet", account: CLAUDE });
  });
});

describe("RoutingStore — account enable/disable arm (issue #10)", () => {
  it("a disable edit lands in the overlay (live isAccountDisabled + snapshot), a re-enable clears it", () => {
    const store = buildStore({ accounts: [
      { id: "c1", provider: "claude", configDir: "/c1" },
      { id: "c2", provider: "claude", configDir: "/c2" },
    ] });
    expect(store.isAccountDisabled("c2")).toBe(false);

    expect(store.applyEdit({ target: "account", id: "c2", enabled: false })).toEqual({ ok: true, cleared: false });
    expect(store.isAccountDisabled("c2")).toBe(true);
    expect(store.snapshot().disabledAccounts).toEqual(["c2"]);

    expect(store.applyEdit({ target: "account", id: "c2", enabled: true })).toEqual({ ok: true, cleared: false });
    expect(store.isAccountDisabled("c2")).toBe(false);
    expect(store.snapshot().disabledAccounts).toEqual([]);
  });

  it("rejects an unknown pool id with a clear error (typo / box-default login), overlay untouched", () => {
    const store = buildStore({ accounts: [{ id: "c1", provider: "claude", configDir: "/c1" }] });
    const outcome = store.applyEdit({ target: "account", id: "nope", enabled: false });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toMatch(/unknown account id 'nope'/);
    expect(store.snapshot().disabledAccounts).toEqual([]);
  });

  it("rejects disabling the LAST enabled account of a provider any preference list selects (claude default)", () => {
    // Default routing: every type resolves to claude, whose pool has exactly one account.
    const store = buildStore({ accounts: [{ id: "c1", provider: "claude", configDir: "/c1" }] });
    const outcome = store.applyEdit({ target: "account", id: "c1", enabled: false });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toMatch(/every claude account in the pool is disabled/);
    expect(store.isAccountDisabled("c1")).toBe(false);
  });

  it("rejects disabling the last enabled zai account while a type routes to zai; allows it once the sibling covers", () => {
    process.env.ZAI_KEY = "secret";
    const store = buildStore({
      agent: { types: { review: { provider: "zai" } } },
      providers: { zai: {} },
      accounts: [
        { id: "z1", provider: "zai", authTokenEnv: "ZAI_KEY" },
        { id: "z2", provider: "zai", authTokenEnv: "ZAI_KEY" },
      ],
    });
    // Parking one of two is fine — the sibling still serves the review route.
    expect(store.applyEdit({ target: "account", id: "z1", enabled: false }).ok).toBe(true);
    // Parking the second would leave review with zero enabled zai accounts → rejected at the edge.
    const outcome = store.applyEdit({ target: "account", id: "z2", enabled: false });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toMatch(/every zai account in the pool is disabled/);
    expect(store.isAccountDisabled("z2")).toBe(false);
  });

  it("a disable edit is idempotent (already-parked stays parked, list not duplicated)", () => {
    const store = buildStore({ accounts: [
      { id: "c1", provider: "claude", configDir: "/c1" },
      { id: "c2", provider: "claude", configDir: "/c2" },
    ] });
    expect(store.applyEdit({ target: "account", id: "c2", enabled: false }).ok).toBe(true);
    expect(store.applyEdit({ target: "account", id: "c2", enabled: false }).ok).toBe(true);
    expect(store.snapshot().disabledAccounts).toEqual(["c2"]);
  });

  it("persists the disabled set to config.yaml (comments preserved); a re-enable removes the key entirely", () => {
    const path = writeConfigFile(
      "# my operator config\ntargets:\n  - { repo: owner/app, commands: { build: b, test: t } }\naccounts: # the pool\n  - { id: c1, provider: claude, configDir: /c1 }\n  - { id: c2, provider: claude, configDir: /c2 }\n",
    );
    const config = loadConfig(path);
    const store = new RoutingStore({ config, targets: resolveTargets(config), configPath: path });

    expect(store.applyEdit({ target: "account", id: "c2", enabled: false }).ok).toBe(true);
    // Round-trip: a daemon restart reloads the parked state from the file.
    expect(loadConfig(path).disabledAccounts).toEqual(["c2"]);
    const written = readFileSync(path, "utf8");
    expect(written).toContain("# my operator config");
    expect(written).toContain("# the pool");

    expect(store.applyEdit({ target: "account", id: "c2", enabled: true }).ok).toBe(true);
    expect(loadConfig(path).disabledAccounts).toEqual([]);
    // The cleared list leaves no residue key — the file returns to its pre-#10 shape.
    expect(readFileSync(path, "utf8")).not.toContain("disabledAccounts");
  });

  it("rejects the account edit and leaves the overlay unchanged when write-through fails", () => {
    const store = buildStore(
      { accounts: [
        { id: "c1", provider: "claude", configDir: "/c1" },
        { id: "c2", provider: "claude", configDir: "/c2" },
      ] },
      {
        configPath: "/no/such/dir/config.yaml",
        readFile: () => {
          throw new Error("ENOENT: no such file");
        },
        writeFile: () => {
          throw new Error("should not be reached");
        },
      },
    );
    const outcome = store.applyEdit({ target: "account", id: "c2", enabled: false });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toMatch(/failed to persist/i);
    expect(store.isAccountDisabled("c2")).toBe(false);
  });
});
