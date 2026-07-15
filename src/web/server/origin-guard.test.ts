import { describe, expect, it } from "vitest";
import { isOriginAllowed, isSafeMethod } from "./origin-guard";

const ctx = (host: string | undefined, allowed: string[] = []) => ({
  host,
  allowedOrigins: new Set(allowed),
});

describe("isSafeMethod", () => {
  it("treats read methods as safe and writes as unsafe", () => {
    for (const m of ["GET", "head", "OPTIONS"]) expect(isSafeMethod(m)).toBe(true);
    for (const m of ["POST", "put", "PATCH", "DELETE"]) expect(isSafeMethod(m)).toBe(false);
  });
  it("defaults a missing method to safe (GET)", () => {
    expect(isSafeMethod(undefined)).toBe(true);
  });
});

describe("isOriginAllowed", () => {
  it("allows a request with no Origin header (non-browser client / same-origin GET)", () => {
    expect(isOriginAllowed(undefined, ctx("127.0.0.1:4280"))).toBe(true);
  });

  it("allows the server's own origin (same host:port as the Host header)", () => {
    expect(isOriginAllowed("http://127.0.0.1:4280", ctx("127.0.0.1:4280"))).toBe(true);
  });

  it("allows a Tailscale-hostname same-origin request", () => {
    expect(isOriginAllowed("http://ralph.tailnet.ts.net:4280", ctx("ralph.tailnet.ts.net:4280"))).toBe(true);
  });

  it("rejects a cross-site origin not in the allowlist", () => {
    expect(isOriginAllowed("https://evil.example", ctx("127.0.0.1:4280"))).toBe(false);
  });

  it("rejects a same-host but different-port origin", () => {
    expect(isOriginAllowed("http://127.0.0.1:9999", ctx("127.0.0.1:4280"))).toBe(false);
  });

  it("allows an explicitly allowlisted origin", () => {
    expect(isOriginAllowed("https://ui.example", ctx("127.0.0.1:4280", ["https://ui.example"]))).toBe(true);
  });

  it("rejects a malformed Origin", () => {
    expect(isOriginAllowed("not a url", ctx("127.0.0.1:4280"))).toBe(false);
  });
});
