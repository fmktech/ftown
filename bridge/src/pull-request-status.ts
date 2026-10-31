import { spawn } from 'node:child_process';
import { normalizePullRequestUrl } from './pull-request-url.js';
import type { PullRequestState, PullRequestStatus, PullRequestStatusReason, PullRequestStatusesResponse } from './pull-request-status-protocol.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MAX_OUTPUT = 1024 * 1024;
type RunnerResult = { stdout: string; stderr: string; exitCode: number };
type Runner = (input: string) => Promise<RunnerResult>;
export interface PullRequestObservation extends PullRequestStatus { headOid?: string; attempt: number }
type Entry = { url: string; state: PullRequestState; checkedAt: number | null; reason?: PullRequestStatusReason; headOid?: string; attempt: number; lastAttempt: number; nextAttempt: number; used: number };

/** Run a single bounded gh process; credentials stay in gh's environment. */
export function runGh(input: string): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', ['api', 'graphql', '--hostname', 'github.com', '--include', '--input', '-'], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, settled = false;
    const finish = (error?: Error, code = 1) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { child.kill('SIGKILL'); reject(error); }
      else resolve({ stdout, stderr, exitCode: code });
    };
    const timer = setTimeout(() => finish(new Error('timeout')), 15_000);
    const append = (chunk: Buffer, output: 'stdout' | 'stderr') => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) return finish(new Error('output limit'));
      if (output === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', chunk => append(chunk, 'stdout'));
    child.stderr.on('data', chunk => append(chunk, 'stderr'));
    child.on('error', error => finish(error));
    child.on('close', code => finish(undefined, code ?? 1));
    child.stdin.on('error', () => { /* process exit is handled above */ });
    child.stdin.end(input);
  });
}

