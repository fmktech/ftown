import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, open, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

import type { HarnessModel, ModelPricing, ModelsFetcher, ProviderModels, QuotaFetchOptions } from './types.js';

/**
 * opencode model list (opencode 2.3.0).
 *
 * Ids come from plain `opencode models` (no arguments): one `provider/model`
 * per line for every connected provider. Details (name, context, cost,
 * reasoning efforts) are joined from opencode's own catalogue cache,
 * `<home>/.cache/opencode/models.json`, keyed by provider id then model id. A
 * missing or unreadable catalogue only drops the details; the ids are still
 * listed.
 *
 * Returned: every model of the selected subscription providers, then every
 * zero-priced ('free') model of any other listed provider.
 *
 * Nothing here starts a model turn. The binary is `<home>/.opencode/bin/opencode`
 * when that file exists, otherwise `opencode` from PATH.
 */

const PROVIDERS_ENV = 'FTOWN_QUOTA_OPENCODE_PROVIDERS';
const DEFAULT_PROVIDERS: readonly string[] = ['opencode-go', 'zai-coding-plan'];
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const BINARY_NAME = 'opencode';
const MODEL_FLAG = '-m <id>';
/** opencode 2.3.0 takes the effort as a `#variant` suffix on the model id. */
const EFFORT_FLAG = '-m <id>#<level>';
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_CATALOGUE_BYTES = 64 * 1024 * 1024;
const CATALOGUE_RELATIVE_PATH = join('.cache', 'opencode', 'models.json');
const UNEXPECTED_OUTPUT_MESSAGE = 'unexpected output from `opencode models`';
const NOT_FOUND_MESSAGE = 'opencode CLI not found';
const FAILED_MESSAGE = '`opencode models` failed';
const TIMED_OUT_MESSAGE = '`opencode models` timed out';
const TOO_LARGE_MESSAGE = '`opencode models` output was too large';
/** A model id line: no whitespace or control characters. */
const ID_LINE_PATTERN = /^[^\s\u0000-\u001f\u007f]+$/;

/**
 * Providers whose zero-priced models are covered by a subscription plan the
 * user holds (priced 'included' rather than 'free'). Any provider id
 * containing `coding-plan` also counts, see isOpencodePlanProvider.
 */
export const OPENCODE_PLAN_PROVIDERS: readonly string[] = [];

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function ownRecord(container: Json, key: string): Json | null {
  if (!Object.prototype.hasOwnProperty.call(container, key)) return null;
  const value = container[key];
  return isRecord(value) ? value : null;
}

/** Pure: true for a subscription-plan provider (listed, or id contains `coding-plan`). */
export function isOpencodePlanProvider(providerId: string): boolean {
  return OPENCODE_PLAN_PROVIDERS.includes(providerId) || providerId.includes('coding-plan');
}

/**
 * Pure: the provider ids to list, from FTOWN_QUOTA_OPENCODE_PROVIDERS (comma
 * separated; entries are trimmed, empties and ids that fail the pattern are
 * dropped, duplicates removed). Falls back to the defaults when the variable is
 * unset, empty, or leaves no valid id.
 */
export function opencodeSubscriptionProviders(env: NodeJS.ProcessEnv): string[] {
  const raw = env[PROVIDERS_ENV];
  const ids: string[] = [];
  if (raw !== undefined) {
    for (const part of raw.split(',')) {
      const id = part.trim();
      if (PROVIDER_ID_PATTERN.test(id) && !ids.includes(id)) ids.push(id);
    }
  }
  return ids.length > 0 ? ids : [...DEFAULT_PROVIDERS];
}

interface ModelRef {
  id: string;
  provider: string;
  model: string;
}

/**
 * Pure: the `provider/model` lines of `opencode models` stdout, in output
 * order, without duplicates. CRLF and blank lines are tolerated; lines with no
 * slash, an empty provider or model part, or whitespace/control characters are
 * ignored.
 */
export function parseOpencodeModelIds(stdout: string): string[] {
  return modelRefs(stdout).map((ref) => ref.id);
}

function modelRefs(stdout: string): ModelRef[] {
  const refs: ModelRef[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || !ID_LINE_PATTERN.test(line)) continue;
    const slash = line.indexOf('/');
    if (slash <= 0 || slash === line.length - 1) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    refs.push({ id: line, provider: line.slice(0, slash), model: line.slice(slash + 1) });
  }
  return refs;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Cost class from a catalogue entry's `cost`, or undefined when not stated. */
function pricingOf(entry: Json | null, provider: string): ModelPricing | undefined {
  const cost = entry === null ? null : entry.cost;
  if (!isRecord(cost)) return undefined;
  const input = finiteNumber(cost.input);
  const output = finiteNumber(cost.output);
  if (input === null || output === null || input < 0 || output < 0) return undefined;
  if (input > 0 || output > 0) return 'paid';
  return isOpencodePlanProvider(provider) ? 'included' : 'free';
}

