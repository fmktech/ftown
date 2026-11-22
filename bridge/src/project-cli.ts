import { randomUUID } from 'node:crypto';
import { Command, CommanderError } from 'commander';
import { api, currentPeerTarget, loadPointer, setPeerTarget } from './cli-client.js';
import type { ProjectBoardCommand } from './project-directory-protocol.js';
import type { ProjectBoard, HomeProject } from './project-board-store.js';
import { TICKET_NOTIFICATION_INBOX, type TicketNotice } from './ticket-notification-protocol.js';

type BoardPage = ProjectBoard & { nextCursor?: string };
interface Comment { id: string; text: string; author: string; createdAt: string }
interface TicketOptions {
  id?: string; title?: string; body?: string; stage?: string; assignee?: string; parent?: string;
  link?: string; unlink?: string;
}

function boardRequest<T>(command: ProjectBoardCommand, payload: Record<string, unknown>): Promise<T> {
  return api<T>(loadPointer(), 'POST', '/api/project-board/' + command, payload);
}

async function directory() {
  const { projects, homeBridgeId } = await boardRequest<{ projects: HomeProject[]; homeBridgeId: string }>('list_projects', {});
  return projects.filter(project => !currentPeerTarget() || project.bridgeId === homeBridgeId);
}

async function locateProject(selector?: string) {
  if (!selector?.trim()) throw new Error('Supply --project <name|id> (see ftown projects list)');
  const projects = await directory();
  const exact = projects.filter(project => project.id === selector);
  const matches = exact.length ? exact : projects.filter(project => project.name === selector);
  const unique = new Map(matches.map(project => [project.bridgeId + '/' + project.id, project]));
  if (unique.size === 0) throw new Error('Unknown project: ' + selector);
  if (unique.size > 1) throw new Error('Ambiguous project. Specify its project ID or home with --bridge.');
  const [project] = unique.values();
  if (!currentPeerTarget() && project.bridgeId !== loadPointer().bridgeId) setPeerTarget(project.bridgeId);
  return project;
}

async function readBoard(projectId: string, first?: BoardPage, ticketId?: string): Promise<ProjectBoard> {
  const getPage = (cursor?: string) => boardRequest<BoardPage>('get_project_board', { projectId, ...(cursor && { cursor }) });
  let page = first ?? await getPage();
  const tickets = [...page.tickets];
  while (page.nextCursor && !(ticketId && page.tickets.some(ticket => ticket.id === ticketId))) {
    page = await getPage(page.nextCursor);
    tickets.push(...page.tickets);
  }
  return { project: page.project, tickets };
}

function ticketFields(options: TicketOptions, create: boolean) {
  const result: Record<string, unknown> = {};
  for (const key of ['title', 'body', 'stage'] as const) if (options[key] !== undefined) result[key] = options[key];
  if (options.assignee !== undefined) {
    if (!options.assignee.trim()) throw new Error('Supply a bridge ID, user or none for --assignee');
    result.assignee = options.assignee === 'none' ? null : options.assignee === 'user'
      ? { kind: 'user' } : { kind: 'bridge', bridgeId: options.assignee };
  }
  if (options.parent !== undefined) result.parentTicketId = options.parent === 'none' ? null : options.parent;
  if (options.link !== undefined) {
    if (create) result.sessionIds = [options.link];
    else result.addSessionId = options.link;
  }
  if (options.unlink !== undefined) result.removeSessionId = options.unlink;
  return result;
}

function editOptions(command: Command) {
  return command.option('--body <text>', 'Ticket description')
    .option('--stage <stage>', 'Backlog, In progress, Blocked, Review or Done')
    .option('--assignee <target>', 'Bridge ID, user or none')
    .option('--parent <id>', 'Parent ticket ID, or none to make a top-level ticket')
    .option('--link <session>', 'Link a worker session by ID');
}

