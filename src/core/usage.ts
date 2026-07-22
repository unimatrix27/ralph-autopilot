/**
 * Agent usage-limit awareness — the pure core that keeps the daemon from converting
 * its whole backlog to `agent-stuck` when a provider's usage window/cooldown is
 * exhausted.
 *
 * The Agent SDK surfaces, for subscription (OAuth) sessions, the live plan
 * rate-limit windows: a **5-hour** rolling window and several **7-day** (weekly)
 * windows, each with a `utilization` percentage (0-100) and a `resets_at`
 * timestamp. It streams an `SDKRateLimitEvent` whenever that state changes, and a
 * session that crosses a hard limit ends with a "you've hit your session limit ·
 * resets …" error. Both feed this module (DESIGN §3): a session-limit hit is
 * *transient and self-clearing at a known time*, so it must drive a **deferral +
 * cooldown**, never a terminal human-attention state.
 *
 * Two levers, both pure here and applied at the edges:
 *   - **proactive gate** ({@link usageGate}) — admit no NEW agents while any
 *     window is at/above the configured threshold, or while a cooldown is active;
 *   - **reactive cooldown** ({@link recordRateLimit} / {@link tripCooldown}) — a
 *     `rejected` signal (or a thrown limit error) pauses admission until the
 *     window's `resets_at` (or a conservative fallback when none is known).
 */
import { z } from "zod";

/** Fallback cooldown when a limit is hit but no reset timestamp is known. */
export const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Normalize a plan `resetsAt` to epoch **milliseconds**. The SDK reports it as a
 * number whose unit is not pinned across versions; anything below `1e12` (i.e.
 * before year 2001 in ms) is treated as epoch *seconds* and scaled up. `null` /
 * `undefined` pass through as `null`.
 */
export function resetToMs(epoch: number | null | undefined): number | null {
  if (epoch == null || !Number.isFinite(epoch)) {
    return null;
  }
  return epoch < 1e12 ? Math.round(epoch * 1000) : Math.round(epoch);
}

/** One plan window's last-known state (e.g. `five_hour`, `seven_day`). */
export interface RateLimitWindowState {
  /** Percentage of the window used, 0-100, or null if unknown. */
  utilization: number | null;
  /** When the window resets (epoch ms), or null if unknown. */
  resetsAtMs: number | null;
}

/** The daemon-wide usage picture: per-window utilization plus a global cooldown. */
export interface UsageState {
  /** Per-window state, keyed by the SDK `rateLimitType` (`five_hour`, `seven_day`, …). */
  windows: Record<string, RateLimitWindowState>;
  /** Admit no new agents until this epoch-ms; null = no active cooldown. */
  cooldownUntilMs: number | null;
}

export const EMPTY_USAGE: UsageState = { windows: {}, cooldownUntilMs: null };

/**
 * A streamed usage signal — the shape of the SDK's `SDKRateLimitInfo` reduced to
 * the fields this module folds in (plus a synthetic `rejected` used when a thrown
 * limit error carries no event).
 *
 * The zod schema is the **single source of truth** for the shape: the container
 * telemetry pipe relays a runner-observed signal as a versioned frame (ADR-0038 /
 * issue #228), so the codec validates it on the wire against this very schema and the
 * {@link RateLimitSignal} type cannot drift from what crosses the pipe. `.strict()` ⇒
 * unknown keys are rejected (ADR-0010).
 */
export const rateLimitSignalSchema = z
  .object({
    status: z.enum(["allowed", "allowed_warning", "rejected"]).optional(),
    utilization: z.number().optional(),
    /** Epoch (seconds or ms — normalized by {@link resetToMs}). */
    resetsAt: z.number().optional(),
    rateLimitType: z.string().optional(),
  })
  .strict();

export type RateLimitSignal = z.infer<typeof rateLimitSignalSchema>;

/**
 * Fold one streamed signal into the usage state (pure). Updates the named
 * window's utilization/reset, and — when the signal is `rejected` (the limit is
 * actively blocking) — trips the global cooldown to that window's reset (or the
 * {@link DEFAULT_COOLDOWN_MS} fallback). The cooldown only ever moves *later*, so
 * a stale shorter reset can't shorten an active pause.
 */
