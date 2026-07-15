import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createECDH, randomBytes } from "node:crypto";
import { createLogger, REDACTED } from "../log/logger";
import { decryptWebPushPayload } from "../notify/webpush-crypto";
import { resolveVapidIdentity } from "../notify/webpush";
import { parseConfig } from "../config/load";
import type { RalphConfig } from "../config/schema";
import { MEMORY_DB, openStore, type Store } from "../store/store";
import { startNotificationSink } from "./daemon";
import { Executor } from "../executor/executor";
import { Reconciler, type ReconcileBudget } from "./reconciler";
import { PrOpeningAgentRunner } from "../testing/fake-agent";
import { FakeGitHub } from "../testing/fake-github";
import { FakeWorktreeManager } from "../testing/fake-worktree";

const silentLogger = createLogger({ level: "error", write: () => {} });

/** A config with the notification sink enabled for a webhook endpoint. */
function config(over: Partial<RalphConfig["notifications"]> = {}): RalphConfig {
  const base = parseConfig({
    targets: [{ repo: "owner/repo", commands: { build: "true", test: "true" } }],
  });
  return { ...base, notifications: { ...base.notifications, enabled: true, ...over } };
}

function budgetFor(getActive: () => number, cap: number): ReconcileBudget {
  return {
    available: () => Math.max(0, cap - getActive()),
    hasCapacity: () => getActive() < cap,
  };
}

interface RecordedCall {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

describe("startNotificationSink — daemon wiring (end-to-end)", () => {
  let store: Store;
  let originalFetch: typeof globalThis.fetch;
  let calls: RecordedCall[];

  beforeEach(() => {
    store = openStore(MEMORY_DB, { now: () => "2026-06-22T00:00:00.000Z" });
    originalFetch = globalThis.fetch;
    calls = [];
    globalThis.fetch = ((url: string, init: RecordedCall["init"]) => {
      calls.push({ url, init: init ?? { method: "POST", headers: {}, body: "" } });
      return Promise.resolve({ ok: true, status: 200 } as Response);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    store.close();
  });

  /** Let the after-commit microtask drain + the fire-and-forget fetch be called. */
  function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("returns null when notifications are disabled", () => {
    const base = parseConfig({
      targets: [{ repo: "owner/repo", commands: { build: "true", test: "true" } }],
    });
    expect(startNotificationSink({ config: base, store, logger: silentLogger, vapid: null })).toBeNull();
  });

  it("pages the webhook when a new escalation commits (store → broadcast → sink → fetch)", async () => {
    const handle = startNotificationSink({
      config: config({
        endpoints: [{ kind: "webhook", url: "https://hooks.example.com/ralph" }],
      }),
      store,
      logger: silentLogger,
      vapid: null,
    });
    expect(handle).not.toBeNull();

    // A new escalation commits on the issue stream → the after-commit emitter fans it to
    // the broadcaster → the sink wakes, decides, and dispatches a best-effort POST.
    await store.forRepo("owner/repo").addQuestion({
      runId: 1,
      issueNumber: 42,
      kind: "escalate",
      headline: "Which database should I target?",
      commentId: 7,
    });
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://hooks.example.com/ralph");
    const payload = JSON.parse(calls[0]!.init.body);
    expect(payload).toMatchObject({
      kind: "escalation",
      repo: "owner/repo",
      issue: 42,
      message: "Which database should I target?",
    });
    expect(calls[0]!.init.headers["Content-Type"]).toContain("application/json");

    handle!.stop();
  });

  it("redacts escalation text before the webhook POST leaves the daemon", async () => {
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const handle = startNotificationSink({
      config: config({
        endpoints: [{ kind: "webhook", url: "https://hooks.example.com/ralph" }],
      }),
      store,
      logger: silentLogger,
      vapid: null,
    });

    await store.forRepo("owner/repo").addQuestion({
      runId: 1,
      issueNumber: 42,
      kind: "escalate",
      headline: `Token leaked ${secret}`,
      commentId: 7,
    });
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.body).not.toContain(secret);
    expect(JSON.parse(calls[0]!.init.body).message).toBe(`Token leaked ${REDACTED}`);
    handle!.stop();
  });

  it("pages ntfy with the message body + Title/Priority headers", async () => {
    const handle = startNotificationSink({
      config: config({
        endpoints: [{ kind: "ntfy", url: "https://ntfy.sh/ralph-alerts" }],
      }),
      store,
      logger: silentLogger,
      vapid: null,
    });
    await store.forRepo("owner/repo").recordRunStuck({ runId: 1, issueNumber: 9, reason: "fix-iterations exhausted" });
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.body).toBe("fix-iterations exhausted");
    expect(calls[0]!.init.headers["Title"]).toContain("Agent stuck");
    expect(calls[0]!.init.headers["Priority"]).toBe("4"); // high severity
    handle!.stop();
  });

  it("starts from head — a pre-existing escalation is NOT replayed on start", async () => {
    // Commit an escalation BEFORE the sink starts.
    await store.forRepo("owner/repo").addQuestion({
      runId: 1, issueNumber: 1, kind: "escalate", headline: "old", commentId: 1,
    });
    await flush(); // drain any prior subscribers (none yet)

    calls.length = 0;
    const handle = startNotificationSink({
      config: config({ endpoints: [{ kind: "webhook", url: "https://hooks.example.com/x" }] }),
      store,
      logger: silentLogger,
      vapid: null,
    });
    await flush();
    expect(calls).toHaveLength(0); // history not replayed

    // A NEW escalation after start does page.
    await store.forRepo("owner/repo").addQuestion({
      runId: 2, issueNumber: 2, kind: "escalate", headline: "new", commentId: 2,
    });
    await flush();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.init.body).message).toBe("new");
    handle!.stop();
  });

