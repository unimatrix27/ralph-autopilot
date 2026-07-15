/**
 * The **Tier-2 daemon control** wire shape (ADR-0032, issue #118) — the browser-safe contract
 * for the second write tier: driving the daemon lifecycle from the UI. Both the daemon
 * (serialize) and the UI (parse) share this leaf, so a drift is a compile error, not a silent
 * mis-fire.
 *
 * Three actions over `DaemonControl`: **drain** (a graceful drain — no new pickups, in-flight
 * finish, then exit), **force-tick** (run a reconcile round now), and **kill-run** (tear down
 * one in-flight run). They are eventually-consistent control signals, not a second source of
 * truth — the reconciler remains the actor (ADR-0032).
 *
 * Confused-deputy + accidental-fire hygiene: every control route is a POST (so the Origin guard
 * fronts it, ADR-0032), and the two destructive actions — drain and kill-run — additionally
 * require an explicit `confirm: true` at the wire edge. A body missing `confirm: true` fails the
 * schema and is rejected with 400 before the action fires, so an accidental click or a stray
 * request cannot drain the daemon or kill a run. Force-tick is non-destructive, so it needs no
 * confirm. Browser-safe like the rest of the leaf (zod only, zero node imports).
 */
import { z } from "zod";

/** The `/api/daemon/drain` request body: the operator must explicitly confirm. */
export const drainRequestBodySchema = z
  .object({
    /** Required literal `true` — the wire-edge gate against an accidental drain. */
    confirm: z.literal(true),
  })
  .strict();
export type DrainRequestBody = z.infer<typeof drainRequestBodySchema>;

/** The `/api/daemon/drain` response: the drain signal was sent (the daemon now drains + exits). */
export const drainResponseSchema = z
  .object({
    /** ISO-8601 instant the drain was triggered. */
    generatedAt: z.string(),
    /** Always `true` here — the signal was accepted. The drain itself settles under the loop. */
    draining: z.literal(true),
  })
  .strict();
export type DrainResponse = z.infer<typeof drainResponseSchema>;

/**
 * The `/api/daemon/force-tick` request body. Force-tick is non-destructive, so it carries no
 * `confirm`; the body is an empty object (a POST requires a body, so the UI sends `{}`).
 */
export const forceTickRequestBodySchema = z.object({}).strict();
export type ForceTickRequestBody = z.infer<typeof forceTickRequestBodySchema>;

/** The `/api/daemon/force-tick` response: a reconcile round was forced (it runs immediately). */
export const forceTickResponseSchema = z
  .object({
    /** ISO-8601 instant the force-tick was triggered. */
    generatedAt: z.string(),
    /** Always `true` here — the wake was accepted. The tick runs on the loop. */
    ticked: z.literal(true),
  })
  .strict();
export type ForceTickResponse = z.infer<typeof forceTickResponseSchema>;

/**
 * The `/api/daemon/kill-run` request body: the run id to kill, plus an explicit confirm. The
 * run id is the wire correlation tag (`String(run.id)`) every run response already carries, so
 * the UI identifies a specific in-flight run without a (repo, issue) round-trip.
 */
export const killRunRequestBodySchema = z
  .object({
    /** The run id to kill (the canonical positive safe-integer `String(run.id)` correlation tag). */
    runId: z
      .string()
      .regex(/^[1-9]\d*$/, "runId must be a positive integer")
      .refine((runId) => Number.isSafeInteger(Number(runId)), "runId must be a safe integer"),
    /** Required literal `true` — the wire-edge gate against an accidental kill. */
    confirm: z.literal(true),
  })
  .strict();
export type KillRunRequestBody = z.infer<typeof killRunRequestBodySchema>;

/**
 * The `/api/daemon/kill-run` response: whether a live session was found and aborted. `killed:
 * false` means the run had already settled — the kill raced its own exit (no live session to
 * tear down). `runId` echoes the request so the UI can correlate the result to the run.
 */
export const killRunResponseSchema = z
  .object({
    /** ISO-8601 instant the kill was attempted. */
    generatedAt: z.string(),
    /** The run id the kill was attempted on (echoed from the request). */
    runId: z.string(),
    /** Whether a live session was found and aborted. */
    killed: z.boolean(),
  })
  .strict();
export type KillRunResponse = z.infer<typeof killRunResponseSchema>;
