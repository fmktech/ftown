import { z } from 'zod';

/** Direct peer read of projects stored by the responding home bridge. */
export const PROJECT_DIRECTORY = '/api/projects/directory';
export const projectDirectoryEntry = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  bridgeId: z.string().min(1).max(256),
});
export type ProjectDirectoryEntry = z.infer<typeof projectDirectoryEntry>;
