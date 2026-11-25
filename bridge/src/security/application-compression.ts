import { gunzipBounded } from '../gzip.js';
import { MAX_ENVELOPE_BYTES, SecurityError } from './crypto.js';

// A legacy envelope could never carry more plaintext than this after the AEAD tag and base64.
// seal() also applies the exact wire limit for the authenticated header of the current packet.
const MAX_APPLICATION_BYTES = Math.floor(MAX_ENVELOPE_BYTES * 3 / 4) - 16;
const supportsGzip = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
const tooLarge = () => new SecurityError('capacity_exceeded', 'Application exceeds the transport size limit');

/** Old peers already accept opaque epoch and challenge tokens and echo the complete challenge. */
export function gzipHandshakeToken(uuid: string): string {
  return supportsGzip() ? 'gz1_' + uuid : uuid;
}

export function acceptsApplicationGzip(token: string | null): boolean {
  return token?.startsWith('gz1_') === true;
}

export async function encodeApplicationBytes(bytes: Uint8Array, acceptsGzip: boolean): Promise<Uint8Array> {
  if (bytes.length > MAX_APPLICATION_BYTES) throw tooLarge();
  // The gzip header, deflate payload and trailer need at least 20 bytes.
  if (!acceptsGzip || !supportsGzip() || bytes.length <= 20) return bytes;
  const stream = new Response(Uint8Array.from(bytes)).body!.pipeThrough(new CompressionStream('gzip'));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  return compressed.length < bytes.length ? compressed : bytes;
}

/** Called on authenticated application plaintext only. JSON cannot begin with gzip's magic bytes. */
export async function decodeApplicationBytes(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length > MAX_APPLICATION_BYTES) throw tooLarge();
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  try {
    return await gunzipBounded(bytes, MAX_APPLICATION_BYTES);
  } catch (error) {
    if (error instanceof RangeError) throw tooLarge();
    throw new SecurityError('invalid_envelope', 'Invalid compressed application content');
  }
}
