import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFrames } from '../host/frames.ts';

test('emit via CHAOS_FRAMES from a separate process, file by file, round-trips a 2 MB file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chaos-emit-'));
  try {
    const frames = join(dir, 'frames.txt');
    const big = join(dir, 'big.bin');
    const data = randomBytes(2 * 1024 * 1024);
    writeFileSync(big, data);
    const script = `
      import { readFileSync } from 'node:fs';
      const { emitFile, emitExit } = await import(${JSON.stringify(new URL('./emit.ts', import.meta.url).href)});
      emitFile('canon.jsonl', '{"k":"run"}\\n');
      emitFile('side-big.bin', readFileSync(${JSON.stringify(big)}));
      emitExit(1, undefined, null);`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, CHAOS_FRAMES: frames }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const parsed = parseFrames(readFileSync(frames, 'latin1'));
    assert.equal(parsed.exitCode, 1);
    assert.equal(parsed.files.get('canon.jsonl')!.toString(), '{"k":"run"}\n');
    assert.ok(parsed.files.get('side-big.bin')!.equals(data));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
