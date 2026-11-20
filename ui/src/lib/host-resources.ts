export interface HostResources {
  sampledAt: number;
  cpuPercent: number | null;
  freeRamBytes: number;
  totalRamBytes: number;
  freeDiskBytes: number | null;
}

export function validResources(value: unknown): value is HostResources {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  return count(r.sampledAt) && (r.cpuPercent === null || (count(r.cpuPercent) && r.cpuPercent <= 100))
    && count(r.freeRamBytes) && count(r.totalRamBytes) && r.freeRamBytes <= r.totalRamBytes
    && (r.freeDiskBytes === null || count(r.freeDiskBytes));
}
