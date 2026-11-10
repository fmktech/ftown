type Env = Record<string, string | undefined>;

/** The rate limiter refuses budgets at or above the Postgres integer ceiling. */
const CEILING = 2_147_483_646;

/** A plain positive decimal integer, at most CEILING. Anything else (unset, empty, 0, negative, fractional, exponent, hex, NaN, too large)
 *  is the default: a typo never disables a limit. */
function positive(value: string | undefined, fallback: number): number {
  const text = (value ?? '').trim();
  if (!/^[0-9]+$/.test(text)) return fallback;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= CEILING ? parsed : fallback;
}

/** Soft cap on hosted accounts (FTOWN_MAX_ACCOUNTS, default 1000). */
export function maxAccounts(env: Env = process.env): number {
  return positive(env.FTOWN_MAX_ACCOUNTS, 1000);
}

/** Account creations admitted per client IP per hour (FTOWN_ACCOUNT_CREATE_PER_IP_HOUR, default 5). */
export function accountCreatePerHour(env: Env = process.env): number {
  return positive(env.FTOWN_ACCOUNT_CREATE_PER_IP_HOUR, 5);
}

/** Account creations admitted per day across all clients (FTOWN_ACCOUNT_CREATE_GLOBAL_DAY, default 200). */
export function accountCreateGlobalPerDay(env: Env = process.env): number {
  return positive(env.FTOWN_ACCOUNT_CREATE_GLOBAL_DAY, 200);
}
