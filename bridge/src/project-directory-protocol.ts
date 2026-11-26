import { z } from 'zod';

/** Paired bridges exchange a project through a direct link. */
export const PROJECT_MOVE = '/api/projects/move-storage';
export const PROJECT_DIRECTORY = '/api/projects/directory';
export const projectDirectoryEntry = z.object({
  id: z.string().min(1).max(128),
  homeRevision: z.number().int().nonnegative().optional(),
  name: z.string().min(1).max(256),
  bridgeId: z.string().min(1).max(256),
});
export type ProjectDirectoryEntry = z.infer<typeof projectDirectoryEntry>;

export type ProjectBoardCommand = 'list_projects' | 'get_project_board' | 'get_project_discussion' | 'mutate_project_discussion' | 'get_ticket_comments' | 'mutate_project_board';

export function boardCommandForPath(path: string): ProjectBoardCommand | undefined {
  switch (path) {
    case '/api/project-board/get_project_discussion': return 'get_project_discussion';
    case '/api/project-board/mutate_project_discussion': return 'mutate_project_discussion';
    case '/api/project-board/list_projects': return 'list_projects';
    case '/api/project-board/get_project_board': return 'get_project_board';
    case '/api/project-board/get_ticket_comments': return 'get_ticket_comments';
    case '/api/project-board/mutate_project_board': return 'mutate_project_board';
  }
}
