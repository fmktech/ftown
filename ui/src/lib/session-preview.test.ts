import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
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
    expect(html).toContain("connect-src 'none'");
    expect(previewRatioBounds(648)).toEqual([37.5, 62.5]);
    expect(clampPreviewRatio(0, 648)).toBe(37.5);
    expect(clampPreviewRatio(100, 648)).toBe(62.5);
  });
});
