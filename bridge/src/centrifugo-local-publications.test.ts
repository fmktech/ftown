import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CentrifugoClient } from './centrifugo-client.js';
import type { Session, Loop } from './types.js';

function fixture(disabled = false) {
  const client = new CentrifugoClient('ws://127.0.0.1:1/connection/websocket', '', async () => '', { disabled });
  const transport = (client as unknown as { client: {
    state: string;
    publish: (channel: string, data: unknown) => Promise<unknown>;
    connect: () => void;
    newSubscription: () => never;
  } }).client;
  return { client, transport };
}

test('disabled local mode never connects or subscribes, and publishes local events with session secrets removed', async () => {
  const { client, transport } = fixture(true);
  transport.connect = () => { throw new Error('unexpected cloud connect'); };
  transport.newSubscription = () => { throw new Error('unexpected cloud subscription'); };
  transport.publish = () => { throw new Error('unexpected cloud publish'); };
  client.connect();
  client.subscribeToSessions('local');
  client.subscribeToLoops('local');
  client.subscribeToCommands('local', () => {});
  client.subscribeToTerminalInput('local', 's', () => {}, () => {});
  client.joinBridgesChannel('local', 'b');
  const events: Array<{ channel: string; data: unknown }> = [];
  const unsubscribe = client.onLocalPublication((channel, data) => events.push({ channel, data }));
  const session = { id: 's', env: { TOKEN: 'secret' } } as unknown as Session;
  await client.publishSessionUpdate('local', session);
  await client.publishLoopUpdate('local', { id: 'l' } as Loop);
  await client.publishLoopRemoved('local', 'l');
  await client.publishTerminalData('local', 's', 'hello');
  await client.publishTerminalScreen('local', 's', 'screen');
  await client.publishHookEvent('local', 's', { type: 'hook', data: 'event' });
  await client.publishCommandResponse('local', { requestId: 'r', success: true });
  assert.deepEqual(events.map((event) => event.channel), [
    'sessions:updates#local', 'loops:updates#local', 'loops:updates#local',
    'terminal:s#local', 'terminal:s#local', 'events:s#local', 'commands:rpc#local',
  ]);
  assert.equal((events[0].data as { session: Session }).session.env, undefined);
  assert.equal(session.env?.TOKEN, 'secret');
  assert.equal((events[6].data as { response: { requestId: string } }).response.requestId, 'r');
  unsubscribe();
  await client.publishLoopRemoved('local', 'another');
  assert.equal(events.length, 7);
});

test('disconnected cloud does not queue or delay local hook and command acknowledgements', async () => {
  const { client, transport } = fixture();
  transport.publish = () => { throw new Error('unexpected disconnected publish'); };
  transport.newSubscription = () => { throw new Error('unexpected hook subscription'); };
  const events: unknown[] = [];
  client.onLocalPublication((_channel, data) => events.push(data));
  await client.publishHookEvent('user', 's', { type: 'hook' });
  await client.publishCommandResponse('user', { requestId: 'r', success: true });
  assert.equal(events.length, 2);
});

test('cloud publish which never acknowledges cannot stall an already committed local mutation', async () => {
  const { client, transport } = fixture();
  transport.state = 'connected';
  const remote: unknown[] = [];
  transport.publish = (channel, data) => {
    remote.push({ channel, data });
    return new Promise(() => {});
  };
  const local: unknown[] = [];
  client.onLocalPublication((channel, data) => local.push({ channel, data }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.publishLoopRemoved('user', 'l'),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('publication stalled')), 100); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  assert.deepEqual(remote, local);
  assert.equal(local.length, 1);
});

test('rejected cloud delivery does not reject a committed local mutation', async () => {
  const { client, transport } = fixture();
  transport.state = 'connected';
  transport.publish = async () => { throw new Error('cloud disconnected during publish'); };
  const local: unknown[] = [];
  client.onLocalPublication((_channel, data) => local.push(data));
  await assert.doesNotReject(client.publishLoopRemoved('user', 'l'));
  assert.equal(local.length, 1);
});
