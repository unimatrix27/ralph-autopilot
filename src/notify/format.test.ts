import { describe, expect, it } from "vitest";
import {
  formatNtfyDispatch,
  formatWebhookDispatch,
  severityToNtfyPriority,
  type HttpDispatch,
} from "./format";
import type { NotificationEndpoint } from "../config/schema";
import { REDACTED } from "../log/logger";
import type { NotificationRequest } from "./types";

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

describe("severityToNtfyPriority", () => {
  it("maps the three severities onto ntfy's 1–5 priority scale", () => {
    expect(severityToNtfyPriority("default")).toBe("3");
    expect(severityToNtfyPriority("high")).toBe("4");
    expect(severityToNtfyPriority("max")).toBe("5");
  });
});

describe("formatNtfyDispatch", () => {
  it("POSTs the message as the body with Title/Priority/Tags headers", () => {
    const d: HttpDispatch = formatNtfyDispatch(req(), ntfy, null);
    expect(d.url).toBe("https://ntfy.sh/ralph-alerts");
    expect(d.method).toBe("POST");
    expect(d.body).toBe("Which db?");
    expect(d.headers["Title"]).toBe("Escalation on owner/repo#42");
    expect(d.headers["Priority"]).toBe("4");
    expect(d.headers["Tags"]).toContain("escalation");
    expect(d.headers["Content-Type"]).toBe("text/plain; charset=utf-8");
  });

  it("sends Authorization: Bearer <token> when a token is supplied", () => {
    const d = formatNtfyDispatch(req(), { ...ntfy, tokenEnv: "NTFY_TOKEN" }, "secret-token");
    expect(d.headers["Authorization"]).toBe("Bearer secret-token");
  });

  it("omits the Authorization header when no token is supplied", () => {
    const d = formatNtfyDispatch(req(), ntfy, null);
    expect(d.headers["Authorization"]).toBeUndefined();
  });

  it("maps max severity to priority 5 (anomaly)", () => {
    const d = formatNtfyDispatch(req({ kind: "anomaly", severity: "max" }), ntfy, null);
    expect(d.headers["Priority"]).toBe("5");
  });

  it("falls back to the title body when the message is empty", () => {
    const d = formatNtfyDispatch(req({ message: "" }), ntfy, null);
    expect(d.body).toBe("Escalation on owner/repo#42");
  });

  it("redacts secret-shaped title and message text before ntfy egress", () => {
    const githubToken = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const bearer = "Bearer abcdefghijklmnopqrstuvwxyz012345";
    const d = formatNtfyDispatch(
      req({
        title: `Escalation leaked ${githubToken}`,
        message: `Agent said ${bearer}`,
      }),
      ntfy,
      null,
    );

    expect(d.headers["Title"]).not.toContain(githubToken);
    expect(d.headers["Title"]).toContain(REDACTED);
    expect(d.body).not.toContain(bearer);
    expect(d.body).toContain(REDACTED);
  });
});

describe("formatWebhookDispatch", () => {
  it("POSTs a JSON payload with the notification fields", () => {
    const d: HttpDispatch = formatWebhookDispatch(req(), webhook, null);
    expect(d.url).toBe("https://example.com/hook");
    expect(d.method).toBe("POST");
    expect(d.headers["Content-Type"]).toBe("application/json; charset=utf-8");
    const payload = JSON.parse(d.body);
    expect(payload).toEqual({
      kind: "escalation",
      severity: "high",
      title: "Escalation on owner/repo#42",
      message: "Which db?",
      repo: "owner/repo",
      issue: 42,
      at: "2026-06-22T10:00:00.000Z",
    });
  });

  it("sends Authorization: Bearer <token> when a token is supplied", () => {
    const d = formatWebhookDispatch(req(), { ...webhook, tokenEnv: "HOOK_TOKEN" }, "tok");
    expect(d.headers["Authorization"]).toBe("Bearer tok");
  });

  it("serializes a daemon-wide stall (null repo/issue) cleanly", () => {
    const d = formatWebhookDispatch(
      req({ kind: "stall", severity: "max", title: "Daemon stalled", message: "No tick for 6m", repo: null, issueNumber: null }),
      webhook,
      null,
    );
    const payload = JSON.parse(d.body);
    expect(payload.repo).toBeNull();
    expect(payload.issue).toBeNull();
    expect(payload.kind).toBe("stall");
  });

  it("redacts secret-shaped title and message text before webhook egress", () => {
    const secret = "sk-ant-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const d = formatWebhookDispatch(
      req({
        title: `Heal card included ${secret}`,
        message: `Review detail included ${secret}`,
      }),
      webhook,
      null,
    );

    expect(d.body).not.toContain(secret);
    const payload = JSON.parse(d.body);
    expect(payload.title).toContain(REDACTED);
    expect(payload.message).toContain(REDACTED);
  });
});
