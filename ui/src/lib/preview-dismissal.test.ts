// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionPreviewDescriptor } from '../../../bridge/src/preview-protocol';
import { PREVIEW_DISMISSAL_STORAGE_KEY, isPreviewDismissed, previewRevisionKey, readDismissedPreviews, withPreviewDismissed, writeDismissedPreviews } from './preview-dismissal';

const descriptor: SessionPreviewDescriptor = { id: 'p1', files: [{ id: 'f1', fileName: 'index.html', kind: 'html' }] };
const changed: SessionPreviewDescriptor = { id: 'p2', files: [{ id: 'f1', fileName: 'index.html', kind: 'html' }] };

afterEach(() => { window.localStorage.clear(); vi.restoreAllMocks(); });

describe('preview dismissal', () => {
  it('keys a revision by the registration id and its file ids', () => {
    expect(previewRevisionKey(descriptor)).not.toBe(previewRevisionKey(changed));
    expect(previewRevisionKey(descriptor)).toBe(previewRevisionKey({ ...descriptor, files: [...descriptor.files] }));
  });

  it('dismisses one session revision and reopens by withdrawing it', () => {
    const dismissed = withPreviewDismissed({}, 'b:s1', descriptor, true);
    expect(isPreviewDismissed(dismissed, 'b:s1', descriptor)).toBe(true);
    expect(isPreviewDismissed(dismissed, 'b:s2', descriptor)).toBe(false);
    expect(isPreviewDismissed(withPreviewDismissed(dismissed, 'b:s1', descriptor, false), 'b:s1', descriptor)).toBe(false);
  });

  it('does not hide a changed revision of the same session', () => {
    const dismissed = withPreviewDismissed({}, 'b:s1', descriptor, true);
    expect(isPreviewDismissed(dismissed, 'b:s1', changed)).toBe(false);
  });

  it('round-trips through localStorage and ignores malformed content', () => {
    writeDismissedPreviews(withPreviewDismissed({}, 'b:s1', descriptor, true));
    expect(readDismissedPreviews()).toEqual({ 'b:s1': previewRevisionKey(descriptor) });
    window.localStorage.setItem(PREVIEW_DISMISSAL_STORAGE_KEY, '["not","a","map"]');
    expect(readDismissedPreviews()).toEqual({});
    window.localStorage.setItem(PREVIEW_DISMISSAL_STORAGE_KEY, '{not json');
    expect(readDismissedPreviews()).toEqual({});
  });

  it('keeps working when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(readDismissedPreviews()).toEqual({});
    expect(() => writeDismissedPreviews({ 'b:s1': 'x' })).not.toThrow();
    expect(isPreviewDismissed(withPreviewDismissed({}, 'b:s1', descriptor, true), 'b:s1', descriptor)).toBe(true);
  });

  it('reads as nothing dismissed when localStorage itself is inaccessible', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('denied'); } });
    try {
      expect(readDismissedPreviews()).toEqual({});
      expect(() => writeDismissedPreviews({ 'b:s1': 'x' })).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});
