import { z } from 'zod';

const bytes = z.number().int().nonnegative().safe();
export const hostResourcesSchema = z.object({
  sampledAt: bytes, cpuPercent: z.number().min(0).max(100).nullable(),
  freeRamBytes: bytes, totalRamBytes: bytes, freeDiskBytes: bytes.nullable(),
  availableRamBytes: bytes.optional().catch(undefined),
  memoryPressure: z.enum(['normal', 'warning', 'critical']).optional().catch(undefined),
}).refine(sample => sample.freeRamBytes <= sample.totalRamBytes).transform(sample => {
  if (sample.availableRamBytes !== undefined && sample.availableRamBytes > sample.totalRamBytes) delete sample.availableRamBytes;
  return sample;
});

export type HostResources = z.infer<typeof hostResourcesSchema>;
