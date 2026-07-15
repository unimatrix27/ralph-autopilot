/**
 * The codebase's one **on-disk strict-YAML config loader** mechanism, shared by the daemon's
 * per-deployment `.ralph/config.yaml` ({@link ../config/load}) and the target's `.ralph/agent.yaml`
 * onboarding contract ({@link ../container/agent-contract}). Both want the identical pipeline —
 * read → ENOENT hint → `parseYaml` → malformed-YAML message → empty check → strict `safeParse` →
 * located zod-error formatting — differing only in the domain error type and the file's noun in
 * the prose. That single point of variation is injected as {@link YamlFileMessages}; the
 * mechanism (and `formatZodError`) lives here exactly once so a second copy can't drift.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { z } from "zod";

/**
 * The per-file-kind customization a {@link loadYamlFile} caller supplies: how to build its
 * domain error, the noun/subject used in the otherwise-uniform error prose, and the remediation
 * hint appended when the file is missing.
 */
export interface YamlFileMessages {
  /** Construct this file kind's domain error (e.g. `(m) => new ConfigError(m)`). */
  makeError: (message: string) => Error;
  /** Lowercase noun for mid-sentence prose: "configuration", "agent contract". */
  noun: string;
  /** Capitalized subject for sentence-start prose: "Configuration file", "Agent contract". */
  subject: string;
  /** The remediation hint appended to the not-found error, given the caller-supplied path. */
  notFoundHint: (path: string) => string;
}

function formatZodError(noun: string, path: string, error: z.ZodError): string {
  const issues = error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${where}: ${issue.message}`;
    })
    .join("\n");
  return `Invalid ${noun} in ${path}:\n${issues}`;
}

/**
 * Strict-validate an already-parsed object against `schema`, throwing the caller's domain error
 * with a located, source-prefixed message on a mismatch. Shared by both file kinds' `parse*`
 * entry points (which validate a value the caller already has in hand).
 */
export function parseYamlValue<S extends z.ZodType>(
  schema: S,
  raw: unknown,
  source: string,
  msgs: YamlFileMessages,
): z.infer<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw msgs.makeError(formatZodError(msgs.noun, source, result.error));
  }
  return result.data;
}

/**
 * Read, parse, and strict-validate a YAML file. Fails loud with a useful, source-located
 * message (via `msgs.makeError`) on a missing file, malformed YAML, an empty document, or a
 * schema mismatch — the one loader both config kinds route through.
 */
export function loadYamlFile<S extends z.ZodType>(path: string, schema: S, msgs: YamlFileMessages): z.infer<S> {
  const abs = resolve(path);

  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw msgs.makeError(`${msgs.subject} not found at ${abs}. ${msgs.notFoundHint(path)}`);
    }
    throw msgs.makeError(`Could not read ${msgs.noun} at ${abs}: ${(err as Error).message}`);
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    if (err instanceof YAMLParseError) {
      throw msgs.makeError(`Malformed YAML in ${abs}: ${err.message}`);
    }
    throw err;
  }

  if (raw === null || raw === undefined) {
    throw msgs.makeError(`${msgs.subject} ${abs} is empty.`);
  }

  return parseYamlValue(schema, raw, abs, msgs);
}
