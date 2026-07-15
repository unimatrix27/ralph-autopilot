import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  POWER_ACTION_MODES,
  type PowerActionAffordanceWire,
  type PowerActionCatalogWire,
  type PowerActionKindWire,
  type PowerActionRequestBody,
  type PowerActionResponse,
  type PowerActionSurfaceWire,
} from "@contract";
import { postPowerAction } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ChevronDownIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";

/**
 * The Tier-1 power actions (issue #114, ADR-0032): on-protocol GitHub label effects an operator
 * fires from the UI to steer the backlog — re-admit / close / set `mode:*` / set priority / pause /
 * unpause. Each posts through `/api/backlog/action`; the reconciler acts on the GitHub write next tick
 * (eventually-consistent — the UI never fakes immediacy). The destructive `close` is gated behind a
 * two-step confirm (the server also requires `confirm: true`, so a stale/double client cannot fire
 * it). On success the relevant read queries are invalidated so the next refetch reflects the new
 * state — the "reflects the new state after the next tick" affordance.
 *
 * A row carries only its `surface` tag; the backend-derived affordance for that (repo, surface)
 * pair is resolved once from the response's `catalog` (the static descriptor is emitted once, not
 * per row — issue #114). Only the resolved actions render, and priority changes are limited to the
 * repo's configured labels.
 */
const OP_LABEL: Record<PowerActionKindWire, string> = {
  readmit: "Re-admit",
  pause: "Pause",
  unpause: "Unpause",
  "set-mode": "Set mode",
  "set-priority": "Set priority",
  close: "Close",
};

/** No controls — the fallback when a (repo, surface) pair is absent from the catalog (never in practice). */
const NO_AFFORDANCE: PowerActionAffordanceWire = { actions: [], priorityLabels: [] };

/** Resolve a row's affordance from the response catalog by its repo + surface tag. */
export function resolvePowerActions(
  catalog: PowerActionCatalogWire,
  repo: string,
  surface: PowerActionSurfaceWire,
): PowerActionAffordanceWire {
  return catalog[repo]?.[surface] ?? NO_AFFORDANCE;
}

export function PowerActions({
  repo,
  issue,
  reconcileIntervalSeconds,
  catalog,
  surface,
  size = "sm",
}: {
  repo: string;
  issue: number;
  reconcileIntervalSeconds: number;
  catalog: PowerActionCatalogWire;
  surface: PowerActionSurfaceWire;
  size?: "sm" | "default";
}) {
  const affordance = resolvePowerActions(catalog, repo, surface);
  const queryClient = useQueryClient();
  const [posted, setPosted] = React.useState<PowerActionResponse | null>(null);
  const [confirmClose, setConfirmClose] = React.useState(false);
  const [priority, setPriority] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const priorityLabels = affordance.priorityLabels;
  const priorityKey = priorityLabels.join("\0");

  React.useEffect(() => {
    setPriority((current) => (priorityLabels.includes(current) ? current : (priorityLabels[0] ?? "")));
  }, [priorityKey]);

  const mutation = useMutation({
    mutationFn: postPowerAction,
    onSuccess: (resp) => {
      setPosted(resp);
      setError(null);
      setConfirmClose(false);
      setPriority(priorityLabels[0] ?? "");
      // The daemon acts next tick; invalidate so the next refetch reflects the new labels
      // (the backlog re-sorts, a paused row leaves, an answered escalation clears, …).
      queryClient.invalidateQueries({ queryKey: ["backlog"] });
      queryClient.invalidateQueries({ queryKey: ["overview"] });
      queryClient.invalidateQueries({ queryKey: ["inbox"] });
    },
    onError: () => setError("The action could not be posted — retry."),
  });

  const fire = (body: PowerActionRequestBody): void => {
    setPosted(null);
    mutation.mutate(body);
  };
  const pending = mutation.isPending;
  const show = (op: PowerActionKindWire): boolean => affordance.actions.includes(op);

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">
        Steers the backlog via GitHub — the daemon acts next tick (~{reconcileIntervalSeconds}s).
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {show("readmit") && (
          <Button size={size} onClick={() => fire({ repo, issue, kind: "readmit" })} disabled={pending}>
            Re-admit
          </Button>
        )}
        {show("pause") && (
          <Button size={size} variant="outline" onClick={() => fire({ repo, issue, kind: "pause" })} disabled={pending}>
            Pause
          </Button>
        )}
        {show("unpause") && (
          <Button size={size} variant="outline" onClick={() => fire({ repo, issue, kind: "unpause" })} disabled={pending}>
            Unpause
          </Button>
        )}
        {show("set-mode") &&
          POWER_ACTION_MODES.map((mode) => (
            <Button
              key={mode}
              size={size}
              variant="outline"
              onClick={() => fire({ repo, issue, kind: "set-mode", mode })}
              disabled={pending}
            >
              mode:{mode}
            </Button>
          ))}
        {show("set-priority") && priorityLabels.length > 0 && (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (priority.length === 0 || pending) return;
              fire({ repo, issue, kind: "set-priority", priority });
            }}
          >
            <span className="relative">
              <select
                aria-label="Priority label"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                disabled={pending}
                className="h-9 w-40 appearance-none rounded-md border bg-background py-1 pl-2 pr-7 text-sm outline-none focus:ring-2 focus:ring-ring"
              >
                {priorityLabels.map((label) => (
                  <option key={label} value={label}>
                    {label}
                  </option>
                ))}
              </select>
              <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 opacity-60" />
            </span>
            <Button type="submit" size={size} variant="outline" disabled={pending || priority.length === 0}>
              Set
            </Button>
          </form>
        )}
        {show("close") &&
          (confirmClose ? (
            <span className="flex items-center gap-1.5">
              <Button
                size={size}
                variant="destructive"
                onClick={() => fire({ repo, issue, kind: "close", confirm: true })}
                disabled={pending}
              >
                Confirm close
              </Button>
              <Button size={size} variant="ghost" onClick={() => setConfirmClose(false)} disabled={pending}>
                Cancel
              </Button>
            </span>
          ) : (
            <Button size={size} variant="ghost" onClick={() => setConfirmClose(true)} disabled={pending}>
              Close
            </Button>
          ))}
      </div>

      {posted && (
        <p className="text-xs text-status-success">
          {OP_LABEL[posted.action]} posted — the daemon acts next tick (~{posted.appliesNextTickSeconds}s).
        </p>
      )}
      {error && <p className={cn("text-xs text-status-danger")}>{error}</p>}
    </div>
  );
}
