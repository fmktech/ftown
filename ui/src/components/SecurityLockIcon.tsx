import type { BridgeSecurityState } from "@security/protocol";

export type SecurityLockState = "secured" | "approval_needed" | "unknown";
export interface SecurityLockIconProps { state: SecurityLockState; className?: string }

/** Connection evidence only; it never asserts account-wide authority. */
export function bridgeConnectionLock(status: BridgeSecurityState["status"] | undefined): { state: SecurityLockState; title: string } {
  switch (status) {
    case "ready": return { state: "secured", title: "Encrypted connection" };
    case "unpaired": return { state: "approval_needed", title: "Approval required" };
    case "revoked": return { state: "approval_needed", title: "Access revoked" };
    case "key_changed": return { state: "approval_needed", title: "Computer key changed" };
    case "upgrade_required": return { state: "approval_needed", title: "Computer upgrade required" };
    case "connecting": return { state: "unknown", title: "Checking encrypted connection" };
    case "offline": return { state: "unknown", title: "Computer offline — connection not verified" };
    default: return { state: "unknown", title: "Connection status unknown" };
  }
}

export function SecurityLockIcon({ state, className }: SecurityLockIconProps) {
  return <svg aria-hidden="true" data-lock-state={state} className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="10" width="14" height="11" rx="2" />
    {state === "approval_needed" ? <path d="M9 10V6a4 4 0 0 1 8 0" /> : <path d="M8 10V6a4 4 0 0 1 8 0v4" />}
    <path d="M12 14v3" />
  </svg>;
}
