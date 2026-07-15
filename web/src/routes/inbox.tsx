import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { fetchInbox } from "@/lib/api";
import { ALL_REPOS, useRepoFilter } from "@/components/repo-filter";
import { PageHeader } from "@/components/page";
import { Card, CardContent } from "@/components/ui/card";
import { InboxCardView } from "@/components/inbox-card";

/**
 * The Inbox (issue #112): every open escalation across repos, oldest-first, as structured cards —
 * stakes emphasized, recommendation highlighted, one-click accept / option-pick / free-text. The
 * first write path: answering posts through `RalphAnswerService` and the daemon resumes next tick.
 */
export function InboxPage() {
  const { repo } = useRepoFilter();
  const filter = repo === ALL_REPOS ? undefined : repo;

  const { data, isLoading, isError } = useQuery({
    queryKey: ["inbox", filter ?? null],
    queryFn: () => fetchInbox(filter),
    refetchInterval: 30_000,
    retry: false,
  });

  const cards = data?.cards ?? [];
  const reconcileIntervalSeconds = data?.reconcileIntervalSeconds ?? 30;
  const catalog = data?.powerActions ?? {};

  return (
    <>
      <PageHeader
        title="Inbox"
        subtitle="Open escalations across all repos, oldest first. Answer to resume the agent next tick."
      />

      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {isLoading ? "Loading…" : isError ? "Couldn't reach the control plane." : `${cards.length} open`}
        </p>
        <Link to="/inbox/focus" className="text-sm font-medium text-primary hover:underline">
          Phone focus mode →
        </Link>
      </div>

      {!isLoading && !isError && cards.length === 0 && (
        <Card>
          <CardContent className="py-10 text-sm text-muted-foreground">
            No open questions. The queue is clear — every escalation is answered.
          </CardContent>
        </Card>
      )}

      <div className="space-y-4">
        {cards.map((card) => (
          <InboxCardView
            key={`${card.repo}#${card.issue}`}
            card={card}
            reconcileIntervalSeconds={reconcileIntervalSeconds}
            catalog={catalog}
          />
        ))}
      </div>
    </>
  );
}
