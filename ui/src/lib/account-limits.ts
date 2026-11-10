type Env = Record<string, string | undefined>;

/** The rate limiter refuses budgets at or above the Postgres integer ceiling. */
const CEILING = 2_147_483_646;
/** Variables whose ignored value was already reported by this process. */
const warned = new Set<string>();

/** A plain positive decimal integer, at most CEILING. Anything else that is set (0, negative, fractional, exponent, hex, NaN, too large)
 *  is ignored, with one console.warn per process per variable, and the default applies: a typo never disables a limit. Unset or blank
 *  is the default, silently. */
function positive(env: Env, name: string, fallback: number): number {
  const text = (env[name] ?? '').trim();
  if (text === '') return fallback;
  const parsed = /^[0-9]+$/.test(text) ? Number(text) : NaN;
  if (Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= CEILING) return parsed;
  if (!warned.has(name)) {
    warned.add(name);
    console.warn(`[ftown] ${name}=${JSON.stringify(text.slice(0, 32))} is not a positive integer up to ${CEILING}; using the default ${fallback}`);
  }
  return fallback;
}

/** Soft cap on hosted accounts (FTOWN_MAX_ACCOUNTS, default 1000). */
export function maxAccounts(env: Env = process.env): number {
  return positive(env, 'FTOWN_MAX_ACCOUNTS', 1000);
}

/** Account creations admitted per client IP per hour (FTOWN_ACCOUNT_CREATE_PER_IP_HOUR, default 5). */
export function accountCreatePerHour(env: Env = process.env): number {
  return positive(env, 'FTOWN_ACCOUNT_CREATE_PER_IP_HOUR', 5);
}

/** Writes admitted per 10 minutes to one existing account's ledger (FTOWN_ACCOUNT_WRITES_PER_10MIN, default 60). */
export function accountWritesPer10Min(env: Env = process.env): number {
  return positive(env, 'FTOWN_ACCOUNT_WRITES_PER_10MIN', 60);
}

/** Account creations admitted per day across all clients (FTOWN_ACCOUNT_CREATE_GLOBAL_DAY, default 200). */
export function accountCreateGlobalPerDay(env: Env = process.env): number {
  return positive(env, 'FTOWN_ACCOUNT_CREATE_GLOBAL_DAY', 200);
}
