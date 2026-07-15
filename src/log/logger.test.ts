import { describe, expect, it } from "vitest";
import { createLogger, redact, REDACTED } from "./logger";

function collect() {
  const lines: string[] = [];
  return {
    lines,
    write: (line: string) => lines.push(line),
  };
}

const fixedNow = () => new Date("2026-06-19T00:00:00.000Z");

describe("Logger", () => {
  it("emits exactly one machine-greppable JSON line per event", () => {
    const sink = collect();
    const log = createLogger({ write: sink.write, now: fixedNow });

    log.info("run.started", { issue: 1, mode: "infra" });

    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).not.toContain("\n");
    const parsed = JSON.parse(sink.lines[0]!);
    expect(parsed).toMatchObject({
      ts: "2026-06-19T00:00:00.000Z",
      level: "info",
      event: "run.started",
      issue: 1,
      mode: "infra",
    });
  });

  it("respects the level threshold", () => {
    const sink = collect();
    const log = createLogger({ write: sink.write, level: "warn" });
    log.debug("nope");
    log.info("nope");
    log.warn("yep");
    log.error("yep");
    expect(sink.lines).toHaveLength(2);
  });

  it("merges child bindings into every line", () => {
    const sink = collect();
    const log = createLogger({ write: sink.write, now: fixedNow }).child({ runId: 42 });
    log.info("phase.advance", { phase: 2 });
    const parsed = JSON.parse(sink.lines[0]!);
    expect(parsed.runId).toBe(42);
    expect(parsed.phase).toBe(2);
  });

  it("never echoes secrets by key name", () => {
    const sink = collect();
    const log = createLogger({ write: sink.write });
    log.info("auth", {
      token: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      password: "hunter2",
      apiKey: "whatever",
      nested: { authorization: "Bearer xyz" },
    });
    const line = sink.lines[0]!;
    expect(line).not.toContain("ghp_");
    expect(line).not.toContain("hunter2");
    const parsed = JSON.parse(line);
    expect(parsed.token).toBe(REDACTED);
    expect(parsed.password).toBe(REDACTED);
    expect(parsed.apiKey).toBe(REDACTED);
    expect(parsed.nested.authorization).toBe(REDACTED);
  });

  it("never echoes secrets that leak under innocuous keys", () => {
    const sink = collect();
    const log = createLogger({ write: sink.write });
    log.info("git.clone", {
      url: "https://x-access-token:ghp_0123456789abcdefghijklmnopqrstuvwxyz@github.com/o/r.git",
      header: "Authorization: Bearer sk-ant-api03-abcdef0123456789",
    });
    const line = sink.lines[0]!;
    expect(line).not.toMatch(/ghp_/);
    expect(line).not.toMatch(/sk-ant-/);
    expect(line).toContain(REDACTED);
  });
});

describe("redact", () => {
  it("redacts JWTs in arrays and leaves ordinary values intact", () => {
    const out = redact({
      items: ["plain text", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payloadpayload"],
      count: 3,
    }) as { items: string[]; count: number };
    expect(out.items[0]).toBe("plain text");
    expect(out.items[1]).toBe(REDACTED);
    expect(out.count).toBe(3);
  });
});
