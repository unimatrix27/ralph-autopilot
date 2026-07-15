/**
 * Structured logger: one machine-greppable JSON line per event, never echoes
 * secrets. Every line is a single-line JSON object with stable leading fields
 * (`ts`, `level`, `event`) followed by the event's own fields, so it can be
 * grepped, `jq`-filtered, and surfaced by the web control plane.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Field whose value is always a secret regardless of its content. */
const SECRET_KEY = /(pass(word|wd)?|secret|token|authorization|auth|api[-_]?key|access[-_]?key|credential|cookie|session)/i;

/**
 * Value patterns that betray a secret even under an innocuous key — GitHub
 * tokens, Anthropic keys, bearer headers, and OAuth-ish blobs. Kept
 * deliberately specific to avoid mangling ordinary text.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub PAT / OAuth / user / server / refresh
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic API key
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  /\beyJ[A-Za-z0-9._-]{20,}/g, // JWT
];

export const REDACTED = "[REDACTED]";

function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/** Recursively redact secrets by key name and by value pattern. */
export function redact(value: unknown, keyHint?: string): unknown {
  if (keyHint && SECRET_KEY.test(keyHint)) {
    return REDACTED;
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => redact(v));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redact(v, k);
    }
    return out;
  }
  return value;
}

export type LogFields = Record<string, unknown>;

export interface LoggerOptions {
  level?: LogLevel;
  /** Sink for finished lines. Defaults to stdout. Override in tests. */
  write?: (line: string) => void;
  /** Bindings merged into every line emitted by this logger. */
  bindings?: LogFields;
  /** Injected clock, for deterministic tests. */
  now?: () => Date;
}

export class Logger {
  private readonly level: LogLevel;
  private readonly write: (line: string) => void;
  private readonly bindings: LogFields;
  private readonly now: () => Date;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.write = options.write ?? ((line) => process.stdout.write(line + "\n"));
    this.bindings = options.bindings ?? {};
    this.now = options.now ?? (() => new Date());
  }

  /** Derive a child logger carrying extra bindings on every line. */
  child(bindings: LogFields): Logger {
    return new Logger({
      level: this.level,
      write: this.write,
      bindings: { ...this.bindings, ...bindings },
      now: this.now,
    });
  }

  private log(level: LogLevel, event: string, fields: LogFields = {}): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) {
      return;
    }
    const merged = { ...this.bindings, ...fields };
    const safe = redact(merged) as LogFields;
    const line: LogFields = {
      ts: this.now().toISOString(),
      level,
      event,
      ...safe,
    };
    this.write(JSON.stringify(line));
  }

  debug(event: string, fields?: LogFields): void {
    this.log("debug", event, fields);
  }

  info(event: string, fields?: LogFields): void {
    this.log("info", event, fields);
  }

  warn(event: string, fields?: LogFields): void {
    this.log("warn", event, fields);
  }

  error(event: string, fields?: LogFields): void {
    this.log("error", event, fields);
  }
}

export function createLogger(options?: LoggerOptions): Logger {
  return new Logger(options);
}
