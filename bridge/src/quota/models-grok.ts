import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { HarnessModel, ModelsFetcher, ProviderModels, QuotaFetchOptions } from './types.js';

/**
 * Grok (xAI Grok Build CLI) model list.
 *
 * Sources, both local files the harness maintains:
 * - `<homeDir>/.grok/models_cache.json`: the model catalogue, keyed by model id,
 *   each entry carrying an `info` object.
 * - `<homeDir>/.grok/config.toml`: `[models]` holds the default model and the
 *   default reasoning effort.
 *
 * Never runs grok, never starts a model turn, never touches the network.
 */

const MODEL_FLAG = '-m <id>';
const EFFORT_FLAG = '--reasoning-effort <level>';
const UNRECOGNISED_MESSAGE = 'unrecognised grok model cache format';
const MISSING_CACHE_MESSAGE = 'grok model cache not found (open grok once to create it)';
const MODELS_SECTION = 'models';
/** Epoch values below this are read as seconds (1e11 ms is in 1973). */
const EPOCH_SECONDS_LIMIT = 1e11;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string') return error.code;
  return 'unknown';
}

function emptyResult(
  status: ProviderModels['status'],
  observedAt: string,
  message: string,
): ProviderModels {
  return {
    provider: 'grok',
    status,
    models: [],
    source: 'cached',
    observedAt,
    message,
    modelFlag: MODEL_FLAG,
    effortFlag: EFFORT_FLAG,
  };
}

