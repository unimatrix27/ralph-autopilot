import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { fetchInbox } from "@/lib/api";
import { PageHeader } from "@/components/page";
import { Card, CardContent } from "@/components/ui/card";
import { InboxCardView } from "@/components/inbox-card";

/**
 * Phone focus mode (issue #112): one open question at a time — the oldest — with large action
 * buttons, for Tailscale triage from the couch. Answering it removes it from the queue and the
 * next-oldest takes its place on the next refetch.
 */
export function InboxFocusPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["inbox", null],
    queryFn: () => fetchInbox(),
    refetchInterval: 30_000,
    retry: false,
  });

  const cards = data?.cards ?? [];
  const reconcileIntervalSeconds = data?.reconcileIntervalSeconds ?? 30;
  const catalog = data?.powerActions ?? {};
  const oldest = cards[0];

  return (
    <>
      <PageHeader
        title="Inbox · focus"
        subtitle="One question at a time. Answer the oldest escalation — the next takes its place."
      />

      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {isLoading ? "Loading…" : isError ? "Couldn't reach the control plane." : `${cards.length} open · showing the oldest`}
        </p>
        <Link to="/inbox" className="text-sm font-medium text-primary hover:underline">
          All questions →
        </Link>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {!isLoading && !isError && !oldest && (
        <Card>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            No open questions. You're clear.
          </CardContent>
        </Card>
      )}

      {oldest && (
        <InboxCardView
          key={`${oldest.repo}#${oldest.issue}`}
          card={oldest}
          reconcileIntervalSeconds={reconcileIntervalSeconds}
          catalog={catalog}
          focus
        />
      )}
    </>
  );
}