  it("fan-out: one escalation POSTs to every configured endpoint", async () => {
    const handle = startNotificationSink({
      config: config({
        endpoints: [
          { kind: "webhook", url: "https://hooks.example.com/a" },
          { kind: "webhook", url: "https://hooks.example.com/b" },
          { kind: "ntfy", url: "https://ntfy.sh/c" },
        ],
      }),
      store,
      logger: silentLogger,
      vapid: null,
    });
    await store.events.appendToIssue("owner/repo", 5, [
      { type: "AnomalyDetected", data: { reason: "island" } },
    ]);
    await flush();

    expect(calls.map((c) => c.url).sort()).toEqual([
      "https://hooks.example.com/a",
      "https://hooks.example.com/b",
      "https://ntfy.sh/c",
    ]);
    handle!.stop();
  });

  it("pages when a real completeness pass surfaces daemon-anomaly", async () => {
    const handle = startNotificationSink({
      config: config({ endpoints: [{ kind: "webhook", url: "https://hooks.example.com/anomaly" }] }),
      store,
      logger: silentLogger,
      vapid: null,
    });
    const scoped = store.forRepo("owner/repo");
    const github = new FakeGitHub();
    github.seed({
      number: 77,
      title: "orphaned pause",
      labels: ["awaiting-answer", "afk", "mode:tdd"],
    });
    const worktrees = new FakeWorktreeManager();
    const executor = new Executor({
      store: scoped,
      github,
      worktrees,
      agentRunner: new PrOpeningAgentRunner(github),
      logger: silentLogger,
    });
    let reconciler: Reconciler;
    reconciler = new Reconciler({
      store: scoped,
      github,
      executor,
      worktrees,
      logger: silentLogger,
      budget: budgetFor(() => reconciler.activeCount(), 5),
      cap: 5,
      priorityLabels: [],
      targetRepo: "owner/repo",
      reconcileIntervalSeconds: 30,
    });

    await reconciler.tick();
    await reconciler.awaitInFlight();
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://hooks.example.com/anomaly");
    expect(JSON.parse(calls[0]!.init.body)).toMatchObject({
      kind: "anomaly",
      repo: "owner/repo",
      issue: 77,
    });
    handle!.stop();
  });