export function recordRateLimit(state: UsageState, signal: RateLimitSignal, nowMs: number): UsageState {
  const windows = { ...state.windows };
  const resetsAtMs = resetToMs(signal.resetsAt);
  if (signal.rateLimitType) {
    const prev = windows[signal.rateLimitType];
    // A `rejected` signal is definitionally "at the limit" for its window: record it
    // as fully utilized when the signal itself carries no utilization, so the window
    // — not just the scalar cooldown — holds the gating truth (with its own reset).
    // That keeps a real cap parked through {@link usageGate}'s window path and lets a
    // stale cooldown that no window corroborates expire without self-sealing the pool.
    const atLimit = signal.status === "rejected";
    windows[signal.rateLimitType] = {
      utilization: signal.utilization ?? (atLimit ? 100 : prev?.utilization ?? null),
      resetsAtMs: resetsAtMs ?? prev?.resetsAtMs ?? null,
    };
  }
  let cooldownUntilMs = state.cooldownUntilMs;
  if (signal.status === "rejected") {
    cooldownUntilMs = Math.max(cooldownUntilMs ?? 0, resetsAtMs ?? nowMs + DEFAULT_COOLDOWN_MS);
  }
  return { windows, cooldownUntilMs };
}

/**
 * Trip the global cooldown until `untilMs` (or {@link DEFAULT_COOLDOWN_MS} ahead
 * of now when null) — the path a *thrown* session-limit error takes when no
 * `resets_at` is recoverable. Monotonic: never shortens an active cooldown.
 */
export function tripCooldown(state: UsageState, untilMs: number | null, nowMs: number): UsageState {
  return {
    ...state,
    cooldownUntilMs: Math.max(state.cooldownUntilMs ?? 0, untilMs ?? nowMs + DEFAULT_COOLDOWN_MS),
  };
}

/** Whether admission may launch new agents, and if not, why. */
export interface UsageGateResult {
  admit: boolean;
  reason?: "cooldown" | "utilization";
  /** Human-readable detail for the log (the reset time, or `window=NN%`). */
  detail?: string;
}

/**
 * The proactive admission gate (pure): refuse new agents while a cooldown is
 * active, or while any known window's utilization is at/above `admitBelowPercent`
 * (the "stop at 85%" knob). In-flight work is unaffected — this gates only the
 * decision to *start* more.
 *
 * A window whose `resetsAtMs` has passed no longer gates (issue #279): the stored
 * utilization belongs to the window that already ended, and no fresh signal can
 * arrive to clear it while the pool itself is gated (signals only flow from live
 * sessions). Skipping it degrades the window to the same optimistic "unknown"
 * a never-seen token gets; the account's true usage re-records on its next session.
 * A window with an *unknown* reset (`resetsAtMs: null`) keeps gating — there is no
 * evidence it ended.
 *
 * The cooldown is subject to the same self-seal (the cooldown analogue of #279): a
 * `rejected` on a long-horizon window (a weekly / overage reset) trips a cooldown
 * many hours out, and once every account is gated no fresh signal can supersede it —
 * the pool self-seals until that far timestamp even after the account's own windows
 * show headroom. So a cooldown only gates while it is **corroborated** by the
 * windows: either the account has no live window telemetry at all (a bare backoff —
 * honour it) or at least one non-lapsed window is itself gating. A cooldown left
 * standing after its windows have all reset or dropped below the threshold is stale
 * and skipped — degrading to the same optimism a window gets, so the pool can probe
 * once and the account's true usage re-records. (A real cap keeps its window at/above
 * the threshold — see {@link recordRateLimit} — so it stays parked here.)
 */
