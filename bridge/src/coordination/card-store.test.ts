import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Session } from '../types.js';
import { CardStore } from './card-store.js';
import { CardValidationError, type CardPatch, type SessionCardDeclared } from './contract.js';

const NOW = Date.parse('2026-01-02T03:04:05.000Z');
const NOW_ISO = '2026-01-02T03:04:05.000Z';

interface Change {
  session: Session;
  previous: SessionCardDeclared | null;
}

function makeSession(id: string, card?: SessionCardDeclared): Session {
  const session: Session = {
    id,
    name: `name-${id}`,
    command: 'shell',
    status: 'running',
    bridgeId: 'bridge-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  if (card) session.card = card;
  return session;
}

function makeHarness(onChange?: (session: Session, previous: SessionCardDeclared | null) => void | Promise<void>) {
  const sessions = new Map<string, Session>();
  const changes: Change[] = [];
  const store = new CardStore({
    loadSession: async (id) => sessions.get(id) ?? null,
    saveSession: async (session) => { sessions.set(session.id, session); },
    onChange: onChange ?? ((session, previous) => { changes.push({ session, previous }); }),
    now: () => NOW,
  });
  return { sessions, changes, store };
}

function existingCard(overrides: Partial<SessionCardDeclared> = {}): SessionCardDeclared {
  return {
    state: 'working',
    headline: 'Existing headline',
    progress: { done: 1, total: 4 },
    next: 'Existing next',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function expectValidation(store: CardStore, id: string, patch: unknown): Promise<void> {
  await assert.rejects(store.set(id, patch as CardPatch), CardValidationError);
}

test('valid create stamps updatedAt, preserves other session fields, and notifies with null previous', async () => {
  const { sessions, changes, store } = makeHarness();
  sessions.set('s1', makeSession('s1'));

  const card = await store.set('s1', {
    state: 'working',
    headline: 'Building the store',
    progress: { done: 1, total: 3 },
    next: 'Write tests',
  });

  assert.deepEqual(card, {
    state: 'working',
    headline: 'Building the store',
    progress: { done: 1, total: 3 },
    next: 'Write tests',
    updatedAt: NOW_ISO,
  });
  const saved = sessions.get('s1');
  assert.equal(saved?.name, 'name-s1');
  assert.equal(saved?.command, 'shell');
  assert.deepEqual(saved?.card, card);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].previous, null);
  assert.deepEqual(changes[0].session.card, card);
  assert.deepEqual(await store.get('s1'), card);
});

test('partial update leaves omitted fields unchanged and stamps updatedAt', async () => {
  const { sessions, store } = makeHarness();
  sessions.set('s1', makeSession('s1', existingCard()));

  const card = await store.set('s1', { headline: 'Updated headline' });

  assert.deepEqual(card, {
    state: 'working',
    headline: 'Updated headline',
    progress: { done: 1, total: 4 },
    next: 'Existing next',
    updatedAt: NOW_ISO,
  });
});

test('null removes progress, next, and blockedOn', async () => {
  const { sessions, store } = makeHarness();
  sessions.set('s1', makeSession('s1', existingCard({
    state: 'blocked',
    blockedOn: { kind: 'human', text: 'Need approval' },
  })));

  const card = await store.set('s1', { progress: null, next: null, blockedOn: null });

  assert.deepEqual(card, {
    state: 'blocked',
    headline: 'Existing headline',
    updatedAt: NOW_ISO,
  });
});

test('blockedOn auto-clears when state leaves blocked, but explicit blockedOn is kept', async () => {
  const { sessions, store } = makeHarness();
  sessions.set('s1', makeSession('s1', existingCard({
    state: 'blocked',
    blockedOn: { kind: 'external', text: 'Waiting on CI' },
  })));

  const cleared = await store.set('s1', { state: 'working' });
  assert.equal(cleared.blockedOn, undefined);

  sessions.set('s2', makeSession('s2', existingCard({ state: 'blocked', blockedOn: { kind: 'human', text: 'Old' } })));
  const kept = await store.set('s2', { state: 'working', blockedOn: { kind: 'human', text: 'Still noted' } });
  assert.deepEqual(kept.blockedOn, { kind: 'human', text: 'Still noted' });
});

test('blocked state without blockedOn is allowed and session blockedOn ref is stored', async () => {
  const { sessions, store } = makeHarness();
  sessions.set('s1', makeSession('s1'));

  const blocked = await store.set('s1', { state: 'blocked', headline: 'Stuck' });
  assert.equal(blocked.blockedOn, undefined);

  const withRef = await store.set('s1', { blockedOn: { kind: 'session', ref: 'child-1_A', text: 'Waiting on child' } });
  assert.deepEqual(withRef.blockedOn, { kind: 'session', ref: 'child-1_A', text: 'Waiting on child' });
});

test('control characters are stripped and whitespace is collapsed', async () => {
  const { sessions, store } = makeHarness();
  sessions.set('s1', makeSession('s1'));

  const card = await store.set('s1', {
    state: 'working',
    headline: '  Hello' + String.fromCharCode(0) + ' \n\t world' + String.fromCharCode(7) + '  ',
    next: 'Next' + String.fromCharCode(0) + '   step',
  });

  assert.equal(card.headline, 'Hello world');
  assert.equal(card.next, 'Next step');
});

test('validation errors cover state, limits, blockedOn, progress, first write, empty and unknown keys', async () => {
  const { sessions, store } = makeHarness();
  sessions.set('s1', makeSession('s1', existingCard()));
  sessions.set('fresh', makeSession('fresh'));

  await expectValidation(store, 's1', { state: 'nope' });
  await expectValidation(store, 's1', { headline: '   ' });
  await expectValidation(store, 's1', { headline: 'x'.repeat(141) });
  await expectValidation(store, 's1', { next: 'x'.repeat(281) });
  await expectValidation(store, 's1', { blockedOn: { kind: 'nope', text: 'Wait' } });
  await expectValidation(store, 's1', { blockedOn: { kind: 'human', text: '  ' } });
  await expectValidation(store, 's1', { blockedOn: { kind: 'human', text: 'x'.repeat(281) } });
  await expectValidation(store, 's1', { blockedOn: { kind: 'session', text: 'Wait' } });
  await expectValidation(store, 's1', { blockedOn: { kind: 'session', ref: 'bad ref!', text: 'Wait' } });
  await expectValidation(store, 's1', { blockedOn: { kind: 'human', ref: 's1', text: 'Wait' } });
  await expectValidation(store, 's1', { progress: { done: 5, total: 4 } });
  await expectValidation(store, 's1', { progress: { done: 0, total: 0 } });
  await expectValidation(store, 's1', { progress: { done: 0, total: 10_001 } });
  await expectValidation(store, 's1', { progress: { done: 1.5, total: 4 } });
  await expectValidation(store, 's1', { progress: { done: -1, total: 4 } });
  await expectValidation(store, 'fresh', { headline: 'Only headline' });
  await expectValidation(store, 'fresh', { state: 'working' });
  await assert.rejects(store.set('s1', {}), (error: unknown) => {
    assert.ok(error instanceof CardValidationError);
    assert.equal(error.message, 'Empty card update');
    return true;
  });
  await expectValidation(store, 's1', { headline: 'Ok', bogus: true });
});

test('onChange receives the previous card', async () => {
  const { sessions, changes, store } = makeHarness();
  const previous = existingCard();
  sessions.set('s1', makeSession('s1', previous));

  await store.set('s1', { headline: 'New headline' });

  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].previous, previous);
  assert.equal(changes[0].session.card?.headline, 'New headline');
});

