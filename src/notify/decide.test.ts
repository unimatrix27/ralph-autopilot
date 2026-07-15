import { describe, expect, it } from "vitest";
import type { RecordedLogEvent } from "../store/log-broadcast";
import { decideNotifications } from "./decide";
import type { NotificationKind, NotificationSeverity } from "./types";

/** Build a recorded log event with the bits the transform reads. */
function event(
  streamId: string,
  type: string,
  data: Record<string, unknown>,
  globalPosition = 1,
): RecordedLogEvent {
  return { globalPosition, streamId, type, data };
}

const STREAM = "owner/repo#42";

describe("decideNotifications — which events notify", () => {
  it("maps an escalate-kind Escalated to an escalation notification", () => {
    const [n] = decideNotifications([
      event(STREAM, "Escalated", { runId: "1", kind: "escalate", headline: "Which db?", commentId: 9 }),
    ]);
    expect(n).toMatchObject({
      kind: "escalation",
      repo: "owner/repo",
      issueNumber: 42,
      message: "Which db?", // message carries the headline
    });
    expect(n!.severity).toBe("high");
  });

  it("maps a heal-card Escalated and a ReviewMaxed both to a heal notification", () => {
    const heal = decideNotifications([
      event(STREAM, "Escalated", { runId: "1", kind: "heal-card", headline: "Fix attempt maxed", commentId: null }),
    ]);
    expect(heal[0]).toMatchObject({ kind: "heal" });
    expect(heal[0]!.severity).toBe("high");

    const maxed = decideNotifications([
      event(STREAM, "ReviewMaxed", { runId: "1", phase: 1 }),
    ]);
    expect(maxed[0]).toMatchObject({ kind: "heal", repo: "owner/repo", issueNumber: 42 });
  });

  it("maps a RunStuck to a stuck notification", () => {
    const [n] = decideNotifications([
      event(STREAM, "RunStuck", { runId: "1", reason: "fix-iterations exhausted" }),
    ]);
    expect(n).toMatchObject({ kind: "stuck", repo: "owner/repo", issueNumber: 42 });
    expect(n!.severity).toBe("high");
    expect(n!.message).toContain("fix-iterations exhausted");
  });

  it("maps an AnomalyDetected to an anomaly notification at max severity", () => {
    const [n] = decideNotifications([
      event(STREAM, "AnomalyDetected", { reason: "island: open with no mode" }),
    ]);
    expect(n).toMatchObject({ kind: "anomaly", repo: "owner/repo", issueNumber: 42 });
    expect(n!.severity).toBe("max");
    expect(n!.message).toContain("island: open with no mode");
  });

  it("ignores events that should not notify (RunStarted, FixAttempted, Merged, …)", () => {
    const events: RecordedLogEvent[] = [
      event(STREAM, "RunStarted", { runId: "1", mode: "tdd" }),
      event(STREAM, "FixAttempted", { runId: "1", phase: 1 }),
      event(STREAM, "Merged", { runId: "1", prNumber: 7 }),
      event(STREAM, "AnomalyCleared", {}),
      event("transcript:owner/repo#42:run1", "TranscriptMessage", { blocks: [] }),
    ];
    expect(decideNotifications(events)).toHaveLength(0);
  });

  it("ignores a malformed issue stream id (no repo/issue recoverable)", () => {
    expect(
      decideNotifications([event("not-a-stream", "RunStuck", { runId: "1", reason: "x" })]),
    ).toHaveLength(0);
  });

  it("never throws on an unexpected payload shape (tolerant reader)", () => {
    expect(() => decideNotifications([event(STREAM, "Escalated", "not-an-object")])).not.toThrow();
    expect(() => decideNotifications([event(STREAM, "RunStuck", null as unknown as Record<string, unknown>)])).not.toThrow();
  });

  it("skips an Escalated it cannot classify (no recognised kind)", () => {
    // No kind → the sink cannot tell escalation from heal, so it does not guess.
    expect(decideNotifications([event(STREAM, "Escalated", { runId: "1" })])).toHaveLength(0);
  });

  it("still pages on RunStuck / AnomalyDetected even when the detail string is missing", () => {
    // The event TYPE is the signal (an agent stuck / the completeness invariant fired);
    // the reason is detail. Skipping a real anomaly would violate no-silent-loss.
    const stuck = decideNotifications([event(STREAM, "RunStuck", {})]);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.message.length).toBeGreaterThan(0); // falls back to the title
    const anomaly = decideNotifications([event(STREAM, "AnomalyDetected", {})]);
    expect(anomaly).toHaveLength(1);
    expect(anomaly[0]!.kind).toBe("anomaly");
  });

  it("treats an unknown event type as a no-op (tolerant reader)", () => {
    expect(decideNotifications([event(STREAM, "SomethingNew", { reason: "x" })])).toHaveLength(0);
  });

  it("handles a totally empty batch", () => {
    expect(decideNotifications([])).toEqual([]);
  });
});

