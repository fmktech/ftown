// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionPreviewDescriptor } from '../../../bridge/src/preview-protocol';
import { usePreviewDismissal } from './usePreviewDismissal';

const descriptor: SessionPreviewDescriptor = { id: 'p1', files: [{ id: 'f1', fileName: 'index.html', kind: 'html' }] };
const next: SessionPreviewDescriptor = { id: 'p2', files: [{ id: 'f1', fileName: 'index.html', kind: 'html' }] };

afterEach(() => { cleanup(); window.localStorage.clear(); vi.restoreAllMocks(); });

it('keeps a dismissed preview closed across a remount', () => {
  const first = renderHook(() => usePreviewDismissal());
  act(() => first.result.current.setPreviewDismissed('b:s1', descriptor, true));
  expect(first.result.current.isDismissed('b:s1', descriptor)).toBe(true);
  first.unmount();
  const second = renderHook(() => usePreviewDismissal());
  expect(second.result.current.isDismissed('b:s1', descriptor)).toBe(true);
  expect(second.result.current.isDismissed('b:s2', descriptor)).toBe(false);
});

it('shows a new revision of the same session again', () => {
  const { result } = renderHook(() => usePreviewDismissal());
  act(() => result.current.setPreviewDismissed('b:s1', descriptor, true));
  expect(result.current.isDismissed('b:s1', next)).toBe(false);
});

it('reopening clears the flag for that revision', () => {
  const { result } = renderHook(() => usePreviewDismissal());
  act(() => result.current.setPreviewDismissed('b:s1', descriptor, true));
  act(() => result.current.setPreviewDismissed('b:s1', descriptor, false));
  expect(result.current.isDismissed('b:s1', descriptor)).toBe(false);
  const reloaded = renderHook(() => usePreviewDismissal());
  expect(reloaded.result.current.isDismissed('b:s1', descriptor)).toBe(false);
});

it('still dismisses in memory when storage throws', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  const { result } = renderHook(() => usePreviewDismissal());
  act(() => result.current.setPreviewDismissed('b:s1', descriptor, true));
  expect(result.current.isDismissed('b:s1', descriptor)).toBe(true);
});
