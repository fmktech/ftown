import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionStore } from './session-store.js';

describe('SessionStore.appendTerminalData terminal.log cap', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ftown-store-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps the whole log while under the cap', async () => {
    const store = new SessionStore(dir, { maxTerminalLogBytes: 1024 * 1024 });
    const sid = 'under-cap';
    await store.appendTerminalData(sid, 'HEAD_MARKER\r\n');
    await store.appendTerminalData(sid, 'TAIL_MARKER\r\n');

    const log = await store.loadTerminalLog(sid);
    assert.equal(log, 'HEAD_MARKER\r\nTAIL_MARKER\r\n');
  });

  it('bounds the file and retains the recent tail once the cap is exceeded', async () => {
    const keep = 4096;
    const store = new SessionStore(dir, { maxTerminalLogBytes: keep });
    const sid = 'over-cap';

    // A unique marker that must be evicted (written first, oldest).
    await store.appendTerminalData(sid, 'OLDEST_HEAD_MARKER\r\n');
    // Flood well past the 2x trim trigger so the head is dropped.
    const filler = 'X'.repeat(120) + '\r\n';
    for (let i = 0; i < 400; i++) {
      await store.appendTerminalData(sid, `line-${i}-${filler}`);
    }
    // A unique marker that must survive (written last, newest).
    await store.appendTerminalData(sid, 'NEWEST_TAIL_MARKER\r\n');

    const size = (await stat(store.sessionDir(sid) + '/terminal.log')).size;
    const log = await store.loadTerminalLog(sid);

    // 1. The file is bounded (not the ~50KB we wrote): catches "no trimming".
    assert.ok(size <= keep * 2 + 512, `expected file <= ${keep * 2 + 512}, got ${size}`);
    // 2. The newest output survives: catches "kept the wrong end".
    assert.ok(log.includes('NEWEST_TAIL_MARKER'), 'newest tail must be retained');
    // 3. The oldest output is evicted: catches "trim did not drop the head".
    assert.ok(!log.includes('OLDEST_HEAD_MARKER'), 'oldest head must be evicted');
    // 4. The retained log starts at a line boundary (no partial first line/escape).
    const firstLine = log.split('\r\n', 1)[0];
    assert.ok(
      firstLine.startsWith('[ftown]') || firstLine.startsWith('line-') || firstLine === 'X'.repeat(120),
      `retained log must start on a clean line, got: ${JSON.stringify(firstLine.slice(0, 40))}`,
    );
  });
});
