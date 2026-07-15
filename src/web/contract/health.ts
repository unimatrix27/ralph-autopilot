/**
 * The `/api/health` wire shape (ADR-0031). The first — and, in the foundations
 * slice, only — read contract: just enough for the SPA to prove the embedded
 * server is live and report which daemon build it is talking to. Read endpoints
 * over `buildSnapshot`/projections land in slice 1 and extend this leaf.
 */
import { z } from "zod";

export const healthResponseSchema = z
  .object({
    /** Always `"ok"` while the server is serving; the field exists so the SPA can branch on a richer status later. */
    status: z.literal("ok"),
    /** Package name of the daemon process (e.g. `ralph-autopilot`). */
    name: z.string(),
    /** Daemon build version (from `package.json`); lets the UI flag a stale frontend/backend mismatch. */
    version: z.string(),
    /** ISO-8601 instant the web layer began serving. */
    startedAt: z.string(),
    /** Whole seconds the web layer has been serving — cheap "is it alive" signal. */
    uptimeSeconds: z.number().int().nonnegative(),
  })
  .strict();

export type HealthResponse = z.infer<typeof healthResponseSchema>;
