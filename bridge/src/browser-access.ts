import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Command, CommandResponse } from './types.js';

export type BrowserBootstrap = { version: 1; userId: string; bridgeId: string; hostname: string; localPort: number; localNonce: string };
type Options = { dataDir: string; allowedOrigins: string[]; bootstrap: () => BrowserBootstrap; execute: (command: Command) => Promise<CommandResponse>; onRevoke?: () => void };
type Device = { id: string; origin: string; createdAt: string; hash: string; bridgeId: string; remember: boolean };
type Pairing = { id: string; code: string; origin: string; remember: boolean; expiresAt: string; pollHash: string; status: 'pending' | 'denied' | 'approved'; credential?: string };
type Cached = { body: string; result: Promise<CommandResponse>; completedAt?: number };
type Event = { sequence: number; channel: string; data: unknown; bytes: number };
const WINDOW_MS = 120_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
class HttpError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
const fail = (status: number, code: string, message: string): never => { throw new HttpError(status, code, message); };
const commandTypes = new Set(['create_session', 'stop_session', 'list_sessions', 'get_history', 'retry_session', 'send_message', 'rename_session', 'remove_session', 'bridge_exec', 'clear_terminal', 'update_session_parent', 'get_session_usage', 'get_sessions_usage', 'create_loop', 'list_loops', 'update_loop', 'delete_loop', 'run_loop_now', 'get_loop_runs']);

