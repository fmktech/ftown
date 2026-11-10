import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Limits = typeof import('./account-limits');
/** A fresh module per test: the "warn once per process" memory is module state. */
const load = async (): Promise<Limits> => { vi.resetModules(); return import('./account-limits'); };
const limits = [
  { name: 'maxAccounts', key: 'maxAccounts', variable: 'FTOWN_MAX_ACCOUNTS', fallback: 1000 },
  { name: 'accountCreatePerHour', key: 'accountCreatePerHour', variable: 'FTOWN_ACCOUNT_CREATE_PER_IP_HOUR', fallback: 5 },
  { name: 'accountCreateGlobalPerDay', key: 'accountCreateGlobalPerDay', variable: 'FTOWN_ACCOUNT_CREATE_GLOBAL_DAY', fallback: 200 },
] as const;
const ignored = ['0', '00', '-3', '+4', '2.5', '1.0', '1e3', '0x10', '10abc', 'abc', 'NaN', 'Infinity', '2147483647', '99999999999999999999'];
const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

beforeEach(() => { warn.mockClear(); });
afterEach(() => {
  for (const { variable } of limits) delete process.env[variable];
});

describe.each(limits)('$name', ({ key, variable, fallback }) => {
  it(`defaults to ${fallback} when unset or blank, silently`, async () => {
    const read = (await load())[key];
    expect(read({})).toBe(fallback);
    expect(read({ [variable]: '' })).toBe(fallback);
    expect(read({ [variable]: '  ' })).toBe(fallback);
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts a plain positive decimal integer, silently', async () => {
    const read = (await load())[key];
    expect(read({ [variable]: '1' })).toBe(1);
    expect(read({ [variable]: '42' })).toBe(42);
    expect(read({ [variable]: ' 7 ' })).toBe(7);
    expect(read({ [variable]: '05' })).toBe(5);
    expect(read({ [variable]: '2147483646' })).toBe(2147483646);
    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores any other set value (0 included) for the default, with one warning per process', async () => {
    const read = (await load())[key];
    for (const value of ignored) expect(read({ [variable]: value }), JSON.stringify(value)).toBe(fallback);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toBe(`[ftown] ${variable}="0" is not a positive integer up to 2147483646; using the default ${fallback}`);
  });

  it('reads process.env on every call', async () => {
    const read = (await load())[key];
    expect(read()).toBe(fallback);
    process.env[variable] = '9';
    expect(read()).toBe(9);
    process.env[variable] = 'nine';
    expect(read()).toBe(fallback);
  });
});

describe('warnings', () => {
  it('are kept per variable, and truncate a long value', async () => {
    const module = await load();
    module.maxAccounts({ FTOWN_MAX_ACCOUNTS: '0' });
    module.accountCreatePerHour({ FTOWN_ACCOUNT_CREATE_PER_IP_HOUR: 'x'.repeat(100) });
    module.maxAccounts({ FTOWN_MAX_ACCOUNTS: '-1' });
    module.accountCreateGlobalPerDay({ FTOWN_ACCOUNT_CREATE_GLOBAL_DAY: '0' });
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls.map(call => String(call[0]).split('=')[0])).toEqual(['[ftown] FTOWN_MAX_ACCOUNTS', '[ftown] FTOWN_ACCOUNT_CREATE_PER_IP_HOUR', '[ftown] FTOWN_ACCOUNT_CREATE_GLOBAL_DAY']);
    expect(String(warn.mock.calls[1][0])).toContain(`"${'x'.repeat(32)}" is not`);
  });
});
