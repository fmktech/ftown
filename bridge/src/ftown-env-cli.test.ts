import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDoctorReport,
  maskToken,
  resolveProviderSource,
  resolveSetToken,
  run,
} from './ftown-env-cli.js';
import { installFtownEnvCli } from './install-ftown-env-cli.js';
import { loadProviderEnv } from './provider-env-store.js';

/** Capture console.log lines produced while running `fn`, restoring it after. */
function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

/** Async variant of captureLog: awaits `fn` before restoring console.log. */
async function captureLogAsync(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

describe('maskToken', () => {
  it('reveals only the last 4 chars and never the full token', () => {
    const token = 'sk-secret-payload-9876';
    const masked = maskToken(token);
    assert.ok(masked.endsWith('9876'));
    assert.ok(!masked.includes(token));
    assert.ok(!masked.includes('secret-payload'));
  });

  it('fully masks short tokens so a <=4 char secret is never revealed', () => {
    assert.strictEqual(maskToken('abcd').includes('abcd'), false);
    assert.strictEqual(maskToken('xy').includes('xy'), false);
  });
});

describe('resolveProviderSource', () => {
  it('maps a known flavor to its source env key', () => {
    assert.strictEqual(resolveProviderSource('zai'), 'ZAI_API_TOKEN');
    assert.strictEqual(resolveProviderSource('fireworks'), 'FIREWORKS_API_TOKEN');
    assert.strictEqual(resolveProviderSource('kimi'), 'KIMI_API_TOKEN');
    assert.strictEqual(resolveProviderSource('deepseek'), 'DEEPSEEK_API_TOKEN');
  });

  it('throws on an unknown provider', () => {
    assert.throws(() => resolveProviderSource('bogus'), /Unknown provider/);
  });
});

describe('resolveSetToken', () => {
  const never = async (): Promise<string> => {
    throw new Error('readStdin should not be called when a positional token is given');
  };

  it('returns the trimmed positional when a real value is given (stdin not read)', async () => {
    assert.strictEqual(await resolveSetToken('  zai-1234-1234  ', never), 'zai-1234-1234');
  });

  it('reads from stdin when the positional is "-"', async () => {
    assert.strictEqual(await resolveSetToken('-', async () => 'piped-token-9876\n'), 'piped-token-9876');
  });

  it('reads from stdin when the positional is undefined', async () => {
    assert.strictEqual(
      await resolveSetToken(undefined, async () => '  spaced-token  \n'),
      'spaced-token',
    );
  });

  it('throws a clear error on empty stdin', async () => {
    await assert.rejects(resolveSetToken('-', async () => '   \n'), /No token provided/);
  });

  it('throws a clear error on an empty/whitespace positional', async () => {
    await assert.rejects(resolveSetToken('   ', never), /No token provided/);
  });

  it('invokes onArgvToken when a token is passed positionally', async () => {
    let warned = 0;
    await resolveSetToken('argv-token-1234', never, () => {
      warned += 1;
    });
    assert.strictEqual(warned, 1);
  });

  it('does NOT invoke onArgvToken when the token comes from stdin ("-" or undefined)', async () => {
    let warned = 0;
    const warn = (): void => {
      warned += 1;
    };
    await resolveSetToken('-', async () => 'piped-token-1234\n', warn);
    await resolveSetToken(undefined, async () => 'piped-token-5678\n', warn);
    assert.strictEqual(warned, 0);
  });
});

describe('buildDoctorReport', () => {
  it('classifies store-only as env.json, process-only as process-env, absent as missing', () => {
    const report = buildDoctorReport(
      { ZAI_API_TOKEN: 'z' },
      { KIMI_API_TOKEN: 'k' },
    );
    const byFlavor = Object.fromEntries(report.flavors.map((f) => [f.flavor, f.status]));
    assert.strictEqual(byFlavor.zai, 'env.json');
    assert.strictEqual(byFlavor.kimi, 'process-env');
    assert.strictEqual(byFlavor.fireworks, 'missing');
    assert.strictEqual(byFlavor.deepseek, 'missing');
  });

  it('store beats process for the same flavor (classified as env.json)', () => {
    const report = buildDoctorReport(
      { ZAI_API_TOKEN: 'from-store' },
      { ZAI_API_TOKEN: 'from-process' },
    );
    const zai = report.flavors.find((f) => f.flavor === 'zai');
    assert.strictEqual(zai?.status, 'env.json');
  });

  it('Blocked list is exactly the flavors missing from BOTH sources', () => {
    const report = buildDoctorReport(
      { ZAI_API_TOKEN: 'z' },
      { KIMI_API_TOKEN: 'k' },
    );
    assert.deepStrictEqual(report.blocked, ['fireworks', 'deepseek']);
  });

  it('Blocked is empty when every flavor is configured somewhere', () => {
    const report = buildDoctorReport(
      { ZAI_API_TOKEN: 'z', FIREWORKS_API_TOKEN: 'f' },
      { KIMI_API_TOKEN: 'k', DEEPSEEK_API_TOKEN: 'd' },
    );
    assert.deepStrictEqual(report.blocked, []);
  });
});

describe('ftown-env CLI commands (HOME-overridden)', () => {
  let realHome: string | undefined;
  let home: string;

  beforeEach(() => {
    realHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'ftw-env-cli-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  });

  const envPath = (): string => join(home, '.ftown', 'env.json');

  it('set zai writes env.json at mode 0o600 under the SOURCE key', async () => {
    await run(['set', 'zai', 'zai-1234-1234']);
    assert.strictEqual(statSync(envPath()).mode & 0o777, 0o600);
    assert.deepStrictEqual(loadProviderEnv(), { ZAI_API_TOKEN: 'zai-1234-1234' });
  });

  it('set output masks the token (never prints the raw value)', async () => {
    const out = (await captureLogAsync(() => run(['set', 'zai', 'zai-1234-1234']))).join('\n');
    assert.ok(!out.includes('zai-1234-1234'));
    assert.ok(out.includes('1234'));
  });

  it('ls exposes the SOURCE key with a masked value', async () => {
    await run(['set', 'zai', 'zai-1234-1234']);
    const out = captureLog(() => run(['ls'])).join('\n');
    assert.ok(out.includes('ZAI_API_TOKEN'));
    assert.ok(!out.includes('zai-1234-1234'));
    assert.ok(out.includes('1234'));
  });

  it('rm zai drops the stored key', async () => {
    await run(['set', 'zai', 'zai-1234-1234']);
    await run(['rm', 'zai']);
    assert.deepStrictEqual(loadProviderEnv(), {});
  });

  it('rejects on an unknown command (handled as exit-1 by main)', async () => {
    await assert.rejects(run(['bogus']), /Unknown command/);
  });
});

describe('installFtownEnvCli (HOME-overridden)', () => {
  let realHome: string | undefined;
  let tmp: string;
  let fakeCli: string;

  beforeEach(() => {
    realHome = process.env.HOME;
    tmp = mkdtempSync(join(tmpdir(), 'ftw-env-install-'));
    const dist = join(tmp, 'dist');
    mkdirSync(dist, { recursive: true });
    fakeCli = join(dist, 'ftown-env-cli.js');
    writeFileSync(fakeCli, "#!/usr/bin/env node\nimport './provider-env-store.js';\n");
    writeFileSync(join(dist, 'provider-env-store.js'), 'export const STORE = true;\n');
    process.env.HOME = tmp;
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('copies BOTH the cli and the provider-env-store sibling so the runtime import resolves', () => {
    installFtownEnvCli(fakeCli);
    const ftown = join(tmp, '.ftown');
    assert.strictEqual(existsSync(join(ftown, 'ftown-env-cli.js')), true);
    assert.strictEqual(existsSync(join(ftown, 'provider-env-store.js')), true);
    assert.ok(readFileSync(join(ftown, 'provider-env-store.js'), 'utf8').includes('STORE'));
  });

  it('writes an executable launcher under $HOME/.ftown and returns its path', () => {
    const launcher = installFtownEnvCli(fakeCli);
    assert.strictEqual(launcher, join(tmp, '.ftown', 'ftown-env'));
    assert.strictEqual(existsSync(launcher), true);
    assert.ok(statSync(launcher).mode & 0o100);
    assert.ok(readFileSync(launcher, 'utf8').includes('ftown-env-cli.js'));
  });
});
