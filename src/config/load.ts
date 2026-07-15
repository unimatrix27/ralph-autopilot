import { resolve } from "node:path";
import { loadYamlFile, parseYamlValue, type YamlFileMessages } from "./yaml-loader";
import {
  BACKCOMPAT_OPENAI_ACCOUNT_ID,
  BACKCOMPAT_ZAI_ACCOUNT_ID,
  configSchema,
  type Account,
  type ProviderName,
  type RalphConfig,
  type TargetConfig,
} from "./schema";
import { AGENT_TYPES, allPreferenceLists, capabilityOk } from "../providers/select";

export const DEFAULT_CONFIG_PATH = ".ralph/config.yaml";

/** `owner/repo` → `owner-repo`, a filesystem-safe segment for slug-derived paths. */
function slugToPathSegment(slug: string): string {
  return slug.replace(/\//g, "-");
}

/**
 * Resolve `config.targets` into the per-repo {@link TargetConfig} the reconcilers
 * consume: each target's optional `agent`/`merge`/`review`/`priorityLabels`
 * overrides are deep-merged over the daemon-wide defaults, and `paths.targetClone`
 * / `worktreeRoot` default to slug-derived directories (`.target-repo/<owner>-<repo>`,
 * `.wt/<owner>-<repo>`) so two targets never share a clone or worktree root.
 *
 * Throws {@link ConfigError} on a cross-target conflict the schema can't catch:
 * a duplicate repo slug, or two targets resolving to the same clone/worktree path.
 */
export function resolveTargets(config: RalphConfig): TargetConfig[] {
  const resolved = config.targets.map((target): TargetConfig => {
    const segment = slugToPathSegment(target.repo);
    return {
      targetRepo: target.repo,
      paths: {
        targetClone: target.paths.targetClone ?? `.target-repo/${segment}`,
        worktreeRoot: target.paths.worktreeRoot ?? `.wt/${segment}`,
      },
      commands: target.commands,
      // Spread-merge: the override schema omits absent keys, so only keys the
      // target actually set overwrite a global default (arrays replace, not merge).
      agent: { ...config.agent, ...(target.agent ?? {}) },
      merge: { ...config.merge, ...(target.merge ?? {}) },
      review: { ...config.review, ...(target.review ?? {}) },
      autoMode: { ...config.autoMode, ...(target.autoMode ?? {}) },
      // Provider connection settings are daemon-wide (an OAuth login is a box
      // credential, not per-target), carried onto every target so the per-repo
      // wiring can build a backend from `target.providers` (issue #131).
      providers: config.providers,
      priorityLabels: target.priorityLabels ?? config.scheduler.priorityLabels,
      // Deprecated, accepted-but-ignored execution-mode key (ADR-0038 / #227): carried through
      // verbatim (undefined on a clean config) only so the composition root can log a one-line
      // deprecation when an operator's config still sets it. Every target runs in a container.
      executionMode: target.executionMode,
    };
  });

  // The resolved ACCOUNT POOL is the single credential source for ALL providers
  // (ADR-0037 P2.2): explicit `accounts:` plus the back-compat slices folded from
  // `usageLimit.subscriptions` (claude), `providers.openai.codexHome` (openai), and
  // `providers.zai.authTokenEnv` (zai). Grouped by provider so a selected provider can be
  // checked for "has at least one account" — the credential check that used to live on the
  // now-optional `providers.*` fields.
  const poolByProvider = groupAccountsByProvider(resolveAccountPool(config));

  // Fail loud, at load time, walking EVERY entry of EVERY type's `(provider, model)`
  // preference list ACROSS ALL PHASES (ADR-0037 P1.2/#169 — not just the head, and not just
  // the `base` list: a per-phase `phase1`/`phase2` override for review/fix is validated too),
  // surfaced here rather than at the first launch hours into a run (issue #131/#149/#160,
  // mirroring ADR-0008's no-silent-fallback discipline):
  //   1. the CAPABILITY GATE — a tools-requiring type (impl) may not route to a
  //      non-tools-capable provider (bare openai/Codex); the one pure {@link capabilityOk}
  //      shared by load, the web edit API, and route resolution;
  //   2. a missing KIND block (providers.openai/zai) a selected openai/zai entry needs for
  //      its model/baseUrl; and
  //   3. no ACCOUNT in the pool for a selected provider (its credential authority — a key
  //      env var unset for a zai account is a sub-case, surfaced per account).
  // The default `claude` selection needs no block and is always tools-capable; the
  // box-default Claude login means an empty pool is fine for claude.
  for (const target of resolved) {
    for (const type of AGENT_TYPES) {
      for (const { provider } of allPreferenceLists(target.agent, type)) {
        // Capability gate first: a wrong-backend pairing is more fundamental than a
        // missing block/account, and its message is the more useful one.
        if (!capabilityOk(type, provider, target.providers)) {
          throw new ConfigError(
            `Invalid configuration: agent type '${type}' for target ${target.targetRepo} routes to provider '${provider}', which is not tools-capable — this type requires the in-session escalate/stuck tools (ADR-0037 capability gate)`,
          );
        }
        if (provider === "openai") {
          if (!target.providers.openai) {
            throw new ConfigError(
              `Invalid configuration: agent type '${type}' for target ${target.targetRepo} selects provider 'openai' but providers.openai is not configured`,
            );
          }
          if (!poolByProvider.get("openai")?.length) {
            throw new ConfigError(
              `Invalid configuration: agent type '${type}' for target ${target.targetRepo} selects provider 'openai' but no openai account is in the pool — set providers.openai.codexHome or add an accounts entry`,
            );
          }
        }
        if (provider === "zai") {
          if (!target.providers.zai) {
            throw new ConfigError(
              `Invalid configuration: agent type '${type}' for target ${target.targetRepo} selects provider 'zai' but providers.zai is not configured`,
            );
          }
          const zaiAccounts = poolByProvider.get("zai") ?? [];
          if (!zaiAccounts.length) {
            throw new ConfigError(
              `Invalid configuration: agent type '${type}' for target ${target.targetRepo} selects provider 'zai' but no zai account is in the pool — set providers.zai.authTokenEnv or add an accounts entry`,
            );
          }
          // The z.ai key lives in an env var, never in config (ADR-0034). Require each zai
          // account's env var to be present and non-empty NOW, so a missing key fails at
          // startup rather than at the first GLM session — z.ai has no OAuth store to fall
          // back to. Discriminated on `provider`, so `authTokenEnv` is in scope.
          for (const account of zaiAccounts) {
            if (account.provider !== "zai") {
              continue;
            }
            const token = process.env[account.authTokenEnv];
            if (!token || token.length === 0) {
              throw new ConfigError(
                `Invalid configuration: agent type '${type}' for target ${target.targetRepo} selects provider 'zai' but the auth-token env var '${account.authTokenEnv}' (account '${account.id}') is unset or empty`,
              );
            }
          }
        }
      }
    }
  }

  assertUnique(
    resolved.map((t) => t.targetRepo),
    "duplicate target repo",
  );
  assertUnique(
    resolved.map((t) => resolve(t.paths.targetClone)),
    "two targets share a clone path (paths.targetClone)",
  );
  assertUnique(
    resolved.map((t) => resolve(t.paths.worktreeRoot)),
    "two targets share a worktree root (paths.worktreeRoot)",
  );
  return resolved;
}

/**
 * Resolve the flat ACCOUNT POOL (ADR-0037) — the **single credential source for ALL
 * providers** (P2.2). The explicit `config.accounts` entries, followed by the back-compat
 * single-account slices folded from the legacy provider blocks so an existing
 * `.ralph/config.yaml` keeps loading unchanged while the pool becomes the one authority:
 *   - **claude** — each `usageLimit.subscriptions` `{ id, configDir }` → `{ id, provider:
 *     "claude", configDir }` (ADR-0028);
 *   - **openai** — `providers.openai.codexHome` → a single `{ id: "openai", provider:
 *     "openai", codexHome }`;
 *   - **zai** — `providers.zai.authTokenEnv` → a single `{ id: "zai", provider: "zai",
 *     authTokenEnv }`.
 * A multi-account setup instead lists explicit `accounts:` entries (N per provider) and
 * omits the back-compat field; the two never coexist for one id (the schema's uniqueness
 * guard rejects a collision). Pure — no I/O, no env reads — so it can be exhaustively
 * unit-tested and shared by route resolution + the generalised meter without disagreement.
 *
 * Account-id uniqueness across the resolved pool is validated by {@link configSchema};
 * this helper only normalises already-validated config data.
 */
export function resolveAccountPool(config: RalphConfig): Account[] {
  const claudeSlice: Account[] = (config.usageLimit.subscriptions ?? []).map((sub) => ({
    id: sub.id,
    provider: "claude" as const,
    configDir: sub.configDir,
  }));
  const openaiSlice: Account[] = config.providers.openai?.codexHome
    ? [{ id: BACKCOMPAT_OPENAI_ACCOUNT_ID, provider: "openai" as const, codexHome: config.providers.openai.codexHome }]
    : [];
  const zaiSlice: Account[] = config.providers.zai?.authTokenEnv
    ? [{ id: BACKCOMPAT_ZAI_ACCOUNT_ID, provider: "zai" as const, authTokenEnv: config.providers.zai.authTokenEnv }]
    : [];
  return [...config.accounts, ...claudeSlice, ...openaiSlice, ...zaiSlice];
}

/**
 * Group a resolved {@link Account} pool into per-provider slices. The two consumers of the pool
 * both need this exact fold: load-time validation (a selected provider needs ≥1 account) and the
 * daemon's route-resolution headroom port (the non-claude account source). Hoisted beside
 * {@link resolveAccountPool}, its data source, so both call one definition instead of re-folding
 * the same shape. Pure — no I/O — and preserves pool order within each provider slice.
 */
export function groupAccountsByProvider(pool: Account[]): Map<ProviderName, Account[]> {
  const byProvider = new Map<ProviderName, Account[]>();
  for (const account of pool) {
    const slice = byProvider.get(account.provider);
    if (slice) {
      slice.push(account);
    } else {
      byProvider.set(account.provider, [account]);
    }
  }
  return byProvider;
}

function assertUnique(values: string[], what: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new ConfigError(`Invalid configuration: ${what}: ${value}`);
    }
    seen.add(value);
  }
}

/** Thrown when configuration cannot be read, parsed, or validated. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The {@link loadYamlFile} customization for `.ralph/config.yaml`: its error type + prose nouns. */
const CONFIG_MESSAGES: YamlFileMessages = {
  makeError: (message) => new ConfigError(message),
  noun: "configuration",
  subject: "Configuration file",
  notFoundHint: (path) => `Copy .ralph/config.example.yaml to ${path} and edit it.`,
};

/** Validate an already-parsed object against the schema. */
export function parseConfig(raw: unknown, source = "(config)"): RalphConfig {
  return parseYamlValue(configSchema, raw, source, CONFIG_MESSAGES);
}

/**
 * Read, parse, and validate `.ralph/config.yaml`. Fails loud with a useful,
 * source-located message on a missing file, malformed YAML, or schema mismatch — via the
 * shared {@link loadYamlFile}.
 */
export function loadConfig(path: string = DEFAULT_CONFIG_PATH): RalphConfig {
  return loadYamlFile(path, configSchema, CONFIG_MESSAGES);
}
