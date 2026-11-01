import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { normalizePullRequestUrl } from './pull-request-url.js';
import { prReviewGeneration } from './session-wire.js';
import { PR_REVIEW_CHUNK_BYTES, PR_REVIEW_MAX_BODY_BYTES, PR_REVIEW_MAX_DIFF_BYTES, PR_REVIEW_MAX_TITLE_BYTES } from './pull-request-review-protocol.js';
import type { PrReviewChunk, PrReviewChunkRequest, PrReviewMetadata, PrReviewRequest, PrReviewResult, PrReviewService, PrReviewUnavailableReason } from './pull-request-review-protocol.js';
import type { VerifiedPrincipal } from './security/protocol.js';
import type { Session } from './types.js';

const HASH = /^[a-f0-9]{64}$/;
const OID = /^[a-f0-9]{40}$/;
const MAX_PROCESS_BYTES = 1_310_720;
const SNAPSHOT_TTL = 60_000;
const failure = (reason: PrReviewUnavailableReason): PrReviewResult & PrReviewChunk => ({ state: 'unavailable', reason });
class FetchError extends Error { constructor(readonly reason: PrReviewUnavailableReason) { super(reason); } }
export interface GhReviewResult { stdout: Buffer; stderr: Buffer; exitCode: number }
export type GhReviewRunner = (args: string[], signal: AbortSignal) => Promise<GhReviewResult>;

/** A fixed gh invocation, bounded by process time, output bytes and cancellation. */
export const runReviewGh: GhReviewRunner = (args, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new FetchError('timeout')); return; }
  const child = spawn('gh', args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com', GH_PAGER: 'cat', PAGER: 'cat' } });
  const stdout: Buffer[] = [], stderr: Buffer[] = []; let size = 0, settled = false;
  const finish = (error?: FetchError, code = 1) => {
    if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
    if (error) { child.kill('SIGKILL'); reject(error); } else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code });
  };
  const abort = () => finish(new FetchError('timeout'));
  const timer = setTimeout(abort, 12_000);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const append = (target: Buffer[], chunk: Buffer) => { size += chunk.length; if (size > MAX_PROCESS_BYTES) finish(new FetchError('too_large')); else target.push(chunk); };
  child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk));
  child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk));
  child.on('error', () => finish(new FetchError('unavailable')));
  child.on('close', code => finish(undefined, code ?? 1));
});

