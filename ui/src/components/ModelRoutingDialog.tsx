"use client";

import { useEffect, useId, useReducer, useRef, useState } from "react";
import type { Command, CommandResponse } from "@/types";
import { useModelRouting } from "@/hooks/useModelRouting";
import type { RoutingEditorAction } from "@/lib/model-routing";
import { defaultPickFor, effortOptions, initialRoutingEditorState, modelOptionLabel, modelOptions, normalizePick, pickLabel, providerOptions, routingEditorReducer, validateRoutingDraft } from "@/lib/model-routing";
import { MODEL_ROUTING_LIMITS } from "../../../bridge/src/quota/types";
import type { ModelRoutingConfig, ModelRoutingSnapshot, RoutingConfigState, ProviderQuota, QuotaAvailability, QuotaProviderId, QuotaReport, QuotaWindowKind, RoutingPick, RoutingTier } from "../../../bridge/src/quota/types";

const EMPTY_CONFIG: ModelRoutingConfig = { version: 1, tiers: [], steering: "" };
const button = "min-h-11 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-10";
const iconButton = "inline-flex min-h-9 min-w-9 items-center justify-center rounded-md border border-[var(--border-muted)] text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40";
const field = "min-h-9 rounded-md border border-[var(--border-muted)] bg-[var(--bg-base)] px-2 text-xs text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none disabled:opacity-50";
const availabilityColor: Record<QuotaAvailability, string> = { available: "var(--accent)", low: "var(--status-pending)", exhausted: "var(--status-error)", unknown: "var(--text-muted)" };
const statusLabel: Record<ProviderQuota["status"], string> = { ok: "", no_data: "no data", auth: "login needed", unavailable: "unavailable", error: "error" };
const MAX_LISTED_FILE_ERRORS = 5;

