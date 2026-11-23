import { z } from 'zod';

const originalStages = ['Backlog', 'In progress', 'Blocked', 'Review', 'Done'] as const;
export const boardColumnId = z.union([z.enum(originalStages), z.uuid().regex(/^[a-f0-9-]+$/)]);
export const boardColumnLabel = z.string().trim().min(1).max(64).regex(/^[^\u0000-\u001f\u007f]+$/);
const column = z.object({ id: boardColumnId, label: boardColumnLabel }).strict();
export type BoardColumn = z.infer<typeof column>;
export const defaultBoardColumns: BoardColumn[] = originalStages.map(id => ({ id, label: id }));
export const boardColumns = z.array(column).min(1).max(32).refine(columns =>
  new Set(columns.map(item => item.id)).size === columns.length &&
  new Set(columns.map(item => item.label.toLowerCase())).size === columns.length,
  'Column IDs and names must be unique');
