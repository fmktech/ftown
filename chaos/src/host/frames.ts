// Parses the guest's frame port output (frames.txt) back into files.
import { HOST_PROTOCOL } from '../contract.ts';

export interface ParsedFrames {
  files: Map<string, Buffer>;
  exitCode: number;
}

export class FrameError extends Error {}

/** Throws FrameError (an infra error) on any malformed, truncated or unterminated input. */
export function parseFrames(text: string): ParsedFrames {
  const lines = text.replace(/\r/g, '').split('\n');
  const files = new Map<string, Buffer>();
  let i = 0;
  let exitCode: number | null = null;
  while (i < lines.length) {
    const line = lines[i++];
    if (line === '') continue;
    if (exitCode !== null) throw new FrameError(`data after ${HOST_PROTOCOL.exit}: ${line.slice(0, 80)}`);
    const parts = line.split(' ');
    if (parts[0] === HOST_PROTOCOL.exit) {
      if (parts.length !== 2 || !/^\d+$/.test(parts[1])) throw new FrameError(`bad exit line: ${line}`);
      exitCode = Number(parts[1]);
      continue;
    }
    if (parts[0] !== HOST_PROTOCOL.fileBegin || parts.length !== 3 || !/^\d+$/.test(parts[2])) {
      throw new FrameError(`unexpected line ${i}: ${line.slice(0, 80)}`);
    }
    const name = parts[1];
    const size = Number(parts[2]);
    const b64: string[] = [];
    let closed = false;
    while (i < lines.length) {
      const l = lines[i++];
      if (l === `${HOST_PROTOCOL.fileEnd} ${name}`) { closed = true; break; }
      if (!/^[A-Za-z0-9+/=]{1,76}$/.test(l)) throw new FrameError(`bad base64 line in ${name}: ${l.slice(0, 80)}`);
      b64.push(l);
    }
    if (!closed) throw new FrameError(`truncated frame: ${name}`);
    const data = Buffer.from(b64.join(''), 'base64');
    if (data.length !== size) throw new FrameError(`size mismatch for ${name}: header ${size}, got ${data.length}`);
    if (files.has(name)) throw new FrameError(`duplicate file: ${name}`);
    files.set(name, data);
  }
  if (exitCode === null) throw new FrameError(`missing ${HOST_PROTOCOL.exit} (guest did not finish)`);
  return { files, exitCode };
}
