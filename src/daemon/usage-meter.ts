/**
 * The daemon-wide holder of Claude usage state. ADR-0023 made this one shared
 * meter for one OAuth plan; ADR-0028 generalizes it to **one or more** logins
 * (one {@link UsageState} per token id) with a single daemon-wide **active**
 * pointer that says which login new sessions bind to. The cap is untouched
 * (ADR-0020 stays one global pool) — this only changes *which credential* the next
 * session uses, and pauses the whole daemon only when EVERY token is gated.
 *
 * Thin and stateful by design — every decision (gate, cooldown, which token is
 * active) lives in the pure {@link import("../core/usage")} core so it stays
 * exhaustively testable. With zero or one configured token it behaves byte-for-byte
 * like the ADR-0023 single-meter.
 */

import type { Account, ProviderName } from "../config/schema";
import {
  EMPTY_USAGE,
  pickActiveToken,
  recordRateLimit,
  tripCooldown,
  usageGate,
  type ActiveToken,
  type RateLimitSignal,
  type Subscription,
  type UsageGateResult,
  type UsageState,
} from "../core/usage";

/** The implicit single login when no `subscriptions` are configured (box default). */
const DEFAULT_TOKEN = "default";

export interface UsageMeterOptions {
  /** Configured logins; defaults to one unnamed token on the box-default store. */
  tokens?: Subscription[];
  /** Rotation period in ms; null = no timer (only the safety/threshold trigger). */
  rotateEveryMs?: number | null;
  /** Injectable clock so the cooldown/gate/rotation are deterministic in tests. */
  now?: () => number;
  /**
   * Called whenever the active login changes (threshold/cooldown flip or rotation timer),
   * for operator visibility — the flip was previously silent, so a failover left no trace
   * in the log. Absent → no notification (e.g. tests / single-login).
   */
  onActiveChange?: (change: { from: string; to: string }) => void;
  /**
   * LIVE operator-disable predicate (issue #10): `true` parks the login — selection never
   * binds it and its state never counts toward the pool's headroom OR its pause (disabled
   * is operator intent, not a gate state). A thunk, read fresh on every select, so a web
   * account edit takes effect on the next dispatch with no meter rebuild. Absent → nothing
   * is disabled (byte-for-byte the pre-#10 behaviour).
   */
  isDisabled?: (id: string) => boolean;
}

export class UsageMeter {
  private readonly states = new Map<string, UsageState>();
  private readonly tokens: Subscription[];
  private readonly rotateEveryMs: number | null;
  private readonly now: () => number;
  private readonly onActiveChange?: (change: { from: string; to: string }) => void;
  private readonly isDisabled: (id: string) => boolean;
  private activeId: string;
  private lastRotateMs: number;

  constructor(opts: UsageMeterOptions = {}) {
    this.tokens = opts.tokens && opts.tokens.length > 0 ? opts.tokens : [{ id: DEFAULT_TOKEN }];
    this.rotateEveryMs = opts.rotateEveryMs ?? null;
    this.now = opts.now ?? ((): number => Date.now());
    this.onActiveChange = opts.onActiveChange;
    this.isDisabled = opts.isDisabled ?? ((): boolean => false);
    this.activeId = (this.tokens[0] as Subscription).id;
    this.lastRotateMs = this.now();
  }

  /** The login ids not operator-disabled right now — the LIVE selectable set (issue #10). */
  private enabledIds(): string[] {
    return this.tokens.map((t) => t.id).filter((id) => !this.isDisabled(id));
  }

  /**
   * Re-evaluate the active pointer for *now* (apply the threshold/rotation flip).
   * Idempotent given the same clock + state; called before every read/acquire so a
   * just-tripped token flips the daemon onto the other login within the same tick.
   *
   * Selection runs over the ENABLED ids only (issue #10): a parked login is never a
   * candidate, and a just-parked ACTIVE login is force-flipped off before the pure
   * rotation runs. With every login parked there is nothing to select — the pointer is
   * left standing and the acquire paths refuse to hand it out.
   */
  private select(admitBelowPercent: number): void {
    const ids = this.enabledIds();
    if (ids.length === 0) {
      return;
    }
    const next = pickActiveToken({
      ids,
      states: Object.fromEntries(this.states),
      // A disabled active pointer normalises onto the first enabled login; the pure
      // rotation then walks on from there if that one is gated.
      activeId: ids.includes(this.activeId) ? this.activeId : (ids[0] as string),
      lastRotateMs: this.lastRotateMs,
      nowMs: this.now(),
      admitBelowPercent,
      rotateEveryMs: this.rotateEveryMs,
    });
    if (next.activeId !== this.activeId) {
      this.onActiveChange?.({ from: this.activeId, to: next.activeId });
    }
    this.activeId = next.activeId;
    this.lastRotateMs = next.lastRotateMs;
  }

