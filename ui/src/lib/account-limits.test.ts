import { afterEach, describe, expect, it } from 'vitest';
import { accountCreateGlobalPerDay, accountCreatePerHour, maxAccounts } from './account-limits';

const limits = [
  { name: 'maxAccounts', read: maxAccounts, variable: 'FTOWN_MAX_ACCOUNTS', fallback: 1000 },
  { name: 'accountCreatePerHour', read: accountCreatePerHour, variable: 'FTOWN_ACCOUNT_CREATE_PER_IP_HOUR', fallback: 5 },
  { name: 'accountCreateGlobalPerDay', read: accountCreateGlobalPerDay, variable: 'FTOWN_ACCOUNT_CREATE_GLOBAL_DAY', fallback: 200 },
];
const unusable = ['', ' ', '0', '00', '-3', '+4', '2.5', '1.0', '1e3', '0x10', '10abc', 'abc', 'NaN', 'Infinity', '2147483647', '99999999999999999999'];

afterEach(() => {
  for (const { variable } of limits) delete process.env[variable];
});

describe.each(limits)('$name', ({ read, variable, fallback }) => {
  it(`defaults to ${fallback} when unset`, () => {
    expect(read({})).toBe(fallback);
  });

  it('accepts a plain positive decimal integer', () => {
    expect(read({ [variable]: '1' })).toBe(1);
    expect(read({ [variable]: '42' })).toBe(42);
    expect(read({ [variable]: ' 7 ' })).toBe(7);
    expect(read({ [variable]: '05' })).toBe(5);
    expect(read({ [variable]: '2147483646' })).toBe(2147483646);
  });

  it('falls back to the default for anything else', () => {
    for (const value of unusable) expect(read({ [variable]: value }), JSON.stringify(value)).toBe(fallback);
  });

  it('reads process.env on every call', () => {
    expect(read()).toBe(fallback);
    process.env[variable] = '9';
    expect(read()).toBe(9);
    process.env[variable] = 'nine';
    expect(read()).toBe(fallback);
  });
});
