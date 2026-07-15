import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { contentTypeFor, safeResolve } from "./static";

const ROOT = resolve("/srv/web/dist");

describe("safeResolve", () => {
  it("resolves a normal asset path inside the root", () => {
    expect(safeResolve(ROOT, "/assets/app.js")).toBe(resolve(ROOT, "assets/app.js"));
  });

  it("maps the root path to the root dir itself", () => {
    expect(safeResolve(ROOT, "/")).toBe(ROOT);
  });

  it("refuses parent-directory traversal", () => {
    expect(safeResolve(ROOT, "/../secrets")).toBeNull();
    expect(safeResolve(ROOT, "/assets/../../etc/passwd")).toBeNull();
  });

  it("refuses an encoded traversal", () => {
    expect(safeResolve(ROOT, "/%2e%2e/%2e%2e/etc/passwd")).toBeNull();
  });

  it("refuses a NUL-byte poisoned path", () => {
    expect(safeResolve(ROOT, "/app.js%00.png")).toBeNull();
  });

  it("refuses malformed percent-encoding", () => {
    expect(safeResolve(ROOT, "/%zz")).toBeNull();
  });

  it("does not treat a sibling-prefix dir as inside the root", () => {
    // `/srv/web/dist-evil` shares the `dist` prefix but is not under `dist/`.
    const escaped = safeResolve(ROOT, "/../dist-evil/x");
    expect(escaped).toBeNull();
    expect(safeResolve(ROOT, "/a")?.startsWith(ROOT + sep)).toBe(true);
  });
});

describe("contentTypeFor", () => {
  it("maps known extensions", () => {
    expect(contentTypeFor("/index.html")).toMatch(/text\/html/);
    expect(contentTypeFor("/assets/app.js")).toMatch(/javascript/);
    expect(contentTypeFor("/assets/app.css")).toMatch(/text\/css/);
    expect(contentTypeFor("/logo.svg")).toBe("image/svg+xml");
  });
  it("falls back to octet-stream for unknown extensions", () => {
    expect(contentTypeFor("/data.bin")).toBe("application/octet-stream");
    expect(contentTypeFor("/no-extension")).toBe("application/octet-stream");
  });
});
