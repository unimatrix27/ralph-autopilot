/**
 * Pure wire-format helpers for the notification sink (issue #117): turn a
 * {@link NotificationRequest} + resolved endpoint into the exact HTTP request the
 * dispatcher fires — for ntfy.sh (a text-body POST with `Title`/`Priority`/`Tags`
 * headers) and for a generic webhook (a JSON POST).
 *
 * Pure and total: no node, no fetch, no env. The dispatcher resolves the bearer token
 * from the configured env-var name (ADR-0034 precedent) and passes the resolved value
 * here, so this module never touches `process.env` and stays exhaustively unit-testable.
 */
import type { NotificationEndpoint } from "../config/schema";
import { redact } from "../log/logger";
import type { NotificationKind, NotificationRequest, NotificationSeverity } from "./types";

/** The one HTTP request shape the dispatcher fires per (notification × endpoint). */
export interface HttpDispatch {
  /** Fully-qualified URL to POST to (the endpoint's `url`). */
  url: string;
  /** Always POST (both ntfy and webhook are push). */
  method: "POST";
  /** Header name → value (no duplicates; ntfy/webhook need none that collide). */
  headers: Record<string, string>;
  /** The serialized body (plain text for ntfy, JSON for webhook). */
  body: string;
}

/** The shared redacted JSON-ish egress payload for webhook and web-push channels. */
export interface NotificationEgressPayload {
  kind: NotificationRequest["kind"];
  severity: NotificationRequest["severity"];
  title: string;
  message: string;
  repo: string | null;
  issue: number | null;
  at: string;
}

/** ntfy's priority scale is 1 (min) … 5 (max); map the three severities onto it. */
export function severityToNtfyPriority(severity: NotificationSeverity): string {
  switch (severity) {
    case "default":
      return "3";
    case "high":
      return "4";
    case "max":
      return "5";
  }
}

/** A short text tag per attention kind (ntfy `Tags` header; also reused nowhere else). */
function tagFor(kind: NotificationKind): string {
  return kind; // escalation / heal / stuck / anomaly / stall — stable, filterable tokens.
}

/** The `Authorization: Bearer <token>` header value, or `null` to omit it. */
function authHeader(token: string | null): string | null {
  return token && token.length > 0 ? `Bearer ${token}` : null;
}

/** The non-empty body text, falling back to the title if the message is blank. */
function bodyText(r: NotificationRequest): string {
  const m = r.message.trim();
  return m.length > 0 ? m : r.title;
}

/** Apply the shared secret redactor to text that crosses the notification egress boundary. */
function redactText(value: string): string {
  return redact(value) as string;
}

/** Build the sanitized notification payload shared by structured egress channels. */
export function toNotificationEgressPayload(
  r: NotificationRequest,
  message: string = bodyText(r),
): NotificationEgressPayload {
  return {
    kind: r.kind,
    severity: r.severity,
    title: redactText(r.title),
    message: redactText(message),
    repo: r.repo,
    issue: r.issueNumber,
    at: r.at,
  };
}

/**
 * Format the ntfy.sh POST: the message as the body, `Title`/`Priority`/`Tags` headers,
 * optional bearer auth. ntfy treats the request body as the notification text and the
 * headers as metadata, so `Content-Type` is plain text.
 */
export function formatNtfyDispatch(
  r: NotificationRequest,
  endpoint: NotificationEndpoint,
  token: string | null,
): HttpDispatch {
  const title = redactText(r.title);
  const message = redactText(bodyText(r));
  const headers: Record<string, string> = {
    "Title": title,
    "Priority": severityToNtfyPriority(r.severity),
    "Tags": tagFor(r.kind),
    "Content-Type": "text/plain; charset=utf-8",
  };
  const auth = authHeader(token);
  if (auth) {
    headers["Authorization"] = auth;
  }
  return { url: endpoint.url, method: "POST", headers, body: message };
}

/**
 * Format the generic webhook POST: a JSON body carrying the notification fields, with
 * `repo`/`issue` (null for a daemon-wide stall) and the kind/severity the receiver can
 * route on. Optional bearer auth.
 */
export function formatWebhookDispatch(
  r: NotificationRequest,
  endpoint: NotificationEndpoint,
  token: string | null,
): HttpDispatch {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
  };
  const auth = authHeader(token);
  if (auth) {
    headers["Authorization"] = auth;
  }
  return { url: endpoint.url, method: "POST", headers, body: JSON.stringify(toNotificationEgressPayload(r)) };
}
