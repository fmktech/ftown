import { hostResourcesSchema, type HostResources } from "../../../bridge/src/host-resources-protocol";
export type { HostResources } from "../../../bridge/src/host-resources-protocol";

export function parseResources(value: unknown): HostResources | null {
  return hostResourcesSchema.safeParse(value).data ?? null;
}

export function ramCapacity(sample: HostResources) {
  return sample.availableRamBytes === undefined
    ? { bytes: sample.freeRamBytes, label: "free" }
    : { bytes: sample.availableRamBytes, label: "available" };
}

export function formatResources(sample?: HostResources): string {
  if (!sample) return "";
  const gib = (bytes: number) => (bytes / 2 ** 30).toFixed(1);
  const ram = ramCapacity(sample);
  return `CPU ${sample.cpuPercent ?? "—"}${sample.cpuPercent === null ? "" : "%"} · RAM ${gib(ram.bytes)}/${gib(sample.totalRamBytes)} GiB ${ram.label}` +
    (sample.memoryPressure ? ` · memory pressure ${sample.memoryPressure}` : "") +
    (sample.freeDiskBytes === null ? "" : ` · disk ${gib(sample.freeDiskBytes)} GiB free`) +
    ` · ${new Date(sample.sampledAt).toLocaleTimeString()}`;
}
