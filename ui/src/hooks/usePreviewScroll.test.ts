// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePreviewScroll } from './usePreviewScroll';
import { PREVIEW_SCROLL_CHANNEL as channel, PREVIEW_LINK_CHANNEL, parsePreviewLinkMessage, parsePreviewScrollOwnerKey, previewScrollOwnerKey } from '@/lib/preview-scroll-protocol';
beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('uses only the current opaque frame, snapshots before replacement and restores its coordinates', () => {
  let epoch = 0; const getEpoch = () => epoch;
  const hook = renderHook(({ candidate }) => usePreviewScroll(candidate, 'owner', getEpoch), { initialProps: { candidate: { html: 'one', key: '1' } } });
  const frame = { postMessage: vi.fn() }; Object.defineProperty(hook.result.current.iframeRef, 'current', { configurable: true, value: { contentWindow: frame } });
  const id = hook.result.current.display!.documentId;
  const receive = (data: object, source: object = frame, origin = 'null') => act(() => window.dispatchEvent(new MessageEvent('message', { data, source: source as Window, origin })));
  receive({ channel, documentId: id, kind: 'position', x: 5, y: 90 });
  receive({ channel, documentId: id, kind: 'ready' }, {});
  receive({ channel, documentId: id, kind: 'ready' }, frame, 'https://other.example');
  expect(frame.postMessage).not.toHaveBeenCalled();
  receive({ channel, documentId: id, kind: 'ready' });
  expect(frame.postMessage).toHaveBeenLastCalledWith({ channel, documentId: id, kind: 'restore', x: 0, y: 0 }, '*');
  receive({ channel, documentId: id, kind: 'restored', x: 0, y: 0 });
  receive({ channel, documentId: id, kind: 'position', x: 4, y: 300, extra: true });
  receive({ channel, documentId: id, kind: 'position', x: 4, y: 200 });
  hook.rerender({ candidate: { html: 'two', key: '2' } });
  expect(hook.result.current.display!.key).toBe('1');
  const request = frame.postMessage.mock.calls.at(-1)![0];
  receive({ channel, documentId: id, kind: 'snapshot', requestId: request.requestId, x: 5, y: 240 });
  const next = hook.result.current.display!; expect(next.key).toBe('2');
  receive({ channel, documentId: id, kind: 'position', x: 9, y: 999 });
  receive({ channel, documentId: next.documentId, kind: 'ready' });
  expect(frame.postMessage).toHaveBeenLastCalledWith({ channel, documentId: next.documentId, kind: 'restore', x: 5, y: 240 }, '*');
  epoch++; hook.rerender({ candidate: { html: 'three', key: '3' } });
  receive({ channel, documentId: next.documentId, kind: 'ready' });
  expect(hook.result.current.display!.key).toBe('3');
});
it('commits the latest candidate after the bounded snapshot timeout', () => {
  const getEpoch = () => 0; const hook = renderHook(({ key }) => usePreviewScroll({ html: key, key }, 'owner', getEpoch), { initialProps: { key: '1' } });
  hook.rerender({ key: '2' }); hook.rerender({ key: '3' });
  act(() => vi.advanceTimersByTime(100)); expect(hook.result.current.display!.key).toBe('3');
});

