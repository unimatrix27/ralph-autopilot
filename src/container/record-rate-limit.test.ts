/**
 * The receive-side demux that folds a container-reported {@link RateLimitTelemetry} into the
 * daemon's per-account meter (ADR-0037 account meter / ADR-0038 best-effort pipe, issue #228). These
 * are pure unit tests of {@link foldRateLimitTelemetry}: the run's dispatched provider + account id
 * (both sourced daemon-side from the dispatch route — the wire carries only the signal) are handed to
 * the injected recorder, a non-rate-limit body is left for the caller's transcript sink, a route-less
 * dispatch folds nothing, and a missing recorder never throws (the pipe is never load-bearing).
 */
import { describe, expect, it } from "vitest";
import { foldRateLimitTelemetry, type RecordRateLimitSignal } from "./record-rate-limit";
import type { ContainerDispatch } from "./assignment";
import type { ProviderName } from "../config/schema";
import type { RateLimitSignal } from "../core/usage";
import type { TelemetryFrame } from "./protocol";

const baseAssignment = {
  issueNumber: 7,
  mode: "tdd" as const,
  branch: "ralph/7-x",
  base: "main",
  prompt: "do it",
};

/** A dispatch carrying the resolved route the daemon dispatched the run on. */
function dispatchOn(provider: ProviderName, accountId: string): ContainerDispatch {
  return {
    assignment: baseAssignment,
    token: { value: "t" },
    route: { provider, account: accountFor(provider, accountId) },
  };
}

function accountFor(provider: ProviderName, id: string) {
  switch (provider) {
    case "claude":
      return { id, provider, configDir: `/host/${id}` } as const;
    case "zai":
      return { id, provider, authTokenEnv: "ZAI_KEY" } as const;
    case "openai":
      return { id, provider, codexHome: `/host/${id}` } as const;
  }
}

/** A recorder that captures every fold call, so the test can assert the (provider, account) tag. */
function recordingSink(): { calls: Array<{ provider: ProviderName; accountId: string | undefined; signal: RateLimitSignal }>; record: RecordRateLimitSignal } {
  const calls: Array<{ provider: ProviderName; accountId: string | undefined; signal: RateLimitSignal }> = [];
  return { calls, record: (provider, accountId, signal) => void calls.push({ provider, accountId, signal }) };
}

const rateLimitFrame = (signal: RateLimitSignal): TelemetryFrame => ({
  kind: "telemetry",
  body: { type: "rate-limit", signal },
});

describe("foldRateLimitTelemetry (ADR-0037/0038 / issue #228)", () => {
  it("folds a rate-limit frame with the run's dispatched provider + account id and returns true", () => {
    const sink = recordingSink();
    const signal: RateLimitSignal = { status: "rejected", resetsAt: 1718924400 };

    const handled = foldRateLimitTelemetry(rateLimitFrame(signal), dispatchOn("claude", "c1"), sink.record);

    expect(handled).toBe(true);
    // Both the provider and the account id are the ones the DAEMON dispatched (the wire carries only
    // the signal); the fold sources both from the dispatch route.
    expect(sink.calls).toEqual([{ provider: "claude", accountId: "c1", signal }]);
  });

  it("sources the z.ai provider from the route so the daemon folds the cooldown meter, not the OAuth one", () => {
    const sink = recordingSink();
    const signal: RateLimitSignal = { status: "rejected" };

    foldRateLimitTelemetry(rateLimitFrame(signal), dispatchOn("zai", "zai"), sink.record);

    expect(sink.calls).toEqual([{ provider: "zai", accountId: "zai", signal }]);
  });

  it("leaves a transcript frame for the caller (returns false, never folds)", () => {
    const sink = recordingSink();
    const transcript: TelemetryFrame = { kind: "telemetry", body: { type: "transcript", message: { role: "assistant" } } };

    const handled = foldRateLimitTelemetry(transcript, dispatchOn("claude", "c1"), sink.record);

    expect(handled).toBe(false);
    expect(sink.calls).toHaveLength(0);
  });

  it("never throws when no recorder is wired — the frame is consumed (best-effort drop)", () => {
    const handled = foldRateLimitTelemetry(rateLimitFrame({ status: "rejected" }), dispatchOn("claude", "c1"), undefined);
    // Still 'handled' (it is a rate-limit body), it just has nowhere to fold — a dropped signal.
    expect(handled).toBe(true);
  });

  it("folds nothing on a route-less dispatch (no route → no provider/account → no-op), but consumes the frame", () => {
    const sink = recordingSink();
    const routeless: ContainerDispatch = { assignment: baseAssignment, token: { value: "t" } };

    const handled = foldRateLimitTelemetry(rateLimitFrame({ status: "rejected" }), routeless, sink.record);

    // Both the provider (meter selector) and the account id come from the route; with none, the fold
    // no-ops — the route-less drop lives in this one place — yet still reports the body as handled.
    expect(handled).toBe(true);
    expect(sink.calls).toHaveLength(0);
  });
});
