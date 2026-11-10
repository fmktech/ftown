import { describe, expect, it } from 'vitest';
import { BoundedJsonError, readBoundedJson } from './bounded-json';

const req = (body: string, headers: Record<string, string> = {}) => new Request('https://x.test/', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
const status = async (promise: Promise<unknown>): Promise<number | null> => { try { await promise; return null; } catch (e) { return e instanceof BoundedJsonError ? e.status : -1; } };

describe('readBoundedJson', () => {
  it('parses a body within the cap, including exactly at the cap', async () => {
    expect(await readBoundedJson(req('{"a":1}'), 100)).toEqual({ a: 1 });
    expect(await readBoundedJson(req('{"a":1}'), 7)).toEqual({ a: 1 });
  });
  it('413 when streamed size exceeds the cap, even without a content-length', async () => {
    expect(await status(readBoundedJson(req('{"a":1}'), 6))).toBe(413);
  });
  it('413 when content-length declares more than the cap', async () => {
    expect(await status(readBoundedJson(req('{}', { 'content-length': '1000' }), 10))).toBe(413);
  });
  it('400 for wrong content type, malformed JSON and missing body', async () => {
    expect(await status(readBoundedJson(req('{}', { 'content-type': 'text/plain' }), 10))).toBe(400);
    expect(await status(readBoundedJson(req('{x'), 10))).toBe(400);
    expect(await status(readBoundedJson(new Request('https://x.test/', { method: 'POST', headers: { 'content-type': 'application/json' } }), 10))).toBe(400);
  });
});
