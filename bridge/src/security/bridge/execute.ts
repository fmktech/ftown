import type { ApplicationJson, EnrollmentPacket, InboundTransportContext, SecureEnvelope, VerifiedApplication } from '../protocol.js';
import { BridgeSecurityService } from './security.js';
import { BridgeSecurityError } from './errors.js';

export async function executeSecurePacket(security: BridgeSecurityService, packet: SecureEnvelope | EnrollmentPacket,
  route: InboundTransportContext, dispatch: (message: VerifiedApplication) => Promise<ApplicationJson>,
  admission?: (accept: () => Promise<VerifiedApplication>) => Promise<VerifiedApplication>): Promise<SecureEnvelope> {
  if (packet.type === 'ftown_enrollment' || packet.purpose !== 'application') return security.handleHandshake(packet, route);
  let verified: VerifiedApplication | undefined;
  let dispatchStarted = false;
  try {
    verified = await (admission ? admission(() => security.acceptApplication(packet, route)) : security.acceptApplication(packet, route));
    const activation = verified.application.route.kind === 'command' && verified.application.route.command === 'security_activate_mcp';
    if (!activation) await security.revalidate(verified.principal);
    const selfRevocation = await security.revokeSelfWithReceipt(verified, route);
    if (selfRevocation) return selfRevocation;
    dispatchStarted = true;
    const data = await dispatch(verified);
    const result = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    const response = result?.response && typeof result.response === 'object' && !Array.isArray(result.response) ? result.response : null;
    const body = result?.body && typeof result.body === 'object' && !Array.isArray(result.body) ? result.body : null;
    const failedHttp = typeof result?.status === 'number' && result.status >= 400;
    const unknown = body?.outcomeUnknown === true;
    await security.complete(verified, unknown ? 'unknown' : failedHttp || response?.success === false ? 'rejected' : 'succeeded',
      failedHttp ? typeof body?.code === 'string' ? body.code : 'bridge_error' : response?.success === false ? 'bridge_error' : null);
    return security.sealTo(packet.senderId, { type: 'application', route: { kind: 'response', requestId: packet.messageId }, data, mcp: null }, route);
  } catch (error) {
    // Never authenticate an error on behalf of an unauthenticated/tampered packet.
    if (!verified && (!(error instanceof BridgeSecurityError)
      || !['permission_denied', 'epoch_changed', 'expired', 'replayed', 'capacity_exceeded', 'audit_unavailable'].includes(error.code))) throw error;
    const code = error instanceof BridgeSecurityError ? error.code : dispatchStarted ? 'outcome_unknown' : 'permission_denied';
    if (verified) await security.complete(verified, dispatchStarted ? 'unknown' : 'rejected', code).catch(() => undefined);
    return security.sealTo(packet.senderId, { type: 'application', route: { kind: 'response', requestId: packet.messageId },
      data: { status: dispatchStarted ? 500 : 403, body: { error: code, code, outcomeUnknown: dispatchStarted } }, mcp: null }, route);
  }
}
