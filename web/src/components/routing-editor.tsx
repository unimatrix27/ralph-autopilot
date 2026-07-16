import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  buildAccountToggleEdit,
  buildClearRoutingEdit,
  buildPhasedRoutingEdit,
  buildRoutingEditorModel,
  buildSetRoutingEdit,
  normaliseEntry,
  phasedPreferenceIsPostable,
  preferenceIsPostable,
  type AccountPoolGroup,
  type EffectiveRoutingResponse,
  type PhasedDraft,
  type ProviderOption,
  type RoutingEditRequestBody,
  type RoutingEditResponse,
  type RoutingEntryWire,
  type RoutingProviderWire,
  type TypeRoutingRow,
} from "@contract";
import { postRoutingEdit } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, PlusIcon, TrashIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The **global routing editor** (ADR-0037 P4.2, issues #167/#250): view / add / reorder / remove a
 * type's `(provider, model)` preference list, see the account pool, and post edits through the
 * #166 write API (`/api/routing/edit`). Routing is resolved by the daemon **pre-dispatch**, so an
 * edit takes effect on the **next dispatch (~next tick)** — surfaced honestly, like the power
 * actions; an in-flight container finishes on the route it started with (ADR-0038).
 *
 * `impl`/`autoMode` are single-phase: a flat preference list. `review`/`fix` run as numbered phases,
 * so they edit as a **base + optional per-phase** form (#250, the #169 data model): a `base` list
 * (the fallback for every phase) plus optional `phase1` (normal) / `phase2` (thermo) overrides — the
 * common case being a stronger model on the Phase-2 thermo pass. Each phase reuses the same
 * preference-row component as the flat list, so account-pool awareness and the disabled-with-reason
 * capability gate render identically.
 *
 * A provider that is **capability-incompatible** for a type (it can't host the in-session
 * escalate/stuck tools `impl` needs) renders **disabled-with-reason**, never silently hidden — the
 * same gate the store enforces on write, so a selectable choice is one the server accepts. The
 * render-model + the disabled-with-reason logic are the pure {@link buildRoutingEditorModel} in the
 * contract leaf (node-tested); this component is the thin React projection of it.
 */
export function RoutingEditor({ data }: { data: EffectiveRoutingResponse }) {
  const model = React.useMemo(() => buildRoutingEditorModel(data), [data]);
  return (
    <div className="space-y-6">
      <p className="text-[11px] text-muted-foreground">
        Routing is resolved pre-dispatch — an edit applies on the next dispatch (~next tick). An
        in-flight container finishes on the route it started with. Default:{" "}
        <span className="font-mono">
          {model.defaultProvider}·{model.defaultModel}
        </span>
        .
      </p>

      <div className="space-y-4">
        {model.rows.map((row) =>
          row.phaseable ? (
            <PhasedTypeRoutingEditor key={row.type} row={row} defaultProvider={model.defaultProvider} />
          ) : (
            <TypeRoutingEditor key={row.type} row={row} defaultProvider={model.defaultProvider} />
          ),
        )}
      </div>

      <AccountPoolCard pool={model.pool} />
    </div>
  );
}

/** A draft preference row — `model` is the raw input ("" ⇒ provider default). */
interface DraftEntry {
  provider: RoutingProviderWire;
  model: string;
}

/** Seed the editable draft from the server's current preference list. */
function seedDraft(preference: RoutingEntryWire[]): DraftEntry[] {
  return preference.map((entry) => ({ provider: entry.provider, model: entry.model ?? "" }));
}

/**
 * Normalise a draft to the wire `(provider, model)` list — a blank model falls back to the default.
 * Delegates to the contract's {@link normaliseEntry} so the blank-drop policy lives in exactly one
 * (node-tested) place and the UI stays a projection of the contract.
 */
function draftToEntries(draft: DraftEntry[]): RoutingEntryWire[] {
  return draft.map(normaliseEntry);
}

/**
 * The submit action + last-result state shared by the single-phase and per-phase editors. `submit`
 * owns the whole post ritual — the in-flight guard, clearing the prior result/error, and firing the
 * mutation — so each editor's save/reset is a one-liner and the hook keeps `setPosted`/`setError`
 * private (the editors never touch the result state directly).
 */
function useRoutingEditMutation() {
  const queryClient = useQueryClient();
  const [posted, setPosted] = React.useState<RoutingEditResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: postRoutingEdit,
    onSuccess: (resp) => {
      setPosted(resp);
      setError(null);
      // The daemon resolves the new route next dispatch; invalidate so the next refetch reflects it.
      queryClient.invalidateQueries({ queryKey: ["routing"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "The edit could not be posted — retry."),
  });
  const pending = mutation.isPending;
  const submit = (body: RoutingEditRequestBody): void => {
    if (pending) return;
    setPosted(null);
    setError(null);
    mutation.mutate(body);
  };
  return { submit, posted, error, pending };
}

/** The Card header shared by both editors: the type name + the (impl-only) needs-tools badge. */
function TypeHeader({ row, description }: { row: TypeRoutingRow; description: string }) {
  return (
    <CardHeader>
      <CardTitle className="flex items-center gap-2">
        <span className="font-mono">{row.type}</span>
        {row.requiresTools && (
          <Badge variant="outline" title="Requires the in-session escalate/stuck tools (ADR-0037 capability gate)">
            needs in-session tools
          </Badge>
        )}
      </CardTitle>
      <CardDescription>{description}</CardDescription>
    </CardHeader>
  );
}

/**
 * The reusable **preference-row list** (#167): the ordered `(provider, model)` rows with
 * reorder/remove controls and an "Add entry" button, controlled by the parent. Reused verbatim for
 * the flat single-phase list AND for each of `base`/`phase1`/`phase2` (#250), so account-pool
 * awareness and the disabled-with-reason provider gate render the same everywhere. `ariaPrefix`
 * disambiguates the field labels across the (up to three) lists a phaseable type renders.
 */
function PreferenceList({
  row,
  ariaPrefix,
  draft,
  onChange,
  defaultProvider,
  pending,
}: {
  row: TypeRoutingRow;
  ariaPrefix: string;
  draft: DraftEntry[];
  onChange: (next: DraftEntry[]) => void;
  defaultProvider: RoutingProviderWire;
  pending: boolean;
}) {
  const firstSelectable = row.providerOptions.find((o) => !o.disabled)?.provider ?? defaultProvider;

  const setEntry = (i: number, patch: Partial<DraftEntry>): void =>
    onChange(draft.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  const addEntry = (): void => onChange([...draft, { provider: firstSelectable, model: "" }]);
  const removeEntry = (i: number): void => onChange(draft.filter((_, idx) => idx !== i));
  const move = (i: number, delta: number): void => {
    const j = i + delta;
    if (j < 0 || j >= draft.length) return;
    const next = [...draft];
    const a = next[i]!;
    const b = next[j]!;
    next[i] = b;
    next[j] = a;
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {draft.map((entry, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <span className="w-5 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{i + 1}.</span>
          <ProviderSelect
            label={`${ariaPrefix} provider`}
            options={row.providerOptions}
            value={entry.provider}
            disabled={pending}
            onChange={(provider) => setEntry(i, { provider })}
          />
          <input
            aria-label={`${ariaPrefix} entry ${i + 1} model`}
            value={entry.model}
            placeholder="default model"
            disabled={pending}
            onChange={(e) => setEntry(i, { model: e.target.value })}
            className="h-9 w-44 rounded-md border bg-background px-2 py-1 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Move up"
              disabled={pending || i === 0}
              onClick={() => move(i, -1)}
              className="h-9 w-9"
            >
              <ArrowUpIcon className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Move down"
              disabled={pending || i === draft.length - 1}
              onClick={() => move(i, 1)}
              className="h-9 w-9"
            >
              <ArrowDownIcon className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Remove entry"
              disabled={pending || draft.length === 1}
              onClick={() => removeEntry(i)}
              className="h-9 w-9"
            >
              <TrashIcon className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ))}
      <Button type="button" size="sm" variant="outline" onClick={addEntry} disabled={pending}>
        <PlusIcon className="mr-1 h-4 w-4" /> Add entry
      </Button>
    </div>
  );
}

/** The Save / Reset footer + last-result/error line shared by both editors. */
function EditorFooter({
  dirty,
  postable,
  pending,
  posted,
  error,
  onSave,
  onReset,
}: {
  dirty: boolean;
  postable: boolean;
  pending: boolean;
  posted: RoutingEditResponse | null;
  error: string | null;
  onSave: () => void;
  onReset: () => void;
}) {
  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={onSave} disabled={!dirty || !postable || pending}>
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onReset} disabled={pending}>
          Reset to default
        </Button>
        {dirty && !postable && (
          <span className="text-xs text-status-danger">Resolve the disabled provider(s) above before saving.</span>
        )}
      </div>

      {posted && posted.target === "type" && (
        <p className="mt-2 text-xs text-status-success">
          {posted.cleared ? "Reset to the global default" : "Saved"} — applies on the next dispatch (~
          {posted.appliesNextDispatchSeconds}s).
        </p>
      )}
      {error && <p className={cn("mt-2 text-xs text-status-danger")}>{error}</p>}
    </>
  );
}

/** The single-phase editor (`impl`/`autoMode`): one flat `(provider, model)` preference list. */
function TypeRoutingEditor({ row, defaultProvider }: { row: TypeRoutingRow; defaultProvider: RoutingProviderWire }) {
  const { submit, posted, error, pending } = useRoutingEditMutation();
  const seedKey = JSON.stringify(row.preference);
  const [draft, setDraft] = React.useState<DraftEntry[]>(() => seedDraft(row.preference));

  // Re-seed the draft when the server's preference changes under us (the refetch after this edit, or
  // a later tick), mirroring how power-actions re-seeds its select on a catalog change. The last
  // confirmation (`posted`) is left standing — it's cleared when the operator starts the next edit —
  // so the "applies on the next dispatch" message survives the success-triggered refetch.
  React.useEffect(() => {
    setDraft(seedDraft(row.preference));
  }, [seedKey]);

  const entries = draftToEntries(draft);
  const dirty = JSON.stringify(entries) !== seedKey;
  const postable = preferenceIsPostable(row, entries);

  const save = (): void => {
    if (postable) submit(buildSetRoutingEdit(row.type, entries));
  };
  const reset = (): void => submit(buildClearRoutingEdit(row.type));

  return (
    <Card>
      <TypeHeader
        row={row}
        description="First entry whose provider is allowed and has account headroom wins at route resolution."
      />
      <CardContent>
        <PreferenceList
          row={row}
          ariaPrefix={row.type}
          draft={draft}
          onChange={setDraft}
          defaultProvider={defaultProvider}
          pending={pending}
        />
        <EditorFooter
          dirty={dirty}
          postable={postable}
          pending={pending}
          posted={posted}
          error={error}
          onSave={save}
          onReset={reset}
        />
      </CardContent>
    </Card>
  );
}

/**
 * The per-phase editor (`review`/`fix`, #250): a `base` preference list plus optional `phase1` /
 * `phase2` overrides. `base` is always present (the fallback for any phase without an override); a
 * phase override is added/removed by the operator — added starting from the current base
 * (the "bump only the thermo pass" common case), removed to fall back to base. A base-only edit
 * collapses to the flat list form on the wire ({@link buildPhasedRoutingEdit}), so config.yaml stays
 * unphased until an override is actually set.
 */
function PhasedTypeRoutingEditor({
  row,
  defaultProvider,
}: {
  row: TypeRoutingRow;
  defaultProvider: RoutingProviderWire;
}) {
  const { submit, posted, error, pending } = useRoutingEditMutation();
  // The server's current routing as a PhasedDraft — the same shape as `phasedDraft` below, so the
  // dirty compare is shape-for-shape and `seedKey` doubles as the re-seed effect's dependency.
  const seed: PhasedDraft = {
    base: row.preference,
    ...(row.phases.phase1 ? { phase1: row.phases.phase1 } : {}),
    ...(row.phases.phase2 ? { phase2: row.phases.phase2 } : {}),
  };
  const seedKey = JSON.stringify(seed);
  const [base, setBase] = React.useState<DraftEntry[]>(() => seedDraft(row.preference));
  const [phase1, setPhase1] = React.useState<DraftEntry[] | null>(() =>
    row.phases.phase1 ? seedDraft(row.phases.phase1) : null,
  );
  const [phase2, setPhase2] = React.useState<DraftEntry[] | null>(() =>
    row.phases.phase2 ? seedDraft(row.phases.phase2) : null,
  );

  // Re-seed every list when the server's routing changes under us (this edit's refetch, or a later
  // tick) — same convention as the single-phase editor. A phase absent on the server seeds to `null`
  // (inherits base); present seeds its rows.
  React.useEffect(() => {
    setBase(seedDraft(row.preference));
    setPhase1(row.phases.phase1 ? seedDraft(row.phases.phase1) : null);
    setPhase2(row.phases.phase2 ? seedDraft(row.phases.phase2) : null);
  }, [seedKey]);

  const baseEntries = draftToEntries(base);
  const phase1Entries = phase1 ? draftToEntries(phase1) : undefined;
  const phase2Entries = phase2 ? draftToEntries(phase2) : undefined;
  const phasedDraft: PhasedDraft = {
    base: baseEntries,
    ...(phase1Entries ? { phase1: phase1Entries } : {}),
    ...(phase2Entries ? { phase2: phase2Entries } : {}),
  };

  // Dirty when the current draft differs from the server seed — both built as a PhasedDraft (base →
  // optional phase1 → optional phase2), so it's a key-for-key compare with absent phases omitted on
  // either side.
  const dirty = JSON.stringify(phasedDraft) !== seedKey;
  const postable = phasedPreferenceIsPostable(row, phasedDraft);

  const save = (): void => {
    if (postable) submit(buildPhasedRoutingEdit(row.type, phasedDraft));
  };
  const reset = (): void => submit(buildClearRoutingEdit(row.type));

  // Seed a freshly-added override from the current base draft — the useful starting point ("bump
  // only the thermo pass to a stronger model"). Base is always ≥1 (the server seeds a non-empty
  // preference and PreferenceList disables removing the last row), so a copy of base is enough.
  const seedOverrideFromBase = (): DraftEntry[] => base.map((e) => ({ ...e }));

  return (
    <Card>
      <TypeHeader
        row={row}
        description="`base` applies to every phase; add a `phase1` (normal) or `phase2` (thermo) override to deviate — e.g. a stronger model on the Phase-2 thermo pass. First allowed provider with account headroom wins."
      />
      <CardContent className="space-y-4">
        <PhaseBlock label="base" hint="Fallback for any phase without an override.">
          <PreferenceList
            row={row}
            ariaPrefix={`${row.type} base`}
            draft={base}
            onChange={setBase}
            defaultProvider={defaultProvider}
            pending={pending}
          />
        </PhaseBlock>

        <PhaseOverrideBlock
          label="phase1"
          hint="Normal review/fix pass."
          row={row}
          ariaPrefix={`${row.type} phase1`}
          draft={phase1}
          onChange={setPhase1}
          seedOverride={seedOverrideFromBase}
          defaultProvider={defaultProvider}
          pending={pending}
        />
        <PhaseOverrideBlock
          label="phase2"
          hint="Thermo / behaviour-preserving pass."
          row={row}
          ariaPrefix={`${row.type} phase2`}
          draft={phase2}
          onChange={setPhase2}
          seedOverride={seedOverrideFromBase}
          defaultProvider={defaultProvider}
          pending={pending}
        />

        <EditorFooter
          dirty={dirty}
          postable={postable}
          pending={pending}
          posted={posted}
          error={error}
          onSave={save}
          onReset={reset}
        />
      </CardContent>
    </Card>
  );
}

/**
 * A bordered phase section with a `phaseN`/`base` label + one-line hint, wrapping its rows. An
 * optional `action` (e.g. a "Remove override" button) renders right-aligned in the header; with no
 * action the header is just the label/hint group, so the base section's appearance is unchanged.
 */
function PhaseBlock({
  label,
  hint,
  action,
  children,
}: {
  label: string;
  hint: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-sm">{label}</span>
          <span className="text-xs text-muted-foreground">{hint}</span>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

/**
 * An optional per-phase override (`phase1`/`phase2`): when unset, a dashed "inherits base" placeholder
 * with an **Add override** button (seeded from base); when set, the bordered preference rows with a
 * **Remove override** button that clears back to base. The override list reuses {@link PreferenceList}.
 */
function PhaseOverrideBlock({
  label,
  hint,
  row,
  ariaPrefix,
  draft,
  onChange,
  seedOverride,
  defaultProvider,
  pending,
}: {
  label: string;
  hint: string;
  row: TypeRoutingRow;
  ariaPrefix: string;
  draft: DraftEntry[] | null;
  onChange: (next: DraftEntry[] | null) => void;
  seedOverride: () => DraftEntry[];
  defaultProvider: RoutingProviderWire;
  pending: boolean;
}) {
  if (draft === null) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed p-3">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-sm text-muted-foreground">{label}</span>
          <span className="text-xs text-muted-foreground">inherits base — {hint}</span>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={`Add ${label} override`}
          onClick={() => onChange(seedOverride())}
          disabled={pending}
        >
          <PlusIcon className="mr-1 h-4 w-4" /> Add {label} override
        </Button>
      </div>
    );
  }
  return (
    <PhaseBlock
      label={label}
      hint={hint}
      action={
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={`Remove ${label} override`}
          onClick={() => onChange(null)}
          disabled={pending}
        >
          <TrashIcon className="mr-1 h-4 w-4" /> Remove override
        </Button>
      }
    >
      <PreferenceList
        row={row}
        ariaPrefix={ariaPrefix}
        draft={draft}
        onChange={onChange}
        defaultProvider={defaultProvider}
        pending={pending}
      />
    </PhaseBlock>
  );
}

/**
 * A provider `<select>` for one preference entry. Every provider KIND is an option; a
 * capability-incompatible / unconfigured one renders **disabled-with-reason** (the reason inline in
 * the label AND on hover), never hidden — the operator sees exactly why a choice is unavailable.
 */
function ProviderSelect({
  label,
  options,
  value,
  disabled,
  onChange,
}: {
  label: string;
  options: ProviderOption[];
  value: RoutingProviderWire;
  disabled: boolean;
  onChange: (provider: RoutingProviderWire) => void;
}) {
  return (
    <span className="relative">
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as RoutingProviderWire)}
        className="h-9 w-72 appearance-none rounded-md border bg-background py-1 pl-2 pr-7 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
      >
        {options.map((opt) => (
          <option key={opt.provider} value={opt.provider} disabled={opt.disabled} title={opt.reason ?? undefined}>
            {opt.provider}
            {opt.reason ? ` — ${opt.reason}` : ""}
          </option>
        ))}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 opacity-60" />
    </span>
  );
}

