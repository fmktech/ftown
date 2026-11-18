/**
 * Message framing for direct channels (WebRTC DataChannel, loopback WebSocket). Shared with the UI.
 *
 * A DataChannel message is limited to about 256 KiB, while a sealed envelope may be larger. A message is split into text frames
 * `id.index.total.payload`; a frame never starts with `{`, so it cannot be mistaken for an unframed JSON envelope.
 */

/** Chars of payload per frame; 4 bytes worst case each keeps a frame well under the message limit. */
export const FRAME_CHARS = 32_000;
/** Largest framed message; a sealed envelope is itself capped (MAX_ENVELOPE_BYTES), this only bounds reassembly. */
export const MAX_MESSAGE_CHARS = 640_000;
const MAX_FRAMES = Math.ceil(MAX_MESSAGE_CHARS / FRAME_CHARS);
const MAX_ASSEMBLIES = 32;

export const isFrame = (message: string): boolean => !message.startsWith('{');

/** Splits one message into `id.index.total.payload` frames. */
export function frameMessage(message: string, id: string = crypto.randomUUID().replaceAll('-', '').slice(0, 16)): string[] {
  const total = Math.max(1, Math.ceil(message.length / FRAME_CHARS));
  const frames: string[] = [];
  for (let index = 0; index < total; index++) frames.push(`${id}.${index}.${total}.${message.slice(index * FRAME_CHARS, (index + 1) * FRAME_CHARS)}`);
  return frames;
}

/** Reassembles framed messages; throws on anything malformed or over the limits (the caller closes the link). */
export class FrameAssembler {
  private readonly parts = new Map<string, { total: number; next: number; chunks: string[] }>();
  push(frame: string): string | null {
    const match = /^([a-f0-9]{16})\.(\d{1,4})\.(\d{1,4})\./.exec(frame);
    if (!match) throw new Error('Invalid frame');
    const [header, id] = match; const index = Number(match[2]); const total = Number(match[3]);
    const payload = frame.slice(header.length);
    if (total < 1 || total > MAX_FRAMES || index >= total || payload.length > FRAME_CHARS) throw new Error('Invalid frame');
    if (total === 1) { if (this.parts.has(id)) throw new Error('Invalid frame'); return payload; }
    let entry = this.parts.get(id);
    if (!entry) {
      if (index !== 0 || this.parts.size >= MAX_ASSEMBLIES) throw new Error('Invalid frame');
      entry = { total, next: 0, chunks: [] }; this.parts.set(id, entry);
    }
    // The channel is ordered and reliable, so the frames of one message arrive in order.
    if (entry.total !== total || entry.next !== index) throw new Error('Invalid frame');
    entry.chunks.push(payload); entry.next += 1;
    if (entry.next < total) return null;
    this.parts.delete(id);
    return entry.chunks.join('');
  }
}
