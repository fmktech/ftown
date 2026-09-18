import { bootstrapLocal, localOrigin, localRequest, readDevice, rememberDevice } from './local-browser-client';

/** Only call with authenticated cloud presence connInfo, never publication data. */
export function createCloudLocalAccess(signal: AbortSignal): (info: unknown) => Promise<void> {
  const pending = new Map<string, Promise<void>>();
  const complete = new Set<string>();
  const candidates = new Map<string, string>();
  return async (info: unknown) => {
    if (signal.aborted || !info || typeof info !== 'object') return;
    const advert = info as Record<string, unknown>;
    const { bridgeId, localPort, localNonce } = advert;
    if (typeof bridgeId !== 'string' || !bridgeId || typeof localPort !== 'number' ||
      typeof localNonce !== 'string' || !/^[a-f0-9]{32}$/.test(localNonce)) return;
    try { localOrigin(localPort); } catch { return; }
    const key = `${bridgeId}:${localPort}`;
    if (complete.has(key)) return;
    if (pending.has(key)) return pending.get(key);
    const work = (async () => {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
      const saved = readDevice(localPort);
      if (saved?.bridgeId === bridgeId) {
        // A revoked saved credential must not be silently recreated by polling.
        await bootstrapLocal(saved, bounded);
        complete.add(key);
        return;
      }
      let credential = candidates.get(key);
      if (!credential) {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        credential = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        candidates.set(key, credential);
      }
      const granted = await localRequest<{ credential: string }>(localPort, '/api/browser/cloud-devices',
        localNonce, { bridgeId, credential }, bounded);
      if (granted.credential !== credential) throw new Error('Unexpected local credential');
      const device = { port: localPort, bridgeId, credential };
      await bootstrapLocal(device, bounded);
      if (signal.aborted) return;
      rememberDevice(device, true);
      complete.add(key);
      candidates.delete(key);
    })().catch(() => {
      // Most cloud bridges are remote. A failed loopback attempt must not affect
      // cloud use; later authenticated presence snapshots can retry safely.
    }).finally(() => pending.delete(key));
    pending.set(key, work);
    return work;
  };
}
