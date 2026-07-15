import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger, type Logger } from "../log/logger";
import { NotificationDispatcher, type FetchPort, type FetchInit } from "./dispatch";
import type { NotificationEndpoint } from "../config/schema";
import type { NotificationRequest } from "./types";

/** A capturing fetch: records every call and lets the test drive the response/rejection. */
interface RecordedCall {
  url: string;
  init: FetchInit;
}

function makeFetch(
  behaviour: "ok" | "reject" | "throw" = "ok",
): { port: FetchPort; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const port: FetchPort = (url, init) => {
    calls.push({ url, init });
    if (behaviour === "throw") {
      throw new Error("sync boom");
    }
    return behaviour === "reject" ? Promise.reject(new Error("network down")) : Promise.resolve({ ok: true, status: 200 } as Response);
  };
  return { port, calls };
}

function req(over: Partial<NotificationRequest> = {}): NotificationRequest {
  return {
    kind: "escalation",
    severity: "high",
    title: "Escalation on owner/repo#42",
    message: "Which db?",
    repo: "owner/repo",
    issueNumber: 42,
    at: "2026-06-22T10:00:00.000Z",
    ...over,
  };
}

const ntfy: NotificationEndpoint = { kind: "ntfy", url: "https://ntfy.sh/ralph-alerts" };
const webhook: NotificationEndpoint = { kind: "webhook", url: "https://example.com/hook" };

describe("NotificationDispatcher.dispatch", () => {
  let logger: Logger;
  let warnings: string[];

  beforeEach(() => {
    warnings = [];
    logger = createLogger({ level: "debug", write: (line) => {
      if (line.includes('"event":"notify')) warnings.push(line);
    } });
  });

  afterEach(() => {
    delete process.env.NTFY_TOKEN;
  });

  it("fans one notification out to every configured endpoint (ntfy + webhook)", () => {
    const { port, calls } = makeFetch("ok");
    const d = new NotificationDispatcher({ endpoints: [ntfy, webhook], fetch: port, logger });
    d.dispatch([req()]);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.url).sort()).toEqual(["https://example.com/hook", "https://ntfy.sh/ralph-alerts"]);
    // ntfy body is plain text; webhook body is JSON.
    const ntfyCall = calls.find((c) => c.url.includes("ntfy"))!;
    expect(ntfyCall.init.body).toBe("Which db?");
    expect(ntfyCall.init.headers["Title"]).toBe("Escalation on owner/repo#42");
    const hookCall = calls.find((c) => c.url.includes("example"))!;
    expect(JSON.parse(hookCall.init.body).kind).toBe("escalation");
  });

  it("resolves the bearer token from the configured env-var name", () => {
    process.env.NTFY_TOKEN = "tok-123";
    const { port, calls } = makeFetch("ok");
    const d = new NotificationDispatcher({
      endpoints: [{ kind: "ntfy", url: "https://ntfy.sh/x", tokenEnv: "NTFY_TOKEN" }],
      fetch: port,
      logger,
    });
    d.dispatch([req()]);
    expect(calls[0]!.init.headers["Authorization"]).toBe("Bearer tok-123");
  });

  it("omits auth when the named env var is unset (no crash, open topic)", () => {
    const { port, calls } = makeFetch("ok");
    const d = new NotificationDispatcher({
      endpoints: [{ kind: "ntfy", url: "https://ntfy.sh/x", tokenEnv: "MISSING_TOKEN" }],
      fetch: port,
      logger,
    });
    d.dispatch([req()]);
    expect(calls[0]!.init.headers["Authorization"]).toBeUndefined();
  });

  it("returns synchronously — dispatch never awaits (fire-and-forget)", () => {
    let resolved = false;
    const port: FetchPort = () => new Promise((r) => setTimeout(() => { resolved = true; r({ ok: true } as Response); }, 50));
    const d = new NotificationDispatcher({ endpoints: [ntfy], fetch: port, logger });
    const before = Date.now();
    d.dispatch([req()]);
    // Returned immediately without waiting for the 50ms promise.
    expect(Date.now() - before).toBeLessThan(40);
    expect(resolved).toBe(false);
  });

  it("never throws when fetch rejects (best-effort) — logs a warning instead", async () => {
    const { port } = makeFetch("reject");
    const d = new NotificationDispatcher({ endpoints: [ntfy], fetch: port, logger });
    expect(() => d.dispatch([req()])).not.toThrow();
    // Let the detached rejection + its .catch (which logs) flush.
    await new Promise((r) => setTimeout(r, 10));
    expect(warnings.some((w) => w.includes("notify.dispatch-failed"))).toBe(true);
  });

  it("logs only non-sensitive endpoint identity when dispatch fails", async () => {
    const secretUrl = "https://user:pass@hooks.example.com/secret/topic?token=abc123";
    const port: FetchPort = () => Promise.reject(new Error(`Failed to parse URL from ${secretUrl}`));
    const d = new NotificationDispatcher({
      endpoints: [{ kind: "webhook", url: secretUrl }],
      fetch: port,
      logger,
    });

    d.dispatch([req()]);
    await new Promise((r) => setTimeout(r, 10));

    const warning = warnings.find((w) => w.includes("notify.dispatch-failed"))!;
    expect(warning).toContain('"endpoint":"webhook"');
    expect(warning).toContain('"endpointHost":"hooks.example.com"');
    expect(JSON.parse(warning)).not.toHaveProperty("error");
    expect(warning).not.toContain("Failed to parse URL");
    expect(warning).not.toContain("user:pass");
    expect(warning).not.toContain("/secret/topic");
    expect(warning).not.toContain("token=abc123");
    expect(warning).not.toContain(secretUrl);
  });

  it("never throws when fetch throws synchronously (best-effort)", () => {
    const { port } = makeFetch("throw");
    const d = new NotificationDispatcher({ endpoints: [ntfy], fetch: port, logger });
    expect(() => d.dispatch([req()])).not.toThrow();
  });

  it("dispatches nothing for an empty request list", () => {
    const { port, calls } = makeFetch("ok");
    const d = new NotificationDispatcher({ endpoints: [ntfy, webhook], fetch: port, logger });
    d.dispatch([]);
    expect(calls).toHaveLength(0);
  });

  it("dispatches nothing when there are no endpoints", () => {
    const { port, calls } = makeFetch("ok");
    const d = new NotificationDispatcher({ endpoints: [], fetch: port, logger });
    d.dispatch([req(), req()]);
    expect(calls).toHaveLength(0);
  });

  it("one failing endpoint does not stop the others (per-call isolation)", () => {
    // First endpoint's fetch throws synchronously; second must still fire.
    let n = 0;
    const port: FetchPort = () => {
      n += 1;
      if (n === 1) throw new Error("first endpoint broken");
      return Promise.resolve({ ok: true } as Response);
    };
    const d = new NotificationDispatcher({ endpoints: [ntfy, webhook], fetch: port, logger });
    d.dispatch([req()]);
    expect(n).toBe(2); // both endpoints attempted despite the first throwing.
  });
});
