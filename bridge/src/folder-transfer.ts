import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CHUNK_BYTES, MAX_SNAPSHOT_BYTES, extractSnapshot, installSnapshot, makePrivateDirectory, readSnapshot, sha256, writeBytes } from './folder-snapshot.js';
import type { PeerControl } from './peer-control.js';
import { inode, matchesInode, TransferJournal, TRANSFER_ID, type Inode, type StoredReceive } from './folder-transfer-journal.js';
import { TRANSFER_WIRE } from './folder-transfer-protocol.js';

const LEASE_MS = 120_000;
// Leave capacity for control requests on the shared DataChannel.
const LIMIT = 4;
const WINDOW = 4;
const HISTORY_LIMIT = 64;
const INVITATION_MS = 15 * 60_000;

type State = 'waiting' | 'connecting' | 'copying' | 'verifying' | 'installing' | 'installed' | 'retained' | 'failed' | 'cancelled';
interface Status {
  id: string;
  direction: 'send' | 'receive';
  state: State;
  bytes: number;
  entries?: number;
  error?: string;
}
interface Job {
  status: Status;
  abort: AbortController;
  operation?: Promise<void>;
}
interface Receive extends Job {
  endpoint: string;
  destination: string;
  parent: Inode;
  stored?: StoredReceive;
  cancelling?: Promise<void>;
  lease?: ReturnType<typeof setTimeout>;
  digest?: string;
  chunks: Map<number, Promise<void>>;
  written: Map<number, number>;
  end?: number;
}
interface Send extends Job { bridge: string; monitor?: boolean }
interface History {
  status: Status;
  endpoint?: string;
  monitor?: Send;
}

type Input = Record<string, unknown>;
function record(value: unknown): Input {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Input : {};
}

class TransferError extends Error {}

function localPath(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value === '/' || value !== normalize(value)
    || value.endsWith('/') || Buffer.byteLength(value) > 4096 || /[\\\x00-\x1f\x7f]/.test(value)
    || value.split('/').slice(1).some(part => Buffer.byteLength(part) > 255)) {
    throw new TransferError('Use a normalized local path within the supported path limits.');
  }
  return value;
}

async function trustedParent(path: string): Promise<Inode> {
  const uid = process.getuid?.();
  const rootUid = (await lstat('/')).uid;
  for (let current = path; ; current = dirname(current)) {
    const info = await lstat(current);
    if (!info.isDirectory() || (info.uid !== rootUid && info.uid !== uid)
      || ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)) {
      throw new TransferError('Destination needs a trusted local parent directory.');
    }
    if (current === dirname(current)) break;
  }
  return inode(path);
}

async function ensureAbsent(path: string): Promise<void> {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (existing) throw new TransferError('Destination already exists.');
}

function terminal(state: State): boolean {
  return state === 'failed' || state === 'installed' || state === 'cancelled';
}

export class FolderTransfers {
  private readonly incoming = new Map<string, Receive>();
  private readonly outgoing = new Map<string, Send>();
  private readonly history = new Map<string, History>();
  private readonly ready: Promise<void>;
  private stopped = false;

  constructor(private readonly peers: PeerControl, private readonly journal?: TransferJournal) {
    this.ready = this.recover();
    // Dispatch reports initialization errors without leaking local paths.
    void this.ready.catch(() => {});
  }

  private async recover(): Promise<void> {
    for (const { id, saved } of await this.journal?.entries() ?? []) {
      const { destination, endpoint, stage, stageInode, verified, committing } = saved;
      const parent = await trustedParent(dirname(destination)).catch(() => ({ dev: '', ino: '' }));
      const job: Receive = { endpoint, destination, parent, stored: saved, abort: new AbortController(), chunks: new Map(), written: new Map(),
        status: { id, state: 'failed', bytes: verified?.bytes ?? 0, direction: 'receive' } };
      this.incoming.set(id, job);
      if (committing && await matchesInode(destination, committing.tree)) {
        job.status.state = 'installed';
        job.status.entries = committing.entries;
      } else if (verified && stageInode && await matchesInode(stage, stageInode)) {
        job.digest = verified.digest;
        job.status.state = 'retained';
        job.status.error = 'Verified snapshot recovered after restart. Retry installation or discard it.';
        await this.removeTree(job).catch(() => {});
        continue;
      } else job.status.error = 'Transfer interrupted by bridge restart.';
      await this.settle(job);
    }
  }

