// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { MessageClient } from '@/lib/message-client';
import type { Command, CommandResponse, Session } from '@/types';
import { usePreviewConversation } from './usePreviewConversation';
import type { PreviewChatWriteRequest, PreviewChatListRequest } from '../../../bridge/src/preview-chat-protocol';
afterEach(() => cleanup());
function fixture() {
  const endpoint = { version: 1, id: 'bridge-key', ownerId: 'owner', kind: 'bridge', publicKey: 'key' };
  const pin = { endpoint, permissions: ['read', 'control'] }; const listeners = new Set<() => void>(); let allowed = true;
  const runtime = { identity: { endpoint: { ...endpoint, id: 'browser', kind: 'browser' } }, bridge: () => pin, state: () => ({ status: 'ready' }), assertCanSend: () => { if (!allowed) throw Error('revoked'); }, onChange: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); } };
  const session = { id: 'one', bridgeId: 'bridge', status: 'running', shellType: 'codex' } as Session;
  const revoke = (value: boolean) => { allowed = value; listeners.forEach(fn => fn()); };
  return { client: { securityRuntime: runtime } as unknown as MessageClient, session, revoke };
}
it('retains an edited draft when an earlier send is acknowledged and fences batched authority loss', async () => {
  const h = fixture(); let resolve!: (response: CommandResponse) => void; let sent!: Command;
  const sendCommand = vi.fn((command: Command): Promise<CommandResponse> => {
    if (command.type === 'preview_chat_list') return Promise.resolve({ requestId: 'x', success: true, data: { sessionId: 'one', cursor: 'one:0', turns: [], hasMore: false } });
    sent = command; return new Promise(r => { resolve = r; });
  });
  const hook = renderHook(() => usePreviewConversation({ ...h, sessions: [h.session], userId: 'user', readable: true, enabled: true, sendCommand }));
  await act(async () => {}); act(() => hook.result.current.setDraft('first'));
  act(() => { void hook.result.current.send(); }); act(() => hook.result.current.setDraft('edited'));
  if (sent.type !== 'preview_chat_send' || !('id' in sent.payload)) throw Error('unexpected command');
  const sentPayload = sent.payload as PreviewChatWriteRequest;
  await act(async () => resolve({ requestId: 'x', success: true, data: { sessionId: 'one', turn: { id: sentPayload.id, sequence: 1, text: 'first', role: 'user', delivery: 'queued', createdAt: new Date().toISOString() } } }));
  expect(hook.result.current.draft).toBe('edited'); expect(hook.result.current.turns).toHaveLength(1);
  act(() => { h.revoke(false); h.revoke(true); });
  expect(hook.result.current.draft).toBe(''); expect(hook.result.current.turns).toHaveLength(0);
});
it('retries an uncertain transport result with the same message id', async () => {
  const h = fixture(); const ids: string[] = [];
  const sendCommand = vi.fn(async (command: Command): Promise<CommandResponse> => {
    if (command.type === 'preview_chat_list') return { requestId: 'x', success: true, data: { sessionId: 'one', cursor: 'one:0', turns: [], hasMore: false } };
    if (command.type !== 'preview_chat_send' || !('id' in command.payload) || !('text' in command.payload)) throw Error('unexpected'); const payload = command.payload as PreviewChatWriteRequest; ids.push(payload.id);
    if (ids.length === 1) throw Error('lost response');
    return { requestId: 'x', success: true, data: { sessionId: 'one', turn: { id: payload.id, sequence: 1, text: payload.text, role: 'user', delivery: 'queued', createdAt: new Date().toISOString() } } };
  });
  const hook = renderHook(() => usePreviewConversation({ ...h, sessions: [h.session], userId: 'user', readable: true, enabled: true, sendCommand }));
  await act(async () => {}); act(() => hook.result.current.setDraft('hello'));
  await act(async () => hook.result.current.send()); expect(hook.result.current.pendingMode).toBe('uncertain');
  await act(async () => hook.result.current.send()); expect(ids).toHaveLength(2); expect(ids[1]).toBe(ids[0]); expect(hook.result.current.draft).toBe('');
});

