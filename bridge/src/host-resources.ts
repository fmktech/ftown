import { z } from 'zod';
import type { PeerControl } from './peer-control.js';
import { cpus, freemem, totalmem } from 'node:os';
import { statfs } from 'node:fs/promises';

function cpuTime() {
  let idle = 0;
  let total = 0;
  for (const { times } of cpus()) {
    idle += times.idle;
    total += times.idle + times.user + times.nice + times.sys + times.irq;
  }
  return { idle, total };
}

export function hostResourceSampler(dataDir: string) {
  let previous = cpuTime();
  let sampledAt = 0;
  let cached: Promise<{ cpuPercent: number | null; freeRamBytes: number; totalRamBytes: number; freeDiskBytes: number | null; sampledAt: number }> | undefined;
  return () => {
    const now = Date.now();
    if (cached && now - sampledAt < 10_000) return cached;
    const current = cpuTime();
    const elapsed = current.total - previous.total;
    const cpuPercent = elapsed > 0 ? Math.max(0, Math.min(100, Math.round(100 * (1 - (current.idle - previous.idle) / elapsed)))) : null;
    previous = current;
    sampledAt = now;
    const freeRamBytes = freemem();
    const totalRamBytes = totalmem();
    cached = statfs(dataDir).then(fs => fs.bavail * fs.bsize, () => null)
      .then(freeDiskBytes => ({ sampledAt: now, cpuPercent, freeRamBytes, totalRamBytes, freeDiskBytes }));
    return cached;
  };
}

const bytes = z.number().int().nonnegative().safe();
const resourceReport = z.object({
  sampledAt: bytes, cpuPercent: z.number().min(0).max(100).nullable(),
  freeRamBytes: bytes, totalRamBytes: bytes, freeDiskBytes: bytes.nullable(),
});
export type HostResources = z.infer<typeof resourceReport>;

export async function peerResources(peers: Pick<PeerControl, 'http'>, bridgeId: string): Promise<HostResources | null> {
  try {
    const reply = await peers.http(bridgeId, 'GET', '/api/host-resources', undefined, 5000);
    if (reply.status !== 200) return null;
    const report = z.object({ bridgeId: z.literal(bridgeId), resources: resourceReport }).safeParse(reply.body);
    if (report.success && report.data.resources.freeRamBytes <= report.data.resources.totalRamBytes) return report.data.resources;
  } catch { /* An unavailable peer has no current reading. */ }
  return null;
}