  it("never throws and never blocks when an endpoint rejects (best-effort)", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("network down"))) as typeof globalThis.fetch;
    const handle = startNotificationSink({
      config: config({ endpoints: [{ kind: "webhook", url: "https://hooks.example.com/x" }] }),
      store,
      logger: silentLogger,
      vapid: null,
    });
    await expect(
      store.forRepo("owner/repo").addQuestion({
        runId: 1, issueNumber: 1, kind: "escalate", headline: "q", commentId: 1,
      }),
    ).resolves.toBeDefined(); // the append (the tick's path) is unaffected by the failing endpoint
    await flush();
    handle!.stop();
  });
});

describe("startNotificationSink — web push channel (issue #119)", () => {
  let store: Store;
  let originalFetch: typeof globalThis.fetch;
  let calls: { url: string; headers: Record<string, string>; body: Uint8Array }[];

  beforeEach(() => {
    store = openStore(MEMORY_DB, { now: () => "2026-06-22T00:00:00.000Z" });
    originalFetch = globalThis.fetch;
    calls = [];
    globalThis.fetch = ((url: string, init: { method: string; headers: Record<string, string>; body: Uint8Array }) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    store.close();
  });

  function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("delivers an encrypted push to a stored subscription (event → sink → composite → web-push)", async () => {
    // The device's subscription keypair (the test keeps the private key to decrypt).
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const uaPrivate = ecdh.getPrivateKey();
    const authSecret = randomBytes(16);
    const endpoint = "https://fcm.googleapis.com/fcm/send/abc-device-1";
    store.upsertPushSubscription({
      endpoint,
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: authSecret.toString("base64url"),
    });

    const vapidScalar = randomBytes(32).toString("base64url");
    const vapid = resolveVapidIdentity({
      privateKeyScalarB64url: vapidScalar,
      subject: "mailto:operator@example.com",
    });
    const handle = startNotificationSink({
      config: config({
        endpoints: [], // push-only: the ntfy/webhook fan-out is an empty no-op
        webpush: { enabled: true, subject: "mailto:operator@example.com", privateKeyEnv: "RALPH_VAPID_PRIVATE_KEY" },
      }),
      store,
      logger: silentLogger,
      vapid,
    });
    expect(handle).not.toBeNull();

    // A new escalation commits → the sink wakes, decides, and the composite fans it to the
    // web-push dispatcher, which encrypts + POSTs to the subscription endpoint.
    await store.forRepo("owner/repo").addQuestion({
      runId: 1,
      issueNumber: 42,
      kind: "escalate",
      headline: "Which database should I target?",
      commentId: 7,
    });
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(endpoint);
    expect(calls[0]!.headers["content-encoding"]).toBe("aes128gcm");
    expect(calls[0]!.headers["authorization"]).toMatch(/^vapid t=eyJ[\s\S]+,k=[\w-]+$/);
    // The encrypted POST body decrypts with the device's key to the notification payload.
    const plaintext = decryptWebPushPayload({
      body: Buffer.from(calls[0]!.body),
      keys: { uaPrivate, authSecret },
    }).toString("utf8");
    expect(JSON.parse(plaintext)).toMatchObject({
      kind: "escalation",
      repo: "owner/repo",
      issue: 42,
      message: "Which database should I target?",
    });
    handle!.stop();
  });

  it("does not wire the web-push channel when push is enabled but no VAPID identity resolved", async () => {
    // The boundary owns the invariant (the dispatcher never accepts a null identity): a
    // misconfigured daemon — push enabled in config but no key resolved — simply never builds
    // the dispatcher, so a stored subscription receives nothing and nothing surfaces to the tick.
    store.upsertPushSubscription({
      endpoint: "https://fcm.googleapis.com/fcm/send/misconfigured",
      p256dh: createECDH("prime256v1").generateKeys().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    });
    const handle = startNotificationSink({
      config: config({
        endpoints: [],
        webpush: { enabled: true, subject: "mailto:operator@example.com", privateKeyEnv: "RALPH_VAPID_PRIVATE_KEY" },
      }),
      store,
      logger: silentLogger,
      vapid: null,
    });
    await store.forRepo("owner/repo").addQuestion({
      runId: 1,
      issueNumber: 42,
      kind: "escalate",
      headline: "Which database should I target?",
      commentId: 7,
    });
    await flush();

    expect(calls).toHaveLength(0);
    handle?.stop();
  });
});
