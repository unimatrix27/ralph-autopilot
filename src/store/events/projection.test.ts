import { describe, expect, it } from "vitest";
import { initialIssueState, type IssueState } from "./decider";
import type { IssueEvent } from "./event-types";
import {
  decodeProjectionState,
  foldIssueState,
  ISSUE_PROJECTION_DDL,
  ISSUE_PROJECTION_TABLE,
  mapProjectionRow,
  parseFixAttempts,
  parseRoute,
  serializeFixAttempts,
  serializeRoute,
  type IssueProjectionRowRaw,
} from "./projection";

describe("foldIssueState", () => {
  it("folds a batch onto the initial state", () => {
    const state = foldIssueState([
      { type: "RunStarted", data: { runId: "r1", mode: "tdd" } },
      { type: "FixAttempted", data: { runId: "r1", phase: 1 } },
    ]);
    expect(state.status).toBe("running");
    expect(state.fixAttempts).toEqual({ 0: 0, 1: 1, 2: 0 });
  });

  it("folds new events on top of a prior (already-projected) state", () => {
    const prior: IssueState = {
      status: "running",
      runId: "r1",
      prNumber: 42,
      fixAttempts: { 0: 0, 1: 1, 2: 0 },
      anomaly: null,
      ended: false,
      route: null,
    };
    const next = foldIssueState([{ type: "FixAttempted", data: { runId: "r1", phase: 1 } }], prior);
    expect(next.fixAttempts[1]).toBe(2);
    expect(next.prNumber).toBe(42); // carried forward, not reset
  });

  it("folds ReviewPhaseEntered as a non-destructive per-phase span reset", () => {
    const state = foldIssueState([
      { type: "RunStarted", data: { runId: "r1", mode: "tdd" } },
      { type: "FixAttempted", data: { runId: "r1", phase: 1 } },
      { type: "FixAttempted", data: { runId: "r1", phase: 1 } },
      { type: "ReviewPhaseEntered", data: { runId: "r1", phase: 1 } },
      { type: "FixAttempted", data: { runId: "r1", phase: 1 } },
    ]);
    // The count reflects only the current span (one attempt after the re-entry).
    expect(state.fixAttempts[1]).toBe(1);
  });

  it("an empty batch returns the prior state unchanged", () => {
    const prior = initialIssueState();
    expect(foldIssueState([], prior)).toEqual(prior);
  });

  it("is a tolerant reader for unknown event types", () => {
    const events = [
      { type: "RunStarted", data: { runId: "r1", mode: "tdd" } },
      { type: "MintedLater", data: {} },
    ] as unknown as IssueEvent[];
    expect(foldIssueState(events).status).toBe("running");
  });
});

describe("fix-attempt codec", () => {
  it("round-trips per-phase counts", () => {
    const counts = { 0: 3, 1: 0, 2: 7 } as const;
    expect(parseFixAttempts(serializeFixAttempts(counts))).toEqual(counts);
  });

  it("is tolerant of corrupt or partial JSON (rebuildable → soft default to zeros)", () => {
    expect(parseFixAttempts("not json")).toEqual({ 0: 0, 1: 0, 2: 0 });
    expect(parseFixAttempts('{"1": 4}')).toEqual({ 0: 0, 1: 4, 2: 0 });
    expect(parseFixAttempts('{"0": "x", "2": 2}')).toEqual({ 0: 0, 1: 0, 2: 2 });
  });
});

describe("projection row codec", () => {
  const raw: IssueProjectionRowRaw = {
    stream_id: "owner/repo#101",
    repo: "owner/repo",
    issue_number: 101,
    status: "running",
    run_id: "r1",
    pr_number: 42,
    fix_attempts: '{"0":0,"1":2,"2":0}',
    anomaly: null,
    ended: 0,
    route: '{"provider":"claude","model":"opus","account":"c1"}',
    stream_position: 3,
    updated_at: "2026-06-20T00:00:00.000Z",
  };

  it("decodeProjectionState reconstructs IssueState from a row", () => {
    expect(decodeProjectionState(raw)).toEqual({
      status: "running",
      runId: "r1",
      prNumber: 42,
      fixAttempts: { 0: 0, 1: 2, 2: 0 },
      anomaly: null,
      ended: false,
      route: { provider: "claude", model: "opus", account: "c1" },
    });
  });

  it("decodeProjectionState reads a route-less row (no dispatch yet / box-default) as null", () => {
    expect(decodeProjectionState({ ...raw, route: null }).route).toBeNull();
    // Tolerant: a row predating the column (undefined at runtime) reads as null, never throws.
    expect(decodeProjectionState({ ...raw, route: undefined as unknown as null }).route).toBeNull();
    expect(decodeProjectionState({ ...raw, route: "not json" }).route).toBeNull();
  });

  it("decodeProjectionState falls back to the initial state for a missing row", () => {
    expect(decodeProjectionState(null)).toEqual(initialIssueState());
    expect(decodeProjectionState(undefined)).toEqual(initialIssueState());
  });

  it("mapProjectionRow decodes the public row shape (ended as boolean)", () => {
    const row = mapProjectionRow({ ...raw, ended: 1 });
    expect(row).toEqual({
      streamId: "owner/repo#101",
      repo: "owner/repo",
      issueNumber: 101,
      status: "running",
      runId: "r1",
      prNumber: 42,
      fixAttempts: { 0: 0, 1: 2, 2: 0 },
      anomaly: null,
      ended: true,
      route: { provider: "claude", model: "opus", account: "c1" },
      streamPosition: 3,
      updatedAt: "2026-06-20T00:00:00.000Z",
    });
  });
});

describe("route codec", () => {
  it("round-trips a route (model present and absent)", () => {
    expect(parseRoute(serializeRoute({ provider: "claude", model: "opus", account: "c1" }))).toEqual({
      provider: "claude",
      model: "opus",
      account: "c1",
    });
    // A default-model route omits `model` rather than guessing one.
    expect(parseRoute(serializeRoute({ provider: "zai", account: "z3" }))).toEqual({ provider: "zai", account: "z3" });
  });

  it("serialises null/undefined to a null column and parses it back to null", () => {
    expect(serializeRoute(null)).toBeNull();
    expect(serializeRoute(undefined)).toBeNull();
    expect(parseRoute(null)).toBeNull();
  });

  it("is a tolerant reader: corrupt or shape-invalid JSON → null (rebuildable from the log)", () => {
    expect(parseRoute("not json")).toBeNull();
    expect(parseRoute('{"model":"opus"}')).toBeNull(); // missing provider/account
    expect(parseRoute('{"provider":"claude","account":1}')).toBeNull(); // account not a string
  });

  it("rejects an unknown provider — the canonical enum-strict rule shared with the timeline read", () => {
    // The reconciled strictness (ADR-0037 P3.1): an out-of-enum provider degrades to null rather
    // than surviving a blind cast and poisoning the response at the serialize boundary.
    expect(parseRoute('{"provider":"gpt5","account":"x"}')).toBeNull();
  });
});

describe("ISSUE_PROJECTION_DDL", () => {
  it("creates the named table idempotently", () => {
    expect(ISSUE_PROJECTION_DDL).toContain(`CREATE TABLE IF NOT EXISTS ${ISSUE_PROJECTION_TABLE}`);
  });
});