it('requires an explicit new ID after unconfirmed delivery and retains per-session drafts', async () => {
 const h = fixture(); const second = { ...h.session, id: 'two' }; const ids: string[] = [];
 const sendCommand = vi.fn(async (command: Command): Promise<CommandResponse> => {
  if (command.type === 'preview_chat_list') { const payload = command.payload as PreviewChatListRequest; return { requestId: 'x', success: true, data: { sessionId: payload.sessionId, cursor: `${payload.sessionId}:0`, turns: [], hasMore: false } }; }
  if (command.type !== 'preview_chat_send' || !('id' in command.payload) || !('text' in command.payload)) throw Error('unexpected');
  const payload = command.payload as PreviewChatWriteRequest; ids.push(payload.id); return { requestId: 'x', success: true, data: { sessionId: command.payload.sessionId, turn: { id: payload.id, sequence: ids.length, text: payload.text, role: 'user', delivery: ids.length === 1 ? 'unconfirmed' : 'queued', createdAt: new Date().toISOString() } } };
 });
 const hook = renderHook(({ session }) => usePreviewConversation({ client: h.client, session, sessions: [h.session, second], userId: 'user', readable: true, enabled: true, sendCommand }), { initialProps: { session: h.session } });
 await act(async () => {}); act(() => hook.result.current.setDraft('same')); await act(async () => hook.result.current.send());
 expect(hook.result.current.pendingMode).toBe('unconfirmed'); expect(hook.result.current.draft).toBe('same');
 hook.rerender({ session: second }); act(() => hook.result.current.setDraft('other'));
 hook.rerender({ session: h.session }); expect(hook.result.current.draft).toBe('same');
 await act(async () => hook.result.current.send()); expect(ids).toHaveLength(2); expect(ids[1]).not.toBe(ids[0]); expect(hook.result.current.draft).toBe('');
 hook.rerender({ session: second }); expect(hook.result.current.draft).toBe('other');
});

it.each([undefined, 'outcome_unknown', 'bridge_offline', 'new_transport_error'])(
 'reuses the message ID after an ambiguous failure envelope (%s)', async (code) => {
 const h = fixture(); const ids: string[] = [];
 const sendCommand = vi.fn(async (command: Command): Promise<CommandResponse> => {
  if (command.type === 'preview_chat_list') return { requestId: 'x', success: true, data: { sessionId: 'one', cursor: 'one:0', turns: [], hasMore: false } };
  if (command.type !== 'preview_chat_send') throw Error('unexpected');
  const payload = command.payload as PreviewChatWriteRequest; ids.push(payload.id);
  if (ids.length === 1) return { requestId: 'x', success: false, error: 'transport failed', ...(code ? { data: { code } } : {}) };
  return { requestId: 'x', success: true, data: { sessionId: 'one', turn: { id: payload.id, sequence: 1, text: payload.text, role: 'user', delivery: 'queued', createdAt: new Date().toISOString() } } };
 });
 const hook = renderHook(() => usePreviewConversation({ ...h, sessions: [h.session], userId: 'user', readable: true, enabled: true, sendCommand }));
 await act(async () => {}); act(() => hook.result.current.setDraft('message'));
 await act(async () => hook.result.current.send()); expect(hook.result.current.pendingMode).toBe('uncertain');
 await act(async () => hook.result.current.send()); expect(ids).toHaveLength(2); expect(ids[1]).toBe(ids[0]);
 expect(hook.result.current.draft).toBe('');
});
it('clears an ID after a definite pre-reservation rejection', async () => {
 const h = fixture(); const ids: string[] = [];
 const sendCommand = vi.fn(async (command: Command): Promise<CommandResponse> => {
  if (command.type === 'preview_chat_list') return { requestId: 'x', success: true, data: { sessionId: 'one', cursor: 'one:0', turns: [], hasMore: false } };
  const payload = command.payload as PreviewChatWriteRequest; ids.push(payload.id);
  return { requestId: 'x', success: false, data: { code: 'unsupported' } };
 });
 const hook = renderHook(() => usePreviewConversation({ ...h, sessions: [h.session], userId: 'user', readable: true, enabled: true, sendCommand }));
 await act(async () => {}); act(() => hook.result.current.setDraft('message'));
 await act(async () => hook.result.current.send()); expect(hook.result.current.pendingMode).toBeNull();
 await act(async () => hook.result.current.send()); expect(ids).toHaveLength(2); expect(ids[1]).not.toBe(ids[0]);
});