  /**
   * Bind a new session to a login and return it (id + `CLAUDE_CONFIG_DIR`). The
   * returned token is fixed for that session's whole life — the credential cannot
   * change under a running CLI. Threshold/rotation are applied first.
   */
  acquire(admitBelowPercent: number): ActiveToken {
    this.select(admitBelowPercent);
    return this.activeToken();
  }

  /** The currently-active login as an {@link ActiveToken} (id + `CLAUDE_CONFIG_DIR`), no flip. */
  private activeToken(): ActiveToken {
    const t = this.tokens.find((t) => t.id === this.activeId) ?? (this.tokens[0] as Subscription);
    return { id: t.id, configDir: t.configDir };
  }

  /**
   * Acquire a login that has **headroom** (rotated for even wear), or `null` when EVERY
   * login in this pool is gated. Unlike {@link acquire} — which always hands back the
   * active login, even a gated one (one-pool ADR-0023 semantics: defer at the daemon
   * gate, never on the bind) — this is the "a usable credential, or nothing" primitive
   * the generalised per-provider {@link ProviderPoolMeter} composes: a `null` is exactly
   * this pool's "no account has headroom" verdict, so route resolution can fall through
   * to the next provider. The threshold/rotation flip is applied first, so a just-freed
   * login is picked up the same tick.
   */
  acquireIfHeadroom(admitBelowPercent: number): ActiveToken | null {
    if (!this.gate(admitBelowPercent).admit) {
      return null;
    }
    const token = this.activeToken();
    // Defence in depth (issue #10): with EVERY login operator-disabled the gate admits (see
    // gate()) but the standing pointer is a parked credential — never hand it out.
    return this.isDisabled(token.id) ? null : token;
  }

  /** Fold a streamed rate-limit signal into a token's state (default: the active one). */
  record(signal: RateLimitSignal, tokenId: string = this.activeId): void {
    this.states.set(tokenId, recordRateLimit(this.states.get(tokenId) ?? EMPTY_USAGE, signal, this.now()));
  }

  /** Trip a token's cooldown until `untilMs` (default: the active one). Monotonic. */
  trip(untilMs: number | null, tokenId: string = this.activeId): void {
    this.states.set(tokenId, tripCooldown(this.states.get(tokenId) ?? EMPTY_USAGE, untilMs, this.now()));
  }

  /**
   * May admission launch new agents right now? Flips onto a token with headroom if
   * the active one is gated; returns the active token's gate result. Refuses
   * (defers) only when EVERY **enabled** token is gated — the whole-daemon pause of
   * ADR-0023, now reached only when both logins are exhausted. An operator-disabled
   * login counts toward neither side (issue #10): its headroom never admits (it is
   * un-bindable) and its gating never pauses (disabled is operator intent, not a
   * gate state). With EVERY login disabled the gate ADMITS: that state is reachable
   * only when no preference list selects this pool's provider (the config gate
   * rejects it otherwise), so refusing would wrongly pause other providers' work —
   * the acquire paths still never hand out a parked credential.
   */
  gate(admitBelowPercent: number): UsageGateResult {
    this.select(admitBelowPercent);
    if (this.enabledIds().length === 0) {
      return { admit: true };
    }
    return usageGate(this.states.get(this.activeId) ?? EMPTY_USAGE, this.now(), admitBelowPercent);
  }

  /**
   * The current usage picture (read-only snapshot for diagnostics / the web Health
   * view, issue #116): the active login pointer, every configured login id (so a
   * never-streamed login still appears), the per-login state, and which logins are
   * operator-disabled right now (issue #10 — the live predicate, evaluated at
   * snapshot time). Pure read — it never flips the active pointer.
   */
  snapshot(): { activeId: string; ids: string[]; states: Record<string, UsageState>; disabledIds: string[] } {
    return {
      activeId: this.activeId,
      ids: this.tokens.map((t) => t.id),
      states: Object.fromEntries(this.states),
      disabledIds: this.tokens.map((t) => t.id).filter((id) => this.isDisabled(id)),
    };
  }
}

/** Per-pool snapshot keyed by provider — the read-only diagnostics view (ADR-0028, generalised). */
export type ProviderPoolSnapshot = Partial<Record<ProviderName, ReturnType<UsageMeter["snapshot"]>>>;

