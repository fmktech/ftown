export type ChannelKind =
  | 'sessions:updates'
  | 'commands:rpc'
  | 'bridges:presence'
  | 'bridges:security'
  | 'bridges:ledger';

type SessionChannelKind = 'terminal' | 'terminal-input' | 'events' | 'stream';

const ACCOUNT_ID_FORBIDDEN = /[#:,\s]/;
const SESSION_ID_FORBIDDEN = /[#,\s]/;

function invalidPart(): Error {
  return new Error('invalid_channel_part');
}

export function accountChannel(kind: ChannelKind, accountId: string): string {
  if (accountId.length === 0 || ACCOUNT_ID_FORBIDDEN.test(accountId)) {
    throw invalidPart();
  }
  return `${kind}#${accountId}`;
}

export function sessionChannel(
  kind: SessionChannelKind,
  sessionId: string,
  accountId: string,
): string {
  if (sessionId.length === 0 || SESSION_ID_FORBIDDEN.test(sessionId)) {
    throw invalidPart();
  }
  if (accountId.length === 0 || ACCOUNT_ID_FORBIDDEN.test(accountId)) {
    throw invalidPart();
  }
  return `${kind}:${sessionId}#${accountId}`;
}
