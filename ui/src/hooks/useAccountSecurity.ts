"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LedgerClient, LedgerClientSnapshot } from "@/lib/ledger-client";
import { useLedger } from "./useLedger";

/*
 * Account-mode state of the Security panel: the page's ledger client (useLedger) plus a single-flight action runner that keeps every
 * click to at most ONE passkey prompt. A ledger write signs with "this device's" passkey; when the account has several passkeys and
 * this page has not yet learned which one this device holds, LedgerClient.append() would first run an identification ceremony and
 * then the signing ceremony (two prompts in one click). The client reports the credential it knows as snapshot.signer; while that is
 * null (or not one of the account's passkeys) the panel asks for the choice as its own click (chooseSigner), and
 * run(..., { signs: true }) refuses to start a write until it is made.
 */

const CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** A stable snake_case code for any thrown value: Error(code), { code }, or unknown_error. */
export function securityErrorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const tagged = (error as { code?: unknown }).code;
    if (typeof tagged === "string" && CODE.test(tagged)) return tagged;
  }
  if (error instanceof Error && CODE.test(error.message)) return error.message;
  return "unknown_error";
}

export interface AccountSecurityRunOptions {
  /** The action signs a ledger record with this device's passkey (append, revoke, add_authority finish). */
  signs?: boolean;
}

export interface AccountSecurity {
  client: LedgerClient;
  snapshot: LedgerClientSnapshot;
  /** Several passkeys and the signing one is unknown here: a write must wait for chooseSigner() (its own click and prompt). */
  needsSigner: boolean;
  /** Key of the action in flight; every action button is disabled while it is set. */
  busy: string | null;
  /** Code of the last failed action (map it with securityErrorMessage). */
  error: string | null;
  clearError: () => void;
  /** Runs one click's action. Returns true on success, false on failure or when refused (busy, or a write while needsSigner). */
  run: (key: string, action: (client: LedgerClient) => Promise<void>, options?: AccountSecurityRunOptions) => Promise<boolean>;
  /** One passkey prompt: learns which of the account's passkeys this device holds. */
  chooseSigner: () => Promise<boolean>;
}

export function useAccountSecurity(): AccountSecurity {
  const { client, snapshot } = useLedger();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    // The panel shows the newest chain the server has; a failure keeps the verified local replica on screen.
    if (client) void client.refresh().catch(() => {});
    return () => { mounted.current = false; };
  }, [client]);

  const checkpoint = snapshot.checkpoint;
  const signer = snapshot.signer;
  const needsSigner = !!checkpoint && checkpoint.authorities.length > 1 && !checkpoint.authorities.some(item => item.credentialId === signer);

  const execute = useCallback(async (key: string, action: () => Promise<void>): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(key); setError(null);
    try {
      await action();
      return true;
    } catch (failure) {
      if (mounted.current) setError(securityErrorCode(failure));
      return false;
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(null);
    }
  }, []);

  const run = useCallback((key: string, action: (client: LedgerClient) => Promise<void>, options: AccountSecurityRunOptions = {}): Promise<boolean> => {
    if (options.signs && needsSigner) {
      setError("passkey_choice_required");
      return Promise.resolve(false);
    }
    return execute(key, () => action(client));
  }, [client, execute, needsSigner]);

  const chooseSigner = useCallback((): Promise<boolean> => execute("signer", () => client.selectPasskey()), [client, execute]);

  const clearError = useCallback(() => setError(null), []);
  return { client, snapshot, needsSigner, busy, error, clearError, run, chooseSigner };
}
