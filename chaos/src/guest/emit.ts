// Sends files to the host over the second serial port using HOST_PROTOCOL framing.
import { closeSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { HOST_PROTOCOL } from '../contract.ts';

export const FRAME_PORT = '/dev/ttyS1';
/** Marker file the guest init checks to know main already sent CHAOS-EXIT. */
export const EXIT_SENT_MARKER = '/run/chaos-exit-sent';
const NAME_RE = /^[A-Za-z0-9._-]+$/;

/** Encodes one file as a frame. Pure. */
export function encodeFile(name: string, data: Uint8Array | string): string {
  if (!NAME_RE.test(name)) throw new Error(`bad frame file name: ${JSON.stringify(name)}`);
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  const b64 = buf.toString('base64');
  const lines: string[] = [`${HOST_PROTOCOL.fileBegin} ${name} ${buf.length}`];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  lines.push(`${HOST_PROTOCOL.fileEnd} ${name}`);
  return lines.join('\n') + '\n';
}

export function encodeExit(code: number): string {
  return `${HOST_PROTOCOL.exit} ${code}\n`;
}

function writeAll(text: string, port: string): void {
  const fd = openSync(port, 'w');
  try {
    const buf = Buffer.from(text, 'utf8');
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
  } finally {
    closeSync(fd);
  }
}

export function emitFile(name: string, data: Uint8Array | string, port = FRAME_PORT): void {
  writeAll(encodeFile(name, data), port);
}

export function emitExit(code: number, port = FRAME_PORT, marker: string | null = EXIT_SENT_MARKER): void {
  writeAll(encodeExit(code), port);
  if (marker !== null) writeFileSync(marker, String(code));
}
