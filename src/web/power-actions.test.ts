import { describe, expect, it } from "vitest";
import {
  LABEL_AFK,
  LABEL_AGENT_STUCK,
  LABEL_AWAITING_ANSWER,
  LABEL_DAEMON_ANOMALY,
  LABEL_HITL,
  LABEL_MODE_INFRA,
  LABEL_MODE_TDD,
  LABEL_MODE_UI,
  LABEL_READY,
  LABEL_REVIEW_MAXED,
  modeLabelFor,
} from "../core/labels";
import type { PowerActionRequestBody } from "./contract";
import { planPowerAction } from "./power-actions";

const PRIORITIES = ["priority:p0", "priority:p1", "priority:p2"];

/** Build a request body of one action kind (the planner only reads the kind + payload). */
function req(body: PowerActionRequestBody): PowerActionRequestBody {
  return body;
}

describe("planPowerAction — readmit (AC1)", () => {
  it("swaps any paused/stuck human-attention label back to ready-for-agent", () => {
    for (const paused of [LABEL_AWAITING_ANSWER, LABEL_REVIEW_MAXED, LABEL_AGENT_STUCK, LABEL_DAEMON_ANOMALY]) {
      const plan = planPowerAction(req({ repo: "o/r", issue: 1, kind: "readmit" }), [paused, "afk", LABEL_MODE_TDD], PRIORITIES);
      expect(plan).toEqual({ kind: "labels", remove: [paused], add: [LABEL_READY] });
    }
  });

  it("removes every paused label present and adds ready even when none is present (idempotent re-arm)", () => {
    const plan = planPowerAction(req({ repo: "o/r", issue: 1, kind: "readmit" }), [LABEL_READY, "afk", LABEL_MODE_TDD], PRIORITIES);
    expect(plan).toEqual({ kind: "labels", remove: [], add: [LABEL_READY] });
  });
});

describe("planPowerAction — close (AC1/AC2)", () => {
  it("plans the destructive close (confirm was enforced at the contract edge)", () => {
    const plan = planPowerAction(req({ repo: "o/r", issue: 1, kind: "close", confirm: true }), [], PRIORITIES);
    expect(plan).toEqual({ kind: "close" });
  });
});

describe("planPowerAction — set-mode (AC1)", () => {
  it("swaps the current mode for the chosen one", () => {
    const toInfra = planPowerAction(req({ repo: "o/r", issue: 1, kind: "set-mode", mode: "infra" }), [LABEL_MODE_TDD, "afk"], PRIORITIES);
    expect(toInfra).toEqual({ kind: "labels", remove: [LABEL_MODE_TDD], add: [LABEL_MODE_INFRA] });

    const backToTdd = planPowerAction(req({ repo: "o/r", issue: 1, kind: "set-mode", mode: "tdd" }), [LABEL_MODE_INFRA, "afk"], PRIORITIES);
    expect(backToTdd).toEqual({ kind: "labels", remove: [LABEL_MODE_INFRA], add: [LABEL_MODE_TDD] });

    const toUi = planPowerAction(req({ repo: "o/r", issue: 1, kind: "set-mode", mode: "ui" }), [LABEL_MODE_TDD, "afk"], PRIORITIES);
    expect(toUi).toEqual({ kind: "labels", remove: [LABEL_MODE_TDD], add: [LABEL_MODE_UI] });

    const offUi = planPowerAction(req({ repo: "o/r", issue: 1, kind: "set-mode", mode: "tdd" }), [LABEL_MODE_UI, "afk"], PRIORITIES);
    expect(offUi).toEqual({ kind: "labels", remove: [LABEL_MODE_UI], add: [LABEL_MODE_TDD] });
  });

  it("sets a mode on an unmoded issue (no removal)", () => {
    const plan = planPowerAction(req({ repo: "o/r", issue: 1, kind: "set-mode", mode: "tdd" }), [LABEL_READY, "afk"], PRIORITIES);
    expect(plan).toEqual({ kind: "labels", remove: [], add: [LABEL_MODE_TDD] });
  });
});

describe("planPowerAction — set-priority (AC1)", () => {
  it("swaps the current configured priority for the chosen one", () => {
    const plan = planPowerAction(req({ repo: "o/r", issue: 1, kind: "set-priority", priority: "priority:p0" }), ["priority:p2", LABEL_READY], PRIORITIES);
    expect(plan).toEqual({ kind: "labels", remove: ["priority:p2"], add: ["priority:p0"] });
  });

  it("rejects a priority not in the repo's configured set (no label injection)", () => {
    const plan = planPowerAction(req({ repo: "o/r", issue: 1, kind: "set-priority", priority: "priority:evil" }), [], PRIORITIES);
    expect(plan.kind).toBe("bad-request");
  });

  it("rejects any priority when the repo has none configured", () => {
    const plan = planPowerAction(req({ repo: "o/r", issue: 1, kind: "set-priority", priority: "priority:p0" }), [], []);
    expect(plan.kind).toBe("bad-request");
  });
});

describe("planPowerAction — pause / unpause (AC1)", () => {
  it("pause swaps afk → hitl (holds the issue out of the gate)", () => {
    const plan = planPowerAction(req({ repo: "o/r", issue: 1, kind: "pause" }), [LABEL_READY, LABEL_AFK, LABEL_MODE_TDD], PRIORITIES);
    expect(plan).toEqual({ kind: "labels", remove: [LABEL_AFK], add: [LABEL_HITL] });
  });

  it("unpause swaps hitl → afk (returns it to the gate)", () => {
    const plan = planPowerAction(req({ repo: "o/r", issue: 1, kind: "unpause" }), [LABEL_READY, LABEL_HITL, LABEL_MODE_TDD], PRIORITIES);
    expect(plan).toEqual({ kind: "labels", remove: [LABEL_HITL], add: [LABEL_AFK] });
  });
});

describe("modeLabelFor", () => {
  it("maps each mode to its label constant", () => {
    expect(modeLabelFor("tdd")).toBe(LABEL_MODE_TDD);
    expect(modeLabelFor("infra")).toBe(LABEL_MODE_INFRA);
    expect(modeLabelFor("ui")).toBe(LABEL_MODE_UI);
  });
});
