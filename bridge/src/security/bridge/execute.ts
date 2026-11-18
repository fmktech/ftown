import type { ApplicationJson, EnrollmentPacket, InboundTransportContext, SecureEnvelope, VerifiedApplication } from '../protocol.js';
import { BridgeSecurityService } from './security.js';
import { BridgeSecurityError, BridgeStartingError } from './errors.js';
import type { SecureExecutionObserver } from './execution-observer.js';

/** Seals the refusal for a packet that failed, or rethrows when nothing may be said on behalf of an unauthenticated packet. */
async function refusal(security: BridgeSecurityService, packet: SecureEnvelope, route: InboundTransportContext, error: unknown,
  verified: VerifiedApplication | undefined, dispatchStarted: boolean): Promise<SecureEnvelope> {
  // Never authenticate an error on behalf of an unauthenticated/tampered packet.
  if (!verified && (!(error instanceof BridgeSecurityError)
    || (!['permission_denied', 'epoch_changed', 'expired', 'replayed', 'capacity_exceeded', 'audit_unavailable', 'invalid_account_trust'].includes(error.code)
      && !error.code.startsWith('account_')))) throw error;
  const bridgeStarting = error instanceof BridgeStartingError;
  const code = error instanceof BridgeSecurityError ? error.code : bridgeStarting ? 'bridge_starting' : dispatchStarted ? 'outcome_unknown' : 'permission_denied';
  if (bridgeStarting) return security.sealTo(packet.senderId, { type: 'application', route: { kind: 'response', requestId: packet.messageId },
    data: { type: 'command_response', response: { requestId: packet.messageId, success: false, error: 'Bridge is starting', data: { code, retryable: true } } }, mcp: null }, route);
  return security.sealTo(packet.senderId, { type: 'application', route: { kind: 'response', requestId: packet.messageId },
    data: { status: dispatchStarted ? 500 : 403, body: { error: code, code, outcomeUnknown: dispatchStarted } }, mcp: null }, route);
}

/**
 * Everything after admission: runs an already verified application and seals its answer (or the refusal). Shared by the relay and
 * local paths (through executeSecurePacket) and by direct channels, which admit a packet themselves before knowing its kind.
 */
export async function executeVerified(security: BridgeSecurityService, packet: SecureEnvelope, verified: VerifiedApplication,
  route: InboundTransportContext, dispatch: (message: VerifiedApplication) => Promise<ApplicationJson>, observer?: SecureExecutionObserver): Promise<SecureEnvelope> {
  let dispatchStarted = false;
  try {
    observer?.admitted(verified);
    await security.revalidate(verified.principal);
    const selfRevocation = await security.revokeSelfWithReceipt(verified, route);
    if (selfRevocation) return selfRevocation;
    dispatchStarted = true;
    const data = await dispatch(verified);
    const result = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    const response = result?.response && typeof result.response === 'object' && !Array.isArray(result.response) ? result.response : null;
    const body = result?.body && typeof result.body === 'object' && !Array.isArray(result.body) ? result.body : null;
    const failedHttp = typeof result?.status === 'number' && result.status >= 400;
    const unknown = body?.outcomeUnknown === true;
    const sealing = security.sealTo(packet.senderId, { type: 'application', route: { kind: 'response', requestId: packet.messageId }, data, mcp: null }, route);
    if (!observer) return sealing;
    const sealed = await sealing;
    if (unknown || failedHttp || response?.success === false) observer?.failed(verified.envelope.messageId);
    else observer?.sealed(verified, data);
    return sealed;
  } catch (error) {
    observer?.failed(verified.envelope.messageId);
    return refusal(security, packet, route, error, verified, dispatchStarted);
  }
}

export async function executeSecurePacket(security: BridgeSecurityService, packet: SecureEnvelope | EnrollmentPacket,
  route: InboundTransportContext, dispatch: (message: VerifiedApplication) => Promise<ApplicationJson>,
  admission?: (accept: () => Promise<VerifiedApplication>) => Promise<VerifiedApplication>, observer?: SecureExecutionObserver): Promise<SecureEnvelope> {
  if (packet.type === 'ftown_enrollment' || packet.purpose !== 'application') return security.handleHandshake(packet, route);
  let verified: VerifiedApplication;
  try { verified = await (admission ? admission(() => security.acceptApplication(packet, route)) : security.acceptApplication(packet, route)); }
  catch (error) { return refusal(security, packet, route, error, undefined, false); }
  return executeVerified(security, packet, verified, route, dispatch, observer);
}
