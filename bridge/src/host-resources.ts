import { z } from 'zod';
import { hostResourcesSchema, type HostResources } from './host-resources-protocol.js';
export type { HostResources } from './host-resources-protocol.js';
import type { PeerControl } from './peer-control.js';
import { execFile } from 'node:child_process';
import { cpus, freemem, platform, totalmem } from 'node:os';
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

// XNU exposes NOTE_MEMORYSTATUS_PRESSURE_* flags through this sysctl on macOS.
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/event_private.h
function macMemoryPressure(): Promise<HostResources['memoryPressure']> {
  const output = new Promise<string>((resolve, reject) => {
    execFile('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeout: 1000, maxBuffer: 1024 },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  return output.then(stdout => {
    switch (stdout.trim()) {
      case '1': return 'normal';
      case '2': return 'warning';
      case '4': return 'critical';
    }
  }, () => undefined);
}

export function hostResourceSampler(dataDir: string) {
  let previous = cpuTime();
  let sampledAt = 0;
  let cached: Promise<HostResources> | undefined;
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
    cached = Promise.all([
      statfs(dataDir).then(fs => fs.bavail * fs.bsize, () => null),
      platform() === 'darwin' ? macMemoryPressure() : undefined,
    ]).then(([freeDiskBytes, memoryPressure]) => ({
      sampledAt: now, cpuPercent, freeRamBytes, totalRamBytes, freeDiskBytes,
      ...(memoryPressure && { memoryPressure }),
    }));
    return cached;
  };
}

export async function peerResources(peers: Pick<PeerControl, 'http'>, bridgeId: string): Promise<HostResources | null> {
  try {
    const reply = await peers.http(bridgeId, 'GET', '/api/host-resources', undefined, 5000);
    if (reply.status !== 200) return null;
    const report = z.object({ bridgeId: z.literal(bridgeId), resources: hostResourcesSchema }).safeParse(reply.body);
    if (report.success) return report.data.resources;
  } catch { /* An unavailable peer has no current reading. */ }
  return null;
}
