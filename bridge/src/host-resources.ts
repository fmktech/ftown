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

function macMemoryProbe(file: string, args: string[]): Promise<string | undefined> {
  return new Promise<string>((resolve, reject) => {
    execFile(file, args, { timeout: 1000, maxBuffer: 8192 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  }).catch(() => undefined);
}

// XNU exposes NOTE_MEMORYSTATUS_PRESSURE_* flags through kern.memorystatus_vm_pressure_level.
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/event_private.h
function macPressureLevel(output: string | undefined): HostResources['memoryPressure'] {
  switch (output?.trim()) {
    case '1': return 'normal';
    case '2': return 'warning';
    case '4': return 'critical';
  }
}

function macAvailableRam(output: string | undefined, total: number): number | undefined {
  if (!output) return;
  const pageSize = Number(output.match(/\(page size of (\d+) bytes\)/)?.[1]);
  // vm_stat splits speculative pages out of Mach's free count. Recombine them
  // and include inactive pages to estimate RAM available for new work.
  // https://github.com/apple-oss-distributions/system_cmds/blob/main/vm_stat/vm_stat.c
  const free = Number(output.match(/^Pages free:[ \t]+(\d+)\.\s*$/m)?.[1]);
  const speculative = Number(output.match(/^Pages speculative:[ \t]+(\d+)\.\s*$/m)?.[1]);
  const inactive = Number(output.match(/^Pages inactive:[ \t]+(\d+)\.\s*$/m)?.[1]);
  const available = (free + speculative + inactive) * pageSize;
  if (pageSize > 0 && Number.isSafeInteger(available) && available <= total) return available;
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
    const mac = platform() === 'darwin';
    cached = Promise.all([
      statfs(dataDir).then(fs => fs.bavail * fs.bsize, () => null),
      mac ? macMemoryProbe('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']) : undefined,
      mac ? macMemoryProbe('/usr/bin/vm_stat', []) : undefined,
    ]).then(([freeDiskBytes, pressureOutput, vmOutput]) => {
      const memoryPressure = macPressureLevel(pressureOutput);
      const availableRamBytes = macAvailableRam(vmOutput, totalRamBytes);
      return {
        sampledAt: now, cpuPercent, freeRamBytes, totalRamBytes, freeDiskBytes,
        ...(memoryPressure && { memoryPressure }),
        ...(availableRamBytes === undefined ? {} : { availableRamBytes }),
      };
    });
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
