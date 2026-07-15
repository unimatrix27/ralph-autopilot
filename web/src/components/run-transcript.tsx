import * as React from "react";
import { Link } from "@tanstack/react-router";
import {
  highlightCode,
  isLiveRunStatus,
  type AnsiSpan,
  type BashRenderBlock,
  type CodeTokenKind,
  type DiffRenderBlock,
  type EscalationRenderBlock,
  type MessageItem,
  type PhaseDividerItem,
  type RenderBlock,
  type RenderTone,
  type RunHeaderView,
  type RunViewItem,
  type TimelineNode,
  type ToolRenderBlock,
  type ToolStatus,
} from "@contract";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { RouteChip } from "@/components/route-chip";
import { formatDuration } from "@/lib/time";

// ── tone + status mapping ────────────────────────────────────────────────────────

type BadgeVariant = "outline" | "success" | "danger" | "running" | "waiting" | "attention";

function toneVariant(tone: RenderTone): BadgeVariant {
  return tone === "neutral" ? "outline" : tone;
}

const STATUS_DOT: Record<ToolStatus, string> = {
  ok: "bg-status-success",
  error: "bg-status-danger",
  pending: "bg-status-waiting animate-pulse",
};

// ── syntax-highlight token + ANSI colour palettes ─────────────────────────────────

const TOKEN_CLASS: Record<CodeTokenKind, string> = {
  keyword: "text-fuchsia-400",
  string: "text-emerald-400",
  comment: "italic text-muted-foreground",
  number: "text-amber-400",
  function: "text-sky-400",
  punctuation: "text-foreground/60",
  plain: "",
};

const ANSI_COLOR: Record<string, string> = {
  black: "#5c6370",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#dcdfe4",
  brightBlack: "#7f848e",
  brightRed: "#ff7b86",
  brightGreen: "#b5e890",
  brightYellow: "#ffd587",
  brightBlue: "#7cc7ff",
  brightMagenta: "#e29bf0",
  brightCyan: "#6fd6e2",
  brightWhite: "#ffffff",
};

/** Render one highlighted code line as coloured token spans. */
function CodeLine({ text, language }: { text: string; language: string }) {
  if (text.length === 0) {
    return <span> </span>;
  }
  return (
    <>
      {highlightCode(text, language).map((token, i) => (
        <span key={i} className={TOKEN_CLASS[token.kind]}>
          {token.text}
        </span>
      ))}
    </>
  );
}

/** Render an ANSI span with its colour/weight. */
function ansiStyle(span: AnsiSpan): React.CSSProperties {
  const style: React.CSSProperties = {};
  if (span.fg && ANSI_COLOR[span.fg]) style.color = ANSI_COLOR[span.fg];
  if (span.bg && ANSI_COLOR[span.bg]) style.backgroundColor = ANSI_COLOR[span.bg];
  if (span.bold) style.fontWeight = 600;
  if (span.dim) style.opacity = 0.6;
  if (span.italic) style.fontStyle = "italic";
  if (span.underline) style.textDecoration = "underline";
  return style;
}

// ── block renderers ───────────────────────────────────────────────────────────────

