/**
 * A German relative-time formatter for the control plane — the past-only sibling of the
 * UI's {@link import("../../../web/src/lib/time").relativeTo}, but localized to German via
 * the native `Intl.RelativeTimeFormat` (e.g. `vor 2 Minuten`, `vor 3 Tagen`). It mirrors
 * the `DateTime.setLocale('de').toRelative()` style of the sibling example-monorepo Angular client.
 *
 * Lives in the **contract leaf** (ADR-0031) because it is environment-neutral — it imports
 * **nothing from Node**, relying only on the standard `Intl` global — so it is covered by
 * the root `npm test` vitest gate alongside {@link import("./run-view").buildRunView}.
 */

/** German relative units in descending size, each with the second-threshold below which it applies. */
const UNITS: { unit: Intl.RelativeTimeFormatUnit; seconds: number; below: number }[] = [
  { unit: "seconds", seconds: 1, below: 60 },
  { unit: "minutes", seconds: 60, below: 3600 },
  { unit: "hours", seconds: 3600, below: 86_400 },
  { unit: "days", seconds: 86_400, below: Number.POSITIVE_INFINITY },
];

const FORMATTER = new Intl.RelativeTimeFormat("de", { numeric: "always" });

/**
 * Format the elapsed time since an ISO-8601 instant as a German relative string, picking the
 * largest sensible unit by flooring (`< 60s` → seconds, `< 3600s` → minutes, `< 86400s` →
 * hours, else days). The instant is formatted as a *past* event (a negative value), so
 * `format(-2, 'minutes')` yields `vor 2 Minuten`.
 *
 * Returns the sentinel `"—"` when `iso` is `null` or unparseable (`Date.parse` is `NaN`),
 * mirroring the `formatWaited` / `relativeTo` sentinels in `web/src/lib/time.ts`.
 */
export function formatRelativeDe(iso: string | null, nowMs: number): string {
  if (iso === null) {
    return "—";
  }
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return "—";
  }
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - then) / 1000));
  const { unit, seconds } = UNITS.find((u) => elapsedSeconds < u.below) ?? UNITS[UNITS.length - 1]!;
  const value = Math.floor(elapsedSeconds / seconds);
  return FORMATTER.format(-value, unit);
}
