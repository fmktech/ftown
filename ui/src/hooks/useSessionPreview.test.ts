// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MessageClient } from '@/lib/message-client';
import type { Command, CommandResponse } from '@/types';
import { useSessionPreview } from './useSessionPreview';
const id = '12345678-1234-4234-8234-123456789abc';
const target = { bridgeId: 'bridge', sessionId: 'one', preview: { id, fileName: 'demo.html' } };
const client = {} as MessageClient;
beforeEach(() => { vi.useFakeTimers(); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('discards a late response after switching sessions and stops after disposal', async () => {
  const resolvers: Array<(value: CommandResponse) => void> = [];
  const sendCommand = vi.fn(() => new Promise<CommandResponse>(r => { resolvers.push(r); }));
  const hook = renderHook(({ selected }) => useSessionPreview({ client, userId: 'user', target: selected, visible: true, readable: true, securityGeneration: 0, sendCommand }), { initialProps: { selected: target } });
  expect(sendCommand).toHaveBeenCalledTimes(1);
  hook.rerender({ selected: { ...target, sessionId: 'two' } });
  expect(sendCommand).toHaveBeenCalledTimes(2);
  await act(async () => { resolvers[0]({ requestId: 'x', success: true, data: { state: 'unregistered' } }); });
  expect(hook.result.current.state.kind).toBe('loading');
  await act(async () => { resolvers[1]({ requestId: 'x', success: true, data: { state: 'unregistered' } }); });
  expect(hook.result.current.state.kind).toBe('unregistered');
  hook.unmount(); await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(sendCommand).toHaveBeenCalledTimes(2);
});
it('retries errors on the next poll and hides old state immediately on security loss', async () => {
  const sendCommand = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ requestId: 'x', success: true, data: { state: 'unregistered' } });
  const hook = renderHook(({ readable }) => useSessionPreview({ client, userId: 'user', target, visible: true, readable, securityGeneration: 0, sendCommand }), { initialProps: { readable: true } });
  await act(async () => {}); expect(hook.result.current.state.kind).toBe('error');
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(hook.result.current.state.kind).toBe('unregistered');
  hook.rerender({ readable: false }); expect(hook.result.current.state.kind).toBe('offline');
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); }); expect(sendCommand).toHaveBeenCalledTimes(2);
});
it('keeps the document key on unchanged polls, remounts on manual refresh, and pauses while hidden', async () => {
  const { createHash } = await import('node:crypto');
  const html = '<p>hello</p>'; const digest = createHash('sha256').update(html).digest(); const revision = digest.toString('hex');
  Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: { digest: async () => Uint8Array.from(digest).buffer } });
  const sendCommand = vi.fn(async (command: Command) => ({ requestId: 'x', success: true, data: command.type === 'session_preview_chunk'
    ? { state: 'chunk', previewId: id, revision, totalBytes: html.length, offset: 0, dataBase64: btoa(html), done: true }
    : { state: 'knownRevision' in command.payload ? 'unchanged' : 'ready', previewId: id, revision, totalBytes: html.length } }));
  const hook = renderHook(() => useSessionPreview({ client, userId: 'user', target, visible: true, readable: true, securityGeneration: 0, sendCommand }));
  await act(async () => {});
  expect(hook.result.current.state.kind).toBe('ready');
  if (hook.result.current.state.kind !== 'ready') throw new Error('expected ready');
  const key = hook.result.current.state.key;
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(hook.result.current.state).toMatchObject({ kind: 'ready', key });
  await act(async () => { hook.result.current.refresh(); });
  expect(hook.result.current.state.kind).toBe('ready');
  if (hook.result.current.state.kind !== 'ready') throw new Error('expected ready');
  expect(hook.result.current.state.key).not.toBe(key);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  const count = sendCommand.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(sendCommand).toHaveBeenCalledTimes(count);
});
it('keeps automatic status checks quiet but shows actual updates and manual refresh', async () => {
  const { createHash } = await import('node:crypto');
  const first = '<p>one</p>'; const second = '<p>two</p>';
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const firstRevision = hash(first); const secondRevision = hash(second);
  Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: { digest: async (_algorithm: string, bytes: Uint8Array) => Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer } });
  const pendingStatuses: Array<(response: CommandResponse) => void> = [];
  let resolveChunk: ((response: CommandResponse) => void) | undefined;
  const reply = (data: unknown): CommandResponse => ({ requestId: 'x', success: true, data });
  const status = (state: 'ready' | 'unchanged', revision: string, text: string) => reply({ state, previewId: id, revision, totalBytes: text.length });
  const chunk = (revision: string, text: string) => reply({ state: 'chunk', previewId: id, revision, totalBytes: text.length, offset: 0, dataBase64: btoa(text), done: true });
  let statuses = 0;
  const sendCommand = vi.fn((command: Command): Promise<CommandResponse> => {
    if (command.type === 'session_preview_status') {
      if (++statuses === 1) return Promise.resolve(status('ready', firstRevision, first));
      return new Promise(resolve => { pendingStatuses.push(resolve); });
    }
    if ('revision' in command.payload && command.payload.revision === firstRevision) return Promise.resolve(chunk(firstRevision, first));
    return new Promise(resolve => { resolveChunk = resolve; });
  });
  const hook = renderHook(() => useSessionPreview({ client, userId: 'user', target, visible: true, readable: true, securityGeneration: 0, sendCommand }));
  await act(async () => {});
  expect(hook.result.current.state).toMatchObject({ kind: 'ready', html: first, updating: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(hook.result.current.state).toMatchObject({ kind: 'ready', html: first, updating: false });
  await act(async () => { pendingStatuses.shift()!(status('unchanged', firstRevision, first)); });
  act(() => hook.result.current.refresh());
  expect(hook.result.current.state).toMatchObject({ kind: 'ready', html: first, updating: true });
  await act(async () => { pendingStatuses.shift()!(status('unchanged', firstRevision, first)); });
  expect(hook.result.current.state).toMatchObject({ kind: 'ready', html: first, updating: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  await act(async () => { pendingStatuses.shift()!(status('ready', secondRevision, second)); });
  expect(hook.result.current.state).toMatchObject({ kind: 'ready', html: first, updating: true });
  await act(async () => { resolveChunk!(chunk(secondRevision, second)); });
  expect(hook.result.current.state).toMatchObject({ kind: 'ready', html: second, updating: false });
});
