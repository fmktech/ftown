/**
 * Outbound encrypted publication pipeline contract. See
 * docs/investigations/2026-11-04-bridge-encrypted-publication-capacity-reached.md.
 *
 * Jobs are prepared (sealed + authorized) and their packets sent strictly in enqueue order, but a
 * packet's server reply is not awaited before the next packet is sent. A bounded in-flight window
 * replaces the old one-reply-at-a-time chain, which capped throughput at 1 / (recipients x RTT).
 */

/** Publications accepted but not yet fully sent. Beyond this, new publications are dropped. */
export const OUTBOUND_MAX_QUEUED = 100;
/** Packets sent and still awaiting the server reply. */
export const OUTBOUND_MAX_IN_FLIGHT_PACKETS = 64;
/** Serialized bytes of in-flight packets. A single larger packet may still go out alone. */
export const OUTBOUND_MAX_IN_FLIGHT_BYTES = 2 * 1024 * 1024;
/** Repeated drop / failure warnings are summarized at most once per interval. */
export const OUTBOUND_WARN_INTERVAL_MS = 5000;

export const OUTBOUND_CAPACITY_WARNING = '[Centrifugo] Encrypted publication capacity reached';
export const OUTBOUND_FAILURE_ERROR = '[Centrifugo] Encrypted publication failed';
export const COMMAND_REJECTED_WARNING = '[Centrifugo] Encrypted command rejected';

export interface OutboundPacket {
  /** Serialized size, counted against OUTBOUND_MAX_IN_FLIGHT_BYTES. */
  readonly bytes: number;
  /** Starts sending synchronously; resolves on the server reply, rejects on failure. */
  send(): Promise<void>;
}

export interface OutboundJob {
  /** Accounting label for logs, e.g. "terminal/output". Never secret. */
  readonly label: string;
  /** Seals and authorizes the publication. Called serially, in enqueue order. */
  prepare(): Promise<readonly OutboundPacket[]>;
}

export interface OutboundLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface OutboundPipeline {
  /** Accepts the job, or drops it (returns false) when OUTBOUND_MAX_QUEUED jobs are pending. Never throws. */
  enqueue(job: OutboundJob): boolean;
  /** Jobs accepted whose packets have not all been sent yet. */
  readonly queued: number;
  readonly inFlightPackets: number;
  readonly inFlightBytes: number;
  /** Resolves once every accepted job is sent and every in-flight packet has settled. */
  idle(): Promise<void>;
}

export type CreateOutboundPipeline = (options: { readonly logger: OutboundLogger }) => OutboundPipeline;

/** One-line, non-secret description of an error for logs: "<code>: <message>", at most 200 chars. Never throws. */
export function describeError(error: unknown): string {
  try {
    const record = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : null;
    const code = record && (typeof record.code === 'string' || typeof record.code === 'number') ? String(record.code) : '';
    const message = record && typeof record.message === 'string' ? record.message : record ? '' : String(error);
    const text = code && message ? `${code}: ${message}` : code || message || 'unknown error';
    return text.length > 200 ? `${text.slice(0, 197)}...` : text;
  } catch {
    return 'unknown error';
  }
}
