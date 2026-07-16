import { type UsageWindow } from "@contract";
import { relativeTo } from "@/lib/time";

/**
 * The per-window utilization bars + reset ETAs for one account/login, shared by the
 * Health and Accounts panels (issue #11) so the usage-bar presentation lives in one
 * leaf and can never drift between them. The null convention renders no bars — an empty
 * `windows` means the login has never streamed a plan signal. A window draws `danger`
 * once its utilization reaches `threshold` (the gate's admit-below cutoff) and `running`
 * below it; `now` is the render clock the reset ETA counts down against (ADR-0031).
 */
export function UsageWindows({ windows, threshold, now }: { windows: UsageWindow[]; threshold: number; now: number }) {
  if (windows.length === 0) {
    return <p className="mt-2 text-xs text-muted-foreground">No plan signal yet — utilization unknown.</p>;
  }
  return (
    <div className="mt-2 space-y-1">
      {windows.map((w) => {
        const pct = w.utilization;
        const over = pct !== null && pct >= threshold;
        return (
          <div key={w.type} className="flex items-center gap-3 text-xs">
            <span className="w-20 shrink-0 font-mono text-muted-foreground">{w.type}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className={over ? "h-full bg-status-danger" : "h-full bg-status-running"}
                style={{ width: `${Math.min(100, Math.max(0, pct ?? 0))}%` }}
              />
            </div>
            <span className="w-10 shrink-0 text-right tabular-nums">{pct === null ? "—" : `${pct}%`}</span>
            <span className="w-24 shrink-0 text-right text-muted-foreground" title={w.resetsAt ?? undefined}>
              {w.resetsAt ? `resets ${relativeTo(w.resetsAt, now)}` : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}
