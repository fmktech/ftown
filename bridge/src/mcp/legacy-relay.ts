import { FleetError, type BridgeRequest } from "./fleet.js";

/** Kept only to fail explicitly for callers of the removed plaintext helper. */
export function legacyRelayCommand(_machineId: string, _request: BridgeRequest, _deadline: number): never {
  throw new FleetError("upgrade_required", "Plaintext legacy MCP execution is no longer supported; approve an encrypted endpoint");
}