it('preserves the last restored position when a replacement frame snapshots before restoration', () => {
 const getEpoch = () => 0;
 const hook = renderHook(({ key }) => usePreviewScroll({ html: key, key }, 'owner', getEpoch), { initialProps: { key: 'a' } });
 const frame = { postMessage: vi.fn() };
 Object.defineProperty(hook.result.current.iframeRef, 'current', { configurable: true, value: { contentWindow: frame } });
 const receive = (data: object) => act(() => window.dispatchEvent(new MessageEvent('message', { data, source: frame as unknown as Window, origin: 'null' })));
 const a = hook.result.current.display!.documentId;
 receive({ channel, documentId: a, kind: 'ready' });
 receive({ channel, documentId: a, kind: 'restored', x: 0, y: 500 });
 hook.rerender({ key: 'b' });
 const first = frame.postMessage.mock.calls.at(-1)![0];
 receive({ channel, documentId: a, kind: 'snapshot', requestId: first.requestId, x: 0, y: 500 });
 const b = hook.result.current.display!.documentId;
 receive({ channel, documentId: b, kind: 'ready' });
 hook.rerender({ key: 'c' });
 const second = frame.postMessage.mock.calls.at(-1)![0];
 receive({ channel, documentId: b, kind: 'snapshot', requestId: second.requestId, x: 0, y: 0 });
 expect(hook.result.current.display!.key).toBe('b');
 act(() => vi.advanceTimersByTime(100));
 const c = hook.result.current.display!; expect(c.key).toBe('c');
 receive({ channel, documentId: c.documentId, kind: 'ready' });
 expect(frame.postMessage).toHaveBeenLastCalledWith({ channel, documentId: c.documentId, kind: 'restore', x: 0, y: 500 }, '*');
});

it('freezes the confirmed link target and opens it exactly once', () => {
 const getEpoch = () => 0;
 const hook = renderHook(({ key }) => usePreviewScroll({ html: key, key }, 'owner', getEpoch), { initialProps: { key: '1' } });
 const frame = { postMessage: vi.fn() };
 Object.defineProperty(hook.result.current.iframeRef, 'current', { configurable: true, value: { contentWindow: frame } });
 const receiveLink = (url: string) => act(() => window.dispatchEvent(new MessageEvent('message', {
   data: { channel: PREVIEW_LINK_CHANNEL, kind: 'open-link', url }, source: frame as unknown as Window, origin: 'null',
 })));
 const open = vi.fn();
 vi.stubGlobal('open', open);
 try {
   receiveLink('https://trusted.example.test/');
   expect(hook.result.current.linkPrompt).toBe('https://trusted.example.test/');
   // A second frame request while the prompt is shown must not replace the target.
   receiveLink('https://other.example.test/');
   expect(hook.result.current.linkPrompt).toBe('https://trusted.example.test/');
   // Confirmation opens the frozen target once, even under StrictMode.
   act(() => hook.result.current.confirmLink());
   expect(open).toHaveBeenCalledTimes(1);
   expect(open).toHaveBeenCalledWith('https://trusted.example.test/', '_blank', 'noopener,noreferrer');
   expect(hook.result.current.linkPrompt).toBeNull();
 } finally { vi.unstubAllGlobals(); }
});

it('keeps independent scroll coordinates per file owner', () => {
  const getEpoch = () => 0;
  const hook = renderHook(({ candidate, owner }) => usePreviewScroll(candidate, owner, getEpoch), { initialProps: { candidate: { html: 'a', key: 'a1' } as { html: string; key: string } | null, owner: 'owner-a' } });
  const frame = { postMessage: vi.fn() };
  Object.defineProperty(hook.result.current.iframeRef, 'current', { configurable: true, value: { contentWindow: frame } });
  const receive = (data: object) => act(() => window.dispatchEvent(new MessageEvent('message', { data, source: frame as unknown as Window, origin: 'null' })));
  const a1 = hook.result.current.display!.documentId;
  receive({ channel, documentId: a1, kind: 'ready' });
  receive({ channel, documentId: a1, kind: 'restored', x: 0, y: 0 });
  receive({ channel, documentId: a1, kind: 'position', x: 0, y: 300 });
  hook.rerender({ candidate: null, owner: 'owner-b' });
  hook.rerender({ candidate: { html: 'b', key: 'b1' }, owner: 'owner-b' });
  const b1 = hook.result.current.display!.documentId;
  receive({ channel, documentId: b1, kind: 'ready' });
  expect(frame.postMessage).toHaveBeenLastCalledWith({ channel, documentId: b1, kind: 'restore', x: 0, y: 0 }, '*');
  receive({ channel, documentId: b1, kind: 'restored', x: 0, y: 0 });
  receive({ channel, documentId: b1, kind: 'position', x: 0, y: 700 });
  hook.rerender({ candidate: null, owner: 'owner-a' });
  hook.rerender({ candidate: { html: 'a', key: 'a1' }, owner: 'owner-a' });
  const a2 = hook.result.current.display!.documentId;
  receive({ channel, documentId: a2, kind: 'ready' });
  expect(frame.postMessage).toHaveBeenLastCalledWith({ channel, documentId: a2, kind: 'restore', x: 0, y: 300 }, '*');
});

