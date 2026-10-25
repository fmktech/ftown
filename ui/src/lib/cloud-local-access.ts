import { SecurityError } from "@security/crypto";

/** The retired cloud capability path explicitly refuses enrollment. */
export function createCloudLocalAccess(_signal: AbortSignal): (info: unknown) => Promise<void> {
  return async (_info: unknown): Promise<void> => {
    throw new SecurityError("approval_required", "Public presence cannot enroll a browser; open a verified invitation");
  };
}
