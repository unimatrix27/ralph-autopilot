import { useQuery } from "@tanstack/react-query";
import { fetchRouting } from "@/lib/api";
import { PageHeader } from "@/components/page";
import { RoutingEditor } from "@/components/routing-editor";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

/**
 * The global routing editor (ADR-0037 P4.2, issue #167): per-type `(provider, model)` preference
 * lists, the account pool, and provider choices rendered disabled-with-reason where they are
 * capability-incompatible. Daemon-wide (global) in v1 — per-repo editing is #170. Reads the
 * effective routing and posts edits through the #166 write API; an edit applies on the next dispatch.
 */
export function RoutingPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["routing"],
    queryFn: () => fetchRouting(),
    refetchInterval: 30_000,
    retry: false,
  });

  return (
    <>
      <PageHeader
        title="Routing"
        subtitle="Per-type provider·model preference, the account pool, and the capability gate — edits apply on the next dispatch."
      />

      {isError && (
        <Card className="border-status-danger/40">
          <CardContent className="flex items-center gap-3 py-4 text-sm">
            <Badge variant="danger">unreachable</Badge>
            <span className="text-muted-foreground">The control plane did not answer. Is the daemon running?</span>
          </CardContent>
        </Card>
      )}

      {isLoading && !data && <p className="text-sm text-muted-foreground">Loading…</p>}

      {data && <RoutingEditor data={data} />}
    </>
  );
}