export interface ProviderPoolMeterOptions {
  /**
   * The resolved {@link Account} pool (`resolveAccountPool`) — flat and arbitrary, N per
   * provider including zero. Accounts are grouped by `provider` into one isolated
   * {@link UsageMeter} each; a provider with no accounts gets no meter and is simply
   * unavailable.
   */
  accounts: Account[];
  /** Rotation period in ms, applied per pool; null = no timer (threshold/cooldown only). */
  rotateEveryMs?: number | null;
  /** Injectable clock so cooldown/gate/rotation are deterministic in tests. */
  now?: () => number;
  /** Notified whenever a pool's active account flips, tagged with the provider. */
  onActiveChange?: (change: { provider: ProviderName; from: string; to: string }) => void;
  /**
   * LIVE operator-disable predicate keyed by pool account id (issue #10), threaded into every
   * per-provider {@link UsageMeter}: a disabled account is invisible to `acquireAccount` and
   * never counts toward `hasHeadroom`. Absent → nothing is disabled.
   */
  isDisabled?: (id: string) => boolean;
}

/**
 * The generalised account meter (ADR-0037 P2.1) — ADR-0028's "Claude, N logins" meter
 * lifted to **a pool per provider**. The flat {@link Account} pool is grouped by provider
 * into one **isolated** {@link UsageMeter} each, so a provider's rate-limit signals only
 * ever fold into *its* state and can never gate another's (the ADR-0034 z.ai-meter rule,
 * generalised). "A provider has headroom" ≙ at least one of its accounts is not gated;
 * `acquireAccount` hands back a headroom account from that provider's pool, **rotated**
 * for even wear (round-robin, gated accounts skipped) — the existing rotation-timer
 * behaviour, now per pool. A provider with **zero** accounts has no meter and is
 * unavailable (`hasHeadroom` false, `acquireAccount` null).
 *
 * Thin and stateful by design — every decision lives in the pure {@link UsageMeter} /
 * {@link import("../core/usage")} core, so this only routes a call to the right pool and
 * maps a chosen login id back to its full account. Pure clock injection keeps it
 * exhaustively testable with no SDK and no network.
 */
export class ProviderPoolMeter {
  private readonly meters = new Map<ProviderName, UsageMeter>();
  private readonly accountsById = new Map<string, Account>();

  constructor(opts: ProviderPoolMeterOptions) {
    const byProvider = new Map<ProviderName, Account[]>();
    for (const account of opts.accounts) {
      this.accountsById.set(account.id, account);
      const slice = byProvider.get(account.provider);
      if (slice) {
        slice.push(account);
      } else {
        byProvider.set(account.provider, [account]);
      }
    }
    for (const [provider, accounts] of byProvider) {
      this.meters.set(
        provider,
        new UsageMeter({
          // The meter keys gating/rotation on the account id alone; the provider-shaped
          // auth lives in `accountsById` and is reattached on acquire.
          tokens: accounts.map((account) => ({ id: account.id })),
          rotateEveryMs: opts.rotateEveryMs ?? null,
          now: opts.now,
          onActiveChange: opts.onActiveChange
            ? (change): void => opts.onActiveChange!({ provider, ...change })
            : undefined,
          isDisabled: opts.isDisabled,
        }),
      );
    }
  }

  /**
   * Does `provider` have at least one **enabled** account with headroom right now? Read via
   * `acquireIfHeadroom` rather than the raw gate: the gate deliberately admits an all-disabled
   * pool (so the whole-daemon claude pause never fires on operator intent, issue #10), but for
   * pool availability an all-disabled provider is exactly as unavailable as an all-gated one.
   */
  hasHeadroom(provider: ProviderName, admitBelowPercent: number): boolean {
    return (this.meters.get(provider)?.acquireIfHeadroom(admitBelowPercent) ?? null) !== null;
  }

  /**
   * Pick a headroom account from `provider`'s pool (rotated for even wear, gated accounts
   * skipped), or `null` when the provider has no account with headroom (every account
   * gated, or the provider has no accounts in the pool at all). Never throws, never guesses.
   */
  acquireAccount(provider: ProviderName, admitBelowPercent: number): Account | null {
    const token = this.meters.get(provider)?.acquireIfHeadroom(admitBelowPercent);
    return token ? this.accountsById.get(token.id) ?? null : null;
  }

  /** Fold a streamed rate-limit signal into the named account's provider pool only. */
  record(signal: RateLimitSignal, accountId: string): void {
    const provider = this.accountsById.get(accountId)?.provider;
    if (provider) {
      this.meters.get(provider)?.record(signal, accountId);
    }
  }

  /** Trip the named account's cooldown until `untilMs` (its provider pool only). Monotonic. */
  trip(untilMs: number | null, accountId: string): void {
    const provider = this.accountsById.get(accountId)?.provider;
    if (provider) {
      this.meters.get(provider)?.trip(untilMs, accountId);
    }
  }

  /** Read-only per-provider usage picture for diagnostics / the web Health view. Never flips. */
  snapshot(): ProviderPoolSnapshot {
    const out: ProviderPoolSnapshot = {};
    for (const [provider, meter] of this.meters) {
      out[provider] = meter.snapshot();
    }
    return out;
  }
}
