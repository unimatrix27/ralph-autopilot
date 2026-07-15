/**
 * The Origin guard (ADR-0032) — confused-deputy hygiene in front of mutating
 * routes. Tailscale (a single-user tailnet) is the identity boundary, so there is
 * no managed auth; but a browser tab on any site can still issue a cross-site
 * `POST` to `http://127.0.0.1:<port>`. This guard rejects such requests by checking
 * the `Origin` header against the server's own origin plus a configured allowlist.
 *
 * The foundations slice ships **no** mutating routes yet — this is the seam they
 * will sit behind (slice 5, the Inbox/answers write path, is the first user). The
 * decision is a **pure predicate** so it is exhaustively unit-testable; the server
 * wires it in front of every unsafe-method (`POST`/`PUT`/`PATCH`/`DELETE`) request.
 */

/** Methods that never mutate, so they bypass the Origin guard entirely. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isSafeMethod(method: string | undefined): boolean {
  return SAFE_METHODS.has((method ?? "GET").toUpperCase());
}

export interface OriginCheckContext {
  /** The request's `Host` header (e.g. `127.0.0.1:4280` or `ralph.tailnet:4280`); used for the same-origin match. */
  host: string | undefined;
  /** Operator-configured extra origins to accept (full origins, e.g. `https://ui.example`). */
  allowedOrigins: ReadonlySet<string>;
}

/**
 * Whether a request bearing `origin` is allowed to mutate. The rules, in order:
 *  - no `Origin` header → allowed (a non-browser client like `curl`/the CLI, or a
 *    same-origin navigation; browsers attach `Origin` to every cross-site write,
 *    which is the case this guard exists to stop);
 *  - `origin` is in the configured allowlist → allowed;
 *  - `origin`'s host:port equals the request's `Host` (same-origin: the request
 *    came from the SPA this very server served) → allowed;
 *  - otherwise → rejected.
 */
export function isOriginAllowed(origin: string | undefined, ctx: OriginCheckContext): boolean {
  if (!origin) {
    return true;
  }
  if (ctx.allowedOrigins.has(origin)) {
    return true;
  }
  if (ctx.host) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return false; // a malformed Origin is never same-origin
    }
    if (parsed.host === ctx.host) {
      return true;
    }
  }
  return false;
}
