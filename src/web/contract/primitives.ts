/**
 * Shared contract identity primitives (ADR-0031). The wire's repo + issue identity
 * recurs in every leaf (overview, health-usage, …); defining each **once** here and
 * importing it everywhere is the single source of truth the contract layer exists to
 * enforce. Tightening `issueNumber` to a range, or `repoSlug` to an `owner/name`
 * regex, then lands in one place and every leaf moves together — a per-leaf drift
 * becomes impossible rather than a silent divergence.
 *
 * Browser-safe like the rest of the leaf: `zod` only, no node imports (see ./README.md).
 */
import { z } from "zod";

/** A target-repo slug (`owner/name`). */
export const repoSlug = z.string();

/** A 1-based GitHub issue number. */
export const issueNumber = z.number().int().positive();

/**
 * The LLM provider kind a phase ran on (ADR-0037) — the wire mirror of the node-side
 * `ProviderName` (config/schema). The **canonical** wire provider enum: the routing-editor
 * contract (`routing.ts`) derives its `routingProviderSchema`/`ROUTING_PROVIDERS` from this
 * one, so the route schema and the routing editor can never name a different provider set.
 * Mirrored, not imported, to keep the leaf browser-safe.
 */
export const providerName = z.enum(["claude", "openai", "zai"]);
export type ProviderNameWire = z.infer<typeof providerName>;

/**
 * The concrete route a phase's container was dispatched on (ADR-0037 P3.1, issue #164): the
 * provider kind, the model (`null` for the provider's default), and the selected account's **id**
 * — never its credential, so this is safe to serialise to the browser. Shared by the fleet
 * summary (the live phase's route) and the run-detail timeline (the route of each past phase), so
 * the daemon serialise ↔ UI parse can never drift (ADR-0031).
 */
export const routeSchema = z
  .object({
    /** The provider kind the phase ran on. */
    provider: providerName,
    /** The per-type model, or null for the provider's default model. */
    model: z.string().nullable(),
    /** The selected account's id (never its credential). */
    account: z.string(),
  })
  .strict();
export type Route = z.infer<typeof routeSchema>;
