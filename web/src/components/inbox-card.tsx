import * as React from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  buildRunView,
  inboxPhaseLabel,
  inboxResumeTargetText,
  type AnswerRequestBody,
  type AnswerResponse,
  type InboxCard,
  type PowerActionCatalogWire,
} from "@contract";
import { cn } from "@/lib/utils";
import { fetchRunDetail, submitAnswer } from "@/lib/api";
import { formatWaited, useNow } from "@/lib/time";
import { statusFor, toneVariant } from "@/lib/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConversationItemView } from "@/components/run-transcript";
import { PowerActions } from "@/components/power-actions";

/**
 * The Inbox card (issue #112): one open escalation rendered as a structured card — stakes
 * emphasized, recommendation highlighted — with the inline pre-escalation transcript, deep links
 * to the run / WIP branch / PR, the consequence of answering stated plainly, and the three answer
 * affordances (accept-recommendation / pick an option / free text). `focus` widens it for the
 * one-question-at-a-time phone triage route.
 */
export function InboxCardView({
  card,
  reconcileIntervalSeconds,
  catalog,
  focus = false,
  onAnswered,
}: {
  card: InboxCard;
  reconcileIntervalSeconds: number;
  catalog: PowerActionCatalogWire;
  focus?: boolean;
  onAnswered?: () => void;
}) {
  const nowMs = useNow(30_000);
  const meta = statusFor(card.attentionLabel);
  const queryClient = useQueryClient();
  const [submitted, setSubmitted] = React.useState<AnswerResponse | null>(null);
  const phaseLabel = inboxPhaseLabel(card.phase);

  const mutation = useMutation({
    mutationFn: submitAnswer,
    onSuccess: (resp) => {
      setSubmitted(resp);
      // The answered question leaves the Inbox next refetch (the label swap re-arms the daemon),
      // and the Overview's attention badge updates with it.
      queryClient.invalidateQueries({ queryKey: ["inbox"] });
      queryClient.invalidateQueries({ queryKey: ["overview"] });
      onAnswered?.();
    },
  });

  const submit = (body: AnswerRequestBody): void => {
    mutation.mutate(body);
  };

  return (
    <Card className={cn("overflow-hidden", focus && "border-2")}>
      <CardContent className={cn("space-y-4", focus ? "p-5 sm:p-6" : "p-4")}>
        {/* Header: identity + attention state + age. */}
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                {card.repo} #{card.issue}
              </span>
              <Badge variant={toneVariant(meta.tone)}>{meta.label}</Badge>
              {phaseLabel && <Badge variant="outline">{phaseLabel}</Badge>}
              <span>open {formatWaited(card.createdAt, nowMs)}</span>
            </div>
            <h3 className={cn("mt-1 font-semibold leading-snug", focus ? "text-xl" : "text-base")}>{card.question.headline}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{card.question.feature}</p>
          </div>
        </div>

        {/* Stakes — emphasized (the architecture/user-level consequence of ruling wrong). */}
        <div className="rounded-md border border-status-danger/40 bg-status-danger/10 px-3 py-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-status-danger">Stakes</div>
          <p className="mt-0.5 text-sm font-medium text-foreground">{card.question.stakes}</p>
        </div>

        {/* Where we stand + decision. */}
        <div className="space-y-2 text-sm">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Where we stand</div>
            <p className="mt-0.5 whitespace-pre-wrap text-foreground">{card.question.whereWeStand}</p>
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Decision</div>
            <p className="mt-0.5 text-foreground">{card.question.decision}</p>
          </div>
        </div>

        {/* Recommendation — highlighted (the one-click default). */}
        <div className="rounded-md border border-primary/40 bg-primary/5 px-3 py-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-primary">Recommendation</div>
          <p className="mt-0.5 text-sm font-medium text-foreground">{card.question.recommendation}</p>
        </div>

        {/* Deep links: run (internal) + PR + WIP branch (GitHub). */}
        <DeepLinks card={card} />

        {/* The consequence — stated plainly, no faked immediacy (ADR-0032). */}
        <p className="text-xs text-muted-foreground">{consequenceText(card, reconcileIntervalSeconds)}</p>

        {/* The inline pre-escalation transcript (reusing the run-detail viewer). */}
        <EscalationTranscript repo={card.repo} issue={card.issue} defaultOpen={focus} />

        {/* The answer affordances, or the post-submit confirmation. */}
        {submitted ? (
          <div className="rounded-md border border-status-success/40 bg-status-success/10 px-3 py-2 text-sm">
            <span className="font-medium text-status-success">Answered.</span>{" "}
            <span className="text-muted-foreground">{consequenceText(card, reconcileIntervalSeconds)}</span>
          </div>
        ) : (
          <AnswerActions
            card={card}
            focus={focus}
            pending={mutation.isPending}
            error={mutation.isError ? "The answer could not be submitted — retry." : null}
            onSubmit={submit}
          />
        )}

        {/* Tier-1 power actions (issue #114): re-admit with no additional guidance, or close it. */}
        <div className="border-t pt-3">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Or re-admit / close
          </div>
          <PowerActions
            repo={card.repo}
            issue={card.issue}
            reconcileIntervalSeconds={reconcileIntervalSeconds}
            catalog={catalog}
            surface={card.powerActionSurface}
          />
        </div>
      </CardContent>
    </Card>
  );
}