function ago(iso: string, now: number): string | null {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function windowLeft(row: ProviderQuota, kind: QuotaWindowKind): string {
  const window = row.windows.find(candidate => candidate.kind === kind);
  if (window?.usedPercent != null && Number.isFinite(window.usedPercent)) return `${Math.max(0, Math.round(100 - window.usedPercent))}% left`;
  return window?.note ?? "–";
}

function AvailabilityBadge({ availability, title }: { availability: QuotaAvailability; title?: string }) {
  const color = availabilityColor[availability] ?? availabilityColor.unknown;
  return <span title={title} className="inline-flex shrink-0 items-center rounded border px-1.5 py-px text-[10px] font-medium leading-4" style={{ color, borderColor: color }}>{availability}</span>;
}

function Subscriptions({ report }: { report: QuotaReport }) {
  if (report.providers.length === 0) return <p className="text-xs text-[var(--text-muted)]">No subscriptions reported by this bridge.</p>;
  return <ul className="divide-y divide-[var(--border-muted)] rounded-lg border border-[var(--border-muted)] bg-[var(--bg-elevated)] text-xs">
    {report.providers.map(row => {
      const routing = report.routing.find(entry => entry.provider === row.provider);
      const problem = statusLabel[row.status];
      return <li key={row.provider} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5">
        <span className="w-16 shrink-0 font-[family-name:var(--font-mono)] text-[var(--text-primary)]">{row.provider}</span>
        <span className="min-w-0 max-w-32 truncate text-[var(--text-secondary)]" title={row.plan ?? undefined}>{row.plan ?? "–"}</span>
        {problem ? <span className="text-[var(--status-pending)]" title={row.message ?? undefined}>{problem}</span> : <>
          <span className="text-[var(--text-secondary)]"><span className="text-[var(--text-muted)]">5h </span>{windowLeft(row, "five_hour")}</span>
          <span className="text-[var(--text-secondary)]"><span className="text-[var(--text-muted)]">week </span>{windowLeft(row, "weekly")}</span>
        </>}
        <span className="ml-auto"><AvailabilityBadge availability={routing?.availability ?? "unknown"} title={routing?.reason} /></span>
      </li>;
    })}
  </ul>;
}

function PickRow({ report, tier, tierIndex, pick, index, count, onChange, onMove, onRemove }: {
  report: QuotaReport; tier: RoutingTier; tierIndex: number; pick: RoutingPick; index: number; count: number;
  onChange: (pick: RoutingPick) => void; onMove: (direction: -1 | 1) => void; onRemove: () => void;
}) {
  const label = `Tier ${tierIndex + 1} pick ${index + 1}`;
  const providers = providerOptions(report);
  const models = modelOptions(report, pick.provider);
  const { efforts, defaultEffort } = effortOptions(report, pick.provider, pick.model);
  const routing = report.routing.find(entry => entry.provider === pick.provider);
  const stored = report.tiers.find(candidate => candidate.name === tier.name)?.picks[index];
  const annotation = stored && stored.provider === pick.provider && stored.model === pick.model && stored.effort === pick.effort ? stored : null;
  const problem = annotation?.problem ?? null;
  const notChecked = !problem && annotation?.checked === false;
  const showEffort = efforts.length > 0 || pick.effort !== null;
  return <li className="rounded-md border border-[var(--border-muted)] bg-[var(--bg-base)] p-2">
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-5 shrink-0 text-right font-[family-name:var(--font-mono)] text-xs text-[var(--text-muted)]" aria-hidden="true">{index + 1}</span>
      <select aria-label={`${label} CLI`} className={`${field} w-28`} value={pick.provider}
        onChange={event => onChange(normalizePick(report, { ...pick, provider: event.target.value as QuotaProviderId }))}>
        {providers.map(option => <option key={option.provider} value={option.provider} disabled={!option.available && option.provider !== pick.provider} title={option.reason ?? undefined}>{option.provider}{option.available ? "" : " (unavailable)"}</option>)}
      </select>
      <select aria-label={`${label} model`} className={`${field} min-w-0 max-w-full flex-1 basis-40`} value={pick.model}
        onChange={event => onChange(normalizePick(report, { ...pick, model: event.target.value }))}>
        {!models.some(model => model.id === pick.model) && <option value={pick.model}>{pick.model || "(no model)"} (not offered)</option>}
        {models.map(model => <option key={model.id} value={model.id} title={model.description ?? model.id}>{modelOptionLabel(model)}</option>)}
      </select>
      {showEffort && <select aria-label={`${label} effort`} className={`${field} w-28`} value={pick.effort ?? ""}
        onChange={event => onChange({ ...pick, effort: event.target.value === "" ? null : event.target.value })}>
        <option value="">default{defaultEffort ? ` (${defaultEffort})` : ""}</option>
        {pick.effort !== null && !efforts.includes(pick.effort) && <option value={pick.effort}>{pick.effort} (not supported)</option>}
        {efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
      </select>}
      <span className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
        <AvailabilityBadge availability={routing?.availability ?? "unknown"} title={routing?.reason} />
        {routing?.leftPercent != null && <span>{Math.round(routing.leftPercent)}% left</span>}
      </span>
      <span className="ml-auto flex gap-1">
        <button type="button" className={iconButton} aria-label={`Move ${label} up`} disabled={index === 0} onClick={() => onMove(-1)}>↑</button>
        <button type="button" className={iconButton} aria-label={`Move ${label} down`} disabled={index === count - 1} onClick={() => onMove(1)}>↓</button>
        <button type="button" className={iconButton} aria-label={`Remove ${label} (${pickLabel(pick)})`} onClick={onRemove}>✕</button>
      </span>
    </div>
    {problem && <p className="mt-1 pl-7 text-[11px] text-[var(--status-pending)]">{problem}</p>}
    {notChecked && <p className="mt-1 pl-7 text-[11px] text-[var(--text-muted)]">Not checked: this CLI&rsquo;s model list couldn&rsquo;t be read.</p>}
  </li>;
}

function InvalidFileWarning({ configState, blocked, replace, onReplaceChange }: {
  configState: RoutingConfigState | undefined; blocked: boolean; replace: boolean; onReplaceChange: (replace: boolean) => void;
}) {
  const checkboxId = useId();
  const errors = configState?.status === "invalid" ? configState.errors : [];
  const listed = errors.slice(0, MAX_LISTED_FILE_ERRORS);
  const hidden = errors.length - listed.length;
  return <div role={blocked ? "alert" : undefined} className="rounded-lg border border-[var(--status-pending)] bg-[var(--bg-elevated)] p-3 text-xs">
    <p className="font-medium text-[var(--status-pending)]">{blocked ? "Not saved: the" : "The"} routing file stored on this bridge is invalid.</p>
    <p className="mt-1 text-[var(--text-secondary)]">The editor starts from the starter tiers. Saving will replace the stored file with what is below.</p>
    {listed.length > 0 && <ul className="mt-1 list-disc pl-5 text-[var(--text-secondary)]">
      {listed.map((error, i) => <li key={i}>{error}</li>)}
      {hidden > 0 && <li className="list-none text-[var(--text-muted)]">and {hidden} more</li>}
    </ul>}
    {configState?.path && <p className="mt-1 break-all font-[family-name:var(--font-mono)] text-[var(--text-muted)]">{configState.path}</p>}
    <div className="mt-2 flex items-center gap-2">
      <input id={checkboxId} type="checkbox" className="h-4 w-4 accent-[var(--accent)]" checked={replace} onChange={event => onReplaceChange(event.target.checked)} />
      <label htmlFor={checkboxId} className="text-[var(--text-primary)]">Replace the invalid file</label>
    </div>
  </div>;
}

export function ModelRoutingDialog({ open, bridgeId, name, send, onClose }: { open: boolean; bridgeId: string; name: string; send: (command: Command) => Promise<CommandResponse>; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const title = useId();
  const steeringId = useId();
  const routing = useModelRouting(send);
  const view = routing.get(bridgeId);
  const [state, dispatch] = useReducer(routingEditorReducer, EMPTY_CONFIG, initialRoutingEditorState);
  const [seeded, setSeeded] = useState<ModelRoutingSnapshot | null>(null);
  const [saveErrors, setSaveErrors] = useState<string[]>([]);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [replaceInvalid, setReplaceInvalid] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current;
    dialog?.showModal();
    return () => { dialog?.close(); previous?.focus(); };
  }, [open]);
  useEffect(() => { if (open) void routing.load(bridgeId); }, [open, bridgeId, routing]);
  useEffect(() => { if (open) setReplaceInvalid(false); }, [open, bridgeId]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);

  const snapshot = view.snapshot;
  if (snapshot && snapshot !== seeded && !state.dirty) {
    setSeeded(snapshot);
    dispatch({ type: "reset", config: snapshot.config });
  }
  if (!open) return null;

  const report = snapshot?.report ?? null;
  const config = state.config;
  const draftErrors = seeded ? validateRoutingDraft(config) : [];
  const loading = view.status === "loading";
  const firstAvailable = report ? providerOptions(report).find(option => option.available) : undefined;
  const newPick = report && firstAvailable ? defaultPickFor(report, firstAvailable.provider) : null;
  const edit = (action: RoutingEditorAction) => { setSaveErrors([]); dispatch(action); };
  const requestClose = () => { if (state.dirty) setConfirmingClose(true); else onClose(); };
  const save = async () => {
    const draft = state.config;
    setSaveErrors([]);
    const outcome = await routing.save(bridgeId, draft, needsReplaceConfirmation && replaceInvalid ? { overwriteInvalid: true } : undefined);
    if (!outcome.saved) {
      setSaveErrors(outcome.errors);
      // The bridge still refused (e.g. the file turned invalid after this dialog loaded): ask again.
      if (outcome.invalidFileBlocked) setReplaceInvalid(false);
      return;
    }
    setReplaceInvalid(false);
    const reloaded = routing.get(bridgeId).snapshot;
    setSeeded(reloaded);
    dispatch({ type: "reset", config: reloaded?.config ?? draft });
  };
  const asOf = snapshot?.cached ? ago(snapshot.report.generatedAt, now) : null;
  const configState = report?.routingConfig;
  const needsReplaceConfirmation = configState?.status === "invalid" || view.invalidFileBlocked;
  const saveDisabled = (!state.dirty && !needsReplaceConfirmation) || (needsReplaceConfirmation && !replaceInvalid) || draftErrors.length > 0 || view.saving || !report;

  return <dialog ref={ref} aria-labelledby={title} onCancel={event => { event.preventDefault(); requestClose(); }} onClick={event => { if (event.target === event.currentTarget) requestClose(); }}
    className="fixed inset-0 m-auto max-h-[calc(100dvh_-_32px)] w-[calc(100%_-_32px)] max-w-[760px] overflow-hidden rounded-xl border border-[var(--border-muted)] bg-[var(--bg-surface)] p-0 font-[family-name:var(--font-sans)] text-[var(--text-primary)] shadow-2xl backdrop:bg-black/70">
    <div className="flex max-h-[calc(100dvh_-_34px)] flex-col text-sm leading-[1.5]">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border-muted)] p-4 sm:px-6">
        <div className="min-w-0">
          <h2 id={title} className="text-lg font-semibold leading-6">Model routing</h2>
          <p className="mt-1 break-words text-xs text-[var(--text-muted)]">{name}{asOf && <span> · usage as of {asOf}</span>}{loading && snapshot && <span role="status"> · refreshing…</span>}</p>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" className={`${button} border border-[var(--border-muted)] hover:bg-[var(--bg-elevated)]`} disabled={loading || view.saving} onClick={() => void routing.load(bridgeId, true)}>Refresh</button>
          <button type="button" aria-label="Close model routing" className={`${button} flex min-w-11 items-center justify-center text-lg text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]`} onClick={requestClose}>×</button>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 sm:px-6">
        {!report && (view.status === "unsupported" ? <p role="status" className="rounded-lg border border-[var(--status-pending)] bg-[var(--bg-elevated)] p-3">{view.error}</p>
          : view.status === "error" ? <div role="alert" className="rounded-lg border border-[var(--status-error)] bg-[var(--bg-elevated)] p-3">
            <p>{view.error}</p>
            <button type="button" className={`${button} mt-3 border border-[var(--border-muted)] hover:bg-[var(--bg-hover)]`} onClick={() => void routing.load(bridgeId)}>Retry</button>
          </div>
          : <div role="status" aria-live="polite" className="flex items-center gap-2 py-6 text-[var(--text-secondary)]">
            <span aria-hidden="true" className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--accent)]" />
            Reading subscriptions and model lists from this bridge. This can take several seconds.
          </div>)}

        {report && (view.status === "error" || view.status === "unsupported") && <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--status-error)] bg-[var(--bg-elevated)] p-3 text-xs">
          <span className="min-w-0 flex-1">{view.error}</span>
          <button type="button" className={`${button} border border-[var(--border-muted)] hover:bg-[var(--bg-hover)]`} onClick={() => void routing.load(bridgeId)}>Retry</button>
        </div>}

        {report && needsReplaceConfirmation && <InvalidFileWarning configState={configState} blocked={view.invalidFileBlocked} replace={replaceInvalid} onReplaceChange={setReplaceInvalid} />}

        {report && <>
          <section aria-labelledby={`${title}-subs`}>
            <h3 id={`${title}-subs`} className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Subscriptions</h3>
            <Subscriptions report={report} />
          </section>

          {configState?.status === "missing" && <p className="text-xs text-[var(--text-secondary)]">No routing is saved on this bridge yet. The starter tiers are below: add picks to each, then save.</p>}

          <section aria-labelledby={`${title}-tiers`} className="space-y-3">
            <h3 id={`${title}-tiers`} className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Tiers</h3>
            {config.tiers.length === 0 && <p className="text-xs text-[var(--text-muted)]">No tiers. Add one below.</p>}
            {config.tiers.map((tier, tierIndex) => {
              const tierLabel = `Tier ${tierIndex + 1}`;
              const atPickLimit = tier.picks.length >= MODEL_ROUTING_LIMITS.maxPicksPerTier;
              const guidanceId = `${title}-guidance-${tierIndex}`;
              return <section key={tierIndex} aria-label={`${tierLabel}: ${tier.name || "unnamed"}`} className="rounded-lg border border-[var(--border-muted)] bg-[var(--bg-elevated)] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <input aria-label={`${tierLabel} name`} className={`${field} w-36 font-[family-name:var(--font-mono)]`} value={tier.name} maxLength={MODEL_ROUTING_LIMITS.maxTierNameLength} spellCheck={false} autoCapitalize="off" autoComplete="off"
                    onChange={event => edit({ type: "rename_tier", index: tierIndex, name: event.target.value.toLowerCase().replace(/\s+/g, "-") })} />
                  <input aria-label={`${tierLabel} description`} placeholder="What kind of work belongs here" className={`${field} min-w-0 flex-1 basis-48`} value={tier.description} maxLength={MODEL_ROUTING_LIMITS.maxTierDescriptionLength}
                    onChange={event => edit({ type: "set_tier_description", index: tierIndex, value: event.target.value })} />
                  <span className="flex gap-1">
                    <button type="button" className={iconButton} aria-label={`Move ${tierLabel} up`} disabled={tierIndex === 0} onClick={() => edit({ type: "move_tier", index: tierIndex, direction: -1 })}>↑</button>
                    <button type="button" className={iconButton} aria-label={`Move ${tierLabel} down`} disabled={tierIndex === config.tiers.length - 1} onClick={() => edit({ type: "move_tier", index: tierIndex, direction: 1 })}>↓</button>
                    <button type="button" className={iconButton} aria-label={`Delete ${tierLabel}`} onClick={() => edit({ type: "remove_tier", index: tierIndex })}>✕</button>
                  </span>
                </div>
                {tier.picks.length === 0 ? <p className="mt-2 text-xs text-[var(--text-muted)]">No picks yet.</p>
                  : <ol className="mt-2 space-y-1.5" aria-label={`${tierLabel} picks, most preferred first`}>
                    {tier.picks.map((pick, index) => <PickRow key={index} report={report} tier={tier} tierIndex={tierIndex} pick={pick} index={index} count={tier.picks.length}
                      onChange={next => edit({ type: "update_pick", tier: tierIndex, index, pick: next })}
                      onMove={direction => edit({ type: "move_pick", tier: tierIndex, index, direction })}
                      onRemove={() => edit({ type: "remove_pick", tier: tierIndex, index })} />)}
                  </ol>}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button type="button" className={`${button} border border-[var(--border-muted)] text-xs hover:bg-[var(--bg-hover)]`} disabled={!newPick || atPickLimit}
                    onClick={() => { if (newPick) edit({ type: "add_pick", tier: tierIndex, pick: newPick }); }}>Add pick</button>
                  {!newPick && <span className="text-[11px] text-[var(--text-muted)]">No CLI on this bridge reports models right now.</span>}
                  {newPick && atPickLimit && <span className="text-[11px] text-[var(--text-muted)]">At most {MODEL_ROUTING_LIMITS.maxPicksPerTier} picks per tier.</span>}
                </div>
                <div className="mt-3">
                  <div className="mb-1 flex items-baseline justify-between gap-2">
                    <label htmlFor={guidanceId} className="text-[11px] font-medium text-[var(--text-secondary)]">Guidance for the router</label>
                    <span className="text-[11px] text-[var(--text-muted)]" aria-live="polite">{tier.guidance.length}/{MODEL_ROUTING_LIMITS.maxTierGuidanceLength}</span>
                  </div>
                  <textarea id={guidanceId} rows={2} className={`${field} block w-full resize-y py-1.5`} value={tier.guidance} maxLength={MODEL_ROUTING_LIMITS.maxTierGuidanceLength}
                    placeholder="e.g. otherwise any free opencode model" aria-describedby={`${guidanceId}-hint`}
                    onChange={event => edit({ type: "set_tier_guidance", index: tierIndex, value: event.target.value })} />
                  <p id={`${guidanceId}-hint`} className="mt-1 text-[11px] text-[var(--text-muted)]">Free text the router agent reads for this tier, passed on as written.</p>
                </div>
              </section>;
            })}
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={`${button} border border-[var(--border-muted)] hover:bg-[var(--bg-elevated)]`} disabled={config.tiers.length >= MODEL_ROUTING_LIMITS.maxTiers} onClick={() => edit({ type: "add_tier" })}>Add tier</button>
              {config.tiers.length >= MODEL_ROUTING_LIMITS.maxTiers && <span className="text-[11px] text-[var(--text-muted)]">At most {MODEL_ROUTING_LIMITS.maxTiers} tiers.</span>}
            </div>
          </section>

          <section>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <label htmlFor={steeringId} className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Steering</label>
              <span className="text-[11px] text-[var(--text-muted)]" aria-live="polite">{config.steering.length}/{MODEL_ROUTING_LIMITS.maxSteeringLength}</span>
            </div>
            <textarea id={steeringId} rows={3} className={`${field} block w-full resize-y py-1.5`} value={config.steering} maxLength={MODEL_ROUTING_LIMITS.maxSteeringLength} aria-describedby={`${steeringId}-hint`}
              onChange={event => edit({ type: "set_steering", value: event.target.value })} />
            <p id={`${steeringId}-hint`} className="mt-1 text-[11px] text-[var(--text-muted)]">Free-text guidance the router agent reads, e.g. &ldquo;don&rsquo;t fully exhaust Claude&rdquo;.</p>
          </section>
        </>}
      </div>

      <footer className="border-t border-[var(--border-muted)] p-4 sm:px-6">
        {(draftErrors.length > 0 || saveErrors.length > 0) && <ul role="alert" className="mb-3 max-h-28 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs text-[var(--status-error)]">
          {[...saveErrors, ...draftErrors].map((error, i) => <li key={i}>{error}</li>)}
        </ul>}
        {confirmingClose ? <div role="group" aria-label="Discard unsaved changes" className="flex flex-wrap items-center gap-2">
          <span className="mr-auto">Discard changes?</span>
          <button type="button" className={`${button} border border-[var(--status-error)] text-[var(--status-error)] hover:bg-[var(--bg-elevated)]`} onClick={onClose}>Discard</button>
          <button type="button" className={`${button} border border-[var(--border-muted)] hover:bg-[var(--bg-elevated)]`} autoFocus onClick={() => setConfirmingClose(false)}>Keep editing</button>
        </div> : <div className="flex flex-wrap items-center gap-2">
          {state.dirty && <span className="mr-auto text-xs text-[var(--text-muted)]">Unsaved changes</span>}
          <button type="button" className={`${button} ${state.dirty ? "" : "ml-auto "}text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)]`} onClick={requestClose}>Close</button>
          <button type="button" className={`${button} bg-[var(--accent)] text-[var(--bg-void)] hover:bg-[var(--accent-bright)]`} disabled={saveDisabled} onClick={() => void save()}>{view.saving ? "Saving…" : "Save"}</button>
        </div>}
      </footer>
    </div>
  </dialog>;
}