const obj = (x: unknown): Record<string, unknown> | undefined => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : undefined;
const string = (x: unknown, max: number): string => {
  if (typeof x !== 'string') throw new FetchError('unavailable');
  if (Buffer.byteLength(x, 'utf8') > max) throw new FetchError('too_large');
  return x;
};
const count = (x: unknown): number => { if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0) throw new FetchError('unavailable'); return x; };
function metadata(buffer: Buffer, url: string, fetchedAt: string): PrReviewMetadata {
  let data: Record<string, unknown> | undefined;
  try { data = obj(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer))); } catch { throw new FetchError('unavailable'); }
  if (!data) throw new FetchError('unavailable');
  const base = obj(data.base), head = obj(data.head), author = obj(data.user);
  const baseOid = string(base?.sha, 40), headOid = string(head?.sha, 40);
  if (!OID.test(baseOid) || !OID.test(headOid)) throw new FetchError('unavailable');
  const state = data.merged_at !== null && typeof data.merged_at === 'string' ? 'merged' : data.state === 'open' ? 'open' : data.state === 'closed' ? 'closed' : null;
  if (!state || (data.merged_at !== null && typeof data.merged_at !== 'string')) throw new FetchError('unavailable');
  return { url, title: string(data.title, PR_REVIEW_MAX_TITLE_BYTES), body: string(data.body ?? '', PR_REVIEW_MAX_BODY_BYTES), author: string(author?.login, 256), state,
    baseRef: string(base?.ref, 512), headRef: string(head?.ref, 512), baseOid, headOid,
    additions: count(data.additions), deletions: count(data.deletions), changedFiles: count(data.changed_files), fetchedAt };
}
function response(result: GhReviewResult): Buffer {
  if (result.exitCode !== 0) {
    const error = result.stderr.toString('utf8').toLowerCase();
    if (/rate.limit|secondary rate|abuse detection|http 429/.test(error)) throw new FetchError('rate_limited');
    if (/not logged|authentication|gh auth login|requires authentication|http 401/.test(error)) throw new FetchError('unauthenticated');
    if (/http 404|http 403|not found/.test(error)) throw new FetchError('not_found_or_forbidden');
    throw new FetchError('unavailable');
  }
  return result.stdout;
}
interface Snapshot { key: string; sessionId: string; generation: string; revision: string; bytes: Buffer; at: number }
export interface PrReviewDeps { bridgeId: string; loadSession: (id: string) => Promise<Session | null>; revalidate: (principal: VerifiedPrincipal) => Promise<void>; runner?: GhReviewRunner; now?: () => number }
export function createPrReviewService(deps: PrReviewDeps): PrReviewService {
  const runner = deps.runner ?? runReviewGh, now = deps.now ?? Date.now;
  const snapshots = new Map<string, Snapshot>(), flights = new Map<string, Promise<PrReviewResult>>(); let active = 0;
  const key = (p: VerifiedPrincipal, r: PrReviewRequest) => JSON.stringify([deps.bridgeId, r.sessionId, r.linkGeneration, p.endpoint.id, p.policyGeneration]);
  const authorized = async (p: VerifiedPrincipal) => {
    if (p.endpoint.kind !== 'browser' || p.bridgeId !== deps.bridgeId || !p.permissions.includes('read')) throw new FetchError('unavailable');
    try { await deps.revalidate(p); } catch { throw new FetchError('unavailable'); }
  };
  const current = async (r: PrReviewRequest): Promise<string> => {
    if (r.bridgeId !== deps.bridgeId || !/^[A-Za-z0-9_-]{1,200}$/.test(r.sessionId) || !HASH.test(r.linkGeneration)) throw new FetchError('stale');
    const s = await deps.loadSession(r.sessionId);
    const actual = s?.bridgeId === deps.bridgeId && s.pullRequestUrl && s.pullRequestLinkId ? prReviewGeneration(s.pullRequestLinkId) : undefined;
    for (const [key, snapshot] of snapshots) if (snapshot.sessionId === r.sessionId && snapshot.generation !== actual) snapshots.delete(key);
    if (!s || s.bridgeId !== deps.bridgeId || !s.pullRequestUrl) throw new FetchError('unlinked');
    if (!actual || actual !== r.linkGeneration) throw new FetchError('stale');
    let url: string; try { url = normalizePullRequestUrl(s.pullRequestUrl); } catch { throw new FetchError('unavailable'); }
    if (url.length > 2048 || Number(url.slice(url.lastIndexOf('/') + 1)) > 2_147_483_647) throw new FetchError('unavailable');
    return url;
  };
  const clean = () => { for (const [k, s] of snapshots) if (now() - s.at >= SNAPSHOT_TTL) snapshots.delete(k); };
  const fetchReview = async (p: VerifiedPrincipal, r: PrReviewRequest, url: string, cacheKey: string): Promise<PrReviewResult> => {
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(url)!;
    const path = `repos/${match[1]}/${match[2]}/pulls/${match[3]}`;
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 25_000);
    try {
      const run = async (args: string[]) => { if (abort.signal.aborted) throw new FetchError('timeout'); const output = await runner(args, abort.signal); if (abort.signal.aborted) throw new FetchError('timeout'); return response(output); };
      const args = ['api', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github+json', path];
      const first = metadata(await run(args), url, new Date(now()).toISOString());
      const bytes = await run(['api', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github.v3.diff', path]);
      if (bytes.length > PR_REVIEW_MAX_DIFF_BYTES) throw new FetchError('too_large');
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new FetchError('unsupported'); }
      if (bytes.includes(0)) throw new FetchError('unsupported');
      const second = metadata(await run(args), url, new Date(now()).toISOString());
      if (first.baseOid !== second.baseOid || first.headOid !== second.headOid) throw new FetchError('stale');
      await authorized(p); if (await current(r) !== url) throw new FetchError('stale');
      const revision = createHash('sha256').update(bytes).digest('hex');
      const result: PrReviewResult = { state: 'ready', linkGeneration: r.linkGeneration, metadata: second, revision, totalBytes: bytes.length };
      if (Buffer.byteLength(JSON.stringify(result)) > 150_000) throw new FetchError('too_large');
      clean(); snapshots.delete(cacheKey);
      while (snapshots.size >= 4) snapshots.delete(snapshots.keys().next().value!);
      snapshots.set(cacheKey, { key: cacheKey, sessionId: r.sessionId, generation: r.linkGeneration, revision, bytes: Buffer.from(bytes), at: now() });
      return result;
    } finally { clearTimeout(timer); }
  };
  const safe = (e: unknown): PrReviewResult & PrReviewChunk => failure(e instanceof FetchError ? e.reason : 'unavailable');
  return {
    async get(p, r) {
      try {
        await authorized(p); const url = await current(r); const k = key(p, r);
        let flight = flights.get(k);
        if (!flight) {
          if (active >= 2) return failure('unavailable');
          active++;
          flight = fetchReview(p, r, url, k).catch(safe).finally(() => { active--; flights.delete(k); });
          flights.set(k, flight);
        }
        const result = await flight;
        await authorized(p); if (await current(r) !== url) throw new FetchError('stale');
        return result;
      } catch (e) { return safe(e); }
    },
    async chunk(p, r) {
      try {
        await authorized(p); const url = await current(r);
        if (!HASH.test(r.revision) || !Number.isSafeInteger(r.offset) || r.offset < 0 || r.offset % PR_REVIEW_CHUNK_BYTES !== 0) return failure('unavailable');
        clean(); const snapshot = snapshots.get(key(p, r));
        if (!snapshot || snapshot.revision !== r.revision) return { state: 'stale_revision' };
        const len = snapshot.bytes.length;
        if (len === 0 ? r.offset !== 0 : r.offset >= len) return failure('unavailable');
        const data = snapshot.bytes.subarray(r.offset, r.offset + PR_REVIEW_CHUNK_BYTES);
        await authorized(p); if (await current(r) !== url) throw new FetchError('stale');
        clean(); if (snapshots.get(key(p, r)) !== snapshot) return { state: 'stale_revision' };
        return { state: 'chunk', revision: r.revision, totalBytes: len, offset: r.offset, dataBase64: data.toString('base64'), done: r.offset + data.length === len };
      } catch (e) { return safe(e); }
    },
  };
}