/** The three answer affordances: accept-recommendation, pick an option, type free text. */
function AnswerActions({
  card,
  focus,
  pending,
  error,
  onSubmit,
}: {
  card: InboxCard;
  focus: boolean;
  pending: boolean;
  error: string | null;
  onSubmit: (body: AnswerRequestBody) => void;
}) {
  const [text, setText] = React.useState("");
  const options = card.question.options ?? [];
  const size = focus ? "lg" : "default";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          size={size}
          onClick={() => onSubmit({ repo: card.repo, issue: card.issue, kind: "accept-recommendation" })}
          disabled={pending}
        >
          Accept recommendation
        </Button>
        {options.map((opt, i) => (
          <Button
            key={i}
            size={size}
            variant="outline"
            onClick={() => onSubmit({ repo: card.repo, issue: card.issue, kind: "option", optionIndex: i })}
            disabled={pending}
          >
            {i + 1}. {opt}
          </Button>
        ))}
      </div>

      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-start"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim().length === 0 || pending) return;
          onSubmit({ repo: card.repo, issue: card.issue, kind: "free-text", text });
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Or type your own answer…"
          rows={focus ? 3 : 2}
          className={cn(
            "min-w-0 flex-1 resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring",
            focus && "text-base",
          )}
        />
        <Button type="submit" size={size} variant="secondary" disabled={pending || text.trim().length === 0}>
          Send answer
        </Button>
      </form>

      {error && <p className="text-xs text-status-danger">{error}</p>}
    </div>
  );
}

/** The inline pre-escalation transcript, reusing the run-detail viewer (issue #111). */
function EscalationTranscript({ repo, issue, defaultOpen }: { repo: string; issue: number; defaultOpen: boolean }) {
  const [open, setOpen] = React.useState(defaultOpen);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["run", repo, issue],
    queryFn: () => fetchRunDetail(repo, issue),
    enabled: open,
    retry: false,
    staleTime: 30_000,
  });
  const view = React.useMemo(() => (data ? buildRunView(data) : null), [data]);

  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:bg-accent"
      >
        <span>Transcript leading up to the escalation</span>
        <span>{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="max-h-80 overflow-auto border-t px-2 py-2">
          {isLoading && <p className="px-1 py-2 text-xs text-muted-foreground">Loading transcript…</p>}
          {!isLoading && (isError || !view || view.items.length === 0) && (
            <p className="px-1 py-2 text-xs text-muted-foreground">No captured conversation for this run.</p>
          )}
          {view &&
            view.items.map((item) => (
              <div key={item.id} className="py-0.5">
                <ConversationItemView item={item} active={false} />
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

/** Deep links to the run (internal) and the PR + WIP branch (GitHub). */
function DeepLinks({ card }: { card: InboxCard }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <Link
        to="/run"
        search={{ repo: card.repo, issue: card.issue }}
        className="font-medium text-primary hover:underline"
      >
        Open run ↗
      </Link>
      {card.run?.prNumber && (
        <a
          className="text-muted-foreground hover:underline"
          href={`https://github.com/${card.repo}/pull/${card.run.prNumber}`}
          target="_blank"
          rel="noreferrer"
        >
          PR #{card.run.prNumber} ↗
        </a>
      )}
      {card.run?.branch && (
        <a
          className="text-muted-foreground hover:underline"
          href={`https://github.com/${card.repo}/tree/${encodeURIComponent(card.run.branch)}`}
          target="_blank"
          rel="noreferrer"
        >
          WIP branch ↗
        </a>
      )}
      {!card.run && <span className="text-muted-foreground">no tracked run</span>}
    </div>
  );
}

/** The plain-language consequence of answering — what the daemon does, and when (ADR-0032). */
function consequenceText(card: InboxCard, seconds: number): string {
  if (card.consequence === "readmit-fresh") {
    return `Answering re-admits a fresh run with your guidance injected. The daemon picks it up next tick (~${seconds}s).`;
  }
  return `Answering ${inboxResumeTargetText(card.phase)} next tick (~${seconds}s).`;
}
