import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { PREVIEW_CHUNK_BYTES } from '../../../bridge/src/preview-protocol';
import { clampPreviewRatio, isPreviewDescriptor, markdownPreviewDocument, parseChunk, parseStatus, previewDocument, previewRatioBounds, verifyPreview } from './session-preview';
const id = '12345678-1234-4234-8234-123456789abc';
const fileId = '22345678-2234-4234-8234-123456789abc';
const otherFileId = '32345678-3234-4234-8234-123456789abc';
const revision = 'a'.repeat(64);
describe('preview protocol validation', () => {
  it('accepts the SPEC-A descriptor and rejects the old bridge shape', () => {
    expect(isPreviewDescriptor({ id, files: [{ id: fileId, fileName: 'demo.html', kind: 'html' }] })).toBe(true);
    expect(isPreviewDescriptor({ id, files: [{ id: fileId, fileName: 'a.html', kind: 'html' }, { id: otherFileId, fileName: 'notes.md', kind: 'markdown' }] })).toBe(true);
    // Old bridge shape has no files array: callers treat this as no preview.
    expect(isPreviewDescriptor({ id, fileName: 'demo.html' })).toBe(false);
  });
  it('rejects bad files, duplicates, wrong kinds and oversized sets', () => {
    const one = [{ id: fileId, fileName: 'demo.html', kind: 'html' }];
    expect(isPreviewDescriptor({ id, files: [] })).toBe(false);
    expect(isPreviewDescriptor({ id, files: Array.from({ length: 12 }, (_, i) => ({ id: fileId, fileName: `f${i}.html`, kind: 'html' })) })).toBe(true);
    expect(isPreviewDescriptor({ id, files: Array.from({ length: 13 }, (_, i) => ({ id: fileId, fileName: `f${i}.html`, kind: 'html' })) })).toBe(false);
    expect(isPreviewDescriptor({ id, files: [...one, { id: otherFileId, fileName: 'demo.html', kind: 'markdown' }] })).toBe(false);
    expect(isPreviewDescriptor({ id, files: [{ ...one[0], kind: 'text' }] })).toBe(false);
    expect(isPreviewDescriptor({ id, files: [{ ...one[0], id: 'not-uuid' }] })).toBe(false);
    for (const fileName of ['../x', 'x\\y', 'x\n.html', 'é'.repeat(128), '']) expect(isPreviewDescriptor({ id, files: [{ id: fileId, fileName, kind: 'html' }] })).toBe(false);
    expect(isPreviewDescriptor({ id: 'not-uuid', files: one })).toBe(false);
  });
  it('rejects malformed status and chunk data, missing fileId, offsets and noncanonical base64', () => {
    const status = { state: 'ready', previewId: id, fileId, revision, totalBytes: 1 };
    expect(parseStatus(status, id, fileId)).toMatchObject({ state: 'ready', fileId });
    expect(() => parseStatus(status, id, otherFileId)).toThrow();
    expect(() => parseStatus({ state: 'ready', previewId: id, revision, totalBytes: 1 }, id, fileId)).toThrow();
    expect(() => parseStatus({ ...status, totalBytes: 1048577 }, id, fileId)).toThrow();
    const chunk = { state: 'chunk', previewId: id, fileId, revision, totalBytes: 1, offset: 0, dataBase64: 'YQ==', done: true };
    expect(parseChunk(chunk, id, fileId, revision, 1, 0)).toMatchObject({ state: 'chunk', fileId, bytes: Uint8Array.of(97) });
    expect(() => parseChunk({ ...chunk, fileId: otherFileId }, id, fileId, revision, 1, 0)).toThrow();
    const noFile = { ...chunk } as Record<string, unknown>; delete noFile.fileId;
    expect(() => parseChunk(noFile, id, fileId, revision, 1, 0)).toThrow();
    for (const patch of [{ offset: 1 }, { done: false }, { dataBase64: 'YR==' }, { revision: 'b'.repeat(64) }]) expect(() => parseChunk({ ...chunk, ...patch }, id, fileId, revision, 1, 0)).toThrow();
    expect(parseChunk({ ...chunk, totalBytes: 0, dataBase64: '' }, id, fileId, revision, 0, 0)).toMatchObject({ state: 'chunk', done: true });
  });
  it('verifies bytes after a UTF-8 character crosses a chunk boundary', async () => {
    const text = 'a'.repeat(PREVIEW_CHUNK_BYTES - 1) + '🌍';
    const bytes = new TextEncoder().encode(text);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const parts = [bytes.slice(0, PREVIEW_CHUNK_BYTES), bytes.slice(PREVIEW_CHUNK_BYTES)];
    let offset = 0; const joined = new Uint8Array(bytes.length);
    for (const part of parts) {
      const result = parseChunk({ state: 'chunk', previewId: id, fileId, revision: hash, totalBytes: bytes.length, offset, dataBase64: Buffer.from(part).toString('base64'), done: offset + part.length === bytes.length }, id, fileId, hash, bytes.length, offset);
      if (result.state !== 'chunk') throw new Error('unexpected state');
      joined.set(result.bytes, offset); offset += result.bytes.length;
    }
    expect(await verifyPreview(joined, hash)).toBe(text);
    await expect(verifyPreview(joined, revision)).rejects.toThrow();
  });
  it('places the fixed policy before all untrusted markup and clamps split bounds', () => {
    const html = previewDocument('<head><base href="https://evil.example"><script>1</script>');
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<base'));
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script>'));
    expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('<base'));
    // The preview forwards external-link requests to the parent, which confirms
    // before opening; the frame itself never calls window.open.
    expect(html).toContain('ftown-preview-link-v1');
    expect(html).not.toContain('window.open');
    expect(html).toContain("connect-src 'none'");
    // The markdown branch goes through the same wrapping and CSP.
    const md = markdownPreviewDocument('# Hi', 'notes.md');
    expect(md).toContain("content=\"default-src 'none'");
    expect(md).toContain('<h1>Hi</h1>');
    expect(md).toContain('ftown-preview-link-v1');
    expect(previewRatioBounds(648)).toEqual([37.5, 62.5]);
    expect(clampPreviewRatio(0, 648)).toBe(37.5);
    expect(clampPreviewRatio(100, 648)).toBe(62.5);
  });
  function linkFrame(wrapped: string) {
    class TestElement {
      constructor(public value: string) {}
      closest(selector: string) { expect(selector).toBe('a[href],area[href]'); return this; }
      getAttribute() { return this.value; }
    }
    class TestEvent {
      prevented = false; stopped = false;
      constructor(public target: TestElement, public isTrusted: boolean, public buttonValue: number) {}
      composedPath() { return [this.target]; }
      preventDefault() { this.prevented = true; }
      stopImmediatePropagation() { this.stopped = true; }
    }
    class TestMouseEvent extends TestEvent { get button() { return this.buttonValue; } }
    let listener: ((event: TestMouseEvent) => void) | undefined;
    const posted: unknown[][] = [];
    const opened: unknown[][] = [];
    const contextWindow = { open: (...args: unknown[]) => { opened.push(args); }, parent: { postMessage: (...args: unknown[]) => { posted.push(args); } }, location: { hash: '' } };
    const document = { addEventListener: (type: string, callback: (event: TestMouseEvent) => void, capture: boolean) => { expect(type).toBe('click'); expect(capture).toBe(true); listener = callback; } };
    const script = wrapped.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    if (!script) throw new Error('expected script');
    runInNewContext(script, { Element: TestElement, Event: TestEvent, MouseEvent: TestMouseEvent, URL, document, window: contextWindow });
    const click = (value: string, trusted = true, button = 0) => {
      const event = new TestMouseEvent(new TestElement(value), trusted, button);
      if (!listener) throw new Error('missing handler');
      listener(event); expect(event.prevented).toBe(true); expect(event.stopped).toBe(true);
    };
    return { posted, opened, click, contextWindow };
  }
  it('forwards external link clicks to the parent for confirmation without opening a window', () => {
    const frame = linkFrame(previewDocument('<p>user markup</p>'));
    frame.click('https://example.test/path');
    // The frame forwards the target and never opens a window itself.
    expect(frame.opened).toEqual([]);
    expect(frame.posted).toEqual([[{ channel: 'ftown-preview-link-v1', kind: 'open-link', url: 'https://example.test/path' }, '*']]);
    for (const blocked of ['/relative', 'javascript:alert(1)', 'data:text/html,x', 'file:///tmp/x', 'mailto:user@example.test']) frame.click(blocked);
    frame.click('https://example.test/other', false); frame.click('https://example.test/other', true, 1);
    expect(frame.posted).toHaveLength(1);
    frame.click('#section'); expect(frame.contextWindow.location.hash).toBe('#section'); expect(frame.posted).toHaveLength(1);
  });
  it('switches files for relative links to registered files and keeps other behavior', () => {
    const frame = linkFrame(previewDocument('<p>x</p>', undefined, ['a.html', 'notes.md']));
    frame.click('./notes.md#intro');
    frame.click('notes.md?ver=1');
    frame.click('sub/dir/notes.md');
    frame.click('notes.md');
    frame.click('a.html');
    expect(frame.posted).toEqual([
      [{ channel: 'ftown-preview-link-v1', kind: 'switch-file', fileName: 'notes.md' }, '*'],
      [{ channel: 'ftown-preview-link-v1', kind: 'switch-file', fileName: 'notes.md' }, '*'],
      [{ channel: 'ftown-preview-link-v1', kind: 'switch-file', fileName: 'notes.md' }, '*'],
      [{ channel: 'ftown-preview-link-v1', kind: 'switch-file', fileName: 'notes.md' }, '*'],
      [{ channel: 'ftown-preview-link-v1', kind: 'switch-file', fileName: 'a.html' }, '*'],
    ]);
    // Absolute URLs still forward as open-link even when the basename matches.
    frame.click('https://example.test/notes.md');
    expect(frame.posted.at(-1)).toEqual([{ channel: 'ftown-preview-link-v1', kind: 'open-link', url: 'https://example.test/notes.md' }, '*']);
    // Unregistered relatives, protocol-relative and bad schemes never post.
    const before = frame.posted.length;
    for (const blocked of ['other.md', '//cdn.example.test/notes.md', 'javascript:notes.md', 'data:text/html,notes.md']) frame.click(blocked);
    expect(frame.posted).toHaveLength(before);
  });

  // The sandboxed frame is out of process: it can finish loading before the embedder gives it a size.
  function scrollFrame() {
    const script = [...previewDocument('<p>tall</p>', id).matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(text => text.includes('ftown-preview-scroll-v1'));
    if (!script) throw new Error('expected the scroll script');
    const listeners = new Map<string, ((event?: unknown) => void)[]>();
    const posted: Record<string, unknown>[] = [];
    const timers: (() => void)[] = [];
    const view = { width: 0, height: 0, y: 0, documentHeight: 2675 };
    const parent = { postMessage: (value: Record<string, unknown>) => { posted.push(value); } };
    class FrameMessageEvent { constructor(private readonly from: unknown, private readonly payload: unknown) {} get source() { return this.from; } get data() { return this.payload; } }
    const frame = {
      parent,
      setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; },
      setInterval: () => 0, clearInterval: () => {},
      // A real viewport clamps scrolling to (document height - viewport height); a 0x0 one cannot scroll at all.
      scrollTo: ({ top }: { top: number }) => { view.y = view.height > 0 ? Math.max(0, Math.min(top, view.documentHeight - view.height)) : 0; },
      addEventListener: (type: string, callback: (event?: unknown) => void) => { listeners.set(type, [...(listeners.get(type) ?? []), callback]); },
    };
    Object.defineProperties(frame, {
      scrollX: { get: () => 0 }, scrollY: { get: () => view.y },
      innerWidth: { get: () => view.width }, innerHeight: { get: () => view.height },
    });
    runInNewContext(script, { window: frame, document: { readyState: 'complete', addEventListener: () => {} }, MessageEvent: FrameMessageEvent, Window: function Window() {} });
    // Browser-dispatched events are trusted; tests pass { isTrusted: false } to model script-dispatched ones.
    const fire = (type: string, event: object = { isTrusted: true }) => { for (const callback of listeners.get(type) ?? []) callback(event); };
    const restore = (y: number) => fire('message', new FrameMessageEvent(parent, { channel: 'ftown-preview-scroll-v1', documentId: id, kind: 'restore', x: 0, y }));
    const restored = () => posted.filter(message => message.kind === 'restored');
    return { view, fire, restore, restored, timers };
  }

  it('restores the scroll position once a frame that loaded unsized gets its viewport', () => {
    const frame = scrollFrame();
    frame.restore(600);
    // Restoring into a 0x0 viewport would land at the top and report y=0 to the parent, losing the position.
    expect(frame.restored()).toEqual([]);
    frame.view.width = 1000; frame.view.height = 811; frame.fire('resize');
    expect(frame.restored()).toEqual([{ channel: 'ftown-preview-scroll-v1', documentId: id, kind: 'restored', x: 0, y: 600 }]);
    frame.fire('resize');
    expect(frame.restored()).toHaveLength(1);
  });

  it('ignores script-dispatched resize events while waiting for a viewport', () => {
    const frame = scrollFrame();
    frame.restore(600);
    frame.view.width = 1000; frame.view.height = 811;
    frame.fire('resize', { isTrusted: false });
    expect(frame.restored()).toEqual([]);
    frame.fire('resize');
    expect(frame.restored()).toEqual([{ channel: 'ftown-preview-scroll-v1', documentId: id, kind: 'restored', x: 0, y: 600 }]);
  });

  it('restores immediately into a sized frame and still completes when a frame never gets a size', () => {
    const sized = scrollFrame();
    sized.view.width = 1000; sized.view.height = 811;
    sized.restore(600);
    expect(sized.restored()).toEqual([{ channel: 'ftown-preview-scroll-v1', documentId: id, kind: 'restored', x: 0, y: 600 }]);
    const unsized = scrollFrame();
    unsized.restore(600);
    expect(unsized.restored()).toEqual([]);
    for (const timer of [...unsized.timers]) timer();
    expect(unsized.restored()).toEqual([{ channel: 'ftown-preview-scroll-v1', documentId: id, kind: 'restored', x: 0, y: 0 }]);
  });
});
