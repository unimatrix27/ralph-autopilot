/**
 * Container-only invariant (#227): the in-process execution path is gone for good.
 *
 * ADR-0038 amended — the strangler `executionMode` switch and the in-daemon
 * account-binding-into-a-live-backend machinery are retired; route **execution** (the SDK
 * session) lives only inside the container, while route **selection** (`resolveRoute`) stays
 * in the daemon. This test pins the headline acceptance criterion as a grep-clean: none of the
 * deleted in-process symbols may reappear in production `src/` (test files excluded — this file
 * names them by necessity).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC_ROOT = join(__dirname);

/** Every production `.ts` under `src/` (tests + this file's own self-reference excluded). */
function productionSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...productionSources(full));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts") || entry.endsWith(".d.ts")) continue;
    out.push(full);
  }
  return out;
}

describe("container-only: the in-process execution path is grep-clean (#227)", () => {
  // The exact symbols / module the issue's acceptance criterion bans from src/. The trailing
  // four are the in-process impl runner + its OAuth login-binding seam + the in-daemon moding
  // adapter, deleted with the rest of the in-process path (#227); the original sweep omitted
  // `SdkAgentRunner`/`UsageRouter`/`bindSession`, and a later sweep left `BackendModeClassifier`
  // — the in-process moding twin of the deleted SDK runners — unconstructible but alive (it lost
  // its only production builder when `resolveAtCallBackendFactory` went). `SdkAgentRunner` as a
  // substring also bans `SdkAgentRunnerOptions`. Only the in-daemon *impl* class is banned: the
  // provider-neutral `ModeClassifier` port (core/moding.ts) stays for the container-moding
  // follow-up (ADR-0038), exactly as the `AgentRunner` port outlived `SdkAgentRunner`.
  const FORBIDDEN = [
    "InProcessExecution",
    "ResolveAtCallImplRunner",
    "resolveAtCallBackendFactory",
    "execution-flip",
    "AccountBinding",
    "SdkAgentRunner",
    "UsageRouter",
    "bindSession",
    "BackendModeClassifier",
  ];

  const files = productionSources(SRC_ROOT);

  it("finds production sources to scan (guards against an empty/blind sweep)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  for (const symbol of FORBIDDEN) {
    it(`no production source mentions \`${symbol}\``, () => {
      const offenders = files.filter((f) => readFileSync(f, "utf8").includes(symbol));
      expect(offenders, `\`${symbol}\` must not appear in:\n${offenders.join("\n")}`).toEqual([]);
    });
  }
});