test('onChange throwing does not fail set, and clear notifies after removing the card', async () => {
  const throwing = makeHarness(() => { throw new Error('publish failed'); });
  throwing.sessions.set('s1', makeSession('s1'));
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    const card = await throwing.store.set('s1', { state: 'working', headline: 'Still saved' });
    assert.equal(card.headline, 'Still saved');
  } finally {
    console.warn = originalWarn;
  }

  const { sessions, changes, store } = makeHarness();
  const previous = existingCard();
  sessions.set('s1', makeSession('s1', previous));
  await store.clear('s1');
  assert.equal(sessions.get('s1')?.card, undefined);
  assert.equal(await store.get('s1'), null);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].previous, previous);

  await store.clear('s1');
  assert.equal(changes.length, 1, 'clear with no card is a no-op');
});

test('review fixes: empty next removes, code-point length, ref null absent, undefined keys omitted, clear missing no-op', async () => {
  const { sessions, changes, store } = makeHarness();
  sessions.set('s1', makeSession('s1', existingCard()));

  const withoutNext = await store.set('s1', { next: '   ' });
  assert.equal(withoutNext.next, undefined);

  sessions.set('s1', makeSession('s1', existingCard()));
  const withRefNull = await store.set('s1', { blockedOn: { kind: 'human', ref: null, text: 'Wait' } } as unknown as CardPatch);
  assert.deepEqual(withRefNull.blockedOn, { kind: 'human', text: 'Wait' });

  sessions.set('s1', makeSession('s1', existingCard()));
  const withUndefined = await store.set('s1', {
    headline: 'New headline',
    state: undefined,
    next: undefined,
    bogus: undefined,
  } as unknown as CardPatch);
  assert.equal(withUndefined.headline, 'New headline');
  assert.equal(withUndefined.state, 'working');
  assert.equal(withUndefined.next, 'Existing next');
  await expectValidation(store, 's1', { headline: undefined });
  sessions.set('fresh', makeSession('fresh'));
  await expectValidation(store, 'fresh', { state: undefined, headline: 'Only headline' });

  const emoji = String.fromCodePoint(0x1f600);
  sessions.set('s2', makeSession('s2'));
  const emojiCard = await store.set('s2', { state: 'working', headline: emoji.repeat(140) });
  assert.equal([...emojiCard.headline].length, 140);
  assert.equal(emojiCard.headline.length, 280);
  await expectValidation(store, 's2', { headline: emoji.repeat(141) });

  const changesBefore = changes.length;
  await assert.doesNotReject(store.clear('missing'));
  assert.equal(changes.length, changesBefore);
  assert.equal(await store.get('missing'), null);
});

test('missing session: set throws Session not found and get returns null', async () => {
  const { store } = makeHarness();

  await assert.rejects(store.set('missing', { state: 'working', headline: 'Hi' }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!(error instanceof CardValidationError));
    assert.equal(error.message, 'Session not found');
    return true;
  });
  assert.equal(await store.get('missing'), null);
});
