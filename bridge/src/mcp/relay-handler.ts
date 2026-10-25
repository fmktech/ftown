import { FleetError } from './fleet.js';

/** Legacy plaintext relay has no execution capability. Native ciphertext uses the verified dispatcher. */
export function createRelayHandler(_port: number, _token: string) {
  return async (_id: string, _payload: Record<string, unknown>): Promise<never> => {
    throw new FleetError('upgrade_required', 'Encrypted endpoint approval is required');
  };
}
