import type { DirectMessage } from '../../direct-transport/contract.js';
import type { InboundTransportContext } from '../protocol.js';
import { parseSecureEnvelope } from '../crypto.js';
import { BridgeSecurityService, applicationJson } from './security.js';

/** Serial crypto at the peer boundary; application frames never escape as plaintext. */
export class EncryptedPeerChannel {
  private inbound: Promise<void> = Promise.resolve();
  private outbound: Promise<void> = Promise.resolve();
  private endpointId: string | null = null;
  private closed = false;
  private readonly stopRevocation: () => void;
  constructor(private readonly security: BridgeSecurityService, private readonly route: InboundTransportContext,
    private readonly wireSend: (json: string) => void, private readonly deliver: (frame: DirectMessage) => void,
    private readonly authorized: () => void, private readonly teardown: () => void) {
    this.stopRevocation = security.onRevoked(id => { if (id === this.endpointId) this.teardown(); });
  }
  receive(json: string): Promise<void> {
    this.inbound = this.inbound.then(async () => {
      if (this.closed) return;
      const packet = parseSecureEnvelope(JSON.parse(json));
      if (packet.purpose === 'hello') {
        if (this.endpointId && this.endpointId !== packet.senderId) throw new Error('Wrong peer');
        const response = await this.security.handleHandshake(packet, this.route);
        // A pending MCP hello is harmless but cannot open an application data channel.
        await this.security.policy.principal(packet.senderId);
        this.endpointId = packet.senderId;
        this.wireSend(JSON.stringify(response)); this.authorized();
        return;
      }
      if (!this.endpointId || packet.senderId !== this.endpointId) throw new Error('Unpaired peer');
      const verified = await this.security.acceptApplication(packet, this.route);
      if (verified.application.route.kind !== 'terminal') throw new Error('Invalid direct application route');
      await this.security.revalidate(verified.principal);
      this.deliver(verified.application.data as unknown as DirectMessage);
      await this.security.complete(verified, 'succeeded');
      await this.outbound;
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
  async drain(): Promise<void> { await this.inbound; await this.outbound; }
  close(): void { this.closed = true; this.stopRevocation(); }
}