export function usageGate(state: UsageState, nowMs: number, admitBelowPercent: number): UsageGateResult {
  // First resolve the windows: the earliest gating one (if any) and whether any
  // non-lapsed window telemetry exists at all — both feed the cooldown corroboration.
  let gating: { type: string; utilization: number } | null = null;
  let liveWindows = 0;
  for (const [type, w] of Object.entries(state.windows)) {
    if (w.resetsAtMs != null && w.resetsAtMs <= nowMs) {
      continue; // #279 — a lapsed window's stored utilization is stale, ignore it.
    }
    liveWindows += 1;
    if (gating === null && w.utilization != null && w.utilization >= admitBelowPercent) {
      gating = { type, utilization: w.utilization };
    }
  }
  // A cooldown gates only while corroborated (see doc-comment): no live window
  // telemetry to contradict it, or a window that is itself gating. Otherwise it is a
  // stale scalar that would self-seal the pool — skip it and let the windows decide.
  if (state.cooldownUntilMs != null && nowMs < state.cooldownUntilMs && (liveWindows === 0 || gating !== null)) {
    return { admit: false, reason: "cooldown", detail: new Date(state.cooldownUntilMs).toISOString() };
  }
  if (gating !== null) {
    return { admit: false, reason: "utilization", detail: `${gating.type}=${gating.utilization}%` };
  }
  return { admit: true };
}

/**
 * Whether a thrown error is a transient agent **usage / session / rate-limit**
 * rejection (vs a genuine fault) — the signal to defer-not-terminalize. Matches
 * the SDK's "you've hit your session limit · resets …" / "usage limit" wording,
 * plus endpoint-provider quota/rate-limit wording such as 429 / too many requests.
 * Scoped to agent-session errors, so it never sees GitHub's own rate-limit text.
 *
 * Also returns true for a {@link UsageLimitError} regardless of message text, so a
 * session that *ended* on a cap (a `result` message with `is_error`, not a thrown SDK
 * error — see {@link UsageLimitError}) is classified the same as a thrown limit.
 */
export function isUsageLimitError(err: unknown): boolean {
  if (err instanceof UsageLimitError) {
    return true;
  }
  const text = `${(err as { stderr?: string } | null)?.stderr ?? ""} ${String(err)}`.toLowerCase();
  return (
    text.includes("session limit") ||
    text.includes("usage limit") ||
    (text.includes("limit") && text.includes("resets")) ||
    text.includes("rate limit") ||
    text.includes("too many requests") ||
    text.includes("quota exceeded") ||
    text.includes("insufficient quota") ||
    /\b429\b/.test(text)
  );
}

/**
 * An agent usage/session/rate-limit hit surfaced as a *typed* error so every driver
 * (impl, review, fix) can defer-not-terminalize on one `instanceof` check rather
 * than re-sniffing message text. The SDK reports a cap two ways: as a thrown error
 * (caught by {@link isUsageLimitError} on text) OR as a `result` message with
 * `is_error: true` whose human-readable limit text lives in the result body — the
 * backends translate that second shape into this typed throw so the body text is
 * never lost (it once collapsed into a generic "ended without success" that defeated
 * the text matcher and terminalized the whole backlog to `agent-stuck`).
 */
export class UsageLimitError extends Error {
  /** The window reset (epoch ms) parsed from the limit text, or null if none was found. */
  readonly resetsAtMs: number | null;
  constructor(detail: string) {
    super(`Agent usage limit reached: ${detail}`);
    this.name = "UsageLimitError";
    this.resetsAtMs = parseUsageLimitReset(detail);
  }
}

/**
 * Best-effort extract of a window reset (epoch ms) from a usage-limit message. The
 * classic OAuth form is `Claude AI usage limit reached|1718924400` (trailing epoch
 * seconds); we also accept any standalone 10–13 digit run as a unix timestamp.
 * Human phrasings ("resets 10:40pm") carry no machine time → null, and the caller
 * falls back to {@link DEFAULT_COOLDOWN_MS}. Normalized via {@link resetToMs}.
 */
export function parseUsageLimitReset(text: string): number | null {
  const piped = text.match(/\|\s*(\d{10,13})\b/);
  const epoch = piped?.[1] ?? text.match(/\b(\d{10,13})\b/)?.[1];
  return epoch ? resetToMs(Number(epoch)) : null;
}

// --- Dual-subscription rotation (ADR-0028) ------------------------------------
//
// The daemon may carry MORE THAN ONE OAuth login (each a separate `UsageState`,
// keyed by a token id). A single daemon-wide *active* pointer says which login new
// sessions bind to; the cap is untouched (ADR-0020 stays one global pool). These
// pure helpers decide which token is active. Selection — never the credential
// itself — lives here so it is exhaustively testable; the credential routing is an
// env (`CLAUDE_CONFIG_DIR`) applied at the edge.

