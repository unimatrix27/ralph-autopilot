/**
 * The `AnomalyReason → operator action` map (issue #43): "`daemon-anomaly` … must name the
 * operator action required". The map must be **total** — a new reason that forgets its action
 * is a compile error, not a blank line on the operator's dashboard — and it must never
 * paraphrase the authoritative route-defect text that `master/route.ts` already owns.
 */

import { describe, expect, it } from "vitest";
import { describeMasterRouteDefect } from "../master/route";
import { OPERATOR_OWNED_ANOMALIES, type AnomalyReason } from "./completeness";
import {
  ANOMALY_REASONS,
  formatAnomalyActionComment,
  loggedAnomalyAction,
  operatorActionFor,
  parseAnomalyReason,
} from "./anomaly-action";

describe("operatorActionFor (issue #43 — name the operator action)", () => {
  it("names a concrete, imperative action for EVERY anomaly reason", () => {
    for (const reason of ANOMALY_REASONS) {
      const action = operatorActionFor(reason);
      expect(action.length, reason).toBeGreaterThan(20);
      // Imperative voice: an action tells the operator what to do, it does not restate
      // the reason. A bare echo of the enum would be a label, not an action.
      expect(action, reason).not.toBe(reason);
    }
  });

  it("enumerates the full reason vocabulary exactly once (the map cannot silently shrink)", () => {
    expect(new Set(ANOMALY_REASONS).size).toBe(ANOMALY_REASONS.length);
    // Every operator-owned reason is in the vocabulary — the two lists cannot drift.
    for (const reason of OPERATOR_OWNED_ANOMALIES) {
      expect(ANOMALY_REASONS, reason).toContain(reason);
    }
  });

  it("reuses `describeMasterRouteDefect` verbatim rather than paraphrasing the config fix", () => {
    const action = operatorActionFor("master-route-unconfigured");
    expect(action).toContain(describeMasterRouteDefect("missing-tier-1-profile"));
    expect(action).toContain(describeMasterRouteDefect("tier-1-not-tools-capable"));
    expect(action).toContain(".ralph/config.yaml");
  });

  it("tells the operator to do nothing for the self-healing rate-limit stranding", () => {
    // The daemon retries the `ready-for-agent` re-arm every tick; an operator who "fixes"
    // it by hand races the compensator.
    expect(operatorActionFor("answered-pause-stranded").toLowerCase()).toContain("no action");
  });
});

describe("parseAnomalyReason / loggedAnomalyAction", () => {
  it("recovers a bare logged reason", () => {
    expect(parseAnomalyReason("paused-label-missing-run")).toBe("paused-label-missing-run");
  });

  it("recovers a reason carrying a `: detail` suffix (the master engine's own form)", () => {
    const detail = describeMasterRouteDefect("tier-1-not-tools-capable");
    expect(parseAnomalyReason(`master-route-unconfigured: ${detail}`)).toBe("master-route-unconfigured");
  });

  it("returns null for a reason outside the vocabulary (a claim park, a future reason)", () => {
    expect(parseAnomalyReason("claim-failed-after-3-attempts")).toBeNull();
    expect(parseAnomalyReason("")).toBeNull();
  });

  it("prefers the logged detail over the generic action when the log carried one", () => {
    // `master/engine.ts` already logs `master-route-unconfigured: <describeMasterRouteDefect>`;
    // that detail names the EXACT defect, so it beats the two-defect generic text.
    const detail = describeMasterRouteDefect("missing-tier-1-profile");
    expect(loggedAnomalyAction(`master-route-unconfigured: ${detail}`)).toBe(detail);
  });

  it("falls back to the map for a bare logged reason, and to null for an unknown one", () => {
    expect(loggedAnomalyAction("unclassified")).toBe(operatorActionFor("unclassified"));
    expect(loggedAnomalyAction("claim-failed-after-3-attempts")).toBeNull();
  });
});

describe("formatAnomalyActionComment (the on-issue operator surface)", () => {
  it("names the reason AND the action, so the issue itself is actionable", () => {
    const body = formatAnomalyActionComment("paused-label-missing-run" satisfies AnomalyReason, null);
    expect(body).toContain("paused-label-missing-run");
    expect(body).toContain(operatorActionFor("paused-label-missing-run"));
    expect(body.toLowerCase()).toContain("operator action");
  });

  it("carries the live route defect when the caller holds one", () => {
    const detail = describeMasterRouteDefect("tier-1-not-tools-capable");
    const body = formatAnomalyActionComment("master-route-unconfigured", detail);
    expect(body).toContain(detail);
  });
});