  private view(job: Job): Status { return { ...job.status }; }

  private async current(job: Receive | Send): Promise<Status> {
    if (terminal(job.status.state) || job.status.state === 'retained') {
      await job.operation;
      if ('chunks' in job) await Promise.allSettled(job.chunks.values());
    }
    return this.view(job);
  }

  private finish(job: Receive | Send): void {
    const { id, direction } = job.status;
    const history: History = { status: this.view(job) };
    if ('endpoint' in job) history.endpoint = job.endpoint;
    if ('bridge' in job && job.monitor) history.monitor = job;
    this.history.set(id, history);
    if (this.history.size > HISTORY_LIMIT) this.history.delete(this.history.keys().next().value!);
    (direction === 'receive' ? this.incoming : this.outgoing).delete(id);
  }

  private renew(job: Receive): void {
    clearTimeout(job.lease);
    job.lease = setTimeout(() => { void this.cancelReceive(job); }, job.status.state === 'waiting' ? INVITATION_MS : LEASE_MS);
    job.lease.unref();
  }

  private async clean(job: Receive): Promise<void> {
    clearTimeout(job.lease);
    const saved = job.stored;
    if (saved?.stageInode) {
      if (await matchesInode(saved.stage, saved.stageInode)) await rm(saved.stage, { recursive: true, force: true, maxRetries: 3 });
    } else if (saved) {
      // A crash before the inode is journaled can leave only an empty staging directory.
      await rmdir(saved.stage).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    await this.journal?.remove(job.status.id);
    job.stored = undefined;
  }

  private async settle(job: Receive): Promise<void> {
    try {
      await this.clean(job);
      this.finish(job);
    } catch {
      job.status.error = 'Temporary files could not be removed. Use transfer discard to retry cleanup.';
    }
  }

  private cancelReceive(job: Receive): Promise<void> {
    return job.cancelling ??= (async () => {
      clearTimeout(job.lease);
      job.abort.abort();
      await job.operation;
      await Promise.allSettled(job.chunks.values());
      if (!terminal(job.status.state)) job.status.state = 'cancelled';
      if (this.incoming.get(job.status.id) === job) await this.settle(job);
    })().finally(() => { job.cancelling = undefined; });
  }

  async close(): Promise<void> {
    this.stopped = true;
    await this.ready.catch(() => {});
    await Promise.all([
      ...[...this.incoming.values()].map(async job => {
        await job.cancelling;
        // A receiver restart preserves verified data for local retry. Explicit
        // cancellation still wins if it is already in progress.
        clearTimeout(job.lease);
        job.abort.abort();
        await job.operation;
        await Promise.allSettled(job.chunks.values());
        if (!job.stored?.verified && this.incoming.get(job.status.id) === job) await this.settle(job);
      }),
      ...[...this.outgoing.values()].map(async job => {
        job.abort.abort();
        await job.operation;
      }),
    ]);
  }

  private run(job: Job, action: () => Promise<void>): Promise<void> {
    if (job.operation) throw new TransferError('Transfer is busy.');
    const operation = action().finally(() => { job.operation = undefined; });
    job.operation = operation;
    return operation;
  }

  private async prepare(input: Input): Promise<Status> {
    if (this.incoming.size >= LIMIT) throw new TransferError('Too many incoming transfers.');
    const peer = this.peers.resolve(typeof input.bridge === 'string' ? input.bridge : '');
    const path = localPath(input.path);
    const parent = await realpath(dirname(path));
    const destination = join(parent, basename(path));
    const parentInode = await trustedParent(parent);
    await ensureAbsent(destination);
    if (this.stopped || this.incoming.size >= LIMIT) throw new TransferError('Incoming transfers unavailable.');
    if ([...this.incoming.values()].some(job => job.destination === destination)) throw new TransferError('Destination already reserved.');
    const id = randomUUID();
    const job: Receive = { endpoint: peer.endpoint.id, destination, parent: parentInode, abort: new AbortController(), chunks: new Map(), written: new Map(),
      status: { id, state: 'waiting', bytes: 0, direction: 'receive' } };
    this.incoming.set(id, job);
    this.renew(job);
    return this.view(job);
  }

  private send(input: Input): Status {
    if (this.outgoing.size >= LIMIT) throw new TransferError('Too many outgoing transfers.');
    const source = localPath(input.path);
    const peer = this.peers.resolve(typeof input.bridge === 'string' ? input.bridge : '');
    const id = this.id(input);
    if (this.outgoing.has(id) || this.incoming.has(id)) throw new TransferError('Transfer already active.');
    this.history.delete(id);
    const job: Send = { bridge: peer.bridgeId, abort: new AbortController(), status: { id, state: 'connecting', bytes: 0, direction: 'send' } };
    this.outgoing.set(id, job);
    void this.run(job, () => this.copy(job, source));
    return this.view(job);
  }

  private async request(job: Send, body: Input): Promise<Input> {
    const response = await this.peers.directHttp(job.bridge, TRANSFER_WIRE, { ...body, id: job.status.id });
    const data = record(response.body);
    if (response.status !== 200) throw new TransferError(typeof data.error === 'string' && WIRE_ERRORS.has(data.error)
      ? data.error : 'Recipient rejected the transfer request.');
    return data;
  }

  private async copy(job: Send, source: string): Promise<void> {
    const signal = job.abort.signal;
    let linked = false;
    let begun = false;
    let finishing = false;
    try {
      linked = await this.peers.connectDirect(job.bridge);
      if (!linked) throw new TransferError('No direct bridge link available. Folder bytes require a direct connection.');
      signal.throwIfAborted();
      await this.request(job, { action: 'begin' });
      begun = true;
      job.status.state = 'copying';
      const hash = sha256();
      let queued = 0;
      let window: Promise<Input>[] = [];
      // Limit the sender and receiver to one small window of unacknowledged blocks.
      // A window is drained even when one request fails so cancellation cannot race
      // an older block still being written.
      const drain = async () => {
        const results = await Promise.allSettled(window);
        window = [];
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
        job.status.bytes = queued;
      };
      try {
        for await (const chunk of readSnapshot(source, signal)) {
          signal.throwIfAborted();
          if (queued + chunk.length > MAX_SNAPSHOT_BYTES) throw new TransferError('Snapshot exceeds 64 GiB.');
          hash.update(chunk);
          const request = this.request(job, { action: 'chunk', offset: queued, chunk: chunk.toString('base64') });
          // The pipe can take time to supply the next block.
          void request.catch(() => {});
          window.push(request);
          queued += chunk.length;
          if (window.length === WINDOW) await drain();
        }
        await drain();
      } finally {
        await Promise.allSettled(window);
      }
      signal.throwIfAborted();
      job.status.state = 'verifying';
      finishing = true;
      let reply = await this.request(job, { action: 'verify', bytes: job.status.bytes, digest: hash.digest('hex') });
      while (reply.state === 'verifying' || reply.state === 'installing') {
        job.status.state = reply.state;
        await delay(500, undefined, { signal });
        reply = await this.request(job, { action: 'status' });
      }
      this.updateResult(job, reply);
      job.monitor = reply.state === 'retained';
    } catch (error) {
      job.monitor = finishing && !signal.aborted;
      if ((begun && !finishing) || (linked && signal.aborted)) {
        try {
          const result = await this.request(job, { action: 'cancel' });
          if (signal.aborted || result.state === 'installed') this.updateResult(job, result);
        } catch { /* The receiver lease cleans up an incomplete copy. */ }
      }
      if (!terminal(job.status.state)) {
        job.status.state = signal.aborted ? 'cancelled' : 'failed';
        if (!signal.aborted) job.status.error = error instanceof TransferError ? error.message
          : finishing ? 'Direct exchange failed. Check transfer status on the recipient.'
            : 'Transfer interrupted. Check the direct link, source paths, file types and Python 3 availability.';
      }
    } finally {
      this.finish(job);
    }
  }

  private updateResult(job: Send, reply: Input): void {
    if (Number.isSafeInteger(reply.entries)) job.status.entries = reply.entries as number;
    if (reply.state === 'installed' || reply.state === 'cancelled') {
      job.status.state = reply.state;
      delete job.status.error;
    } else if (reply.state === 'retained') {
      job.status.state = 'retained';
      job.status.error = 'Verified snapshot retained. Retry installation on the recipient.';
    } else {
      job.status.state = 'failed';
      job.status.error = 'Recipient could not verify the snapshot.';
    }
  }

  private id(input: Input): string {
    if (typeof input.id !== 'string' || !TRANSFER_ID.test(input.id)) throw new TransferError('Invalid transfer id.');
    return input.id;
  }

  async local(value: unknown): Promise<unknown> {
    await this.ready;
    const input = record(value);
    const { action } = input;
    if (action === 'list') {
      const live = [...this.incoming.values(), ...this.outgoing.values()];
      const past = [...this.history.values()].map(item => item.status);
      return [...await Promise.all(live.map(job => this.current(job))), ...past];
    }
    if (this.stopped) throw new TransferError('Transfers are stopping.');
    if (action === 'receive') return this.prepare(input);
    if (action === 'send') return this.send(input);
    const id = this.id(input);
    const receive = this.incoming.get(id);
    const send = this.outgoing.get(id);
    const job = receive ?? send;
    const history = this.history.get(id);
    const status = job?.status ?? history?.status;
    if (!status) throw new TransferError('Unknown transfer.');
    if (!job && history?.monitor && ['status', 'cancel', 'discard'].includes(String(action))) {
      const remote = history.monitor;
      try {
        if (!await this.peers.connectDirect(remote.bridge)) throw new Error();
        const reply = await this.request(remote, { action: action === 'status' ? 'status' : 'cancel' });
        if (reply.state === 'verifying' || reply.state === 'installing') return { ...status, state: reply.state, error: undefined };
        delete remote.status.error;
        this.updateResult(remote, reply);
        history.status = this.view(remote);
        if (terminal(remote.status.state)) history.monitor = undefined;
        return history.status;
      } catch {
        if (action !== 'status') throw new TransferError('Recipient unreachable. Cancel or discard on the recipient.');
      }
    }
    if (action === 'status' && job) return this.current(job);
    if (action === 'retry' && receive?.status.state === 'retained') {
      await receive.operation;
      if (receive.abort.signal.aborted || receive.status.state !== 'retained' || this.stopped || receive.operation) {
        throw new TransferError('Action unavailable in this transfer state.');
      }
      this.startInstall(receive);
    } else if (action === 'cancel' || action === 'discard') {
      if (receive) await this.cancelReceive(receive);
      if (send) send.abort.abort();
    } else if (action !== 'status') {
      throw new TransferError('Action unavailable in this transfer state.');
    }
    return { ...status };
  }

  private async begin(job: Receive): Promise<void> {
    const parent = dirname(job.destination);
    await trustedParent(parent);
    if (!await matchesInode(parent, job.parent)) throw new TransferError('Destination parent changed.');
    await ensureAbsent(job.destination);
    const stage = join(parent, `.ftown-transfer-${randomUUID()}`);
    await ensureAbsent(stage);
    const saved: StoredReceive = { stage, destination: job.destination, endpoint: job.endpoint };
    job.stored = saved;
    await this.journal?.save(job.status.id, saved);
    await makePrivateDirectory(stage);
    saved.stageInode = await inode(stage);
    await this.journal?.save(job.status.id, saved);
    const spool = await open(join(stage, 'snapshot'), 'wx', 0o600);
    try { await spool.chmod(0o600); }
    finally { await spool.close(); }
    job.status.state = 'copying';
  }

  private async chunk(job: Receive, input: Input): Promise<void> {
    const offset = input.offset;
    const next = job.status.bytes;
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset % CHUNK_BYTES !== 0
      || offset < next || offset >= next + WINDOW * CHUNK_BYTES || job.chunks.has(offset) || job.written.has(offset)
      || typeof input.chunk !== 'string' || input.chunk.length > Math.ceil(CHUNK_BYTES / 3) * 4) {
      throw new TransferError('Invalid snapshot block.');
    }
    const bytes = Buffer.from(input.chunk, 'base64');
    const end = offset + bytes.length;
    if (!bytes.length || bytes.length > CHUNK_BYTES || bytes.toString('base64') !== input.chunk
      || end > MAX_SNAPSHOT_BYTES || (job.end !== undefined && end > job.end)) throw new TransferError('Invalid snapshot block.');
    if (bytes.length < CHUNK_BYTES) {
      if ([...job.chunks.keys(), ...job.written.keys()].some(index => index > offset)) throw new TransferError('Invalid snapshot block.');
      job.end = end;
    }

    const pending = (async () => {
      try {
        const file = await open(join(job.stored!.stage, 'snapshot'), constants.O_RDWR | constants.O_NOFOLLOW);
        try { await writeBytes(file, bytes, offset); }
        finally { await file.close(); }
        job.written.set(offset, end);
        for (let following; (following = job.written.get(job.status.bytes)) !== undefined;) {
          job.written.delete(job.status.bytes);
          job.status.bytes = following;
        }
        if (!job.abort.signal.aborted && job.status.state === 'copying') this.renew(job);
      } catch {
        job.status.state = 'failed';
        job.status.error = 'Could not stage snapshot data.';
        throw new TransferError(job.status.error);
      } finally {
        if (job.chunks.size === 1 && job.status.state === 'failed') await this.settle(job);
        job.chunks.delete(offset);
      }
    })();
    job.chunks.set(offset, pending);
    await pending;
  }

