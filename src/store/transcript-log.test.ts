import { describe, expect, it } from "vitest";
import { openStore, MEMORY_DB } from "./store";
import { ISSUE_PROJECTION_TABLE } from "./events/projection";
import type { TranscriptMessage } from "./events/transcript";

const REPO = "owner/repo";
const FIXED_NOW = "2026-06-20T12:00:00.000Z";

function freshStore() {
  return openStore(MEMORY_DB, { now: () => FIXED_NOW });
}

function message(at: string, text: string): TranscriptMessage {
  return {
    type: "TranscriptMessage",
    data: { runId: "1", at, role: "assistant", sdkType: "assistant", blocks: [{ kind: "text", text }] },
  };
}

describe("EventLog — transcript streams are isolated from the domain log (ADR-0030)", () => {
  it("lands transcript events on the per-run stream and never on the issue/domain stream", async () => {
    const store = freshStore();
    try {
      // A real domain run on the issue stream.
      await store.events.appendToIssue(REPO, 110, [{ type: "RunStarted", data: { runId: "1", mode: "tdd" } }]);
      const domainVersionBefore = (await store.events.aggregateIssue(REPO, 110)).version;

      // Capture transcript events on the per-run stream.
      await store.events.appendToTranscript(REPO, 110, "1", [
        message(FIXED_NOW, "hello"),
        message(FIXED_NOW, "world"),
      ]);

      // The transcript landed on its own stream…
      const transcript = store.events.readTranscript(REPO, 110, "1");
      expect(transcript.map((e) => e.type)).toEqual(["TranscriptMessage", "TranscriptMessage"]);

      // …and the issue/domain stream is UNTOUCHED: same version, projection unchanged.
      const domainAfter = await store.events.aggregateIssue(REPO, 110);
      expect(domainAfter.version).toBe(domainVersionBefore);
      expect(store.events.readIssueProjection(REPO, 110)).toMatchObject({ status: "running", streamPosition: 1 });

      // The domain expected-version guard is unaffected — it still sees version 1, so a
      // guarded append at the pre-transcript version succeeds (transcript never bumped it).
      await expect(
        store.events.appendToIssue(REPO, 110, [{ type: "PrOpened", data: { runId: "1", prNumber: 7 } }], 1n),
      ).resolves.toBeDefined();
    } finally {
      store.close();
    }
  });

  it("never materialises a transcript stream into es_issue_projection", async () => {
    const store = freshStore();
    try {
      await store.events.appendToTranscript(REPO, 200, "1", [message(FIXED_NOW, "only a transcript")]);
      // No issue-stream events were appended, so there is no projection row for #200…
      expect(store.events.readIssueProjection(REPO, 200)).toBeNull();
      // …and nothing in es_issue_projection references a `transcript:` stream id.
      const rows = store.db
        .prepare(`SELECT stream_id FROM ${ISSUE_PROJECTION_TABLE} WHERE stream_id LIKE 'transcript:%'`)
        .all();
      expect(rows).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("EventLog — two-tier retention (ADR-0030)", () => {
  it("prunes transcripts past the age budget oldest-first, leaving a marker; the timeline survives", async () => {
    const store = freshStore();
    try {
      // A domain run whose timeline must survive the prune.
      await store.events.appendToIssue(REPO, 110, [
        { type: "RunStarted", data: { runId: "1", mode: "tdd" } },
        { type: "Merged", data: { runId: "1", prNumber: 7 } },
      ]);

      // An old run's transcript (captured in April) and a fresh one (captured today).
      await store.events.appendToTranscript(REPO, 110, "old", [
        message("2026-04-01T00:00:00.000Z", "ancient line 1"),
        message("2026-04-01T00:05:00.000Z", "ancient line 2"),
      ]);
      await store.events.appendToTranscript(REPO, 110, "fresh", [message("2026-06-20T00:00:00.000Z", "recent line")]);

      const result = await store.events.pruneTranscripts({ maxAgeDays: 30 }, new Date("2026-06-21T00:00:00.000Z"));

      // Only the old stream was pruned.
      expect(result.pruned).toEqual([
        { streamId: "transcript:owner/repo#110:old", reason: "age" },
      ]);

      // The old transcript is reduced to a single "transcript pruned" marker…
      const oldAfter = store.events.readTranscript(REPO, 110, "old");
      expect(oldAfter).toHaveLength(1);
      expect(oldAfter[0]!.type).toBe("TranscriptPruned");
      expect(oldAfter[0]!.data).toMatchObject({ runId: "old", prunedMessageCount: 2, reason: "age" });

      // …the fresh transcript is intact…
      expect(store.events.readTranscript(REPO, 110, "fresh").map((e) => e.type)).toEqual(["TranscriptMessage"]);

      // …and the run's DOMAIN timeline survives untouched.
      const domain = await store.events.aggregateIssue(REPO, 110);
      expect(domain.version).toBe(2n);
      expect(store.events.readIssueProjection(REPO, 110)).toMatchObject({ status: "merged" });

      // A second prune pass is a no-op: the pruned stream has no verbose messages left.
      const again = await store.events.pruneTranscripts({ maxAgeDays: 30 }, new Date("2026-06-21T00:00:00.000Z"));
      expect(again.pruned).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("evicts the oldest transcript first to honour a total size cap", async () => {
    const store = freshStore();
    try {
      const big = "x".repeat(2000);
      await store.events.appendToTranscript(REPO, 1, "a", [message("2026-06-01T00:00:00.000Z", big)]);
      await store.events.appendToTranscript(REPO, 2, "b", [message("2026-06-10T00:00:00.000Z", big)]);
      await store.events.appendToTranscript(REPO, 3, "c", [message("2026-06-20T00:00:00.000Z", big)]);

      // Cap well below the 3-stream total but above two streams: evict only the oldest.
      const result = await store.events.pruneTranscripts(
        { maxAgeDays: 3650, maxTotalBytes: 5000 },
        new Date("2026-06-21T00:00:00.000Z"),
      );
      expect(result.pruned).toEqual([{ streamId: "transcript:owner/repo#1:a", reason: "size" }]);
      expect(store.events.readTranscript(REPO, 1, "a")[0]!.type).toBe("TranscriptPruned");
      expect(store.events.readTranscript(REPO, 2, "b")[0]!.type).toBe("TranscriptMessage");
      expect(store.events.readTranscript(REPO, 3, "c")[0]!.type).toBe("TranscriptMessage");
    } finally {
      store.close();
    }
  });

  it("scopes a prune to one repo, leaving other repos' transcripts alone", async () => {
    const store = freshStore();
    try {
      await store.events.appendToTranscript("owner/a", 1, "1", [message("2026-01-01T00:00:00.000Z", "old a")]);
      await store.events.appendToTranscript("owner/b", 1, "1", [message("2026-01-01T00:00:00.000Z", "old b")]);

      await store.events.pruneTranscripts({ maxAgeDays: 30 }, new Date("2026-06-21T00:00:00.000Z"), "owner/a");

      expect(store.events.readTranscript("owner/a", 1, "1")[0]!.type).toBe("TranscriptPruned");
      expect(store.events.readTranscript("owner/b", 1, "1")[0]!.type).toBe("TranscriptMessage");
    } finally {
      store.close();
    }
  });
});
