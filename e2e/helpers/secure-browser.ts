import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { ApplicationJson } from "../../bridge/src/security/protocol.js";
import { readBridgePointer } from "./bridge-api";
import { BRIDGE_HOME, E2E_DIR } from "./config";

export { browserEndpointId } from "./passkey";

interface LocalCli {
  securityCommand(pointer: unknown, type: "security_devices" | "security_invite" | "security_revoke", payload?: Record<string, ApplicationJson>): Promise<ApplicationJson>;
}

/**
 * The bridge's OS-local security CLI over its encrypted local command path
 * (production `cli-client`). In account mode `security_devices` lists the
 * browsers the bridge projected from the account ledger (source "account");
 * invitations (`security_invite`) are refused there (`account_managed`).
 */
export async function bridgeSecurityCommand(type: "security_devices" | "security_invite" | "security_revoke", payload: Record<string, ApplicationJson> = {}, bridgeHome = BRIDGE_HOME): Promise<ApplicationJson> {
  const cli = await import(pathToFileURL(join(E2E_DIR, "..", "bridge", "dist", "cli-client.js")).href) as LocalCli;
  return cli.securityCommand(readBridgePointer(bridgeHome), type, payload);
}