  private async removeTree(job: Receive): Promise<void> {
    const { stage, stageInode } = job.stored!;
    if (stageInode && await matchesInode(stage, stageInode)) await rm(join(stage, 'tree'), { recursive: true, force: true, maxRetries: 3 });
  }

  private startInstall(job: Receive): void {
    void this.run(job, async () => {
      const signal = job.abort.signal;
      const saved = job.stored!;
      const spool = join(saved.stage, 'snapshot');
      const tree = join(saved.stage, 'tree');
      let verified = saved.verified !== undefined;
      try {
        job.status.state = 'verifying';
        delete job.status.error;
        if (!saved.stageInode || !await matchesInode(saved.stage, saved.stageInode)) throw new Error();
        const file = await open(spool, constants.O_RDWR | constants.O_NOFOLLOW);
        let valid: boolean;
        try {
          const hash = sha256();
          let bytes = 0;
          for await (const chunk of file.createReadStream({ autoClose: false, signal })) {
            hash.update(chunk);
            bytes += chunk.length;
          }
          valid = bytes === job.status.bytes && hash.digest('hex') === job.digest;
          if (valid && !verified) await file.sync();
        } finally {
          await file.close();
        }
        if (!valid) {
          job.status.state = 'failed';
          job.status.error = 'Received snapshot checksum mismatch.';
        } else {
          saved.verified = { bytes: job.status.bytes, digest: job.digest! };
          await this.journal?.save(job.status.id, saved);
          verified = true;
          job.status.state = 'installing';
          await ensureAbsent(job.destination);
          await this.removeTree(job);
          await makePrivateDirectory(tree);
          job.status.entries = await extractSnapshot(spool, tree, job.status.bytes, job.digest!, signal);
          saved.committing = { tree: await inode(tree), entries: job.status.entries };
          await this.journal?.save(job.status.id, saved);
          await trustedParent(dirname(job.destination));
          if (!await matchesInode(dirname(job.destination), job.parent)) throw new Error();
          await installSnapshot(tree, job.destination, signal);
          job.status.state = 'installed';
        }
      } catch {
        job.status.state = signal.aborted && (!this.stopped || job.cancelling) ? 'cancelled' : verified ? 'retained' : 'failed';
        if (job.status.state !== 'cancelled') job.status.error = verified
          ? 'Installation failed. The snapshot is retained for retry or discard.'
          : 'Could not verify the received snapshot.';
      }
      if (terminal(job.status.state)) await this.settle(job);
      else await this.removeTree(job).catch(() => {
        job.status.error = 'Could not remove partial extraction. Discard the snapshot to retry cleanup.';
      });
    });
  }