/** Effort levels from `reasoning_options` entries of type `effort`, in catalogue order. */
function effortsOf(entry: Json | null): { efforts: string[]; defaultEffort: string | null } {
  const efforts: string[] = [];
  let defaultEffort: string | null = null;
  const options = entry === null ? undefined : entry.reasoning_options;
  if (!Array.isArray(options)) return { efforts, defaultEffort };
  for (const option of options) {
    if (!isRecord(option) || option.type !== 'effort' || !Array.isArray(option.values)) continue;
    for (const value of option.values) {
      const rawLevel = nonEmptyString(value);
      const level = rawLevel === null ? null : rawLevel.trim();
      if (level !== null && level.length > 0 && !efforts.includes(level)) efforts.push(level);
    }
    const rawDefault = nonEmptyString(option.default);
    const stated = rawDefault === null ? null : rawDefault.trim();
    if (defaultEffort === null && stated !== null) defaultEffort = stated;
  }
  if (defaultEffort !== null && !efforts.includes(defaultEffort)) defaultEffort = null;
  return { efforts, defaultEffort };
}

function catalogueEntry(catalogue: unknown, ref: ModelRef): Json | null {
  if (!isRecord(catalogue)) return null;
  const provider = ownRecord(catalogue, ref.provider);
  const models = provider === null ? null : ownRecord(provider, 'models');
  return models === null ? null : ownRecord(models, ref.model);
}

function singleLine(value: unknown): string | null {
  const text = nonEmptyString(value);
  return text === null ? null : text.replace(/\s+/g, ' ').trim();
}

function harnessModel(ref: ModelRef, entry: Json | null): HarnessModel {
  const limit = entry === null ? undefined : entry.limit;
  const { efforts, defaultEffort } = effortsOf(entry);
  const model: HarnessModel = {
    id: ref.id,
    name: entry === null ? null : singleLine(entry.name),
    isDefault: false,
    description: entry === null ? null : singleLine(entry.description),
    contextTokens: isRecord(limit) ? finiteNumber(limit.context) : null,
    efforts,
    defaultEffort,
  };
  const pricing = pricingOf(entry, ref.provider);
  if (pricing !== undefined) model.pricing = pricing;
  return model;
}

function okModels(models: HarnessModel[], observedAt: string): ProviderModels {
  return {
    provider: 'opencode',
    status: 'ok',
    models,
    source: 'live',
    observedAt,
    message: null,
    modelFlag: MODEL_FLAG,
    effortFlag: EFFORT_FLAG,
  };
}

function failedModels(status: 'unavailable' | 'error', observedAt: string, message: string): ProviderModels {
  return {
    provider: 'opencode',
    status,
    models: [],
    source: 'live',
    observedAt,
    message,
    modelFlag: MODEL_FLAG,
    effortFlag: EFFORT_FLAG,
  };
}

/**
 * Pure: joins the `opencode models` stdout with the parsed catalogue
 * (`models.json`, or null/anything malformed for "no details"). Only ids
 * present in the stdout are returned: first every model of `providers`
 * (provider order, then output order), then every 'free' model of any other
 * provider, sorted by id. No duplicates. Error when the stdout has no ids.
 * Never throws.
 */
