import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INJECTED_PROMPT_PREFIXES, MAIL_WAKE_TEXT, OPENCODE_MAIL_WAKE_TEXT } from './mail-delivery.js';

const BRIDGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function startsWithListedPrefix(text: string): boolean {
  const trimmed = text.trim();
  return INJECTED_PROMPT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

describe('injected prompt prefixes (single source of truth)', () => {
  it('bridge generators start with a listed prefix', () => {
    assert.ok(startsWithListedPrefix(MAIL_WAKE_TEXT), `MAIL_WAKE_TEXT: ${MAIL_WAKE_TEXT.slice(0, 60)}`);
    assert.ok(startsWithListedPrefix(OPENCODE_MAIL_WAKE_TEXT), `OPENCODE: ${OPENCODE_MAIL_WAKE_TEXT.slice(0, 60)}`);
    assert.equal(MAIL_WAKE_TEXT, "FTown mail may be available. If this prompt's hooks supplied [ftown mail], process that mail without reading it again. Otherwise run `ftown harness mail read` once; if no mail is returned, no action is needed.");
  });

  it('claude-mod static WAKE starts with a listed prefix', () => {
    const path = join(BRIDGE_ROOT, 'claude-mod/hooks/register.js');
    assert.ok(existsSync(path), `missing ${path}`);
    const source = readFileSync(path, 'utf8');
    const match = /const WAKE = "([^"]*)"/.exec(source);
    assert.ok(match, 'WAKE literal not found in register.js');
    assert.ok(startsWithListedPrefix(match[1]), `WAKE: ${match[1].slice(0, 60)}`);
  });

  it('opencode static wake starts with a listed prefix', () => {
    const path = join(BRIDGE_ROOT, 'opencode-plugin/ftown.js');
    assert.ok(existsSync(path), `missing ${path}`);
    const source = readFileSync(path, 'utf8');
    const match = /`([^\`$]+)\$\{MAIL_WAKE_TEXT\}/.exec(source);
    assert.ok(match, 'opencode wake template not found');
    assert.ok(startsWithListedPrefix(match[1]), `opencode lead: ${JSON.stringify(match[1])}`);
  });

  it('pi static wake starts with a listed prefix', () => {
    const path = join(BRIDGE_ROOT, 'pi-extension/ftown.js');
    assert.ok(existsSync(path), `missing ${path}`);
    const source = readFileSync(path, 'utf8');
    const match = /`(\[ftown mail\]\\n)\$\{formatted\}/.exec(source);
    assert.ok(match, 'pi wake template not found');
    const effective = match[1].replace('\\n', '\n');
    assert.ok(startsWithListedPrefix(effective), `pi lead: ${JSON.stringify(effective)}`);
  });
});
