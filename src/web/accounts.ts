/**
 * The pure render-model transform behind `/api/accounts` (issue #11) — the operator's account
 * panel. It joins three pure reads into the browser-safe accounts contract:
 *   - the **resolved pool** ({@link import("../config/load").resolveAccountPool}) + the
 *     operator-park set (`disabledAccounts`), both off the routing overlay snapshot (issue #10),
 *   - the **usage-meter windows** keyed by account id (the shape `/api/health/usage` already
 *     carries, ADR-0028) — utilization + reset per window, plus the active/gated/cooldown markers,
 *   - the daemon-side **OAuth identity** read from each claude account's `configDir` profile.
 *
 * `buildAccounts` is the read edge's only logic (ADR-0029): it takes already-read identities so it
 * stays pure and exhaustively unit-testable — the fs read ({@link readAccountIdentity}) is the one
 * side effect, injected at the composition root. **No secret material is ever produced**: only the
 * account id, provider, park state, identity (email/name/org), the zai env-var *name*, and usage
 * cross the wire — never a `configDir`/`codexHome` path, an OAuth token, or an env-var value.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Account } from "../config/schema";
import { EMPTY_USAGE, isTokenGated, type UsageState } from "../core/usage";
import type { UsageMeterSnapshot } from "./health-usage";
import type { AccountIdentity, AccountUsage, AccountsResponse, PoolAccount } from "./contract";

export interface BuildAccountsInput {
  /** The resolved account pool (`resolveAccountPool`), in pool order. */
  pool: Account[];
  /** Operator-parked pool ids (issue #10) — an account here renders `enabled: false`. */
  disabledAccounts: string[];
  /** The usage-meter snapshot (ADR-0028), joined to accounts by id — the `/api/health/usage` shape. */
  usage: UsageMeterSnapshot;
  /** Already-read OAuth identities keyed by account id; an account absent here has no readable profile. */
  identities: Record<string, AccountIdentity>;
  /** The "stop at N%" plan-budget threshold (`admitBelowPercent`) the usage gate uses. */
  admitBelowPercent: number;
  /** Injected clock for a deterministic `generatedAt` and the gate/cooldown evaluation. */
  now: () => Date;
}

/**
 * Fold the pool + park state + usage + identities into the account-panel view-model. Pure: every
 * field derives from its inputs plus the injected clock and threshold. Each account's usage is
 * joined by id; an account with no meter state shows the null convention (empty windows, un-gated,
 * no cooldown) exactly like a never-streamed login in `/api/health/usage`.
 */
export function buildAccounts(input: BuildAccountsInput): AccountsResponse {
  const nowMs = input.now().getTime();
  const disabled = new Set(input.disabledAccounts);
  const accounts = input.pool.map((account): PoolAccount => {
    const state = input.usage.states[account.id];
    const usage: AccountUsage = {
      active: input.usage.activeId === account.id,
      gated: isTokenGated(state, nowMs, input.admitBelowPercent),
      cooldownUntil: activeCooldown(state, nowMs),
      windows: toWindows(state),
    };
    const identity = input.identities[account.id];
    return {
      id: account.id,
      provider: account.provider,
      enabled: !disabled.has(account.id),
      // Identity (claude only) is omitted, never guessed, on graceful absence (issue #11).
      ...(identity ? { identity } : {}),
      // The zai auth-token env-var NAME may be shown — never its value (ADR-0034).
      ...(account.provider === "zai" ? { authTokenEnvName: account.authTokenEnv } : {}),
      usage,
    };
  });
  return {
    generatedAt: input.now().toISOString(),
    admitBelowPercent: input.admitBelowPercent,
    accounts,
  };
}

/** A login's plan windows as wire rows, type-ordered; epoch-ms resets become absolute ISO instants. */
function toWindows(state: UsageState | undefined): AccountUsage["windows"] {
  const windows = (state ?? EMPTY_USAGE).windows;
  return Object.entries(windows)
    .map(([type, w]) => ({
      type,
      utilization: w.utilization,
      resetsAt: w.resetsAtMs === null ? null : new Date(w.resetsAtMs).toISOString(),
    }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

/** The ISO instant an *active* (future) cooldown lifts, or null — a lapsed cooldown is not surfaced. */
function activeCooldown(state: UsageState | undefined, nowMs: number): string | null {
  const until = state?.cooldownUntilMs ?? null;
  return until !== null && until > nowMs ? new Date(until).toISOString() : null;
}

/**
 * Fold a parsed `.claude.json` object into an {@link AccountIdentity}, reading only the three
 * `oauthAccount` fields the panel surfaces. Pure — given the already-parsed JSON. An absent
 * `oauthAccount`, or an object with none of the three fields (a blank/empty value counts as
 * absent), returns `undefined` so the caller omits identity entirely (graceful absence).
 */
export function parseOauthIdentity(claudeJson: unknown): AccountIdentity | undefined {
  if (typeof claudeJson !== "object" || claudeJson === null) {
    return undefined;
  }
  const oauth = (claudeJson as Record<string, unknown>).oauthAccount;
  if (typeof oauth !== "object" || oauth === null) {
    return undefined;
  }
  const source = oauth as Record<string, unknown>;
  const identity: AccountIdentity = {};
  const take = (key: "emailAddress" | "displayName" | "organizationName"): void => {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) {
      identity[key] = value;
    }
  };
  take("emailAddress");
  take("displayName");
  take("organizationName");
  return Object.keys(identity).length > 0 ? identity : undefined;
}

/** Expand a leading `~` to the box home dir (the `CLAUDE_CONFIG_DIR` stores use `~`-relative paths). */
function expandHome(path: string): string {
  return path.startsWith("~") ? join(homedir(), path.slice(1).replace(/^[/\\]/, "")) : path;
}

/**
 * Read a claude account's OAuth identity from `<configDir>/.claude.json`, daemon-side, at
 * projection time (issue #11). Side-effecting (the one edge fs read; `readFile` is injectable for
 * tests) but **fail-soft**: a key-based (openai/zai) account has no identity to read (→ undefined),
 * and an absent profile file, an unreadable dir, or malformed JSON all return `undefined` — a live
 * case, never an error (one of the current pool's configDirs has no profile file at all). The
 * `configDir` path and the file contents never leave the box as a credential; only the three
 * identity fields do.
 */
export function readAccountIdentity(
  account: Account,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): AccountIdentity | undefined {
  if (account.provider !== "claude") {
    return undefined;
  }
  let raw: string;
  try {
    raw = readFile(join(expandHome(account.configDir), ".claude.json"));
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return parseOauthIdentity(parsed);
}