export function parseOpencodeModels(
  idsStdout: string,
  catalogue: unknown,
  providers: readonly string[],
  observedAt: string,
): ProviderModels {
  const refs = modelRefs(idsStdout);
  if (refs.length === 0) return failedModels('error', observedAt, UNEXPECTED_OUTPUT_MESSAGE);

  const all = refs.map((ref) => harnessModel(ref, catalogueEntry(catalogue, ref)));
  const providerOf = new Map(refs.map((ref) => [ref.id, ref.provider]));
  const selected: HarnessModel[] = [];
  const taken = new Set<string>();
  for (const provider of providers) {
    for (const model of all) {
      if (providerOf.get(model.id) === provider && !taken.has(model.id)) {
        selected.push(model);
        taken.add(model.id);
      }
    }
  }
  const free = all
    .filter((model) => model.pricing === 'free' && !taken.has(model.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return okModels([...selected, ...free], observedAt);
}

function observedNow(options: QuotaFetchOptions): string {
  try {
    return options.now().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/** A regular file that the current user may execute (no spawn). */
async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves the opencode binary: `<homeDir>/.opencode/bin/opencode` when that is
 * an executable regular file, else the first such `opencode` on PATH. An empty
 * homeDir skips the home candidate; relative or empty PATH entries are skipped,
 * so nothing resolves against the working directory. Nothing is spawned.
 * Returns null when neither exists. Never throws.
 */
export async function resolveOpencodeBinary(
  homeDir: string,
  pathValue: string | undefined,
): Promise<string | null> {
  if (homeDir.length > 0) {
    const bundled = join(homeDir, '.opencode', 'bin', BINARY_NAME);
    if (await isExecutableFile(bundled)) return bundled;
  }

  for (const dir of (pathValue ?? '').split(delimiter)) {
    if (dir.length === 0 || !isAbsolute(dir)) continue;
    const candidate = join(dir, BINARY_NAME);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Reads and parses `<homeDir>/.cache/opencode/models.json`. Returns null when
 * homeDir is empty, or the file is missing, not a regular file, larger than the
 * size bound, or not valid JSON. Never throws.
 */
export async function readOpencodeCatalogue(homeDir: string): Promise<unknown> {
  if (homeDir.length === 0) return null;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(join(homeDir, CATALOGUE_RELATIVE_PATH), 'r');
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_CATALOGUE_BYTES) return null;
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < info.size) {
      const { bytesRead } = await handle.read(buffer, offset, info.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return JSON.parse(buffer.subarray(0, offset).toString('utf8')) as unknown;
  } catch {
    return null;
  } finally {
    try {
      await handle?.close();
    } catch {
      // ignore
    }
  }
}

type CallOutcome =
  | { kind: 'ok'; stdout: string }
  | { kind: 'missing' | 'timeout' | 'too_large' | 'failed' };

/** The one `opencode models` call (no arguments). Never rejects. */
function runModelsCall(binary: string, timeoutMs: number): Promise<CallOutcome> {
  return new Promise<CallOutcome>((resolve) => {
    try {
      execFile(
        binary,
        ['models'],
        {
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          encoding: 'utf8',
          maxBuffer: MAX_BUFFER_BYTES,
          windowsHide: true,
        },
        (error, stdout) => {
          try {
            if (!error) {
              resolve({ kind: 'ok', stdout: String(stdout) });
              return;
            }
            const failure = error as { code?: unknown; killed?: unknown };
            if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') resolve({ kind: 'too_large' });
            else if (failure.killed === true) resolve({ kind: 'timeout' });
            else if (failure.code === 'ENOENT') resolve({ kind: 'missing' });
            else resolve({ kind: 'failed' });
          } catch {
            resolve({ kind: 'failed' });
          }
        },
      );
    } catch {
      resolve({ kind: 'failed' });
    }
  });
}

/**
 * Resolves the promise, but falls back after `ms` if still pending. The
 * underlying work is left to finish in the background; only the awaited
 * result is bounded. Never rejects.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (ms <= 0) return Promise.resolve(fallback);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise.catch(() => fallback), timeoutPromise]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

async function readOpencodeModels(options: QuotaFetchOptions): Promise<ProviderModels> {
  const observedAt = observedNow(options);
  const providers = opencodeSubscriptionProviders(process.env);
  const startedAt = Date.now();
  const capped = Number.isFinite(options.timeoutMs);
  const binary = await resolveOpencodeBinary(options.homeDir, process.env.PATH);
  if (binary === null) return failedModels('unavailable', observedAt, NOT_FOUND_MESSAGE);

  const remainingMs = capped ? startedAt + options.timeoutMs - Date.now() : options.timeoutMs;
  if (capped && remainingMs <= 0) {
    return failedModels('error', observedAt, TIMED_OUT_MESSAGE);
  }

  const outcomePromise = runModelsCall(binary, capped ? remainingMs : options.timeoutMs);
  const cataloguePromise = readOpencodeCatalogue(options.homeDir);
  const catalogue = capped
    ? await withDeadline(cataloguePromise, remainingMs, null)
    : await cataloguePromise;
  const outcome = await outcomePromise;
  switch (outcome.kind) {
    case 'ok':
      return parseOpencodeModels(outcome.stdout, catalogue, providers, observedAt);
    case 'missing':
      return failedModels('unavailable', observedAt, NOT_FOUND_MESSAGE);
    case 'timeout':
      return failedModels('error', observedAt, TIMED_OUT_MESSAGE);
    case 'too_large':
      return failedModels('error', observedAt, TOO_LARGE_MESSAGE);
    default:
      return failedModels('error', observedAt, FAILED_MESSAGE);
  }
}

/**
 * Lists the subscription-provider models plus every free model opencode
 * offers. Never throws or rejects.
 */
export const fetchOpencodeModels: ModelsFetcher = async (options) => {
  try {
    return await readOpencodeModels(options);
  } catch {
    return failedModels('error', observedNow(options), FAILED_MESSAGE);
  }
};
