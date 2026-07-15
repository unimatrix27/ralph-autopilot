/**
 * Static serving of the built SPA (ADR-0031: the daemon serves the Vite output).
 * Two concerns kept apart so the security-critical bit is pure and unit-testable:
 *
 *  - {@link safeResolve} — pure path joining that refuses traversal outside the
 *    static root (the only place an attacker-controlled URL touches the filesystem);
 *  - {@link serveStatic} — the fs-touching part: stream the file if it exists, else
 *    fall back to `index.html` so client-side routes (TanStack Router) deep-link.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";
import type { Logger } from "../../log/logger";

/** Minimal extension → MIME map covering a Vite SPA bundle's asset kinds. */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Resolve a request URL path to an absolute path **inside** `rootDir`, or `null`
 * if it would escape the root (path traversal). Pure: it neither reads the fs nor
 * decides fallback — only that the join is safe. A trailing-slash or `/` path maps
 * to the root itself (the caller serves `index.html`).
 */
export function safeResolve(rootDir: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes("\0")) {
    return null; // NUL byte poisoning
  }
  const root = resolve(rootDir);
  const candidate = resolve(root, "." + (decoded.startsWith("/") ? decoded : "/" + decoded));
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    return null; // escaped the static root
  }
  return candidate;
}

/**
 * Serve `urlPath` from `rootDir` onto `res`. Returns `true` once it has written a
 * response, `false` only when `rootDir` does not exist at all (caller serves a
 * placeholder — the UI was not built into the configured dir). Directory requests
 * and unknown client-side routes fall back to `index.html` (SPA deep links).
 *
 * A read fault (file removed between the existence check and end-of-read, EIO,
 * permission, fd exhaustion) surfaces asynchronously on the stream, after this
 * function and the caller's try/catch have returned. It must be handled here or it
 * becomes an unhandled `'error'` event → uncaught exception → daemon crash, which
 * would violate the ADR-0029 isolation invariant ("a web fault can never wedge the
 * daemon"). The error handler turns it into a 500 (or a clean end if headers are
 * already on the wire); the response `close` listener destroys the stream so a
 * client disconnect never leaks a file descriptor.
 */
export function serveStatic(rootDir: string, urlPath: string, res: ServerResponse, logger?: Logger): boolean {
  const indexPath = resolve(rootDir, "index.html");
  if (!existsSync(indexPath)) {
    return false;
  }
  const resolved = safeResolve(rootDir, urlPath);
  if (resolved === null) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return true;
  }
  // A concrete, existing file (and not a directory) is served as-is; anything else
  // — the root, a directory, or an unknown path — falls back to the SPA entrypoint.
  const isFile = resolved !== resolve(rootDir) && existsSync(resolved) && statSync(resolved).isFile();
  const filePath = isFile ? resolved : indexPath;
  const headers = {
    "content-type": contentTypeFor(filePath),
    // index.html must never be cached (it references hashed assets); hashed assets
    // are immutable. A coarse split is enough for a single-operator control plane.
    "cache-control": isFile && !filePath.endsWith("index.html") ? "public, max-age=31536000, immutable" : "no-cache",
  };
  const stream = createReadStream(filePath);
  // Commit the 200 only once the fd actually opens, so an open-time fault (the file
  // was removed after the existence check, EACCES, fd exhaustion) can still answer a
  // 500 instead of a committed-200 empty body.
  stream.once("open", () => res.writeHead(200, headers));
  // A read fault surfaces asynchronously, after handle()'s try/catch has returned, so
  // it must be handled here or it is an unhandled 'error' event → uncaught exception →
  // daemon crash, which would violate the ADR-0029 isolation invariant.
  stream.on("error", (err) => {
    logger?.error("web.static-read-failed", { filePath, error: String(err) });
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("internal error");
    } else {
      res.end(); // headers/body already partly on the wire — terminate cleanly
    }
    stream.destroy();
  });
  // Client disconnect (or any early response close) should free the fd.
  res.on("close", () => stream.destroy());
  stream.pipe(res);
  return true;
}
