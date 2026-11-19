export const TRANSFER_LOCAL = '/api/transfer';
export const TRANSFER_WIRE = '/api/transfer/wire';
export const TRANSFER_REQUEST_TTL_MS = 20_000;

// Binary frames share the authenticated, ordered bridge DataChannel with the
// HPKE control messages. The receiver grants one bounded batch at a time.
export const TRANSFER_ID_BYTES = 16;
export const TRANSFER_FRAME_BYTES = 60 * 1024;
export const TRANSFER_CREDIT_BYTES = 16 * 1024 * 1024;