describe("decideNotifications — dedup within a coalesced batch", () => {
  it("dedups two Escalated(escalate) for the same issue to one escalation", () => {
    // A coalesced batch (two publishes fanned into one delivery) can carry the same
    // attention event twice for one issue — e.g. a re-appended escalation. Notify once.
    const out = decideNotifications([
      event(STREAM, "Escalated", { runId: "1", kind: "escalate", headline: "first", commentId: 1 }),
      event(STREAM, "Escalated", { runId: "1", kind: "escalate", headline: "second", commentId: 2 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "escalation", issueNumber: 42 });
  });

  it("dedups a heal-card Escalated and a ReviewMaxed for the same issue to one heal", () => {
    const out = decideNotifications([
      event(STREAM, "Escalated", { runId: "1", kind: "heal-card", headline: "maxed", commentId: null }),
      event(STREAM, "ReviewMaxed", { runId: "1", phase: 1 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("heal");
  });

  it("skips an Escalated that is answered later in the same committed batch", () => {
    const out = decideNotifications([
      event(STREAM, "Escalated", { runId: "1", kind: "escalate", headline: "already answered", commentId: 99 }, 1),
      event(STREAM, "QuestionAnswered", { runId: "1", commentId: 99 }, 2),
    ]);
    expect(out).toHaveLength(0);
  });

  it("skips a ReviewMaxed restore compensation answered in the same committed batch", () => {
    const out = decideNotifications([
      event(STREAM, "ReviewMaxed", { runId: "1", phase: 1 }, 1),
      event(STREAM, "QuestionAnswered", { runId: "1", commentId: 99 }, 2),
    ]);
    expect(out).toHaveLength(0);
  });

  it("suppresses lower-severity same-issue facts when an anomaly is in the batch", () => {
    const out = decideNotifications([
      event(STREAM, "RunStuck", { runId: "1", reason: "claim failed" }, 1),
      event(STREAM, "AnomalyDetected", { reason: "claim-failed-after-2-attempts" }, 2),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("anomaly");
  });

  it("keeps distinct kinds for the same issue separate (escalation + stuck both notify)", () => {
    const out = decideNotifications([
      event(STREAM, "Escalated", { runId: "1", kind: "escalate", headline: "q", commentId: 1 }),
      event(STREAM, "RunStuck", { runId: "1", reason: "done" }),
    ]);
    const kinds = out.map((n) => n.kind).sort();
    expect(kinds).toEqual(["escalation", "stuck"]);
  });

  it("keeps the same kind for different issues separate", () => {
    const out = decideNotifications([
      event("owner/repo#1", "RunStuck", { runId: "1", reason: "a" }),
      event("owner/repo#2", "RunStuck", { runId: "2", reason: "b" }),
    ]);
    expect(out.map((n) => n.issueNumber).sort((a, b) => (a! - b!))).toEqual([1, 2]);
  });

  it("emits in first-seen order across the batch", () => {
    const out = decideNotifications([
      event("owner/repo#3", "RunStuck", { runId: "3", reason: "x" }),
      event("owner/repo#1", "Escalated", { runId: "1", kind: "escalate", headline: "y", commentId: 1 }),
      event("owner/repo#2", "AnomalyDetected", { reason: "z" }),
    ]);
    expect(out.map((n) => n.kind)).toEqual(["stuck", "escalation", "anomaly"]);
  });
});

describe("decideNotifications — severity + title shape", () => {
  const cases: Array<{ type: string; data: Record<string, unknown>; kind: NotificationKind; severity: NotificationSeverity }> = [
    { type: "Escalated", data: { runId: "1", kind: "escalate", headline: "h", commentId: 1 }, kind: "escalation", severity: "high" },
    { type: "Escalated", data: { runId: "1", kind: "heal-card", headline: "h", commentId: null }, kind: "heal", severity: "high" },
    { type: "ReviewMaxed", data: { runId: "1", phase: 1 }, kind: "heal", severity: "high" },
    { type: "RunStuck", data: { runId: "1", reason: "r" }, kind: "stuck", severity: "high" },
    { type: "AnomalyDetected", data: { reason: "r" }, kind: "anomaly", severity: "max" },
  ];
  for (const c of cases) {
    it(`${c.type} → kind=${c.kind} severity=${c.severity} with a non-empty title`, () => {
      const [n] = decideNotifications([event(STREAM, c.type, c.data)]);
      expect(n).not.toBeNull();
      expect(n!.kind).toBe(c.kind);
      expect(n!.severity).toBe(c.severity);
      expect(n!.title.length).toBeGreaterThan(0);
      expect(n!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  }
});
