import { hostResourcesSchema, type HostResources } from "../../../bridge/src/host-resources-protocol";
export type { HostResources } from "../../../bridge/src/host-resources-protocol";

export function parseResources(value: unknown): HostResources | null {
  return hostResourcesSchema.safeParse(value).data ?? null;
}

export function formatResources(sample?: HostResources): string {
  if (!sample) return "";
  const gib = (bytes: number) => (bytes / 2 ** 30).toFixed(1);
  return `CPU ${sample.cpuPercent ?? "—"}${sample.cpuPercent === null ? "" : "%"} · RAM ${gib(sample.freeRamBytes)}/${gib(sample.totalRamBytes)} GiB free` +
    (sample.memoryPressure ? ` · memory pressure ${sample.memoryPressure}` : "") +
    (sample.freeDiskBytes === null ? "" : ` · disk ${gib(sample.freeDiskBytes)} GiB free`) +
    ` · ${new Date(sample.sampledAt).toLocaleTimeString()}`;
}