it('switches the owner directly without a loading gap and restores the earlier position', () => {
  const getEpoch = () => 0;
  const hook = renderHook(({ candidate, owner }) => usePreviewScroll(candidate, owner, getEpoch), { initialProps: { candidate: { html: 'a', key: 'a1' } as { html: string; key: string } | null, owner: 'owner-a' } });
  const frame = { postMessage: vi.fn() };
  Object.defineProperty(hook.result.current.iframeRef, 'current', { configurable: true, value: { contentWindow: frame } });
  const receive = (data: object) => act(() => window.dispatchEvent(new MessageEvent('message', { data, source: frame as unknown as Window, origin: 'null' })));
  const a1 = hook.result.current.display!.documentId;
  receive({ channel, documentId: a1, kind: 'ready' });
  receive({ channel, documentId: a1, kind: 'restored', x: 0, y: 0 });
  receive({ channel, documentId: a1, kind: 'position', x: 12, y: 400 });
  hook.rerender({ candidate: { html: 'b', key: 'b1' }, owner: 'owner-b' });
  const b1 = hook.result.current.display!;
  expect(b1.key).toBe('b1');
  receive({ channel, documentId: b1.documentId, kind: 'ready' });
  expect(frame.postMessage).toHaveBeenLastCalledWith({ channel, documentId: b1.documentId, kind: 'restore', x: 0, y: 0 }, '*');
  hook.rerender({ candidate: { html: 'a', key: 'a1' }, owner: 'owner-a' });
  const a2 = hook.result.current.display!;
  receive({ channel, documentId: a2.documentId, kind: 'ready' });
  expect(frame.postMessage).toHaveBeenLastCalledWith({ channel, documentId: a2.documentId, kind: 'restore', x: 12, y: 400 }, '*');
});

it('forwards switch-file messages to the caller and ignores malformed ones', () => {
  const onSwitchFile = vi.fn();
  const hook = renderHook(() => usePreviewScroll({ html: 'a', key: 'a1' }, 'owner-a', () => 0, onSwitchFile));
  const frame = { postMessage: vi.fn() };
  Object.defineProperty(hook.result.current.iframeRef, 'current', { configurable: true, value: { contentWindow: frame } });
  const receive = (data: object) => act(() => window.dispatchEvent(new MessageEvent('message', { data, source: frame as unknown as Window, origin: 'null' })));
  receive({ channel: PREVIEW_LINK_CHANNEL, kind: 'switch-file', fileName: 'notes.md' });
  expect(onSwitchFile).toHaveBeenCalledTimes(1);
  expect(onSwitchFile).toHaveBeenCalledWith('notes.md');
  for (const bad of [
    { channel: PREVIEW_LINK_CHANNEL, kind: 'switch-file' },
    { channel: PREVIEW_LINK_CHANNEL, kind: 'switch-file', fileName: '' },
    { channel: PREVIEW_LINK_CHANNEL, kind: 'switch-file', fileName: 'notes.md', extra: true },
    { channel: PREVIEW_LINK_CHANNEL, kind: 'open-link' },
  ]) receive(bad);
  expect(onSwitchFile).toHaveBeenCalledTimes(1);
  expect(hook.result.current.linkPrompt).toBeNull();
});