function ttl(state: PullRequestState): number {
  if (state === 'merged') return Infinity;
  if (state === 'closed') return HOUR;
  if (state === 'passed' || state === 'failed') return 5 * MINUTE;
  return MINUTE;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function stateOf(value: unknown): { state: PullRequestState; reason?: PullRequestStatusReason; headOid?: string } {
  const pr = record(value);
  if (!pr) return { state: 'unknown', reason: 'unavailable' };
  if (pr.merged === true || pr.state === 'MERGED') return pr.merged === true && pr.state === 'MERGED' ? { state: 'merged' } : { state: 'unknown', reason: 'unavailable' };
  if (pr.merged !== false) return { state: 'unknown', reason: 'unavailable' };
  if (pr.state === 'CLOSED') return { state: 'closed' };
  if (pr.state !== 'OPEN' || typeof pr.headRefOid !== 'string' || !pr.headRefOid) return { state: 'unknown', reason: 'unavailable' };
  const nodes = record(pr.commits)?.nodes;
  const commit = Array.isArray(nodes) ? record(record(nodes[0])?.commit) : undefined;
  if (!commit || commit.oid !== pr.headRefOid) return { state: 'unknown', reason: 'unavailable' };
  const rollup = record(commit.statusCheckRollup);
  if (!rollup) return { state: 'unknown', reason: 'no_checks' };
  const count = record(rollup.contexts)?.totalCount;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return { state: 'unknown', reason: 'unavailable' };
  if (count === 0) return { state: 'unknown', reason: 'no_checks' };
  switch (rollup.state) {
    case 'FAILURE': case 'ERROR': return { state: 'failed', headOid: pr.headRefOid };
    case 'PENDING': case 'EXPECTED': return { state: 'in_progress', headOid: pr.headRefOid };
    case 'SUCCESS': return { state: 'passed', headOid: pr.headRefOid };
    default: return { state: 'unknown', reason: 'unavailable' };
  }
}
function parseGh(raw: string): { headers: string; body: Record<string, unknown> | undefined; status: number | undefined } {
  // gh --include emits HTTP headers followed by JSON. Some test runners return JSON directly.
  const split = raw.search(/\r?\n\r?\n/);
  const headers = raw.startsWith('HTTP/') && split >= 0 ? raw.slice(0, split) : '';
  const bodyText = headers ? raw.slice(split).trim() : raw.trim();
  let body: Record<string, unknown> | undefined;
  try { body = record(JSON.parse(bodyText)); } catch { /* bounded unavailable */ }
  const status = headers ? Number(/^HTTP\/\S+\s+(\d+)/.exec(headers)?.[1]) : undefined;
  return { headers, body, status };
}
function header(headers: string, name: string): string | undefined {
  return headers.split(/\r?\n/).find(line => line.toLowerCase().startsWith(`${name.toLowerCase()}:`))?.slice(name.length + 1).trim();
}
function futureReset(headers: string, body: Record<string, unknown> | undefined, now: number): number {
  const retry = header(headers, 'retry-after');
  const retryMs = retry ? (/^\d+$/.test(retry) ? now + Number(retry) * 1000 : Date.parse(retry)) : NaN;
  const resetHeader = Number(header(headers, 'x-ratelimit-reset')) * 1000;
  const rate = record(record(body?.data)?.rateLimit);
  const resetBody = typeof rate?.resetAt === 'string' ? Date.parse(rate.resetAt) : NaN;
  const values = [retryMs, resetHeader, resetBody].filter(n => Number.isFinite(n) && n > now);
  // JS timers overflow beyond 2^31-1 ms. Recheck unusually distant resets later.
  return Math.min(now + 2_000_000_000, Math.max(now + MINUTE, ...(values.length ? values : [now + 15 * MINUTE])));
}
function query(entries: Entry[]): string {
  const fields = entries.map((entry, index) => {
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(entry.url)!;
    return `r${index}: repository(owner: ${JSON.stringify(match[1])}, name: ${JSON.stringify(match[2])}) { pullRequest(number: ${match[3]}) { state merged headRefOid commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 1) { totalCount } } } } } } }`;
  });
  return JSON.stringify({ query: `query { ${fields.join(' ')} rateLimit { cost remaining resetAt } }` });
}

/** Process-wide, demand-driven PR status cache and quota gate. */
export class PullRequestStatusService {
  private readonly cache = new Map<string, Entry>();
  private launches: number[] = [];
  private cooldown = 0;
  private flight: Promise<void> | undefined;
  private sequence = 0;
  private attemptSequence = 0;
  private background = new Set<string>();
  private inFlight = new Set<string>();
  constructor(private readonly now: () => number = Date.now, private readonly runner: Runner = runGh) {}

  private entry(value: string): string | undefined {
    let url: string;
    try { url = normalizePullRequestUrl(value); } catch { return undefined; }
    if (Number(url.slice(url.lastIndexOf('/') + 1)) > 2_147_483_647) return undefined;
    const key = url.toLowerCase();
    let entry = this.cache.get(key);
    if (!entry) { entry = { url, state: 'unknown', checkedAt: null, attempt: 0, lastAttempt: 0, nextAttempt: 0, used: 0 }; this.cache.set(key, entry); }
    entry.used = ++this.sequence;
    return key;
  }

  private evict(): void {
    while (this.cache.size > 500) {
      const oldest = [...this.cache.entries()].filter(([key]) => !this.background.has(key) && !this.inFlight.has(key)).sort((a, b) => a[1].used - b[1].used)[0];
      if (!oldest) break;
      this.cache.delete(oldest[0]);
    }
  }

  setBackgroundUrls(urls: readonly string[]): void {
    this.background.clear();
    for (const url of urls) {
      if (this.background.size >= 20) break;
      const key = this.entry(url); if (key) this.background.add(key);
    }
    this.evict();
  }

  async get(urls: readonly string[]): Promise<Pick<PullRequestStatusesResponse, 'statuses' | 'nextRefreshAt'>> {
    const { observations, nextRefreshAt } = await this.read(urls, true);
    return { statuses: observations.map(({ headOid: _headOid, attempt: _attempt, ...status }) => status), nextRefreshAt };
  }

  async getObservations(urls: readonly string[]): Promise<{ observations: PullRequestObservation[]; nextRefreshAt: string }> {
    return this.read(urls, false);
  }

  private async read(urls: readonly string[], foreground: boolean): Promise<{ observations: PullRequestObservation[]; nextRefreshAt: string }> {
    const keys: string[] = [];
    for (const value of urls) {
      const key = this.entry(value);
      if (key && !keys.includes(key)) keys.push(key);
    }
    this.evict();
    if (this.flight) await this.flight;
    else {
      const now = this.now();
      this.launches = this.launches.filter(time => time > now - HOUR);
      const allowed = Math.max(this.cooldown, (this.launches.at(-1) ?? -Infinity) + MINUTE, this.launches.length >= 60 ? this.launches[0] + HOUR : 0);
      const due = (key: string) => { const e = this.cache.get(key); return !!e && e.state !== 'merged' && now >= e.nextAttempt && (e.checkedAt === null || now >= e.checkedAt + ttl(e.state)); };
      const sort = (a: Entry, b: Entry) => a.lastAttempt - b.lastAttempt || a.used - b.used;
      const foregroundDue = (foreground ? keys : []).filter(due).map(key => this.cache.get(key)!).sort(sort);
      const backgroundDue = [...this.background].filter(due).map(key => this.cache.get(key)!).sort(sort);
      const selected: Entry[] = [];
      const add = (entry: Entry | undefined) => { if (entry && !selected.includes(entry) && selected.length < 20) selected.push(entry); };
      if (foregroundDue.length && backgroundDue.length) { add(foregroundDue[0]); add(backgroundDue[0]); }
      for (const entry of [...new Set([...foregroundDue, ...backgroundDue])].sort(sort)) add(entry);
      if (selected.length && now >= allowed) {
        this.launches.push(now);
        for (const entry of selected) { entry.lastAttempt = now || 1; entry.attempt = ++this.attemptSequence; this.inFlight.add(entry.url.toLowerCase()); }
        this.flight = this.refresh(selected, now).finally(() => { this.inFlight.clear(); this.flight = undefined; this.evict(); });
        await this.flight;
      }
    }
    const now = this.now();
    const entries = keys.map(key => this.cache.get(key)).filter((entry): entry is Entry => !!entry);
    const observations: PullRequestObservation[] = entries.map(entry => ({ url: entry.url, state: entry.state, checkedAt: entry.checkedAt === null ? null : new Date(entry.checkedAt).toISOString(), stale: entry.checkedAt === null || now >= entry.checkedAt + ttl(entry.state) || (entry.reason !== undefined && entry.reason !== 'no_checks'), ...(entry.reason ? { reason: entry.reason } : {}), ...(entry.headOid ? { headOid: entry.headOid } : {}), attempt: entry.attempt }));
    const nextDue = entries.filter(entry => entry.state !== 'merged').map(entry => Math.max(entry.nextAttempt, entry.checkedAt === null ? 0 : entry.checkedAt + ttl(entry.state)));
    const next = nextDue.length ? Math.max(now + MINUTE, this.cooldown, (this.launches.at(-1) ?? -Infinity) + MINUTE, Math.min(...nextDue), this.launches.length >= 60 ? this.launches[0] + HOUR : 0) : now + HOUR;
    return { observations, nextRefreshAt: new Date(next).toISOString() };
  }

  private async refresh(entries: Entry[], now: number): Promise<void> {
    const fail = (reason: PullRequestStatusReason, until: number) => {
      for (const entry of entries) { entry.reason = reason; entry.nextAttempt = until; }
    };
    try {
      const result = await this.runner(query(entries));
      const { headers, body, status } = parseGh(result.stdout);
      const errors = Array.isArray(body?.errors) ? body.errors : [];
      const errorText = [body?.message, ...errors.map(error => record(error)?.message)].filter(value => typeof value === 'string').join(' ').toLowerCase();
      const headerRemaining = header(headers, 'x-ratelimit-remaining');
      const rateLimited = status === 429 || (status === 403 && headerRemaining === '0') || /rate.?limit|secondary rate|abuse detection/.test(errorText) || /rate.?limit|secondary rate|abuse detection/i.test(result.stderr);
      const rate = record(record(body?.data)?.rateLimit);
      if (rateLimited || (typeof rate?.remaining === 'number' && rate.remaining <= 100)) this.cooldown = Math.max(this.cooldown, futureReset(headers, body, now));
      if (rateLimited) { fail('rate_limited', this.cooldown); return; }
      const authenticationFailure = status === 401 || /authentication|not logged|gh auth login|requires authentication/i.test(result.stderr);
      // gh can exit nonzero for GraphQL errors even when data contains useful
      // partial results. HTTP failures and malformed responses still fail globally.
      if (authenticationFailure || (result.exitCode !== 0 && errors.length === 0) || (status !== undefined && status >= 400) || !body || !record(body.data)) {
        const reason = authenticationFailure ? 'unauthenticated' : 'unavailable';
        this.cooldown = Math.max(this.cooldown, now + 5 * MINUTE); fail(reason, this.cooldown); return;
      }
      const data = record(body.data)!;
      const failedAliases = new Set<string>();
      let unscopedError = false;
      for (const error of errors) {
        const path = record(error)?.path;
        if (!Array.isArray(path) || typeof path[0] !== 'string') { unscopedError = true; continue; }
        if (path[0] === 'rateLimit') continue;
        if (/^r(?:0|[1-9]\d*)$/.test(path[0]) && Number(path[0].slice(1)) < entries.length) failedAliases.add(path[0]);
        else unscopedError = true;
      }
      entries.forEach((entry, index) => {
        if (unscopedError || failedAliases.has(`r${index}`)) {
          entry.reason = 'unavailable'; entry.nextAttempt = now + 5 * MINUTE; return;
        }
        const repository = record(data[`r${index}`]);
        const mapped = stateOf(repository?.pullRequest);
        if (mapped.reason === 'unavailable') {
          entry.reason = 'unavailable'; entry.nextAttempt = now + 5 * MINUTE;
        } else {
          entry.state = mapped.state; entry.reason = mapped.reason; entry.headOid = mapped.headOid; entry.checkedAt = now; entry.nextAttempt = now + ttl(mapped.state);
        }
      });
    } catch {
      this.cooldown = Math.max(this.cooldown, now + 5 * MINUTE); fail('unavailable', this.cooldown);
    }
  }
}
