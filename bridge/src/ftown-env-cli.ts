#!/usr/bin/env node
/**
 * `ftown env` — manage per-provider machine tokens in ~/.ftown/env.json.
 *
 * Installed to ~/.ftown/ftown-env by ftown-bridge (alongside a sibling copy of
 * provider-env-store.js). Imports ONLY ./provider-env-store.js (plus node
 * builtins) so a single sibling copy makes the installed CLI self-sufficient.
 * Every token value is masked before it touches stdout — raw secrets never print.
 */
import { pathToFileURL } from 'node:url';

import {
  PROVIDER_AUTH_ENV,
  PROVIDER_FLAVORS,
  listProviderEnv,
  removeProviderToken,
  setProviderToken,
} from './provider-env-store.js';

/** Mask all but the last 4 chars; tokens of length <=4 are fully masked. */
export function maskToken(value: string): string {
  if (value.length <= 4) return '****';
  return `****${value.slice(-4)}`;
}

/** Resolve a provider flavor to its source env-var KEY. Throws on unknown. */
export function resolveProviderSource(provider: string): string {
  const mapping = PROVIDER_AUTH_ENV[provider];
  if (!mapping) {
    throw new Error(
      `Unknown provider "${provider}" — use one of: ${PROVIDER_FLAVORS.join(', ')}`,
    );
  }
  return mapping.source;
}

/**
 * Resolve the token for `set` without exposing it on argv.
 *
 * When `positional` is a real value (defined and not the "-" stdin sentinel) it
 * is used verbatim (trimmed) and `onArgvToken` is invoked so the caller can warn
 * that an argv token leaks into `ps`/shell history. Otherwise the token is read
 * from stdin via `readStdin` (piped, keeping it out of `ps` output and shell
 * history). Throws a clear error when no non-empty token is found.
 */
export async function resolveSetToken(
  positional: string | undefined,
  readStdin: () => Promise<string>,
  onArgvToken?: () => void,
): Promise<string> {
  const fromArgv = positional !== undefined && positional !== '-';
  if (fromArgv) onArgvToken?.();
  const raw = fromArgv ? positional : await readStdin();
  const token = (raw ?? '').trim();
  if (!token) {
    throw new Error(
      'No token provided — pass it as an argument or pipe it via stdin ' +
        '(e.g. `printf %s "$TOKEN" | ftown env set <provider> -`)',
    );
  }
  return token;
}

/** Read all of process.stdin to end, decoded as UTF-8 (trimming is the caller's job). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export type DoctorStatus = 'env.json' | 'process-env' | 'missing';

export interface DoctorFlavorEntry {
  flavor: string;
  source: string;
  status: DoctorStatus;
}

export interface DoctorReport {
  flavors: DoctorFlavorEntry[];
  blocked: string[];
}

/**
 * Classify each flavor's token: stored in env.json wins over the process env;
 * a flavor absent from BOTH is "missing" and listed under `blocked`.
 */
export function buildDoctorReport(
  store: Record<string, string>,
  processEnv: Record<string, string | undefined>,
): DoctorReport {
  const flavors: DoctorFlavorEntry[] = PROVIDER_FLAVORS.map((flavor) => {
    const source = PROVIDER_AUTH_ENV[flavor].source;
    let status: DoctorStatus;
    if (store[source]) status = 'env.json';
    else if (processEnv[source]) status = 'process-env';
    else status = 'missing';
    return { flavor, source, status };
  });
  const blocked = flavors.filter((f) => f.status === 'missing').map((f) => f.flavor);
  return { flavors, blocked };
}

/** Positional args, skipping flags and the values of value-taking flags. */
function positionals(args: string[], valueFlags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (valueFlags.includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function usage(): void {
  console.error(`Usage: ftown env <command> [options]

Commands:
  set <provider> [token]   Store a machine token for a provider
  ls                       List configured provider tokens (masked)
  rm <provider>            Remove a stored provider token
  doctor                   Report which providers are configured / blocked

Providers: ${PROVIDER_FLAVORS.join(' | ')}

Recommended (keeps the token out of \`ps\` and shell history): omit the token
positional and read it from stdin —
  ftown env set zai                        then paste the token and press Ctrl-D
  printf %s "$TOKEN" | ftown env set zai -  pipe it (the "-" forces stdin)

Tokens live in ~/.ftown/env.json (mode 0o600). Values are always masked on output.`);
}

/** Dispatch a single command. Throws on bad input; main() maps that to exit 1. */
export async function run(argv: string[]): Promise<void> {
  const cmd = argv[0];
  const rest = argv.slice(1);

  switch (cmd) {
    case 'set': {
      const positional = positionals(rest, []);
      const provider = positional[0];
      if (!provider) {
        throw new Error('Usage: ftown env set <provider> [token]  (omit the token to read it from stdin)');
      }
      const source = resolveProviderSource(provider);
      const token = await resolveSetToken(positional[1], readStdin, () =>
        console.error(
          'ftown-env: warning: the token was passed as an argument, which exposes it to ' +
            '`ps` and shell history. Prefer stdin: `printf %s "$TOKEN" | ftown env set <provider> -`.',
        ),
      );
      setProviderToken(source, token);
      console.log(`set ${source} (${maskToken(token)}) for ${provider}`);
      break;
    }

    case 'ls': {
      const store = listProviderEnv();
      const keys = Object.keys(store);
      if (keys.length === 0) {
        console.log('(no provider tokens configured)');
        break;
      }
      for (const key of keys) console.log(`${key}  ${maskToken(store[key])}`);
      break;
    }

    case 'rm': {
      const positional = positionals(rest, []);
      const provider = positional[0];
      if (!provider) throw new Error('Usage: ftown env rm <provider>');
      const source = resolveProviderSource(provider);
      const existed = removeProviderToken(source);
      console.log(existed ? `removed ${source} for ${provider}` : `${source} (${provider}) was not set`);
      break;
    }

    case 'doctor': {
      const report = buildDoctorReport(listProviderEnv(), process.env);
      for (const f of report.flavors) {
        console.log(`${f.flavor.padEnd(9)} ${f.source.padEnd(20)} ${f.status}`);
      }
      console.log(`blocked: ${report.blocked.length ? report.blocked.join(', ') : '(none)'}`);
      break;
    }

    default:
      usage();
      throw new Error(cmd ? `Unknown command "${cmd}"` : 'No command given');
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    usage();
    process.exit(argv.length === 0 ? 1 : 0);
  }
  try {
    await run(argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ftown-env: ${msg}`);
    process.exit(1);
  }
}

// Only run as a script (installed CLI / `node dist/ftown-env-cli.js`), never on
// import — tests import the exported helpers without triggering the dispatcher.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main();
}
