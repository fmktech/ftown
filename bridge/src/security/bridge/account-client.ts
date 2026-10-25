import { parseAccountHistory, ACCOUNT_TRUST_LIMITS } from '../account-crypto.js';
import type { AccountHistory } from '../account-protocol.js';
import { BridgeSecurityError } from './errors.js';

/** Network/auth availability is distinct from a received invalid trust history. */
export class AccountReadUnavailable extends Error {
  constructor() { super('Account trust service is unavailable.'); this.name = 'AccountReadUnavailable'; }
}
export function accountReadUrl(apiUrl: string): URL {
  let url: URL;
  try { url = new URL(apiUrl); } catch { throw new BridgeSecurityError('invalid_account_trust'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const literalLocal = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:\/|$)/i.test(apiUrl);
  if (/[\x00-\x20\x7f?#]/.test(apiUrl) || url.username || url.password || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && literalLocal))) {
    throw new BridgeSecurityError('invalid_account_trust');
  }
  return new URL('/api/security/account', url);
}
export async function readAccountHistory(apiUrl: string, token: string, signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch): Promise<AccountHistory | null> {
  const url = accountReadUrl(apiUrl);
  if (!token) throw new AccountReadUnavailable();
  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` },
      redirect: 'manual', cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
  } catch { throw new AccountReadUnavailable(); }
  if (!response.ok) throw new AccountReadUnavailable();
  const maxBytes = ACCOUNT_TRUST_LIMITS.maxHistoryBytes + 1024;
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new BridgeSecurityError('account_capacity_exceeded');
  const reader = response.body?.getReader();
  if (!reader) throw new BridgeSecurityError('invalid_account_trust');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); } catch { throw new AccountReadUnavailable(); }
      const { value, done } = chunk; if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel().catch(() => undefined); throw new BridgeSecurityError('account_capacity_exceeded'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const result: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).join(',') !== 'history') {
      throw new BridgeSecurityError('invalid_account_trust');
    }
    const history = (result as { history: unknown }).history;
    return history === null ? null : parseAccountHistory(history);
  } catch (error) {
    if (error instanceof BridgeSecurityError || error instanceof AccountReadUnavailable) throw error;
    throw new BridgeSecurityError('invalid_account_trust');
  } finally { reader.releaseLock(); }
}
