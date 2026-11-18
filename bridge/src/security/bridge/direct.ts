import type { DirectMessage } from '../../direct-transport/contract.js';
import type { ApplicationJson, InboundTransportContext, SecureEnvelope, VerifiedApplication } from '../protocol.js';
import { frameMessage } from '../../direct-transport/framing.js';
import { executeVerified } from './execute.js';
import type { SecureExecutionObserver } from './execution-observer.js';
import { scopedUpdateObserver } from '../../update-effects.js';
import { parseSecureEnvelope } from '../crypto.js';
import { BridgeSecurityService, applicationJson } from './security.js';

/** How a direct channel serves dashboard commands: the bridge's secure dispatch and update observer, exactly as the relay path uses them. */
export interface DirectCommands {
  dispatch: (message: VerifiedApplication) => Promise<ApplicationJson>;
  observer?: SecureExecutionObserver;
}
/** Answers above this size are framed (direct-transport/framing.ts); smaller ones are sent as plain JSON. */
const FRAME_THRESHOLD_CHARS = 60_000;
const MAX_COMMANDS_IN_FLIGHT = 32;

/** Serial crypto per direction at the peer boundary; application frames never escape as plaintext. */
export class EncryptedPeerChannel {
  private commandsInFlight = 0;
  private inbound: Promise<void> = Promise.resolve();
  private outbound: Promise<void> = Promise.resolve();
  private endpointId: string | null = null;
  private closed = false;
  private readonly stopRevocation: () => void;
  constructor(private readonly security: BridgeSecurityService, private readonly route: InboundTransportContext,
    private readonly wireSend: (json: string) => void, private readonly deliver: (frame: DirectMessage) => void,
    private readonly authorized: () => void, private readonly teardown: () => void,
    private readonly commands?: DirectCommands) {
    this.stopRevocation = security.onRevoked(id => { if (id === this.endpointId) this.teardown(); });
  }
  receive(json: string): Promise<void> {
    this.inbound = this.inbound.then(async () => {
      if (this.closed) return;
      const packet = parseSecureEnvelope(JSON.parse(json));
      if (packet.purpose === 'hello') {
        if (this.endpointId && this.endpointId !== packet.senderId) throw new Error('Wrong peer');
        const response = await this.security.handleHandshake(packet, this.route);
        await this.security.policy.principal(packet.senderId);
        this.endpointId = packet.senderId;
        this.wireSend(JSON.stringify(response)); this.authorized();
        // Tell the client it may send dashboard commands here; a client that never hears this keeps them on the relay.
        if (this.commands) this.send({ kind: 'capabilities', commands: true });
        return;
      }
      if (!this.endpointId || packet.senderId !== this.endpointId) throw new Error('Unpaired peer');
      const verified = await this.security.acceptApplication(packet, this.route);
      // Commands are answered on this channel, off the inbound chain so a slow one never holds up terminal frames.
      if (verified.application.route.kind === 'command') { this.serve(packet, verified); return; }
      if (verified.application.route.kind !== 'terminal') throw new Error('Invalid direct application route');
      await this.security.revalidate(verified.principal);
      this.deliver(verified.application.data as unknown as DirectMessage);
    }).catch(() => { this.teardown(); });
    return this.inbound;
  }
  send(frame: DirectMessage): void {
    this.outbound = this.outbound.then(async () => {
      if (this.closed || !this.endpointId) return;
      const envelope = await this.security.sealTo(this.endpointId, { type: 'application', route: { kind: 'terminal',
        sessionId: 'sessionId' in frame ? frame.sessionId : '', frameType: frame.kind, pairId: this.route.pairId },
        data: applicationJson(frame), mcp: null }, this.route);
      if (!this.closed) {
        try { this.wireSend(JSON.stringify(envelope)); } catch { /* Native send failure drops only this frame; keepalive detects dead peers. */ }
      }
    }).catch(() => { this.teardown(); });
  }
  private serve(packet: SecureEnvelope, verified: VerifiedApplication): void {
    // Without a dispatcher, or over capacity, the command goes unanswered and the client reports it as undelivered.
    if (!this.commands || this.commandsInFlight >= MAX_COMMANDS_IN_FLIGHT) return;
    const { dispatch, observer: shared } = this.commands;
    const observer = scopedUpdateObserver(shared);
    const messageId = packet.messageId;
    this.commandsInFlight += 1;
    void (async () => {
      const envelope = await executeVerified(this.security, packet, verified, this.route, dispatch, observer);
      if (this.closed) { observer?.failed(messageId); return; }
      const json = JSON.stringify(envelope);
      for (const frame of json.length > FRAME_THRESHOLD_CHARS ? frameMessage(json) : [json]) this.wireSend(frame);
      observer?.delivered(messageId);
    })().catch(() => { observer?.failed(messageId); }).finally(() => { this.commandsInFlight -= 1; });
  }
  async drain(): Promise<void> { await this.inbound; await this.outbound; }
  close(): void { this.closed = true; this.stopRevocation(); }
}
