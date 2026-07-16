import { describe, expect, it } from "vitest";
import {
  buildRunView,
  searchRunView,
  parseAnsiLines,
  computeLineDiff,
  highlightCode,
  languageForPath,
  extractResultText,
  type BashRenderBlock,
  type DiffRenderBlock,
  type EscalationRenderBlock,
  type MessageItem,
  type RunViewItem,
  type ToolRenderBlock,
} from "./run-view";
import { runDetailResponseSchema, type RunDetailResponse, type TranscriptEntry, type TimelineEntry } from "./run-detail";

// ── builders ────────────────────────────────────────────────────────────────────

function msg(globalPosition: number, role: "assistant" | "user" | "result", blocks: unknown[]): TranscriptEntry {
  return {
    type: "TranscriptMessage",
    globalPosition,
    streamPosition: globalPosition,
    data: { runId: "5", at: "2026-06-22T00:00:00.000Z", role, sdkType: role, blocks: blocks as never },
  };
}

function domain(globalPosition: number, type: string, data: Record<string, unknown>): TimelineEntry {
  return { globalPosition, streamPosition: globalPosition, type, data };
}

function detail(over: Partial<RunDetailResponse> = {}): RunDetailResponse {
  const base: RunDetailResponse = {
    generatedAt: "2026-06-22T01:00:00.000Z",
    run: {
      repo: "owner/repo",
      issue: 111,
      title: "Sample run title",
      runId: "5",
      status: "merged",
      mode: "tdd",
      branch: "ralph/111-x",
      prNumber: 42,
      startedAt: "2026-06-22T00:00:00.000Z",
      updatedAt: "2026-06-22T00:30:00.000Z",
      spanStartGlobalPosition: 1,
      fixAttempts: { "1": 1 },
    },
    timeline: [],
    transcript: [],
    pruned: null,
  };
  return { ...base, ...over };
}

// ── header ───────────────────────────────────────────────────────────────────────

describe("buildRunView — header", () => {
  it("summarises status, PR, branch, mode, duration, and fix attempts", () => {
    const view = buildRunView(
      detail({
        timeline: [
          domain(1, "RunStarted", { runId: "5", mode: "tdd" }),
          domain(6, "PrOpened", { runId: "5", prNumber: 42 }),
          domain(7, "ReviewPhaseEntered", { runId: "5", phase: 1 }),
          domain(8, "FixAttempted", { runId: "5", phase: 1 }),
          domain(20, "Merged", { runId: "5", prNumber: 42 }),
        ],
      }),
    );
    expect(view.header.statusLabel).toBe("Merged");
    expect(view.header.statusTone).toBe("success");
    expect(view.header.prNumber).toBe(42);
    expect(view.header.branch).toBe("ralph/111-x");
    expect(view.header.mode).toBe("tdd");
    expect(view.header.durationMs).toBe(30 * 60 * 1000);
    expect(view.header.totalFixAttempts).toBe(1);
    expect(view.header.fixAttempts).toEqual([{ phase: 1, count: 1 }]);
    expect(view.header.phaseSummary).toContain("impl ✓");
    expect(view.header.phaseSummary).toContain("merged");
  });

  it("yields a null duration when timestamps are unparseable", () => {
    const view = buildRunView(detail({ run: { ...detail().run, startedAt: "nope", updatedAt: "nope" } }));
    expect(view.header.durationMs).toBeNull();
  });

  it("leaves duration null for a live run so the header ticks it live (the row's updated_at is stale)", () => {
    // A live run's lifecycle status is event-sourced, never written to the row, so updated_at
    // would freeze the duration; durationMs must be null and the live header counts from start.
    expect(buildRunView(detail({ run: { ...detail().run, status: "running" } })).header.durationMs).toBeNull();
    expect(buildRunView(detail({ run: { ...detail().run, status: "awaiting-merge" } })).header.durationMs).toBeNull();
    // A terminal run still reports its settled wall-clock from the row interval.
    expect(buildRunView(detail({ run: { ...detail().run, status: "merged" } })).header.durationMs).toBe(30 * 60 * 1000);
  });
});

// ── conversation: tool collapse + expansion ───────────────────────────────────────

