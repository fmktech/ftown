import { classifyCommand, classifyHttp, classifyTerminal } from './security/bridge/permissions.js';
import type { SecureExecutionObserver } from './security/bridge/execution-observer.js';
import type { ApplicationJson, VerifiedApplication } from './security/protocol.js';
import { UpdateAdmission, UpdateResponseTicket } from './update-admission.js';
import type { ServerResponse } from 'node:http';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
type Entry = { message: VerifiedApplication; release: () => void; ticket?: UpdateResponseTicket; timer?: ReturnType<typeof setTimeout>; sealed: boolean };

/** Tracks only authenticated in-process requests. Transport completion releases their admission fence. */
export class UpdateEffects implements SecureExecutionObserver {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly admission: UpdateAdmission) {}
  admitted(message: VerifiedApplication): void {
    const route = message.application.route;
    const body = message.application.data;
    const permission = route.kind === 'command' ? (route.command === 'security_activate_mcp' ? { mutating: true } : classifyCommand(route.command, record(body) ? body.payload as ApplicationJson : undefined))
      : route.kind === 'http' ? classifyHttp(route.method, route.path)
      : route.kind === 'terminal' ? classifyTerminal(route.frameType) : null;
    const key = message.envelope.messageId;
    if (!key || this.entries.has(key)) throw new Error('Duplicate secure request');
    const release = permission?.mutating ? this.admission.enter() : () => {};
    this.entries.set(key, { message, release, sealed: false });
  }
  attachTicket(message: VerifiedApplication, ticket: UpdateResponseTicket): void {
    const entry = this.entries.get(message.envelope.messageId);
    if (!entry || entry.message !== message || entry.ticket || message.application.route.kind !== 'command' || message.application.route.command !== 'update_bridge') {
      ticket.cancel(); throw new Error('Update response ticket is not bound to an admitted request');
    }
    entry.ticket = ticket;
    entry.timer = setTimeout(() => {
      if (entry.ticket !== ticket) return;
      ticket.cancel(); entry.ticket = undefined;
      if (entry.sealed) this.finish(message.envelope.messageId, false);
    }, 30_000);
    entry.timer.unref();
  }
  sealed(message: VerifiedApplication, data: ApplicationJson): void {
    const entry = this.entries.get(message.envelope.messageId);
    if (!entry || entry.message !== message) throw new Error('Secure request is not admitted');
    entry.sealed = true;
    if (!entry.ticket) return;
    const route = message.application.route; const input = message.application.data;
    const response = record(data) && data.type === 'command_response' && record(data.response) ? data.response : null;
    const accepted = response && record(response.data) ? response.data : null;
    const op = accepted && record(accepted.operation) ? accepted.operation : null;
    const payload = record(input) && record(input.payload) ? input.payload : null;
    if (route.kind !== 'command' || route.command !== 'update_bridge' || !record(input) || input.requestId !== route.requestId
      || !response || response.requestId !== route.requestId || response.success !== true
      || !payload || !accepted || accepted.bridgeId !== payload.bridgeId || !op || op.id !== payload.operationId || op.targetVersion !== payload.targetVersion) {
      this.finish(message.envelope.messageId, false); return;
    }
    entry.ticket.markSealed();
  }
  delivered(requestId: string): void { this.finish(requestId, true); }
  failed(requestId: string): void { this.finish(requestId, false); }
  private finish(key: string, delivered: boolean): void {
    const entry = this.entries.get(key); if (!entry) return;
    this.entries.delete(key); if (entry.timer) clearTimeout(entry.timer);
    entry.release();
    if (delivered && entry.sealed) entry.ticket?.markDelivered(); else entry.ticket?.cancel();
  }
}

/** Per-envelope guard prevents unauthenticated collisions from completing another request. */
export function scopedUpdateObserver(observer?: SecureExecutionObserver): SecureExecutionObserver | undefined {
  if (!observer) return undefined;
  let key: string | undefined;
  return {
    admitted(message) { observer.admitted(message); key = message.envelope.messageId; },
    sealed(message, data) { if (key !== message.envelope.messageId) throw new Error('Secure request identity changed'); observer.sealed(message, data); },
    delivered(id) { if (key === id) { key = undefined; observer.delivered(id); } },
    failed(id) { if (key === id) { key = undefined; observer.failed(id); } },
  };
}

/** Bind transport signals before writing, but never release a running dispatch on close. */
export function observeHttpDelivery(response: ServerResponse, observer: SecureExecutionObserver | undefined, requestId: string): (executionSucceeded: boolean) => void {
  let executionDone = false; let closed = response.destroyed; let finished = false; let done = false;
  const finalize = () => {
    if (done || !executionDone || (!finished && !closed)) return;
    done = true;
    if (finished && !closed) observer?.delivered(requestId); else observer?.failed(requestId);
  };
  response.once('finish', () => { finished = true; finalize(); });
  response.once('close', () => { if (!finished) closed = true; finalize(); });
  response.once('error', () => { closed = true; finalize(); });
  return succeeded => { executionDone = true; if (!succeeded) closed = true; finalize(); };
}
