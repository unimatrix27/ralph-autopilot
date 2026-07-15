import { describe, expect, it } from "vitest";
import { formatRelativeDe } from "./relative-time";

describe("formatRelativeDe", () => {
  // A fixed reference clock + fixed started instants — deterministic, no real clock.
  const NOW = Date.parse("2026-06-29T12:00:00.000Z");
  const startedAgo = (ms: number): string => new Date(NOW - ms).toISOString();

  it("renders seconds when elapsed < 60s", () => {
    expect(formatRelativeDe(startedAgo(5_000), NOW)).toBe("vor 5 Sekunden");
  });

  it("renders minutes when elapsed < 1h", () => {
    expect(formatRelativeDe(startedAgo(2 * 60_000), NOW)).toBe("vor 2 Minuten");
  });

  it("renders hours when elapsed < 1 day", () => {
    expect(formatRelativeDe(startedAgo(60 * 60_000), NOW)).toBe("vor 1 Stunde");
  });

  it("renders days when elapsed >= 1 day", () => {
    expect(formatRelativeDe(startedAgo(3 * 24 * 60 * 60_000), NOW)).toBe("vor 3 Tagen");
  });

  it("floors to the largest sensible unit (90s → 1 minute, not 90 seconds)", () => {
    expect(formatRelativeDe(startedAgo(90_000), NOW)).toBe("vor 1 Minute");
  });

  it("returns the sentinel for a null instant", () => {
    expect(formatRelativeDe(null, NOW)).toBe("—");
  });

  it("returns the sentinel for an unparseable instant", () => {
    expect(formatRelativeDe("not-a-date", NOW)).toBe("—");
  });
});