  async wire(endpoint: string, value: unknown): Promise<Status> {
    await this.ready;
    const input = record(value);
    const id = this.id(input);
    const job = this.incoming.get(id);
    // Completed results remain visible locally. The receiver also returns the final
    // result to its authorized sender after background verification.
    const receipt = this.history.get(id);
    if (!job || job.endpoint !== endpoint) {
      if ((input.action === 'status' || input.action === 'cancel') && receipt?.endpoint === endpoint) return receipt.status;
      throw new TransferError('No matching receive invitation.');
    }
    if (input.action === 'status') return this.current(job);
    if (this.stopped) throw new TransferError('Transfer is busy.');
    if (input.action === 'cancel') {
      await this.cancelReceive(job);
      return this.view(job);
    }
    if (job.abort.signal.aborted || job.operation) throw new TransferError('Transfer is busy.');
    if (input.action === 'verify' && job.status.state === 'copying') {
      if (job.chunks.size || job.written.size || input.bytes !== job.status.bytes || job.status.bytes < 4 || typeof input.digest !== 'string'
        || !/^[0-9a-f]{64}$/.test(input.digest)) throw new TransferError('Invalid snapshot checksum.');
      clearTimeout(job.lease);
      job.digest = input.digest;
      this.startInstall(job);
      return this.view(job);
    }
    if (input.action === 'chunk' && job.status.state === 'copying') {
      await this.chunk(job, input);
      return this.view(job);
    }
    if (input.action === 'begin' && job.status.state === 'waiting') {
      let refusal: TransferError | undefined;
      await this.run(job, async () => {
        try {
          await this.begin(job);
          if (!job.abort.signal.aborted) this.renew(job);
        } catch (error) {
          job.status.state = job.abort.signal.aborted ? 'cancelled' : 'failed';
          job.status.error = transferError(error, 'Could not stage snapshot data.');
          await this.settle(job);
          refusal = new TransferError(job.status.error);
        }
      });
      if (refusal) throw refusal;
      return this.view(job);
    }
    throw new TransferError('Action unavailable in this transfer state.');
  }
}

// Only fixed strings from the remote side may become CLI output.
const WIRE_ERRORS = new Set(['No matching receive invitation.', 'Transfer is busy.', 'Could not stage snapshot data.',
  'Invalid snapshot block.', 'Invalid snapshot checksum.', 'Action unavailable in this transfer state.']);

export function transferError(error: unknown, fallback = 'Transfer request failed. Check the paired bridge and local path.'): string {
  return error instanceof TransferError ? error.message : fallback;
}
