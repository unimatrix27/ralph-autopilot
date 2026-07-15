/**
 * The web-push control card (issue #119): lets the operator turn native phone/desktop
 * notifications on or off from the Health page. Escalations / anomalies / stalls then arrive as
 * real notifications even when the tab is closed (the service worker owns delivery).
 *
 * State comes from `readPushState` (browser Push API + the daemon's VAPID config). The card
 * degrades gracefully through every state: unsupported, daemon-unconfigured, permission-denied,
 * not-subscribed, and subscribed.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { readPushState, subscribeToPush, unsubscribeFromPush } from "@/lib/push";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function PushCard() {
  const queryClient = useQueryClient();
  const stateKey = ["push-state"];
  const { data } = useQuery({
    queryKey: stateKey,
    queryFn: readPushState,
    refetchInterval: 15_000,
    retry: false,
  });

  const subscribe = useMutation({
    mutationFn: subscribeToPush,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: stateKey }),
  });

  const unsubscribe = useMutation({
    mutationFn: unsubscribeFromPush,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: stateKey }),
  });

  /** Re-prompt for permission after the operator flips it back on in browser site settings. */
  const retryPermission = useMutation({
    mutationFn: () => Notification.requestPermission(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: stateKey }),
  });

  const supported = data?.supported ?? false;
  const enabled = data?.enabled ?? false;
  const subscribed = data?.subscribed ?? false;
  const permission = data?.permission ?? "default";
  const activeMutation = subscribed ? unsubscribe : subscribe;
  const busy = subscribe.isPending || unsubscribe.isPending || retryPermission.isPending;
  const error =
    subscribe.error ?? unsubscribe.error ?? retryPermission.error;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Push notifications
          {!supported && <Badge variant="secondary">unsupported</Badge>}
          {supported && !enabled && <Badge variant="secondary">not configured</Badge>}
          {supported && enabled && subscribed && <Badge variant="success">on</Badge>}
          {supported && enabled && !subscribed && <Badge variant="outline">off</Badge>}
        </CardTitle>
        <CardDescription>
          Get native phone &amp; desktop notifications for escalations, anomalies, and a stalled daemon —
          even with the tab closed. Installable as an app over TLS / Tailscale.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!supported && (
          <p className="text-sm text-muted-foreground">
            This browser does not support web push. Use a recent Chrome/Edge/Firefox/Safari over HTTPS or
            localhost (service workers need a secure context).
          </p>
        )}
        {supported && !enabled && (
          <p className="text-sm text-muted-foreground">
            Web push is not configured on the daemon. Set <code className="font-mono">notifications.webpush</code> in
            <code className="font-mono"> .ralph/config.yaml</code> and provide a VAPID private key.
          </p>
        )}
        {supported && enabled && permission === "denied" && (
          <>
            <p className="text-sm text-status-danger">
              Notification permission was blocked for this site. Re-enable it in your browser&apos;s site
              settings, then tap retry.
            </p>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => retryPermission.mutate()}>
              {busy ? "…" : "Retry permission"}
            </Button>
          </>
        )}
        {supported && enabled && permission !== "denied" && (
          <p className="text-sm text-muted-foreground">
            {subscribed
              ? "This device is subscribed. Unsubscribe to stop notifications here."
              : "Enable to subscribe this device — the daemon will page it on the next event."}
          </p>
        )}
        {error && <p className="text-sm text-status-danger">{error instanceof Error ? error.message : String(error)}</p>}
        {supported && enabled && permission !== "denied" && (
          <Button
            variant={subscribed ? "outline" : "default"}
            size="sm"
            disabled={busy}
            onClick={() => activeMutation.mutate()}
          >
            {busy ? "…" : subscribed ? "Turn off" : "Enable notifications"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
