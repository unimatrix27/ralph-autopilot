import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "@/router";
import "@/index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000 } },
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("missing #root element");
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);

// Register the PWA service worker (issue #119): it owns the offline app shell and the web-push
// delivery edge. A service worker only registers in a secure context (HTTPS or localhost) — over
// plain HTTP the browser silently ignores this, which is fine (the operator reaches the control
// plane over Tailscale; installability + push require TLS, see OPERATING.md §6). Errors are
// swallowed: a SW fault must never break the app — the SPA works with or without it.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* best-effort: the SPA remains fully usable without the service worker */
    });
  });
}