/** One configured OAuth login: a stable `id` and its `CLAUDE_CONFIG_DIR` store. */
export interface Subscription {
  id: string;
  /** Absolute `CLAUDE_CONFIG_DIR`; absent = the box default (`~/.claude`). */
  configDir?: string;
}

/** The login a session is bound to for its whole life. */
export type ActiveToken = Subscription;

/**
 * Is this token unavailable for NEW work right now — i.e. would the proactive gate
 * refuse it (cooldown active, or any known window at/above the threshold)? A token
 * with no known state yet is *not* gated (optimistic: its real utilization becomes
 * known after its first session streams a signal).
 */
export function isTokenGated(
  state: UsageState | undefined,
  nowMs: number,
  admitBelowPercent: number,
): boolean {
  return !usageGate(state ?? EMPTY_USAGE, nowMs, admitBelowPercent).admit;
}

/**
 * The soonest **future** instant (epoch ms) at which this login could regain headroom — the
 * approximate "resets ~HH:MM" ETA the ADR-0037 no-provider backlog wait shows. It is the earliest
 * of (a) an active cooldown lifting and (b) any window that is *currently gating* (utilization at/
 * above `admitBelowPercent`) resetting; only those signals actually hold work back, so a
 * not-yet-gating window's reset is ignored. Returns null when no gating signal carries a known
 * future reset, so the caller degrades gracefully (shows the wait without an ETA). Pure.
 */
export function soonestReset(
  state: UsageState | undefined,
  nowMs: number,
  admitBelowPercent: number,
): number | null {
  const s = state ?? EMPTY_USAGE;
  const candidates: number[] = [];
  if (s.cooldownUntilMs != null && s.cooldownUntilMs > nowMs) {
    candidates.push(s.cooldownUntilMs);
  }
  for (const w of Object.values(s.windows)) {
    if (w.utilization != null && w.utilization >= admitBelowPercent && w.resetsAtMs != null && w.resetsAtMs > nowMs) {
      candidates.push(w.resetsAtMs);
    }
  }
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

/**
 * Pick the active token (pure). Keeps the current one unless it is **gated** (the
 * safety trigger — its window hit the threshold or it tripped a cooldown) or the
 * **rotation timer** has elapsed (`rotateEveryMs`); in either case it round-robins
 * to the next token that has headroom. If no other token has headroom it keeps the
 * current one — and the daemon-wide gate then defers, exactly as ADR-0023, until
 * the first window resets. The rotation clock is reset whenever a flip happens or
 * the timer elapsed (so a single eligible token doesn't re-trigger every tick).
 */
export function pickActiveToken(args: {
  ids: string[];
  states: Record<string, UsageState>;
  activeId: string;
  lastRotateMs: number;
  nowMs: number;
  admitBelowPercent: number;
  rotateEveryMs: number | null;
}): { activeId: string; lastRotateMs: number } {
  const { ids, states, activeId, lastRotateMs, nowMs, admitBelowPercent, rotateEveryMs } = args;
  if (ids.length <= 1) {
    return { activeId: ids[0] ?? activeId, lastRotateMs };
  }
  const gated = (id: string): boolean => isTokenGated(states[id], nowMs, admitBelowPercent);
  const timerElapsed = rotateEveryMs != null && nowMs - lastRotateMs >= rotateEveryMs;
  const mustFlip = gated(activeId) || timerElapsed;
  if (!mustFlip) {
    return { activeId, lastRotateMs };
  }
  const start = ids.indexOf(activeId);
  for (let i = 1; i <= ids.length; i++) {
    const cand = ids[(start + i) % ids.length] as string;
    if (cand !== activeId && !gated(cand)) {
      return { activeId: cand, lastRotateMs: nowMs };
    }
  }
  // No other token has headroom: keep current. Advance the clock only if the timer
  // fired, so a lone-eligible token doesn't spin the rotation check every tick.
  return { activeId, lastRotateMs: timerElapsed ? nowMs : lastRotateMs };
}