export async function runProjectCommands(group: 'projects' | 'tickets', args: string[]): Promise<number> {
  const program = new Command('ftown ' + group).exitOverride().allowExcessArguments(false)
    .description(group === 'projects' ? 'Manage hosted projects on paired bridges' : 'Manage tickets on their project home bridge')
    .option('--json', 'Emit compact JSON for automation');
  const originalTarget = currentPeerTarget();
  const print = (value: unknown) => console.log(JSON.stringify(value, null, program.opts().json ? undefined : 2));
  const mutate = (action: string, projectId: string, fields: Record<string, unknown> = {}) =>
    boardRequest<BoardPage>('mutate_project_board', { ...fields, action, projectId });
  const command = (spec: string) => program.command(spec).allowExcessArguments(false);
  if (group === 'projects') {
    command('list').description('List known projects and their homes')
      .action(async () => print({ projects: await directory() }));
    command('create <name>').option('--id <uuid>', 'Stable project ID for retries')
      .action(async (name, options) => print({ project: (await mutate('create_project', options.id ?? randomUUID(), { name })).project }));
    command('rename <project> <name>').action(async (selector, name) => {
      const { id } = await locateProject(selector);
      print({ project: (await mutate('rename_project', id, { name })).project });
    });
    command('delete <project>').action(async selector => {
      const { id } = await locateProject(selector);
      await mutate('delete_project', id);
      print({ projectId: id, deleted: true });
    });
  } else {
    program.option('--project <name|id>', 'Hosted project name or ID');
    const project = () => locateProject(program.opts().project);
    const outputTicket = async (projectId: string, ticketId: string, page?: BoardPage) => {
      const board = await readBoard(projectId, page, ticketId);
      const ticket = board.tickets.find(ticket => ticket.id === ticketId);
      if (!ticket) throw new Error('Ticket not found: ' + ticketId);
      print({ project: board.project, ticket });
    };
    command('list').action(async () => print(await readBoard((await project()).id)));
    command('show <ticket>').action(async ticketId => outputTicket((await project()).id, ticketId));
    editOptions(command('create')).requiredOption('--title <title>').option('--id <uuid>', 'Stable ticket ID for retries')
      .action(async (options: TicketOptions) => {
        const { id } = await project();
        const ticketId = options.id ?? randomUUID();
        const page = await mutate('create_ticket', id, { ...ticketFields(options, true), ticketId });
        await outputTicket(id, ticketId, page);
      });
    editOptions(command('update <ticket>')).option('--title <title>').option('--unlink <session>', 'Remove worker link')
      .action(async (ticketId, options: TicketOptions) => {
        const fields = ticketFields(options, false);
        if (!Object.keys(fields).length) throw new Error('Supply a ticket field to update');
        const { id } = await project();
        await outputTicket(id, ticketId, await mutate('update_ticket', id, { ...fields, ticketId }));
      });
    command('delete <ticket>').action(async ticketId => {
      const { id } = await project();
      await mutate('delete_ticket', id, { ticketId });
      print({ projectId: id, ticketId, deleted: true });
    });
    command('comment <ticket>').requiredOption('--text <text>').option('--id <uuid>', 'Stable comment ID for retries')
      .action(async (ticketId, options) => {
        const { id } = await project();
        const commentId = options.id ?? randomUUID();
        await mutate('add_ticket_comment', id, { ticketId, commentId, text: options.text });
        print({ projectId: id, ticketId, commentId });
      });
    command('comments <ticket>').description('Read all comments, newest first').action(async ticketId => {
      const { id } = await project();
      const comments: Comment[] = [];
      let after: number | undefined;
      do {
        const page: { comments: Comment[]; nextAfter?: number } = await boardRequest('get_ticket_comments',
          { projectId: id, ticketId, ...(after !== undefined && { after }) });
        comments.push(...page.comments);
        after = page.nextAfter;
      } while (after !== undefined);
      print({ comments });
    });
    command('inbox').description('Read ticket messages delivered to the selected bridge')
      .option('--after <sequence>', 'Return messages after this cursor', '0').action(async ({ after }) => {
        if (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))) throw new Error('Invalid --after sequence');
        const page = await api<{ notifications: (TicketNotice & { sequence: number })[]; nextCursor: number }>(
          loadPointer(), 'GET', TICKET_NOTIFICATION_INBOX + '?after=' + after);
        if (program.opts().json) print(page);
        else if (!page.notifications.length) console.log('No ticket messages.');
        else for (const event of page.notifications) console.log(event.sequence, event.projectName, event.title, event.reason, event.stage);
      });
  }
  try {
    await program.parseAsync(args, { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    console.error('ftown ' + group + ': ' + (error instanceof Error ? error.message : String(error)));
    return 1;
  } finally {
    setPeerTarget(originalTarget);
  }
}
