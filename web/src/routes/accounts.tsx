import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { buildAccountToggleEdit, type PoolAccount } from "@contract";
import { fetchAccounts, postRoutingEdit } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { relativeTo, useNow } from "@/lib/time";
import { PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The account panel (issue #11): every resolved pool account with its identity (claude OAuth
 * email/name/org, omitted on graceful absence), operator-park state (#10), and live plan usage —
 * the one place to read *which* account each pool id is and act on it (enable/disable). Reads
 * `/api/accounts`; the toggle posts through the #10 account edit and invalidates the account +
 * usage reads so the new state lands on the next poll. No secret material is ever shown.
 */
export function AccountsPage() {
  const now = useNow(1000);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["accounts"],
    queryFn: fetchAccounts,
    refetchInterval: 5_000,
    retry: false,
  });

  return (
    <>
      <PageHeader
        title="Accounts"
        subtitle="Who each pool login is, its plan usage, and its park state — the one place to read and act on the account pool."
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

      {data && <AccountsPanel accounts={data.accounts} threshold={data.admitBelowPercent} generatedAt={data.generatedAt} now={now} />}
    </>
  );
}

function AccountsPanel({
  accounts,
  threshold,
  generatedAt,
  now,
}: {
  accounts: PoolAccount[];
  threshold: number;
  generatedAt: string;
  now: number;
}) {
  const queryClient = useQueryClient();
  const [toggleError, setToggleError] = React.useState<string | null>(null);
  const toggle = useMutation({
    mutationFn: postRoutingEdit,
    onSuccess: () => {
      setToggleError(null);
      // The new park state lands on the next accounts read (and the usage / routing snapshots).
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      queryClient.invalidateQueries({ queryKey: ["health-usage"] });
      queryClient.invalidateQueries({ queryKey: ["routing"] });
    },
    onError: (err) => setToggleError(err instanceof Error ? err.message : "The toggle could not be posted — retry."),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Account pool</CardTitle>
        <CardDescription>
          Every resolved pool account, with its identity and live plan usage. New work is held above{" "}
          <span className="font-medium">{threshold}%</span>; a disabled account is operator-parked — never dispatched, and
          never counted toward the pause. Identity is read on the box and never leaves it; no credential is ever shown.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No accounts in the pool — the box-default login is in use.</p>
        ) : (
          <ul className="space-y-3">
            {accounts.map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                threshold={threshold}
                now={now}
                pending={toggle.isPending}
                onToggle={() => {
                  setToggleError(null);
                  toggle.mutate(buildAccountToggleEdit(account.id, !account.enabled));
                }}
              />
            ))}
          </ul>
        )}
        {toggleError && <p className="mt-3 text-xs text-status-danger">{toggleError}</p>}
        <p className="mt-3 text-[11px] text-muted-foreground" title={generatedAt}>
          as of {relativeTo(generatedAt, now)}
        </p>
      </CardContent>
    </Card>
  );
}

function AccountRow({
  account,
  threshold,
  now,
  pending,
  onToggle,
}: {
  account: PoolAccount;
  threshold: number;
  now: number;
  pending: boolean;
  onToggle: () => void;
}) {
  const { usage } = account;
  return (
    <li className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm">{account.id}</span>
            <Badge variant="outline">{account.provider}</Badge>
            {usage.active && account.enabled && <Badge variant="running">active</Badge>}
            {!account.enabled ? (
              <Badge variant="outline">disabled</Badge>
            ) : usage.gated ? (
              <Badge variant="danger">gated</Badge>
            ) : (
              <Badge variant="success">headroom</Badge>
            )}
          </div>
          <AccountIdentity account={account} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {usage.cooldownUntil && (
            <span className="text-xs text-muted-foreground" title={usage.cooldownUntil}>
              cooldown {relativeTo(usage.cooldownUntil, now)}
            </span>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={`${account.enabled ? "Disable" : "Enable"} account ${account.id}`}
            disabled={pending}
            onClick={onToggle}
          >
            {account.enabled ? "Disable" : "Enable"}
          </Button>
        </div>
      </div>
      <UsageWindows account={account} threshold={threshold} now={now} />
    </li>
  );
}

/**
 * The account's identity, when known. For a claude login: email / display name / organization,
 * each rendered only when present (an absent profile or field is omitted, never guessed — issue
 * #11). For a zai key account: the auth-token env-var NAME (never its value). openai key accounts
 * carry neither, so this renders nothing.
 */
function AccountIdentity({ account }: { account: PoolAccount }) {
  const { identity } = account;
  const hasIdentity =
    identity && (identity.emailAddress || identity.displayName || identity.organizationName);
  if (!hasIdentity && !account.authTokenEnvName) {
    return <p className="mt-0.5 text-xs text-muted-foreground">No identity beyond the credential.</p>;
  }
  return (
    <div className="mt-0.5 space-y-0.5 text-xs text-muted-foreground">
      {identity?.emailAddress && <div className="truncate">{identity.emailAddress}</div>}
      {(identity?.displayName || identity?.organizationName) && (
        <div className="truncate">
          {identity.displayName}
          {identity.displayName && identity.organizationName ? " · " : ""}
          {identity.organizationName}
        </div>
      )}
      {account.authTokenEnvName && (
        <div>
          auth token env <span className="font-mono">{account.authTokenEnvName}</span>
        </div>
      )}
    </div>
  );
}

/** The per-window utilization bars + reset ETAs — the null convention (no bars) when never used. */
function UsageWindows({ account, threshold, now }: { account: PoolAccount; threshold: number; now: number }) {
  const { windows } = account.usage;
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
