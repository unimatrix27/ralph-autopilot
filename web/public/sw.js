// ralph-autopilot control-plane service worker (issue #119).
//
// Two responsibilities, deliberately minimal:
//   1. An **offline app shell** — cache the SPA entry on install and serve it back when the
//      network is unavailable (navigations fall back to the cached shell; same-origin static
//      assets are cached on first fetch). The daemon is reached over Tailscale, which can
//      drop, so the shell must still paint.
//   2. **Web push** — surface a native notification on a `push` event and focus/open the app
//      on `notificationclick`. The push payload is the daemon's `{kind,title,message,repo,issue}`
//      (RFC 8291-encrypted end-to-end by the daemon; the browser decrypts before it reaches us).
//
// This file is served verbatim from the origin root (`/sw.js`) so its scope is the whole app.
// It is plain ES5 (no bundler, no imports) — it must stay self-contained.
var SHELL_CACHE = "ralph-shell-v2";
var SHELL_ENTRY = "/";
var CORE_SHELL_URLS = ["/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then(function (cache) {
        return precacheShell(cache);
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) {
          return k !== SHELL_CACHE;
        }).map(function (k) {
          return caches.delete(k);
        }));
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") {
    return;
  }
  var url = new URL(req.url);
  // Never intercept the API — it must always hit the live daemon (live data, writes).
  if (url.pathname.indexOf("/api/") === 0) {
    return;
  }
  // Navigations: network-first, fall back to the cached shell when offline (the SPA then
  // deep-links from its own router). This is the "loads an offline shell" acceptance bar.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then(function (res) {
          var copy = res.clone();
          caches.open(SHELL_CACHE).then(function (cache) {
            return cache.put("/", copy);
          }).catch(function (err) {
            return undefined;
          });
          return res;
        })
        .catch(function (err) {
          return caches.match("/").then(function (cached) {
            return cached || caches.match(req);
          });
        })
    );
    return;
  }
  // Same-origin static assets: cache-first (Vite's hashed assets are immutable), then network.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then(function (cached) {
        if (cached) {
          return cached;
        }
        return fetch(req)
          .then(function (res) {
            if (res.ok) {
              var copy = res.clone();
              caches.open(SHELL_CACHE).then(function (cache) {
                return cache.put(req, copy);
              }).catch(function (err) {
                return undefined;
              });
            }
            return res;
          })
          // Offline + cache miss: respond with a network-error Response (the right semantic for a
          // failed sub-resource) rather than `undefined`, which violates the SW fetch contract.
          .catch(function (err) {
            return Response.error();
          });
      })
    );
  }
});

self.addEventListener("push", function (event) {
  var payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (err) {
      payload = { title: "ralph-autopilot", message: event.data.text() };
    }
  }
  var title = payload.title || "ralph-autopilot";
  var body = payload.message || "New activity in the control plane.";
  var tag = payload.issue ? payload.repo + "#" + payload.issue : payload.kind || "ralph";
  var options = {
    body: body,
    tag: tag,
    renotify: true,
    data: {
      url: targetUrl(payload),
      kind: payload.kind,
      repo: payload.repo,
      issue: payload.issue
    },
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    // A max-severity event (a daemon anomaly or stall — see NotificationSeverity in
    // src/notify/types.ts) stays visible until dismissed; lower severities auto-dismiss.
    requireInteraction: payload.severity === "max"
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (all) {
      var i;
      var client;
      // Prefer an already-open app window: focus it. The control plane is single-operator, so one
      // window is the norm; focusing (rather than opening a duplicate) keeps the operator's place.
      for (i = 0; i < all.length; i += 1) {
        client = all[i];
        if ("focus" in client) {
          return client.focus();
        }
      }
      // No open window: open the app at the deep-link target. The SPA router reads the URL, so a
      // /run?repo=…&issue=… target lands on the exact run; /health on the daemon view; else /inbox.
      if (self.clients.openWindow) {
        return self.clients.openWindow(target);
      }
      return undefined;
    })
  );
});

/** Deep-link target for a push: the run viewer for a per-issue event, else the inbox. */
function targetUrl(payload) {
  if (payload.repo && payload.issue) {
    return "/run?repo=" + encodeURIComponent(payload.repo) + "&issue=" + encodeURIComponent(payload.issue);
  }
  if (payload.kind === "stall" || payload.kind === "anomaly") {
    return "/health";
  }
  return "/inbox";
}

function precacheShell(cache) {
  return fetch(SHELL_ENTRY, { cache: "reload" })
    .then(function (res) {
      if (!res.ok) {
        throw new Error("shell fetch failed: " + res.status);
      }
      var copy = res.clone();
      return cache.put(SHELL_ENTRY, copy).then(function () {
        return res.text();
      });
    })
    .then(
      function (html) {
        return cache.addAll(uniqueUrls(CORE_SHELL_URLS.concat(discoverShellUrls(html))));
      },
      function (err) {
        return cache.addAll([SHELL_ENTRY].concat(CORE_SHELL_URLS)).catch(function (cacheErr) {
          return undefined;
        });
      }
    );
}

function discoverShellUrls(html) {
  var urls = [];
  var seen = {};
  var attr = /\b(?:href|src)=["']([^"']+)["']/g;
  var match = attr.exec(html);
  var url;
  while (match) {
    url = sameOriginPath(match[1]);
    if (url && url.indexOf("/assets/") === 0 && !seen[url]) {
      seen[url] = true;
      urls.push(url);
    }
    match = attr.exec(html);
  }
  return urls;
}

function sameOriginPath(value) {
  try {
    var url = new URL(value, self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search : null;
  } catch (err) {
    return null;
  }
}

function uniqueUrls(urls) {
  var seen = {};
  var out = [];
  var i;
  var url;
  for (i = 0; i < urls.length; i += 1) {
    url = urls[i];
    if (!seen[url]) {
      seen[url] = true;
      out.push(url);
    }
  }
  return out;
}
