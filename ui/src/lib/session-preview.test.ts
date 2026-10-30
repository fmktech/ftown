import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { PREVIEW_CHUNK_BYTES } from '../../../bridge/src/preview-protocol';
import { clampPreviewRatio, isPreviewDescriptor, parseChunk, parseStatus, previewDocument, previewRatioBounds, verifyPreview } from './session-preview';
const id = '12345678-1234-4234-8234-123456789abc';
const revision = 'a'.repeat(64);
describe('preview protocol validation', () => {
  it('accepts bounded safe descriptors and rejects paths, controls and oversized names', () => {
    expect(isPreviewDescriptor({ id, fileName: 'demo.html' })).toBe(true);
    for (const fileName of ['../x', 'x\\y', 'x\n.html', 'é'.repeat(128), '']) expect(isPreviewDescriptor({ id, fileName })).toBe(false);
    expect(isPreviewDescriptor({ id: 'not-uuid', fileName: 'demo.html' })).toBe(false);
  });
  it('rejects malformed status and chunk data, offsets and noncanonical base64', () => {
    expect(parseStatus({ state: 'ready', previewId: id, revision, totalBytes: 1 }, id).state).toBe('ready');
    expect(() => parseStatus({ state: 'ready', previewId: id, revision, totalBytes: 1048577 }, id)).toThrow();
    const chunk = { state: 'chunk', previewId: id, revision, totalBytes: 1, offset: 0, dataBase64: 'YQ==', done: true };
    expect(parseChunk(chunk, id, revision, 1, 0)).toMatchObject({ state: 'chunk', bytes: Uint8Array.of(97) });
    for (const patch of [{ offset: 1 }, { done: false }, { dataBase64: 'YR==' }, { revision: 'b'.repeat(64) }]) expect(() => parseChunk({ ...chunk, ...patch }, id, revision, 1, 0)).toThrow();
    expect(parseChunk({ ...chunk, totalBytes: 0, dataBase64: '' }, id, revision, 0, 0)).toMatchObject({ state: 'chunk', done: true });
  });
  it('verifies bytes after a UTF-8 character crosses a chunk boundary', async () => {
    const text = 'a'.repeat(PREVIEW_CHUNK_BYTES - 1) + '🌍';
    const bytes = new TextEncoder().encode(text);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const parts = [bytes.slice(0, PREVIEW_CHUNK_BYTES), bytes.slice(PREVIEW_CHUNK_BYTES)];
    let offset = 0; const joined = new Uint8Array(bytes.length);
    for (const part of parts) {
      const result = parseChunk({ state: 'chunk', previewId: id, revision: hash, totalBytes: bytes.length, offset, dataBase64: Buffer.from(part).toString('base64'), done: offset + part.length === bytes.length }, id, hash, bytes.length, offset);
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
    expect(html).toContain('noopener,noreferrer');
    expect(html).toContain("connect-src 'none'");
    expect(previewRatioBounds(648)).toEqual([37.5, 62.5]);
    expect(clampPreviewRatio(0, 648)).toBe(37.5);
    expect(clampPreviewRatio(100, 648)).toBe(62.5);
  });
  it('installs an early delegated trusted-click handler that opens only absolute web links safely', () => {
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
    const calls: unknown[][] = [];
    const contextWindow = { open: (...args: unknown[]) => { calls.push(args); }, location: { hash: '' } };
    const document = { addEventListener: (type: string, callback: (event: TestMouseEvent) => void, capture: boolean) => { expect(type).toBe('click'); expect(capture).toBe(true); listener = callback; } };
    const wrapped = previewDocument('<p>user markup</p>');
    const script = wrapped.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    if (!script) throw new Error('expected script');
    runInNewContext(script, { Element: TestElement, Event: TestEvent, MouseEvent: TestMouseEvent, URL, document, window: contextWindow });
    TestElement.prototype.getAttribute = () => 'javascript:alert(1)';
    const click = (value: string, trusted = true, button = 0) => {
      const event = new TestMouseEvent(new TestElement(value), trusted, button);
      if (!listener) throw new Error('missing handler');
      listener(event); expect(event.prevented).toBe(true); expect(event.stopped).toBe(true);
    };
    click('https://example.test/path');
    expect(calls).toEqual([['https://example.test/path', '_blank', 'noopener,noreferrer']]);
    for (const blocked of ['/relative', 'javascript:alert(1)', 'data:text/html,x', 'file:///tmp/x', 'mailto:user@example.test']) click(blocked);
    click('https://example.test/other', false); click('https://example.test/other', true, 1);
    expect(calls).toHaveLength(1);
    click('#section'); expect(contextWindow.location.hash).toBe('#section'); expect(calls).toHaveLength(1);
  });

});