/** Loopback browser consent and control. No cloud dependency and no raw persisted tokens. */
export class BrowserAccess {
  private devices = new Map<string, Device>();
  private pairings = new Map<string, Pairing>();
  private rates = new Map<string, number[]>();
  private commands = new Map<string, Cached>();
  private events: Event[] = [];
  private eventBytes = 0;
  private sequence = 0;
  private waiters = new Map<() => void, string>();
  private windowExpires = 0;
  private closed = false;
  private readonly file: string;
  constructor(private readonly opts: Options) {
    this.file = join(opts.dataDir, 'browser-devices.json');
    try {
      const saved: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!Array.isArray(saved)) throw new Error('Invalid browser credential store');
      for (const d of saved) {
        if (!object(d) || typeof d.id !== 'string' || typeof d.origin !== 'string' || typeof d.createdAt !== 'string' || typeof d.hash !== 'string' || !/^[a-f0-9]{64}$/.test(d.hash) || typeof d.bridgeId !== 'string') throw new Error('Invalid browser credential store');
        if (this.devices.size >= 100) throw new Error('Browser credential store exceeds limit');
        this.devices.set(d.id, { ...d, remember: true } as Device);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  private persist() {
    mkdirSync(this.opts.dataDir, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify([...this.devices.values()].filter(d => d.remember)), { mode: 0o600 });
    renameSync(temp, this.file);
  }
  private device(token: string, origin: string): Device | undefined {
    if (this.closed || !this.opts.allowedOrigins.includes(origin) || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const digest = hash(token);
    return [...this.devices.values()].find(d => d.hash === digest && d.origin === origin && d.bridgeId === this.opts.bootstrap().bridgeId);
  }
  authorize(token: string, origin: string): boolean { return !!this.device(token, origin); }
  private sweep() {
    const now = Date.now();
    for (const [id, pair] of this.pairings) if (Date.parse(pair.expiresAt) <= now) this.pairings.delete(id);
    for (const [id, entry] of this.commands) if (entry.completedAt !== undefined && now - entry.completedAt >= 600_000) this.commands.delete(id);
  }
  private send(res: ServerResponse, status: number, body: unknown) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }
  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) fail(400, 'invalid_body', 'Expected application/json');
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > 65536) fail(400, 'invalid_body', 'Request body too large');
      chunks.push(bytes);
    }
    if (this.closed) fail(503, 'closed', 'Bridge is closing');
    let result: unknown;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'invalid_body', 'Invalid JSON'); }
    if (!object(result)) return fail(400, 'invalid_body', 'Expected an object');
    return result;
  }
  async handle(req: IncomingMessage, res: ServerResponse, admin: boolean): Promise<void> {
    let requestId = randomUUID() as string;
    try {
      if (this.closed) fail(503, 'closed', 'Bridge is closing');
      this.sweep();
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      if (!path.startsWith('/api/browser/')) fail(404, 'not_found', 'Not found');
      const origin = req.headers.origin ?? '';
      admin = admin && !origin;
      if (!admin) {
        if (!this.opts.allowedOrigins.includes(origin)) fail(403, 'origin_forbidden', 'Origin is not allowed');
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        if (req.method === 'OPTIONS') {
          if (!['GET', 'POST', 'DELETE'].includes(req.headers['access-control-request-method'] ?? '')) fail(403, 'preflight_forbidden', 'Method is not allowed');
          const headers = String(req.headers['access-control-request-headers'] ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
          if (headers.some(h => !['authorization', 'content-type'].includes(h))) fail(403, 'preflight_forbidden', 'Headers are not allowed');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE');
          res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
          if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
          res.writeHead(204); res.end(); return;
        }
      }
      const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
      if (admin) {
        if (path === '/api/browser/window' && req.method === 'POST') {
          await this.body(req); this.windowExpires = Date.now() + WINDOW_MS; this.pairings.clear();
          this.send(res, 200, { expiresAt: new Date(this.windowExpires).toISOString() }); return;
        }
        if (path === '/api/browser/pairings' && req.method === 'GET') {
          this.send(res, 200, { pairings: [...this.pairings.values()].filter(p => p.status === 'pending').map(({ id, code, origin, remember, expiresAt }) => ({ id, code, origin, remember, expiresAt })) }); return;
        }
        const decision = /^\/api\/browser\/pairings\/([^/]+)\/decision$/.exec(path);
        if (decision && req.method === 'POST') {
          const body = await this.body(req);
          if (typeof body.approve !== 'boolean') fail(400, 'invalid_decision', 'approve must be boolean');
          this.sweep();
          const pair = this.pairings.get(decision[1]);
          if (!pair) fail(404, 'not_found', 'Pairing expired or missing');
          const state = body.approve ? 'approved' : 'denied';
          if (pair!.status !== 'pending' && pair!.status !== state) fail(409, 'decision_conflict', 'Pairing already decided');
          if (pair!.status === 'pending' && body.approve) {
            if (this.devices.size >= 100) fail(429, 'device_limit', 'Too many paired browsers');
            const credential = secret();
            const device: Device = { id: randomUUID(), origin: pair!.origin, createdAt: new Date().toISOString(), hash: hash(credential), bridgeId: this.opts.bootstrap().bridgeId, remember: pair!.remember };
            this.devices.set(device.id, device);
            try { if (device.remember) this.persist(); } catch (error) { this.devices.delete(device.id); throw error; }
            pair!.credential = credential;
          }
          pair!.status = state; this.send(res, 200, { ok: true }); return;
        }
        if (path === '/api/browser/devices' && req.method === 'GET') {
          this.send(res, 200, { devices: [...this.devices.values()].map(({ id, origin, createdAt }) => ({ id, origin, createdAt })) }); return;
        }
        const deletion = /^\/api\/browser\/devices\/([^/]+)$/.exec(path);
        if (deletion && req.method === 'DELETE') {
          const previous = this.devices.get(deletion[1]);
          this.devices.delete(deletion[1]);
          try { if (previous?.remember) this.persist(); } catch (error) { this.devices.set(previous!.id, previous!); throw error; }
          for (const wake of [...this.waiters.keys()]) wake();
          this.opts.onRevoke?.(); this.send(res, 200, { ok: true }); return;
        }
        fail(404, 'not_found', 'Unknown admin route');
      }
      if (path === '/api/browser/pairings' && req.method === 'POST') {
        const recent = (this.rates.get(origin) ?? []).filter(t => Date.now() - t < 60_000);
        this.rates.set(origin, recent);
        if (recent.length >= 10) fail(429, 'pairing_rate_limit', 'Too many pairing requests');
        recent.push(Date.now());
        if (Date.now() >= this.windowExpires) fail(409, 'window_closed', 'Run ftown-bridge pair to open approval');
        const body = await this.body(req);
        if (Date.now() >= this.windowExpires) fail(409, 'window_closed', 'Pairing window expired');
        if (typeof body.remember !== 'boolean') fail(400, 'invalid_pairing', 'remember must be boolean');
        if (this.pairings.size >= 5) fail(429, 'pairing_limit', 'Too many pairing requests');
        const pollToken = secret();
        let code: string;
        do { code = String(randomInt(1_000_000)).padStart(6, '0'); } while ([...this.pairings.values()].some(p => p.code === code));
        const pair: Pairing = { id: randomUUID(), code, origin, remember: body.remember as boolean, expiresAt: new Date(Math.min(this.windowExpires, Date.now() + WINDOW_MS)).toISOString(), pollHash: hash(pollToken), status: 'pending' };
        this.pairings.set(pair.id, pair);
        this.send(res, 201, { id: pair.id, code: pair.code, pollToken, expiresAt: pair.expiresAt }); return;
      }
      const poll = /^\/api\/browser\/pairings\/([^/]+)$/.exec(path);
      if (poll && req.method === 'GET') {
        const pair = this.pairings.get(poll[1]);
        if (!pair || pair.origin !== origin || !bearer || pair.pollHash !== hash(bearer)) fail(401, 'unauthorized', 'Invalid pairing credential');
        this.send(res, 200, { status: pair!.status, ...(pair!.credential ? { credential: pair!.credential } : {}) }); return;
      }
      const device = this.device(bearer, origin);
      if (!device) fail(401, 'unauthorized', 'Pair this browser first');
      if (path === '/api/browser/bootstrap' && req.method === 'POST') {
        await this.body(req);
        if (!this.authorize(bearer, origin)) fail(401, 'unauthorized', 'Browser credential revoked');
        this.send(res, 200, { ...this.opts.bootstrap(), localNonce: bearer }); return;
      }
      if (path === '/api/browser/commands' && req.method === 'POST') {
        const body = await this.body(req);
        if (typeof body.requestId !== 'string' || !body.requestId || body.requestId.length > 128 || typeof body.type !== 'string' || !commandTypes.has(body.type) || !object(body.payload)) fail(400, 'invalid_command', 'Invalid command envelope');
        if (!this.authorize(bearer, origin)) fail(401, 'unauthorized', 'Browser credential revoked');
        requestId = body.requestId as string;
        const payload = body.payload as Record<string, unknown>;
        if (payload.bridgeId !== undefined && payload.bridgeId !== this.opts.bootstrap().bridgeId) fail(403, 'wrong_bridge', 'Command targets another bridge');
        const key = `${device!.id}:${requestId}`;
        const serialized = canonical(body);
        let cached = this.commands.get(key);
        if (cached && cached.body !== serialized) fail(409, 'request_conflict', 'Request ID was used for a different command');
        if (!cached) {
          if (this.commands.size >= 1000) fail(429, 'command_limit', 'Command cache is full; wait before issuing new commands');
          const entry: Cached = { body: serialized, result: Promise.resolve(undefined as unknown as CommandResponse) };
          entry.result = Promise.resolve().then(() => this.opts.execute(body as unknown as Command)).catch(() => ({ requestId, success: false, error: 'Local command failed' })).finally(() => { entry.completedAt = Date.now(); });
          this.commands.set(key, entry); cached = entry;
        }
        this.send(res, 200, await cached!.result); return;
      }
      if (path === '/api/browser/events' && req.method === 'GET') {
        const raw = url.searchParams.get('cursor') ?? '0';
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) fail(400, 'invalid_cursor', 'Invalid cursor');
        const cursor = Number(raw);
        const reply = () => {
          const reset = cursor > this.sequence || cursor < (this.events[0]?.sequence ?? this.sequence + 1) - 1;
          return { cursor: this.sequence, reset, events: this.events.filter(e => reset || e.sequence > cursor).map(({ channel, data }) => ({ channel, data })) };
        };
        if (cursor !== this.sequence) { this.send(res, 200, reply()); return; }
        if ([...this.waiters.values()].filter(id => id === device!.id).length >= 2) fail(429, 'poll_limit', 'Too many pending event requests');
        await new Promise<void>(resolve => {
          const wake = () => { clearTimeout(timer); this.waiters.delete(wake); res.off('close', wake); resolve(); };
          const timer = setTimeout(wake, 20_000); timer.unref();
          this.waiters.set(wake, device!.id); res.once('close', wake);
        });
        if (!this.authorize(bearer, origin)) fail(401, 'unauthorized', 'Browser credential revoked');
        this.send(res, 200, reply()); return;
      }
      fail(404, 'not_found', 'Not found');
    } catch (error) {
      const known = error instanceof HttpError;
      this.send(res, known ? error.status : 503, { error: known ? error.message : 'Local bridge unavailable', code: known ? error.code : 'unavailable', requestId });
    }
  }
  publish(channel: string, data: unknown): void {
    if (this.closed) return;
    // Clone publications so later caller mutations cannot alter history or byte accounting.
    const serialized = JSON.stringify({ channel, data });
    const bytes = Buffer.byteLength(serialized);
    const clone = JSON.parse(serialized) as { channel: string; data: unknown };
    this.sequence++;
    if (bytes > 2 * 1024 * 1024) { this.events = []; this.eventBytes = 0; }
    else {
      this.events.push({ sequence: this.sequence, ...clone, bytes }); this.eventBytes += bytes;
      while (this.events.length > 256 || this.eventBytes > 2 * 1024 * 1024) this.eventBytes -= this.events.shift()!.bytes;
    }
    for (const wake of [...this.waiters.keys()]) wake();
  }
  close(): void {
    this.closed = true; this.windowExpires = 0; this.pairings.clear();
    for (const wake of [...this.waiters.keys()]) wake();
    this.devices.clear(); this.events = []; this.commands.clear(); this.rates.clear();
  }
}