/**
 * The account pool (ADR-0037) with the per-account enable/disable toggle (issue #10). Disabling
 * parks the account: dispatch-time selection never picks it (route resolution walks on to the
 * next preference entry, exactly like the all-gated case) until it is re-enabled — with
 * next-dispatch effect only, so the action is reversible and needs no confirm step. The server
 * rejects a toggle that would leave a provider any preference list selects with zero enabled
 * accounts; that rejection surfaces inline.
 */
function AccountPoolCard({ pool }: { pool: AccountPoolGroup[] }) {
  const { submit, posted, error, pending } = useRoutingEditMutation();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Account pool</CardTitle>
        <CardDescription>
          The configured credentials per provider (model-free; account choice within a provider is automatic).
          Disable an account to park it — invisible to dispatch from the next dispatch on; in-flight runs finish
          on the route they started with.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-3">
          {pool.map((group) => (
            <li key={group.provider} className="rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm">{group.provider}</span>
                <Badge variant={group.configured ? "success" : "outline"}>
                  {group.configured ? "configured" : "not configured"}
                </Badge>
                <Badge variant={group.toolsCapable ? "success" : "outline"}>
                  {group.toolsCapable ? "tools-capable" : "no in-session tools"}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {group.accounts.length} account{group.accounts.length === 1 ? "" : "s"}
                </span>
              </div>
              {group.accounts.length > 0 && (
                <ul className="mt-2 space-y-1.5">
                  {group.accounts.map((account) => (
                    <li key={account.id} className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          "rounded border px-1.5 py-0.5 font-mono text-[11px]",
                          account.enabled ? "text-muted-foreground" : "text-muted-foreground/60 line-through",
                        )}
                      >
                        {account.id}
                      </span>
                      {account.enabled ? (
                        <Badge variant="success">enabled</Badge>
                      ) : (
                        <Badge variant="outline">disabled</Badge>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-label={`${account.enabled ? "Disable" : "Enable"} account ${account.id}`}
                        disabled={pending}
                        onClick={() => submit(buildAccountToggleEdit(account.id, !account.enabled))}
                      >
                        {account.enabled ? "Disable" : "Enable"}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>

        {posted && posted.target === "account" && (
          <p className="mt-3 text-xs text-status-success">
            Account <span className="font-mono">{posted.id}</span>{" "}
            {posted.enabled ? "enabled" : "disabled"} — applies on the next dispatch (~
            {posted.appliesNextDispatchSeconds}s); in-flight runs are untouched.
          </p>
        )}
        {error && <p className="mt-3 text-xs text-status-danger">{error}</p>}
      </CardContent>
    </Card>
  );
}