/** ISO instant from an ISO string or an epoch in seconds or milliseconds, else null. */
function parseObservedAt(fetchedAt: unknown): string | null {
  if (typeof fetchedAt === 'string') {
    const ms = Date.parse(fetchedAt);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  if (typeof fetchedAt === 'number' && Number.isFinite(fetchedAt) && fetchedAt > 0) {
    const ms = fetchedAt < EPOCH_SECONDS_LIMIT ? fetchedAt * 1000 : fetchedAt;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

interface ReadEffort {
  id: string;
  isDefault: boolean;
}

function readReasoningEfforts(info: Json): ReadEffort[] {
  const raw = info.reasoning_efforts;
  if (!Array.isArray(raw)) return [];
  const efforts: ReadEffort[] = [];
  for (const item of raw) {
    if (isRecord(item) && typeof item.id === 'string' && item.id.length > 0) {
      efforts.push({ id: item.id, isDefault: item.default === true });
    }
  }
  return efforts;
}

function readContextTokens(info: Json): number | null {
  const raw = info.context_windows;
  if (!Array.isArray(raw)) return null;
  let largest: number | null = null;
  for (const size of raw) {
    if (typeof size === 'number' && Number.isFinite(size) && (largest === null || size > largest)) {
      largest = size;
    }
  }
  return largest;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Pure: maps the parsed JSON of `models_cache.json` onto a ProviderModels.
 * `configDefaultModel` / `configDefaultEffort` come from parseGrokConfigDefaults.
 * Never throws.
 */
export function parseGrokModelsCache(
  cacheJson: unknown,
  configDefaultModel: string | null,
  configDefaultEffort: string | null,
  fallbackObservedAt: string,
): ProviderModels {
  const root = isRecord(cacheJson) ? cacheJson : null;
  const observedAt = parseObservedAt(root?.fetched_at) ?? fallbackObservedAt;
  const catalogue = root !== null && isRecord(root.models) ? Object.entries(root.models) : [];

  const models: HarnessModel[] = [];
  for (const [key, entry] of catalogue) {
    if (!isRecord(entry) || !isRecord(entry.info)) continue;
    const info = entry.info;
    if (info.hidden === true) continue;

    const id = readOptionalString(info.id) ?? key;
    const efforts = readReasoningEfforts(info);
    const supportedEfforts =
      info.supports_reasoning_effort === false ? [] : efforts.map((effort) => effort.id);
    const flagged = efforts.find((effort) => effort.isDefault)?.id ?? null;
    const infoEffort = readOptionalString(info.reasoning_effort);
    const isDefault = configDefaultModel !== null && id === configDefaultModel;

    let defaultEffort: string | null = null;
    if (flagged !== null && supportedEfforts.includes(flagged)) {
      defaultEffort = flagged;
    } else if (infoEffort !== null && supportedEfforts.includes(infoEffort)) {
      defaultEffort = infoEffort;
    }
    if (
      isDefault &&
      configDefaultEffort !== null &&
      supportedEfforts.includes(configDefaultEffort)
    ) {
      defaultEffort = configDefaultEffort;
    }

    models.push({
      id,
      name: readOptionalString(info.name),
      isDefault,
      description: readOptionalString(info.description),
      contextTokens: readContextTokens(info),
      efforts: supportedEfforts,
      defaultEffort,
    });
  }

  if (models.length === 0) {
    return emptyResult('error', observedAt, UNRECOGNISED_MESSAGE);
  }
  return {
    provider: 'grok',
    status: 'ok',
    models,
    source: 'cached',
    observedAt,
    message: null,
    modelFlag: MODEL_FLAG,
    effortFlag: EFFORT_FLAG,
  };
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line.charAt(i);
    if (quote === '"' && ch === '\\') {
      i += 1;
    } else if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

/** A TOML basic ("...") or literal ('...') string value, else null. */
function parseTomlString(raw: string): string | null {
  const value = raw.trim();
  const basic = /^"((?:[^"\\]|\\.)*)"$/.exec(value);
  if (basic) {
    const inner = (basic[1] ?? '').replace(/\\(["\\])/g, '$1');
    return inner.length > 0 ? inner : null;
  }
  const literal = /^'([^']*)'$/.exec(value);
  if (literal) return readOptionalString(literal[1]);
  return null;
}

/** Strips one pair of matching TOML quotes from a bare key or header name. */
function unquoteTomlKey(raw: string): string {
  const value = raw.trim();
  const basic = /^"((?:[^"\\]|\\.)*)"$/.exec(value);
  if (basic) return (basic[1] ?? '').replace(/\\(["\\])/g, '$1');
  const literal = /^'([^']*)'$/.exec(value);
  if (literal) return literal[1] ?? '';
  return value;
}

/**
 * Pure: reads `default` and `default_reasoning_effort` from the `[models]`
 * section of a grok config.toml. Accepts quoted headers and keys, and the
 * dotted top-level form `models.default = "x"`. Line-based, no TOML
 * dependency; other sections are ignored. Never throws.
 */
export function parseGrokConfigDefaults(tomlText: string): {
  model: string | null;
  effort: string | null;
} {
  let section = '';
  let model: string | null = null;
  let effort: string | null = null;

  for (const rawLine of tomlText.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (line.length === 0) continue;

    if (line.startsWith('[')) {
      if (line.startsWith('[[')) {
        section = '';
      } else {
        const header = /^\[\s*(.+?)\s*\]$/.exec(line)?.[1] ?? '';
        section = unquoteTomlKey(header);
      }
      continue;
    }

    const pair = /^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!pair) continue;
    const segments = (pair[1] ?? '').split('.').map(unquoteTomlKey);
    const value = pair[2] ?? '';

    // Dotted top-level form: `models.default = "x"` is the same as a [models] key.
    let keySection = section;
    if (section === '' && segments.length === 2) {
      keySection = segments[0] ?? '';
    } else if (segments.length !== 1) {
      continue;
    }
    if (keySection !== MODELS_SECTION) continue;

    const key = segments[segments.length - 1] ?? '';
    if (key === 'default' && model === null) {
      model = parseTomlString(value);
    } else if (key === 'default_reasoning_effort' && effort === null) {
      effort = parseTomlString(value);
    }
  }

  return { model, effort };
}

async function readConfigDefaults(path: string): Promise<{ model: string | null; effort: string | null }> {
  try {
    return parseGrokConfigDefaults(await readFile(path, 'utf8'));
  } catch {
    return { model: null, effort: null };
  }
}

/** Reads the grok model list from the local cache. Never throws or rejects. */
export const fetchGrokModels: ModelsFetcher = async (options: QuotaFetchOptions) => {
  let nowIso = new Date(0).toISOString();
  try {
    nowIso = options.now().toISOString();
    const cachePath = join(options.homeDir, '.grok', 'models_cache.json');

    let cacheText: string;
    let mtimeIso: string;
    try {
      mtimeIso = (await stat(cachePath)).mtime.toISOString();
      cacheText = await readFile(cachePath, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return emptyResult('unavailable', nowIso, MISSING_CACHE_MESSAGE);
      }
      return emptyResult('error', nowIso, `grok model cache could not be read (${errorCode(error)})`);
    }

    const defaults = await readConfigDefaults(join(options.homeDir, '.grok', 'config.toml'));

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(cacheText);
    } catch {
      parsed = null;
    }
    return parseGrokModelsCache(parsed, defaults.model, defaults.effort, mtimeIso);
  } catch (error) {
    return emptyResult('error', nowIso, `grok model list failed (${errorCode(error)})`);
  }
};
