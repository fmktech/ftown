import { z } from 'zod';

const bytes = z.number().int().nonnegative().safe();
export const hostResourcesSchema = z.object({
  sampledAt: bytes, cpuPercent: z.number().min(0).max(100).nullable(),
  freeRamBytes: bytes, totalRamBytes: bytes, freeDiskBytes: bytes.nullable(),
  memoryPressure: z.enum(['normal', 'warning', 'critical']).optional().catch(undefined),
}).refine(sample => sample.freeRamBytes <= sample.totalRamBytes);

export type HostResources = z.infer<typeof hostResourcesSchema>;