describe("buildRunView — conversation", () => {
  it("renders messages with tool calls collapsed to a one-line summary, raw input retained for expansion", () => {
    const view = buildRunView(
      detail({
        transcript: [
          msg(2, "assistant", [
            { kind: "text", text: "Let me look." },
            { kind: "tool_use", id: "t1", name: "Read", input: { file_path: "src/index.ts" } },
          ]),
          msg(3, "user", [{ kind: "tool_result", toolUseId: "t1", content: "file contents", isError: false }]),
        ],
      }),
    );
    // The user(tool_result)-only message is folded away, leaving one assistant message.
    const messages = view.items.filter((i): i is MessageItem => i.kind === "message");
    expect(messages).toHaveLength(1);
    const tool = messages[0]!.blocks.find((b): b is ToolRenderBlock => b.kind === "tool")!;
    expect(tool.toolName).toBe("Read");
    expect(tool.summary).toBe("src/index.ts"); // collapsed one-liner
    expect(tool.input).toEqual({ file_path: "src/index.ts" }); // raw input kept for expansion
    expect(tool.status).toBe("ok");
    expect(tool.result?.text).toBe("file contents");
  });

  it("marks a tool call pending when no result has come back yet (live tail)", () => {
    const view = buildRunView(
      detail({ transcript: [msg(2, "assistant", [{ kind: "tool_use", id: "t9", name: "Grep", input: { pattern: "foo" } }])] }),
    );
    const tool = (view.items[0] as MessageItem).blocks[0] as ToolRenderBlock;
    expect(tool.status).toBe("pending");
    expect(tool.result).toBeNull();
  });

  it("renders a file edit as an add/del/context line diff with a language", () => {
    const view = buildRunView(
      detail({
        transcript: [
          msg(2, "assistant", [
            {
              kind: "tool_use",
              id: "e1",
              name: "Edit",
              input: { file_path: "src/a.ts", old_string: "const a = 1;\nconst b = 2;", new_string: "const a = 1;\nconst b = 3;" },
            },
          ]),
          msg(3, "user", [{ kind: "tool_result", toolUseId: "e1", content: "ok", isError: false }]),
        ],
      }),
    );
    const diff = (view.items[0] as MessageItem).blocks.find((b): b is DiffRenderBlock => b.kind === "diff")!;
    expect(diff.filePath).toBe("src/a.ts");
    expect(diff.language).toBe("typescript");
    expect(diff.additions).toBe(1);
    expect(diff.deletions).toBe(1);
    expect(diff.rows.map((r) => r.kind)).toEqual(["context", "del", "add"]);
    expect(diff.rows.find((r) => r.kind === "add")!.text).toBe("const b = 3;");
  });

  it("renders a Write as an all-add diff (new file)", () => {
    const view = buildRunView(
      detail({
        transcript: [
          msg(2, "assistant", [
            { kind: "tool_use", id: "w1", name: "Write", input: { file_path: "x.json", content: "{\n  \"a\": 1\n}" } },
          ]),
        ],
      }),
    );
    const diff = (view.items[0] as MessageItem).blocks.find((b): b is DiffRenderBlock => b.kind === "diff")!;
    expect(diff.language).toBe("json");
    expect(diff.deletions).toBe(0);
    expect(diff.additions).toBe(3);
    expect(diff.rows.every((r) => r.kind === "add")).toBe(true);
  });

  it("renders Bash with ANSI-coloured output, a parsed exit code, and a pass/fail status", () => {
    const failing = buildRunView(
      detail({
        transcript: [
          msg(2, "assistant", [{ kind: "tool_use", id: "b1", name: "Bash", input: { command: "npm test", description: "run tests" } }]),
          msg(3, "user", [
            {
              kind: "tool_result",
              toolUseId: "b1",
              content: "\x1b[31mFAIL\x1b[0m suite\nExit code: 1",
              isError: true,
            },
          ]),
        ],
      }),
    );
    const bash = (failing.items[0] as MessageItem).blocks.find((b): b is BashRenderBlock => b.kind === "bash")!;
    expect(bash.command).toBe("npm test");
    expect(bash.description).toBe("run tests");
    expect(bash.status).toBe("error");
    expect(bash.exitCode).toBe(1);
    // First line has a red "FAIL" span.
    expect(bash.output[0]!.some((s) => s.text === "FAIL" && s.fg === "red")).toBe(true);
  });

  it("lifts escalate and stuck tool calls to inline cards", () => {
    const view = buildRunView(
      detail({
        transcript: [
          msg(2, "assistant", [
            {
              kind: "tool_use",
              id: "x1",
              name: "mcp__ralph__escalate",
              input: { headline: "Pick storage backend", stakes: "Affects durability", recommendation: "Use SQLite" },
            },
          ]),
          msg(4, "assistant", [
            { kind: "tool_use", id: "x2", name: "mcp__ralph__stuck", input: { category: "no-green-build", reason: "tests will not pass" } },
          ]),
        ],
      }),
    );
    const cards = view.items
      .filter((i): i is MessageItem => i.kind === "message")
      .flatMap((m) => m.blocks)
      .filter((b): b is EscalationRenderBlock => b.kind === "escalation");
    expect(cards.map((c) => c.variant)).toEqual(["escalate", "stuck"]);
    expect(cards[0]!.headline).toBe("Pick storage backend");
    expect(cards[0]!.detail).toBe("Affects durability");
    expect(cards[1]!.headline).toContain("tests will not pass");
    expect(cards[1]!.detail).toContain("no-green-build");
  });

  it("drops a message that renders nothing (a bare tool_result turn)", () => {
    const view = buildRunView(
      detail({ transcript: [msg(3, "user", [{ kind: "tool_result", toolUseId: "none", content: "x", isError: false }])] }),
    );
    expect(view.items.filter((i) => i.kind === "message")).toHaveLength(0);
  });
});