it('rejects switch-file and open-link from a foreign origin', () => {
  const onSwitchFile = vi.fn();
  const hook = renderHook(() => usePreviewScroll({ html: 'a', key: 'a1' }, 'owner-a', () => 0, onSwitchFile));
  const frame = { postMessage: vi.fn() };
  Object.defineProperty(hook.result.current.iframeRef, 'current', { configurable: true, value: { contentWindow: frame } });
  const receive = (data: object, origin: string) => act(() => window.dispatchEvent(new MessageEvent('message', { data, source: frame as unknown as Window, origin })));
  receive({ channel: PREVIEW_LINK_CHANNEL, kind: 'switch-file', fileName: 'notes.md' }, 'https://other.example');
  expect(onSwitchFile).not.toHaveBeenCalled();
  receive({ channel: PREVIEW_LINK_CHANNEL, kind: 'open-link', url: 'https://trusted.example.test/' }, 'https://other.example');
  expect(hook.result.current.linkPrompt).toBeNull();
  // Positive control: the sandboxed frame's opaque origin still forwards.
  receive({ channel: PREVIEW_LINK_CHANNEL, kind: 'switch-file', fileName: 'notes.md' }, 'null');
  expect(onSwitchFile).toHaveBeenCalledTimes(1);
  expect(onSwitchFile).toHaveBeenCalledWith('notes.md');
});

it('rejects open-link from a foreign source even with the correct origin', () => {
  const onSwitchFile = vi.fn();
  const hook = renderHook(() => usePreviewScroll({ html: 'a', key: 'a1' }, 'owner-a', () => 0, onSwitchFile));
  const frame = { postMessage: vi.fn() };
  Object.defineProperty(hook.result.current.iframeRef, 'current', { configurable: true, value: { contentWindow: frame } });
  const receive = (data: object, source: object) => act(() => window.dispatchEvent(new MessageEvent('message', { data, source: source as unknown as Window, origin: 'null' })));
  receive({ channel: PREVIEW_LINK_CHANNEL, kind: 'open-link', url: 'https://trusted.example.test/' }, {});
  expect(hook.result.current.linkPrompt).toBeNull();
  receive({ channel: PREVIEW_LINK_CHANNEL, kind: 'switch-file', fileName: 'notes.md' }, {});
  expect(onSwitchFile).not.toHaveBeenCalled();
  // Positive control: the current frame with the correct origin prompts.
  receive({ channel: PREVIEW_LINK_CHANNEL, kind: 'open-link', url: 'https://trusted.example.test/' }, frame);
  expect(hook.result.current.linkPrompt).toBe('https://trusted.example.test/');
});

it('round-trips the per-file owner key and rejects bad keys', () => {
  const owner = { userId: 'user', bridgeId: 'bridge', sessionId: 'one', previewId: '11111111-1111-4111-8111-111111111111', fileId: '22222222-2222-4222-8222-222222222222' };
  const key = previewScrollOwnerKey(owner);
  expect(key).toBe(JSON.stringify(['user', 'bridge', 'one', owner.previewId, owner.fileId]));
  expect(parsePreviewScrollOwnerKey(key)).toEqual(owner);
  expect(parsePreviewScrollOwnerKey(JSON.stringify(['user', 'bridge', 'one']))).toBeNull();
  expect(parsePreviewScrollOwnerKey('not-json')).toBeNull();
  expect(parsePreviewScrollOwnerKey(JSON.stringify(['user', 'bridge', 'one', 1, 2]))).toBeNull();
});

it('parses link messages strictly', () => {
  expect(parsePreviewLinkMessage({ channel: PREVIEW_LINK_CHANNEL, kind: 'open-link', url: 'https://example.test/' })).toEqual({ channel: PREVIEW_LINK_CHANNEL, kind: 'open-link', url: 'https://example.test/' });
  expect(parsePreviewLinkMessage({ channel: PREVIEW_LINK_CHANNEL, kind: 'switch-file', fileName: 'notes.md' })).toEqual({ channel: PREVIEW_LINK_CHANNEL, kind: 'switch-file', fileName: 'notes.md' });
  expect(parsePreviewLinkMessage({ channel: PREVIEW_LINK_CHANNEL, kind: 'open-link', url: 'https://example.test/', extra: 1 })).toBeNull();
  expect(parsePreviewLinkMessage({ channel: 'other', kind: 'switch-file', fileName: 'notes.md' })).toBeNull();
  expect(parsePreviewLinkMessage({ channel: PREVIEW_LINK_CHANNEL, kind: 'switch-file', fileName: 1 })).toBeNull();
  expect(parsePreviewLinkMessage(null)).toBeNull();
});
