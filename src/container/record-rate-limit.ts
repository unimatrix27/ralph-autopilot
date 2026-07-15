/**
 * Folding a container-reported {@link RateLimitTelemetry} back into the daemon's per-account usage
 * meter (ADR-0037 account meter / ADR-0038 best-effort pipe, issue #228). In container-only
 * execution an LLM rate-limit signal is born *inside* the container — the in-container SDK session
 * is the first to see the 429 / usage-window header — so the runner relays it as a telemetry frame
 * and the daemon (the meter's sole writer) folds it here, keeping the headroom view `resolveRoute`
 * and the `no-provider` admission wait read from current.
 *
 * Two pieces, both pure-at-the-edges:
 *
 *   - {@link RecordRateLimitSignal} — the injected sink the meter fold is done through. The daemon
 *     backs it with {@link import("../daemon/daemon").buildRateLimitRecorder} (claude → the ADR-0028
 *     OAuth `UsageMeter` keyed by account id; z.ai → the separate provider cooldown meter; never
 *     cross-fed, ADR-0034); tests inject a recording fake.
 *   - {@link foldRateLimitTelemetry} — the receive-side demux every container adapter runs in its
 *     `onTelemetry`: a `rate-limit` body is folded with the run's **provider and account id, both
 *     taken from the dispatch route** (the runner ships only the signal — it never learns the account,
 *     whose credential arrives mounted, ADR-0037, and its provider is exactly `dispatch.route.provider`
 *     — so the daemon supplies both, exactly as a transcript frame is keyed by the dispatch runId) and
 *     any other telemetry body is left for the caller's transcript sink.
 *
 * The pipe is **best-effort and never load-bearing** (ADR-0016/0038): a dropped frame simply never
 * folds, the meter goes one tick staler, the daemon may dispatch one more run to a throttled account
 * — which fails fast and is re-picked next tick — and no work is lost. Nothing here throws.
 */
import type { ProviderName } from "../config/schema";
import type { RateLimitSignal } from "../core/usage";
import type { ContainerDispatch } from "./assignment";
import type { TelemetryFrame } from "./protocol";

/**
 * Fold one runner-reported rate-limit `signal` for `(provider, accountId)` into the daemon's meter.
 * `accountId` is the account the daemon dispatched the run on (undefined for a route-less dispatch);
 * the claude OAuth meter keys on it, while the single-pool z.ai cooldown meter ignores it. Total and
 * best-effort: an unknown provider / a missing account simply records nothing.
 */
export type RecordRateLimitSignal = (
  provider: ProviderName,
  accountId: string | undefined,
  signal: RateLimitSignal,
) => void;

/**
 * If `frame` is a `rate-limit` telemetry body, fold it into the meter via `record` — keyed by the
 * route the daemon dispatched this run on: the provider (`dispatch.route.provider`) selects the meter
 * and the account id (`dispatch.route.account.id`) keys the claude one — and return `true`; for any
 * other telemetry body return `false` so the caller runs its own (transcript) handling. The single
 * demux both container adapters share, so the "which meter / which account" mapping lives in one
 * place and can never drift between the impl and the review/fix paths.
 */
export function foldRateLimitTelemetry(
  frame: TelemetryFrame,
  dispatch: ContainerDispatch,
  record: RecordRateLimitSignal | undefined,
): boolean {
  if (frame.body.type !== "rate-limit") {
    return false;
  }
  // Both the meter selector (provider) and the claude meter key (account id) are the daemon's own
  // dispatch knowledge — the runner reports only the signal. A route-less dispatch has neither, so
  // the fold no-ops here (best-effort), symmetric with how the claude meter no-ops on a missing id.
  if (dispatch.route) {
    record?.(dispatch.route.provider, dispatch.route.account.id, frame.body.signal);
  }
  return true;
}