// ── phase dividers + timeline spine ───────────────────────────────────────────────

describe("buildRunView — timeline + phase dividers", () => {
  it("interleaves phase dividers with messages and carries per-phase outcomes", () => {
    const view = buildRunView(
      detail({
        timeline: [
          domain(1, "RunStarted", { runId: "5", mode: "tdd" }),
          domain(6, "PrOpened", { runId: "5", prNumber: 42 }),
          domain(7, "ReviewPhaseEntered", { runId: "5", phase: 1 }),
          domain(9, "FixAttempted", { runId: "5", phase: 1 }),
          domain(11, "ReviewPhasePassed", { runId: "5", phase: 1 }),
        ],
        transcript: [msg(8, "assistant", [{ kind: "text", text: "fixing" }])],
      }),
    );
    const phases = view.items.filter((i) => i.kind === "phase");
    const impl = phases.find((p) => p.kind === "phase" && p.label === "Implementation")!;
    const review = phases.find((p) => p.kind === "phase" && p.label === "Review · phase 1")!;
    expect(impl.kind === "phase" && impl.outcome).toBe("PR #42");
    // review phase: one fix attempt, then passed → "✓ passed"
    expect(review.kind === "phase" && review.outcome).toBe("✓ passed");
    expect(review.kind === "phase" && review.tone).toBe("success");
    // Items are globally ordered: impl(1) < message(8)? no — review divider is gp 7 < message gp 8.
    const positions = view.items.map((i) => i.globalPosition);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("shows a maxed phase outcome", () => {
    const view = buildRunView(
      detail({
        timeline: [
          domain(7, "ReviewPhaseEntered", { runId: "5", phase: 1 }),
          domain(8, "FixAttempted", { runId: "5", phase: 1 }),
          domain(9, "FixAttempted", { runId: "5", phase: 1 }),
          domain(10, "FixAttempted", { runId: "5", phase: 1 }),
          domain(11, "ReviewMaxed", { runId: "5", phase: 1 }),
        ],
      }),
    );
    const review = view.items.find((i) => i.kind === "phase")!;
    expect(review.kind === "phase" && review.outcome).toBe("review-maxed (3/3)");
    expect(review.kind === "phase" && review.tone).toBe("danger");
  });

  it("makes the timeline spine clickable: each node targets the item at/after its position", () => {
    const view = buildRunView(
      detail({
        timeline: [domain(1, "RunStarted", { runId: "5", mode: "tdd" }), domain(5, "FixAttempted", { runId: "5", phase: 1 })],
        transcript: [msg(6, "assistant", [{ kind: "text", text: "after the fix" }])],
      }),
    );
    const runStarted = view.timeline.find((n) => n.type === "RunStarted")!;
    // RunStarted produced a phase divider at gp 1 → targets it.
    expect(runStarted.targetId).toBe("phase-1");
    const fix = view.timeline.find((n) => n.type === "FixAttempted")!;
    // No divider for the fix; the next item is the message at gp 6.
    expect(fix.targetId).toBe("gp-6");
  });

  it("keeps the timeline even when there is no transcript (targets degrade gracefully)", () => {
    const view = buildRunView(detail({ timeline: [domain(1, "RunStarted", { runId: "5", mode: "tdd" })], transcript: [] }));
    expect(view.timeline).toHaveLength(1);
    // The only item is the impl divider.
    expect(view.timeline[0]!.targetId).toBe("phase-1");
  });

  it("shows each phase's single route as its own timeline node — no in-phase rotation (ADR-0037 P3.2, #165)", () => {
    // A container holds one route for its whole life, so a route changes only BETWEEN phases /
    // across a resume's re-dispatch — rendered as distinct per-phase rows, not an A→B transition.
    const view = buildRunView(
      detail({
        timeline: [
          { ...domain(1, "RunStarted", { runId: "5", mode: "tdd" }) },
          // The recorded per-phase route rides on the typed `route` field (toRunDetailResponse).
          { ...domain(2, "RouteResolved", { runId: "5", phase: "impl" }), route: { provider: "claude", model: "opus", account: "A" } },
          { ...domain(7, "ReviewPhaseEntered", { runId: "5", phase: 1 }) },
          // A resumed fix re-dispatched onto a different account — its own later node, not a transition.
          { ...domain(9, "RouteResolved", { runId: "5", phase: "fix-1" }), route: { provider: "zai", model: null, account: "z3" } },
        ],
      }),
    );
    const routes = view.timeline.filter((n) => n.type === "RouteResolved");
    expect(routes.map((n) => n.route)).toEqual([
      { provider: "claude", model: "opus", account: "A" },
      { provider: "zai", model: null, account: "z3" },
    ]);
    // The node renders the formatted route line; a null model degrades to provider · account.
    expect(routes.map((n) => n.detail)).toEqual(["claude · opus · A", "zai · z3"]);
  });

  it("renders a route-less RouteResolved node without a typed route (box-default dispatch)", () => {
    const view = buildRunView(
      detail({ timeline: [{ ...domain(2, "RouteResolved", { runId: "5", phase: "impl" }) }] }),
    );
    const node = view.timeline.find((n) => n.type === "RouteResolved")!;
    expect(node.route).toBeUndefined();
    expect(node.detail).toBeNull();
  });
});

// ── pruned marker ─────────────────────────────────────────────────────────────────

describe("buildRunView — pruned marker", () => {
  it("surfaces the pruned marker from a TranscriptPruned entry while the timeline still renders", () => {
    const pruned: TranscriptEntry = {
      type: "TranscriptPruned",
      globalPosition: 99,
      streamPosition: 1,
      data: { runId: "5", at: "2026-05-01T00:00:00.000Z", prunedMessageCount: 120, reason: "age" },
    };
    const view = buildRunView(
      detail({ timeline: [domain(1, "RunStarted", { runId: "5", mode: "tdd" }), domain(2, "Merged", { runId: "5", prNumber: 42 })], transcript: [pruned] }),
    );
    expect(view.pruned).toEqual({ at: "2026-05-01T00:00:00.000Z", prunedMessageCount: 120, reason: "age" });
    expect(view.items.filter((i) => i.kind === "message")).toHaveLength(0);
    expect(view.timeline.map((n) => n.type)).toEqual(["RunStarted", "Merged"]);
  });

  it("also honours the response-level pruned field", () => {
    const view = buildRunView(detail({ pruned: { runId: "5", at: "2026-05-01T00:00:00.000Z", prunedMessageCount: 7, reason: "size" } }));
    expect(view.pruned?.reason).toBe("size");
  });
});

// ── in-transcript search ────────────────────────────────────────────────────────

describe("searchRunView", () => {
  it("finds and orders matches across messages (command, file, error)", () => {
    const view = buildRunView(
      detail({
        transcript: [
          msg(2, "assistant", [{ kind: "tool_use", id: "b1", name: "Bash", input: { command: "npm run build" } }]),
          msg(3, "user", [{ kind: "tool_result", toolUseId: "b1", content: "error TS2322: Type mismatch", isError: true }]),
          msg(4, "assistant", [{ kind: "tool_use", id: "e1", name: "Edit", input: { file_path: "src/widget.ts", old_string: "a", new_string: "b" } }]),
        ],
      }),
    );
    expect(searchRunView(view, "npm run build").map((m) => m.itemId)).toEqual(["gp-2"]);
    expect(searchRunView(view, "TS2322").map((m) => m.itemId)).toEqual(["gp-2"]); // bash result folded into its call
    expect(searchRunView(view, "widget.ts").map((m) => m.itemId)).toEqual(["gp-4"]);
    expect(searchRunView(view, "")).toEqual([]);
    expect(searchRunView(view, "nonexistent")).toEqual([]);
  });
});

// ── pure helpers ──────────────────────────────────────────────────────────────────

describe("pure helpers", () => {
  it("parseAnsiLines splits lines and applies SGR colours/styles, tolerant of junk", () => {
    const lines = parseAnsiLines("plain\n\x1b[1;32mbold green\x1b[0m tail");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual([{ text: "plain", fg: null, bg: null, bold: false, dim: false, italic: false, underline: false }]);
    const green = lines[1]!.find((s) => s.text === "bold green")!;
    expect(green.fg).toBe("green");
    expect(green.bold).toBe(true);
    // unmatched escape does not throw
    expect(() => parseAnsiLines("\x1b[")).not.toThrow();
  });

  it("computeLineDiff handles pure additions, deletions, and edits", () => {
    expect(computeLineDiff("", "a\nb").map((r) => r.kind)).toEqual(["add", "add"]);
    expect(computeLineDiff("a\nb", "").map((r) => r.kind)).toEqual(["del", "del"]);
    const rows = computeLineDiff("a\nb\nc", "a\nB\nc");
    expect(rows.map((r) => r.kind)).toEqual(["context", "del", "add", "context"]);
    expect(rows[0]).toEqual({ kind: "context", text: "a", oldLine: 1, newLine: 1 });
  });

  it("highlightCode tags keywords, strings, numbers, and function calls", () => {
    const tokens = highlightCode('const x = render("hi", 42);', "typescript");
    const kinds = new Set(tokens.filter((t) => t.text.trim()).map((t) => t.kind));
    expect(kinds.has("keyword")).toBe(true); // const
    expect(kinds.has("string")).toBe(true); // "hi"
    expect(kinds.has("number")).toBe(true); // 42
    expect(kinds.has("function")).toBe(true); // render(
    // round-trips the source text exactly
    expect(tokens.map((t) => t.text).join("")).toBe('const x = render("hi", 42);');
  });

  it("languageForPath maps extensions", () => {
    expect(languageForPath("a/b/c.tsx")).toBe("typescript");
    expect(languageForPath("Makefile")).toBe("text");
  });

  it("extractResultText flattens strings, block arrays, and objects", () => {
    expect(extractResultText("hi")).toBe("hi");
    expect(extractResultText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(extractResultText({ text: "z" })).toBe("z");
    expect(extractResultText(null)).toBe("");
  });
});

// ── contract round-trip ───────────────────────────────────────────────────────────

describe("run-detail contract", () => {
  it("round-trips a full response through the wire schema (parse → serialize → parse)", () => {
    const d = detail({
      timeline: [domain(1, "RunStarted", { runId: "5", mode: "tdd" }), domain(2, "Merged", { runId: "5", prNumber: 42 })],
      transcript: [
        msg(3, "assistant", [
          { kind: "text", text: "hello" },
          { kind: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        ]),
        msg(4, "user", [{ kind: "tool_result", toolUseId: "t1", content: "out", isError: false }]),
      ],
    });
    const parsed = runDetailResponseSchema.parse(d);
    expect(runDetailResponseSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    // and the transform consumes the parsed value without throwing
    expect(() => buildRunView(parsed)).not.toThrow();
  });
});
