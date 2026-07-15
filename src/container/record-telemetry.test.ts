/**
 * Mapping a runner's best-effort telemetry frames onto the daemon's per-run transcript store
 * (ADR-0038 / issue #185, AC4: "transcript + lifecycle stream to the daemon's store; the run
 * is visible in the web control plane"). The daemon stays the **sole writer** (ADR-0030): a
 * `transcript` frame's SDK message is mapped + redacted into a {@link TranscriptMessage}
 * exactly as the in-process sink does; a `lifecycle` frame lands as a visible system note. The
 * pipe is best-effort, so an unmappable message records nothing rather than throwing.
 */
import { describe, expect, it } from "vitest";
import { createTelemetrySink, recordTelemetry, type TranscriptRunRecorder } from "./record-telemetry";
import type { TranscriptEvent } from "../store/events/transcript";
import { ContainerExecution } from "./container-execution";
import { runContainerRunner, type SessionHost, type WorkspaceCloner } from "./runner";
import type { ContainerDispatch } from "./assignment";
import { FakeDocker } from "../testing/fake-transport";
import { MEMORY_DB, openStore } from "../store/store";

type Appended = { issueNumber: number; runId: string; events: TranscriptEvent[] };

/** A spy recorder capturing every transcript append the mapping makes. */
function spyRecorder(): TranscriptRunRecorder & { appended: Appended[] } {
  const appended: Appended[] = [];
  return {
    appended,
    appendToTranscript: async (issueNumber, runId, events) => void appended.push({ issueNumber, runId, events }),
  };
}

const run = { issueNumber: 185, runId: "run-7" };
const at = (): Date => new Date("2026-06-27T00:00:00.000Z");

describe("recordTelemetry — container telemetry → store (ADR-0038 / issue #185)", () => {
  it("appends a transcript frame's SDK message to the run's transcript stream", async () => {
    const rec = spyRecorder();
    const message = { type: "assistant", message: { content: [{ type: "text", text: "working" }] } };

    await recordTelemetry(rec, run, { kind: "telemetry", body: { type: "transcript", message } }, { now: at });

    expect(rec.appended).toHaveLength(1);
    const entry = rec.appended[0]!;
    expect(entry.issueNumber).toBe(185);
    expect(entry.runId).toBe("run-7");
    expect(entry.events[0]).toMatchObject({
      type: "TranscriptMessage",
      data: { role: "assistant", runId: "run-7", blocks: [{ kind: "text", text: "working" }] },
    });
  });

  it("records a lifecycle frame as a visible system transcript note", async () => {
    const rec = spyRecorder();

    await recordTelemetry(rec, run, { kind: "telemetry", body: { type: "lifecycle", name: "cloning" } }, { now: at });

    expect(rec.appended).toHaveLength(1);
    expect(rec.appended[0]!.events[0]).toMatchObject({
      type: "TranscriptMessage",
      data: { role: "system", sdkType: "lifecycle", blocks: [{ kind: "text", text: "cloning" }] },
    });
  });

  it("appends nothing for a non-conversational transcript message (the mapper skips it)", async () => {
    const rec = spyRecorder();

    await recordTelemetry(
      rec,
      run,
      { kind: "telemetry", body: { type: "transcript", message: { type: "stream_event" } } },
      { now: at },
    );

    expect(rec.appended).toEqual([]);
  });
});

describe("round-trip — runner → pipe → ContainerExecution → store (ADR-0038 / issue #185)", () => {
  it("a containerized run's lifecycle + transcript telemetry read back off its transcript stream", async () => {
    const store = openStore(MEMORY_DB);
    const scoped = store.forRepo("acme/widgets");
    const seeded = scoped.upsertRun({ issueNumber: 185, mode: "tdd" });
    const runId = String(seeded.id); // the transcript correlation tag (ADR-0022)

    const dispatch: ContainerDispatch = {
      assignment: { issueNumber: 185, mode: "tdd", branch: "ralph/185", base: "main", prompt: "go" },
      token: { value: "tok" },
    };
    const cloner: WorkspaceCloner = { clone: async () => ({ path: "/ws/185" }) };
    const session: SessionHost = {
      run: async (input) => {
        input.transcriptSink.capture({
          type: "assistant",
          message: { content: [{ type: "text", text: "in a container" }] },
        } as never);
        return { subtype: "success", isError: false, text: "ok", turns: 1 };
      },
    };
    const docker = new FakeDocker((runner) => void runContainerRunner({ cloner, session, transport: runner }, dispatch));

    // The daemon plugs a serialised telemetry sink into onTelemetry (concurrent appends to a
    // run's not-yet-created transcript stream would otherwise race on stream creation).
    const sink = createTelemetrySink(scoped, { issueNumber: 185, runId });
    await new ContainerExecution({ docker, onTelemetry: (frame) => sink.record(frame) }).dispatch(dispatch);
    await sink.flush();

    const transcript = scoped.readTranscript(185, runId);
    const roles = transcript.filter((e) => e.type === "TranscriptMessage").map((e) => (e.data as { role: string }).role);
    expect(roles).toContain("system"); // the `started` lifecycle note
    expect(roles).toContain("assistant"); // the relayed session message
  });
});
