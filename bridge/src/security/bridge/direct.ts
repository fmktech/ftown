import type { DirectMessage } from '../../direct-transport/contract.js';
import type { ApplicationJson, InboundTransportContext, SecureEnvelope, VerifiedApplication } from '../protocol.js';
import { frameMessage } from '../../direct-transport/framing.js';
import { BridgeStartingError } from './errors.js';
import { parseSecureEnvelope } from '../crypto.js';
import { BridgeSecurityService, applicationJson } from './security.js';

/** Runs one verified command exactly like the relay path does (the bridge's secure dispatch). */
export type DirectCommandDispatch = (message: VerifiedApplication) => Promise<ApplicationJson>;
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
    private readonly dispatch?: DirectCommandDispatch) {
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
        // Tell the client it may send read-only commands here; a client that never hears this keeps them on the relay.
        if (this.dispatch) this.send({ kind: 'capabilities', commands: true });
        return;
      }
      if (!this.endpointId || packet.senderId !== this.endpointId) throw new Error('Unpaired peer');
      const verified = await this.security.acceptApplication(packet, this.route);
      // Read-only commands (admission already limited them to reads) are answered on this channel; they must not hold up terminal frames.
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
    // Without a dispatcher, or over capacity, the command goes unanswered: the browser repeats a read over the relay.
    if (!this.dispatch || this.commandsInFlight >= MAX_COMMANDS_IN_FLIGHT) return;
    const dispatch = this.dispatch;
    this.commandsInFlight += 1;
    void (async () => {
      await this.security.revalidate(verified.principal);
      let data: ApplicationJson;
      try { data = await dispatch(verified); }
      catch (error) {
        const code = error instanceof BridgeStartingError ? 'bridge_starting' : 'bridge_error';
        data = { status: 503, body: { error: code, code } };
      }
      const envelope = await this.security.sealTo(packet.senderId, { type: 'application', route: { kind: 'response', requestId: packet.messageId },
        data, mcp: null }, this.route);
      if (this.closed) return;
      const json = JSON.stringify(envelope);
      for (const frame of json.length > FRAME_THRESHOLD_CHARS ? frameMessage(json) : [json]) this.wireSend(frame);
    })().catch(() => { /* Revoked meanwhile or the channel went away: nothing is answered. */ }).finally(() => { this.commandsInFlight -= 1; });
  }
  async drain(): Promise<void> { await this.inbound; await this.outbound; }
  close(): void { this.closed = true; this.stopRevocation(); }
}
