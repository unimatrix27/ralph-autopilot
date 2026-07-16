/**
 * The `/api/accounts` wire shape (ADR-0031, issue #11) — the operator's **account panel**:
 * every resolved pool account ({@link import("../../config/load").resolveAccountPool}, explicit
 * and back-compat slices alike) with its **identity**, operator-park state, and **live usage**,
 * so the operator can tell *which* login `main` / `second` actually is (whose email/org), what
 * its plan windows look like, and when they reset — the data needed to decide which account to
 * park (the enable/disable issue #10 this one builds on).
 *
 * Like every read leaf it is a thin serialization of pure reads (ADR-0029): a pure transform
 * ({@link import("../accounts").buildAccounts}) joins the resolved pool (routing overlay), the
 * usage-meter windows (keyed by account id — the same shape `/api/health/usage` carries), and the
 * daemon-side OAuth profile read, and both the daemon (serialize) and the UI (parse) share this
 * leaf so a drift is a compile error, not a mis-render.
 *
 * **No secret material crosses this wire, ever** (issue #11): no API keys, OAuth tokens, or
 * env-var *values*. A claude account's identity is read from its `configDir` profile daemon-side
 * and never leaves the box as a credential; a zai account may show the auth-token env-var **name**
 * (never its value); a `configDir` / `codexHome` path is not serialized at all.
 *
 * Every instant is **absolute** (ISO-8601) so the UI ticks reset-remaining / cooldown-remaining
 * live between polls against its own render clock (ADR-0031).
 */
import { z } from "zod";
import { providerName } from "./primitives";
import { usageWindowSchema } from "./health-usage";

/**
 * A claude account's OAuth identity, read daemon-side from `<configDir>/.claude.json`'s
 * `oauthAccount` at projection time and never shipped into agent containers. Every field is
 * **optional**: an absent profile file, or a profile missing a field, omits it — never an error,
 * never a guessed value (graceful absence, issue #11). Key-based accounts (openai/zai) carry no
 * identity at all (the object is absent on those accounts).
 */
export const accountIdentitySchema = z
  .object({
    /** The login's email address (`oauthAccount.emailAddress`), when present. */
    emailAddress: z.string().optional(),
    /** The login's display name (`oauthAccount.displayName`), when present. */
    displayName: z.string().optional(),
    /** The login's organization name (`oauthAccount.organizationName`), when present. */
    organizationName: z.string().optional(),
  })
  .strict();
export type AccountIdentity = z.infer<typeof accountIdentitySchema>;

/**
 * One account's live usage picture, joined from the usage meter by account id (ADR-0028). The
 * markers mirror `/api/health/usage`: `active` is the login new sessions currently bind to,
 * `gated` is whether the proactive gate would refuse NEW work on it right now, `cooldownUntil` is
 * the ISO instant an active cooldown lifts (null when none). A never-used / unmetered account
 * shows the existing null convention — empty `windows`, `gated: false`, `cooldownUntil: null`.
 */
export const accountUsageSchema = z
  .object({
    /** Is this the account new sessions currently bind to? */
    active: z.boolean(),
    /** Would the proactive gate refuse NEW work on this account right now? */
    gated: z.boolean(),
    /** ISO-8601 instant an active cooldown lifts, or null when none is active. */
    cooldownUntil: z.string().nullable(),
    /** Per-window utilization + reset instant, type-ordered (empty until a signal has streamed). */
    windows: z.array(usageWindowSchema),
  })
  .strict();
export type AccountUsage = z.infer<typeof accountUsageSchema>;

/**
 * One resolved pool account for the panel: its stable pool `id`, `provider`, operator-park state
 * (`enabled` — the #10 toggle), optional `identity` (claude only, omitted on graceful absence),
 * optional `authTokenEnvName` (zai only — the env-var **name**, never its value), and its live
 * `usage`. `.strict()`, so a leaked credential field is a parse error — the wire carries no secret.
 */
export const poolAccountSchema = z
  .object({
    /** The stable resolved-pool id (`resolveAccountPool`) — how the operator addresses the account. */
    id: z.string(),
    /** The credential kind: `claude` | `openai` | `zai`. */
    provider: providerName,
    /** `false` = operator-parked (never selected at dispatch, issue #10); `true` = in rotation. */
    enabled: z.boolean(),
    /** OAuth identity for a claude account, when a profile is readable; absent otherwise (never guessed). */
    identity: accountIdentitySchema.optional(),
    /** The zai auth-token env-var **name** (never its value); absent for claude/openai. */
    authTokenEnvName: z.string().optional(),
    /** Live usage / gate / cooldown for this account, joined by id (null convention when never used). */
    usage: accountUsageSchema,
  })
  .strict();
export type PoolAccount = z.infer<typeof poolAccountSchema>;

/**
 * The full `/api/accounts` payload: the "stop at N%" plan-budget threshold the gate uses, and
 * every resolved pool account with identity + park state + live usage. Daemon-wide (a credential
 * is a box credential, not per-target), so it takes no repo filter.
 */
export const accountsResponseSchema = z
  .object({
    /** ISO-8601 instant this view was projected (the "now" the UI counts relative times from). */
    generatedAt: z.string(),
    /** The "stop at N%" plan-budget threshold (`admitBelowPercent`) the usage gate uses. */
    admitBelowPercent: z.number().int(),
    /** Every resolved pool account, in pool order. */
    accounts: z.array(poolAccountSchema),
  })
  .strict();
export type AccountsResponse = z.infer<typeof accountsResponseSchema>;
