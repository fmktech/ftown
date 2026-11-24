import { randomUUID } from 'node:crypto';
import type { Command } from 'commander';
import { api, loadPointer } from './cli-client.js';
import type { HomeProject } from './project-board-store.js';

interface Channel { id: string; name: string; archived: boolean }
interface Page { after?: string }
interface PostOptions { text: string; title?: string; id?: string; mention?: string[] }

function cursor(options: Page): { after?: number } {
  if (options.after === undefined) return {};
  const after = Number(options.after);
  if (!/^\d+$/.test(options.after) || !Number.isSafeInteger(after)) throw new Error('--after requires a nonnegative integer');
  return { after };
}

function postFields(options: PostOptions) {
  const tokens = new Set(options.mention ?? []);
  for (const match of options.text.matchAll(/(?:^|\s)@([\w-]+\/[\w-]+)(?![\w/-])/g)) tokens.add(match[1]);
  const mentions = [...tokens].map(token => {
    const pair = /^([\w-]+)\/([\w-]+)$/.exec(token);
    if (!pair) throw new Error('Mention a project session using <bridge-id>/<session-id>');
    return { bridgeId: pair[1], sessionId: pair[2] };
  });
  return { text: options.text, ...(mentions.length ? { mentions } : {}) };
}

export function registerDiscussionCommands(program: Command, project: () => Promise<HomeProject>, print: (value: unknown) => void) {
  const read = <T>(projectId: string, action: string, fields: Record<string, unknown> = {}) =>
    api<T>(loadPointer(), 'POST', '/api/project-board/get_project_discussion', { projectId, action, ...fields });
  const write = async (projectId: string, action: string, fields: Record<string, unknown>) => {
    const actorSessionId = process.env.FTOWN_SESSION_ID;
    print(await api(loadPointer(), 'POST', '/api/project-board/mutate_project_discussion',
      { projectId, action, ...fields, ...(actorSessionId ? { actorSessionId } : {}) }));
  };
  async function channelId(projectId: string, selector: string) {
    const name = selector.replace(/^#/, '').toLowerCase();
    let after: number | undefined;
    do {
      const page: { channels: Channel[]; nextAfter?: number } = await read(projectId, 'channels', after === undefined ? {} : { after });
      const channel = page.channels.find(row => row.id === selector) ?? page.channels.find(row => row.name === name);
      if (channel) return channel.id;
      after = page.nextAfter;
    } while (after !== undefined);
    throw new Error('Unknown project channel: ' + selector);
  }
  const onChannel = async (selector: string) => {
    const { id: projectId } = await project();
    return { projectId, channelId: await channelId(projectId, selector) };
  };
  const pageOptions = (cmd: Command) => cmd.option('--after <sequence>', 'Read the next page after this sequence number');
  const messageOptions = (cmd: Command) => cmd.requiredOption('--text <message>', 'Message body')
    .option('--mention <bridge-id/session-id>', 'Notify a project session (repeatable)', (value: string, previous: string[]) => [...previous, value], []);
  const channels = program.command('channels').description('List and manage project channels');
  pageOptions(channels.command('list')).description('List channels, including archived channels').action(async options =>
    print(await read((await project()).id, 'channels', cursor(options))));
  channels.command('create <name>').option('--id <uuid>', 'Stable channel ID for retries').action(async (name, options) =>
    write((await project()).id, 'create_channel', { name, channelId: options.id ?? randomUUID() }));
  channels.command('rename <channel> <name>').action(async (selector, name) => {
    const { projectId, channelId } = await onChannel(selector);
    await write(projectId, 'rename_channel', { channelId, name });
  });
  channels.command('archive <channel>').description('Preserve history and close the channel to new posts').action(async selector => {
    const { projectId, channelId } = await onChannel(selector);
    await write(projectId, 'archive_channel', { channelId });
  });
  pageOptions(program.command('threads <channel>')).description('List threads in the channel').action(async (selector, options) => {
    const { projectId, channelId } = await onChannel(selector);
    print(await read(projectId, 'threads', { channelId, ...cursor(options) }));
  });
  messageOptions(program.command('post <channel>')).requiredOption('--title <title>', 'Thread title')
    .option('--id <uuid>', 'Stable thread ID for retries').description('Start a thread').action(async (selector, options: PostOptions) => {
      const { projectId, channelId } = await onChannel(selector);
      const threadId = options.id ?? randomUUID();
      await write(projectId, 'create_thread', { channelId, threadId, postId: threadId, title: options.title, ...postFields(options) });
    });
  messageOptions(program.command('reply <thread>')).description('Post a reply in the project discussion thread')
    .option('--id <uuid>', 'Stable reply ID for retries').action(async (threadId, options: PostOptions) =>
    write((await project()).id, 'reply', { threadId, postId: options.id ?? randomUUID(), ...postFields(options) }));
  pageOptions(program.command('read <thread>')).description('Read posts in a thread').action(async (threadId, options) =>
    print(await read((await project()).id, 'posts', { threadId, ...cursor(options) })));
  pageOptions(program.command('activity <channel>')).description('Read channel posts in sequence order').action(async (selector, options) => {
    const { projectId, channelId } = await onChannel(selector);
    print(await read(projectId, 'posts', { channelId, ...cursor(options) }));
  });
  for (const action of ['follow', 'unfollow']) program.command(action + ' <thread>').description(action === 'follow'
    ? 'Notify the calling session when a reply is posted to the thread' : 'Stop reply notifications for this thread').action(async threadId => {
    if (!process.env.FTOWN_SESSION_ID) throw new Error('Run this command from an ftown session');
    await write((await project()).id, action, { threadId });
  });
  program.command('link <thread> <ticket>').description('Link a thread to an existing project ticket').action(async (threadId, ticketId) =>
    write((await project()).id, 'link_ticket', { threadId, ticketId }));
  program.command('create-ticket <thread>').requiredOption('--title <title>', 'Ticket title').option('--id <uuid>', 'Stable ticket ID for retries')
    .description('Create a project ticket and link the thread').action(async (threadId, options) =>
      write((await project()).id, 'create_ticket', { threadId, ticketId: options.id ?? randomUUID(), title: options.title }));
  pageOptions(program.command('for-ticket <ticket>')).description('Find discussions linked to a ticket').action(async (ticketId, options) =>
    print(await read((await project()).id, 'threads', { ticketId, ...cursor(options) })));
}