function DiffView({ block }: { block: DiffRenderBlock }) {
  const ROW_BG: Record<string, string> = {
    add: "bg-status-success/10",
    del: "bg-status-danger/10",
    context: "",
    meta: "bg-muted/40 text-muted-foreground",
  };
  const GUTTER: Record<string, string> = { add: "+", del: "-", context: " ", meta: "" };
  return (
    <div className="overflow-hidden rounded-md border">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-1.5">
        <span className="truncate font-mono text-xs text-foreground">{block.filePath || block.toolName}</span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          <span className="text-status-success">+{block.additions}</span>{" "}
          <span className="text-status-danger">−{block.deletions}</span>
        </span>
      </div>
      <pre className="overflow-x-auto py-1 text-xs leading-relaxed">
        <code className="block font-mono">
          {block.rows.map((row, i) => (
            <div key={i} className={cn("flex", ROW_BG[row.kind])}>
              <span className="w-4 shrink-0 select-none px-1 text-center text-muted-foreground">{GUTTER[row.kind]}</span>
              <span className="whitespace-pre">
                {row.kind === "meta" ? row.text : <CodeLine text={row.text} language={block.language} />}
              </span>
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}

function BashView({ block }: { block: BashRenderBlock }) {
  const [open, setOpen] = React.useState(true);
  const hasOutput = block.output.some((line) => line.length > 0);
  return (
    <div className="overflow-hidden rounded-md border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 bg-muted/40 px-3 py-1.5 text-left hover:bg-muted/60"
      >
        <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", STATUS_DOT[block.status])} aria-hidden />
        <span className="text-muted-foreground">$</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{block.command}</span>
        {block.exitCode !== null && (
          <Badge variant={block.status === "error" ? "danger" : "success"} className="shrink-0">
            exit {block.exitCode}
          </Badge>
        )}
        {block.exitCode === null && block.status !== "pending" && (
          <Badge variant={block.status === "error" ? "danger" : "success"} className="shrink-0">
            {block.status === "error" ? "failed" : "ok"}
          </Badge>
        )}
      </button>
      {block.description && <div className="border-t px-3 py-1 text-[11px] text-muted-foreground">{block.description}</div>}
      {open && hasOutput && (
        <pre className="max-h-96 overflow-auto bg-background/60 px-3 py-2 text-xs leading-relaxed">
          <code className="block font-mono">
            {block.output.map((line, i) => (
              <div key={i}>
                {line.length === 0 ? (
                  " "
                ) : (
                  line.map((span, j) => (
                    <span key={j} style={ansiStyle(span)}>
                      {span.text}
                    </span>
                  ))
                )}
              </div>
            ))}
          </code>
        </pre>
      )}
    </div>
  );
}

function ToolView({ block }: { block: ToolRenderBlock }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/40"
      >
        <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", STATUS_DOT[block.status])} aria-hidden />
        <span className="shrink-0 font-mono text-xs font-medium text-foreground">{block.toolName}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{block.summary}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t px-3 py-2">
          <div>
            <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">input</div>
            <pre className="max-h-72 overflow-auto rounded bg-muted/40 p-2 text-xs">
              <code className="font-mono">{JSON.stringify(block.input, null, 2)}</code>
            </pre>
          </div>
          {block.result && (
            <div>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                result {block.result.status === "error" ? "· error" : ""}
              </div>
              <pre className="max-h-72 overflow-auto rounded bg-muted/40 p-2 text-xs">
                <code className="font-mono">{block.result.text}</code>
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EscalationView({ block }: { block: EscalationRenderBlock }) {
  const isStuck = block.variant === "stuck";
  return (
    <Card className={cn("border-l-4", isStuck ? "border-l-status-danger" : "border-l-status-attention")}>
      <CardContent className="space-y-1.5 py-3">
        <div className="flex items-center gap-2">
          <Badge variant={isStuck ? "danger" : "attention"}>{isStuck ? "stuck" : "escalate"}</Badge>
          <span className="text-sm font-medium text-foreground">{block.headline}</span>
        </div>
        {block.detail && <p className="text-sm text-muted-foreground">{block.detail}</p>}
        <Link to="/inbox" className="inline-block text-xs font-medium text-primary hover:underline">
          Open in Inbox →
        </Link>
      </CardContent>
    </Card>
  );
}

function ConversationBlock({ block }: { block: RenderBlock }) {
  switch (block.kind) {
    case "text":
      return <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">{block.text}</p>;
    case "thinking":
      return (
        <p className="whitespace-pre-wrap break-words border-l-2 border-muted pl-3 text-sm italic leading-relaxed text-muted-foreground">
          {block.text}
        </p>
      );
    case "tool":
      return <ToolView block={block} />;
    case "diff":
      return <DiffView block={block} />;
    case "bash":
      return <BashView block={block} />;
    case "escalation":
      return <EscalationView block={block} />;
    default:
      return null;
  }
}

const ROLE_META: Record<string, { label: string; className: string }> = {
  assistant: { label: "Agent", className: "text-sky-400" },
  user: { label: "Tool", className: "text-muted-foreground" },
  result: { label: "Result", className: "text-emerald-400" },
  system: { label: "System", className: "text-muted-foreground" },
};

function MessageView({ item, active }: { item: MessageItem; active: boolean }) {
  const role = ROLE_META[item.role] ?? ROLE_META.assistant!;
  return (
    <div
      id={item.id}
      className={cn(
        "scroll-mt-24 rounded-lg border bg-card/40 p-3 transition-shadow",
        active && "ring-2 ring-primary",
      )}
    >
      <div className={cn("mb-2 text-[11px] font-semibold uppercase tracking-wide", role.className)}>{role.label}</div>
      <div className="space-y-2">
        {item.blocks.map((block, i) => (
          <ConversationBlock key={i} block={block} />
        ))}
      </div>
    </div>
  );
}

function PhaseDividerView({ item }: { item: PhaseDividerItem }) {
  return (
    <div id={item.id} className="scroll-mt-24 flex items-center gap-3 py-2">
      <div className="h-px flex-1 bg-border" />
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-foreground">{item.label}</span>
        {item.outcome && <Badge variant={toneVariant(item.tone)}>{item.outcome}</Badge>}
      </div>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

/** Render one conversation item (a message or a phase divider). */
export function ConversationItemView({ item, active }: { item: RunViewItem; active: boolean }) {
  return item.kind === "message" ? <MessageView item={item} active={active} /> : <PhaseDividerView item={item} />;
}

// ── timeline spine ────────────────────────────────────────────────────────────────

const TONE_DOT: Record<RenderTone, string> = {
  neutral: "bg-muted-foreground",
  success: "bg-status-success",
  danger: "bg-status-danger",
  running: "bg-status-running",
  waiting: "bg-status-waiting",
  attention: "bg-status-attention",
};

/** The clickable timeline spine; clicking a node jumps the transcript to its anchor. */
export function TimelineSpine({ nodes, onJump }: { nodes: TimelineNode[]; onJump: (targetId: string) => void }) {
  if (nodes.length === 0) {
    return <p className="text-xs text-muted-foreground">No timeline events yet.</p>;
  }
  return (
    <ol className="relative space-y-1 border-l border-border pl-4">
      {nodes.map((node) => (
        <li key={node.id} className="relative">
          <span
            className={cn("absolute -left-[21px] top-1.5 h-2 w-2 rounded-full ring-2 ring-background", TONE_DOT[node.tone])}
            aria-hidden
          />
          <button
            type="button"
            disabled={!node.targetId}
            onClick={() => node.targetId && onJump(node.targetId)}
            className="block w-full rounded px-2 py-1 text-left text-xs hover:bg-muted/50 disabled:cursor-default disabled:opacity-70"
          >
            <span className="font-medium text-foreground">{node.label}</span>
            {/* A RouteResolved node renders this phase's single route as a chip (#165); every
                other node falls back to its plain detail string. */}
            {node.route ? (
              <RouteChip route={node.route} className="ml-1" />
            ) : (
              node.detail && <span className="ml-1 text-muted-foreground">· {node.detail}</span>
            )}
          </button>
        </li>
      ))}
    </ol>
  );
}

// ── run header ────────────────────────────────────────────────────────────────────

/** The run header card: status, PR, branch, mode, duration, phase summary, fix attempts. */
export function RunHeaderCard({ header, nowMs }: { header: RunHeaderView; nowMs: number }) {
  // A live run (running / awaiting-merge / any non-terminal status) ticks elapsed time from
  // its start against the render clock — the settled `durationMs` is null until it terminalizes
  // (the row's `updated_at` does not track event-sourced status, so it would freeze at "0s").
  const duration = isLiveRunStatus(header.status)
    ? formatDuration(nowMs - Date.parse(header.startedAt))
    : header.durationMs !== null
      ? formatDuration(header.durationMs)
      : "—";
  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={toneVariant(header.statusTone)}>{header.statusLabel}</Badge>
          <Badge variant="outline">{header.mode}</Badge>
          <span className="font-mono text-sm text-muted-foreground">
            {header.repo}
            <span className="text-foreground"> #{header.issue}</span>
          </span>
          {header.prNumber !== null && (
            <Badge variant="outline" className="font-mono">
              PR #{header.prNumber}
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted-foreground">
          {header.branch && (
            <span>
              branch <span className="font-mono text-foreground">{header.branch}</span>
            </span>
          )}
          <span>
            duration <span className="tabular-nums text-foreground">{duration}</span>
          </span>
          {header.totalFixAttempts > 0 && (
            <span>
              fix attempts{" "}
              <span className="text-foreground">
                {header.fixAttempts.map((f) => `p${f.phase}:${f.count}`).join(" ")}
              </span>
            </span>
          )}
        </div>
        {header.phaseSummary && <div className="font-mono text-xs text-muted-foreground">{header.phaseSummary}</div>}
      </CardContent>
    </Card>
  );
}
