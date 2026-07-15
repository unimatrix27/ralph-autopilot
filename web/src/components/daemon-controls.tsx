import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { drainDaemon, forceTickDaemon, killRun } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Tier-2 daemon controls (issue #118, ADR-0032): the operator drives the daemon lifecycle from
 * the Health page. Force-tick runs a reconcile round now (non-destructive); drain begins a
 * graceful drain — no new pickups, in-flight runs finish, then the daemon exits. Both are
 * same-origin POSTs the Origin guard fronts; drain is destructive so it confirms first and the
 * server requires `confirm: true`. A force-tick invalidates the live read queries so the Health
 * view reflects the freshly-forced tick (the snapshot's lastTickAt advances next tick).
 */
export function DaemonControls() {
  const queryClient = useQueryClient();
  const [drainOpen, setDrainOpen] = React.useState(false);
  const [forced, setForced] = React.useState(false);

  const forceTick = useMutation({
    mutationFn: forceTickDaemon,
    onMutate: () => setForced(false),
    onSuccess: () => {
      setForced(true);
      // The forced tick persists a fresh snapshot next round — refresh the live reads so the
      // Health view's lastTickAt / Overview reflect it without waiting on the poll cadence.
      queryClient.invalidateQueries({ queryKey: ["health-usage"] });
      queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });

  const drain = useMutation({
    mutationFn: drainDaemon,
    onSuccess: () => setDrainOpen(false),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Daemon controls</CardTitle>
        <CardDescription>Drive the daemon lifecycle. Writes are eventually-consistent via the reconciler.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" disabled={forceTick.isPending} onClick={() => forceTick.mutate()}>
            {forceTick.isPending ? "Forcing…" : "Force tick"}
          </Button>
          {forced && !forceTick.isPending && (
            <Badge variant="success">forced — the next reconcile round runs now</Badge>
          )}
          {forceTick.isError && (
            <span className="text-xs text-status-danger">The force-tick did not reach the daemon — retry.</span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="destructive" onClick={() => setDrainOpen(true)}>
            Drain &amp; stop
          </Button>
          <span className="text-xs text-muted-foreground">
            Stops new pickups; in-flight runs finish, then the daemon exits.
          </span>
        </div>

        {drain.isSuccess && (
          <div className="rounded-md border border-status-success/40 bg-status-success/10 px-3 py-2 text-sm">
            <span className="font-medium text-status-success">Draining.</span>{" "}
            <span className="text-muted-foreground">The daemon is finishing in-flight runs, then it will exit.</span>
          </div>
        )}
        {drain.isError && <p className="text-xs text-status-danger">The drain did not reach the daemon — retry.</p>}

        <Dialog open={drainOpen} onOpenChange={setDrainOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Drain &amp; stop the daemon?</DialogTitle>
              <DialogDescription>
                No new pickups or resumes start; in-flight runs finish (review + merge), then the daemon process exits.
                This control plane will become unreachable once it exits.
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setDrainOpen(false)} disabled={drain.isPending}>
                Cancel
              </Button>
              <Button variant="destructive" disabled={drain.isPending} onClick={() => drain.mutate()}>
                {drain.isPending ? "Draining…" : "Drain & stop"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

/**
 * Kill one in-flight run (issue #118): tears down its live session by run id. Destructive — a
 * confirm dialog gates the fire and the server requires `confirm: true`. Shown only for live
 * (non-terminal) runs. On success the run terminalizes to `agent-stuck` and its slot frees next
 * tick; `killed: false` means the run had already settled on its own.
 */
export function KillRunButton({ runId }: { runId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [result, setResult] = React.useState<{ killed: boolean } | null>(null);

  const mutation = useMutation({
    mutationFn: () => killRun(runId),
    onSuccess: (resp) => {
      setResult({ killed: resp.killed });
      setOpen(false);
      // The run terminalizes next tick — refresh the run + index reads so the header updates.
      queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
  });

  return (
    <>
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        Kill run
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Kill this run?</DialogTitle>
            <DialogDescription>
              Tears down the run&apos;s live agent session. It terminalizes to <code className="font-mono">agent-stuck</code>{" "}
              (re-admittable by re-labelling <code className="font-mono">ready-for-agent</code>) and its build slot frees
              next tick. Other in-flight runs are unaffected.
            </DialogDescription>
          </DialogHeader>
          {mutation.isError && <p className="text-xs text-status-danger">The kill did not reach the daemon — retry.</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
              {mutation.isPending ? "Killing…" : "Kill run"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {result && (
        <span className={"text-xs " + (result.killed ? "text-status-danger" : "text-muted-foreground")}>
          {result.killed ? "Killed — the run terminalizes next tick." : "Already settled — no live session to kill."}
        </span>
      )}
    </>
  );
}
