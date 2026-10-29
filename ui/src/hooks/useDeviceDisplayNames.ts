"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DeviceDisplayName, DeviceNamesResponse, DeviceNameTarget, SetDeviceNameRequest, SetDeviceNameResponse } from "@/lib/device-display-name-contract";

interface NameState { owner: string | null; names: DeviceDisplayName[]; eligible: DeviceNameTarget[]; loading: boolean; saving: boolean; error: string | null }
const empty = (owner: string | null): NameState => ({ owner, names: [], eligible: [], loading: !!owner, saving: false, error: null });

/** Cosmetic metadata only. Membership and access remain derived from verified account state. */
export function useDeviceDisplayNames(ownerId: string | null) {
  const [state, setState] = useState<NameState>(() => empty(ownerId));
  const currentOwner = useRef(ownerId); currentOwner.current = ownerId;
  const generation = useRef(0);
  const revision = useRef(0);
  const read = useRef<AbortController | null>(null);
  const write = useRef<AbortController | null>(null);
  const saving = useRef(false);
  const refresh = useCallback(() => {
    if (!ownerId || currentOwner.current !== ownerId || read.current || saving.current) return;
    const controller = new AbortController(); read.current = controller;
    const requestGeneration = generation.current, requestRevision = revision.current;
    setState(previous => previous.owner === ownerId ? { ...previous, loading: true } : empty(ownerId));
    void fetch("/api/security/device-names", { cache: "no-store", signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("Could not load display names.");
      const data = await response.json() as DeviceNamesResponse;
      if (!Array.isArray(data.names) || !Array.isArray(data.eligible)) throw new Error("Invalid response");
      return data;
    }).then(data => {
      if (currentOwner.current !== ownerId || generation.current !== requestGeneration || revision.current !== requestRevision) return;
      setState({ owner: ownerId, names: data.names, eligible: data.eligible, loading: false, saving: saving.current, error: null });
    }).catch(() => {
      if (controller.signal.aborted || currentOwner.current !== ownerId || generation.current !== requestGeneration || revision.current !== requestRevision) return;
      setState(previous => previous.owner === ownerId ? { ...previous, names: [], loading: false, eligible: [], error: "Could not load display names. Refresh access to try again." } : previous);
    }).finally(() => { if (read.current === controller) read.current = null; });
  }, [ownerId]);
  useEffect(() => {
    generation.current++; revision.current++; saving.current = false;
    read.current?.abort(); read.current = null; write.current?.abort(); write.current = null;
    setState(empty(ownerId));
    refresh();
    const onFocus = () => refresh();
    const onVisibility = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", onFocus); document.addEventListener("visibilitychange", onVisibility);
    return () => {
      generation.current++; read.current?.abort(); read.current = null; write.current?.abort(); write.current = null; saving.current = false;
      window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ownerId, refresh]);
  const setName = useCallback(async (input: SetDeviceNameRequest): Promise<boolean> => {
    if (!ownerId || currentOwner.current !== ownerId || saving.current) return false;
    saving.current = true; revision.current++;
    read.current?.abort(); read.current = null;
    const controller = new AbortController(); write.current = controller;
    const requestGeneration = generation.current;
    setState(previous => previous.owner === ownerId ? { ...previous, loading: false, saving: true, error: null } : previous);
    try {
      const response = await fetch("/api/security/device-names", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal: controller.signal });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message || "Could not save display name.");
      }
      const result = await response.json() as SetDeviceNameResponse;
      if (currentOwner.current !== ownerId || generation.current !== requestGeneration || controller.signal.aborted) return false;
      setState(previous => ({ ...previous, names: [...previous.names.filter(item => item.kind !== input.kind || item.id !== input.id), ...(result.name ? [result.name] : [])], saving: false, error: null }));
      return true;
    } catch (failure) {
      if (!controller.signal.aborted && currentOwner.current === ownerId && generation.current === requestGeneration) setState(previous => ({ ...previous, saving: false, error: failure instanceof Error ? failure.message : "Could not save display name." }));
      return false;
    } finally { if (write.current === controller) { write.current = null; saving.current = false; } }
  }, [ownerId]);
  const visible = state.owner === ownerId ? state : empty(ownerId);
  return { names: visible.names, eligible: visible.eligible, loading: visible.loading, saving: visible.saving, error: visible.error, refresh, setName };
}
