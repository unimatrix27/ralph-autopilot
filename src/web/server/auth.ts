/**
 * The reserved auth-middleware seam (ADR-0032). Tailscale is the identity boundary
 * for the single-operator deployment, so the daemon ships **no** managed auth: the
 * default middleware allows everything. The seam exists so anyone exposing the
 * control plane beyond loopback/tailnet can drop in real authentication in front of
 * the routes without touching the server core.
 *
 * It is intentionally minimal and synchronous-shaped (a verdict, not a handler) so
 * it composes with the Origin guard and stays a pure decision.
 */
import type { IncomingMessage } from "node:http";

export interface AuthVerdict {
  /** True → continue to routing; false → the server replies with `status`/`message`. */
  ok: boolean;
  status?: number;
  message?: string;
}

/** A pluggable auth check over the raw request. Must not mutate the request. */
export type AuthMiddleware = (req: IncomingMessage) => AuthVerdict;

/** The default: no managed auth (Tailscale is the boundary). Always allows. */
export const allowAllAuth: AuthMiddleware = () => ({ ok: true });
