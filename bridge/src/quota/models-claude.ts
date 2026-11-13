import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { HarnessModel, ModelsFetcher, ProviderModels, QuotaFetchOptions } from './types.js';

/**
 * Claude Code model list. There is no CLI command that lists models, so this
 * reads the signed catalogue cache that Claude Code keeps under
 * `<homeDir>/.claude/cache/model-catalog/published-*.json`. Each file carries
 * the catalogue document base64-encoded in `documentBytes`. The user's default
 * model comes from the `model` key of `<homeDir>/.claude/settings.json` when
 * present, otherwise from the catalogue's own default for the `cc` surface.
 */

const CATALOGUE_DIR = ['.claude', 'cache', 'model-catalog'];
const SETTINGS_PATH = ['.claude', 'settings.json'];
const CATALOGUE_FILE_PATTERN = /^published-.*\.json$/;
const SURFACE = 'cc';
const MODEL_FLAG = '--model <id>';
const EFFORT_FLAG = '--effort <level>';
const UNAVAILABLE_MESSAGE = 'Claude model catalogue not found (open claude once to create it)';
const UNRECOGNISED_MESSAGE = 'unrecognised Claude model catalogue format';
const MODEL_SUFFIX_PATTERN = /\[[^\][]*\]$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR']);

type Json = Record<string, unknown>;

interface CatalogueCandidate {
  path: string;
  mtime: Date;
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errnoCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === 'string' && /^E[A-Z0-9]+$/.test(error.code)) {
    return error.code;
  }
  return 'UNKNOWN';
}

function decodeDocument(documentBytes: unknown): unknown {
  if (typeof documentBytes !== 'string') return undefined;
  const compact = documentBytes.replace(/\s/g, '');
  if (compact.length === 0 || compact.length % 4 !== 0 || !BASE64_PATTERN.test(compact)) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(compact, 'base64').toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function errorModels(observedAt: string, message: string): ProviderModels {
  return {
    provider: 'claude',
    status: 'error',
    models: [],
    source: 'cached',
    observedAt,
    message,
    modelFlag: MODEL_FLAG,
    effortFlag: EFFORT_FLAG,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Resolves the settings model (alias, full id, or either with a "[1m]"-style
 * suffix) to a catalogue id. Returns null when nothing matches.
 */
function resolveSettingsModel(
  settingsModel: string | null,
  aliasTargets: Json,
  ids: readonly string[],
): string | null {
  if (settingsModel === null) return null;
  const bare = settingsModel.trim().replace(MODEL_SUFFIX_PATTERN, '').trim();
  if (ids.includes(bare)) return bare;
  const target = aliasTargets[bare];
  if (isRecord(target) && typeof target.default === 'string' && ids.includes(target.default)) {
    return target.default;
  }
  return null;
}

function buildModel(entry: Json): HarnessModel {
  const runtime = isRecord(entry.runtime) ? entry.runtime : {};
  const maxInput = runtime.max_input_tokens;
  const efforts = Array.isArray(runtime.effort_levels)
    ? runtime.effort_levels.filter((level): level is string => typeof level === 'string')
    : [];
  const declaredDefault = stringOrNull(runtime.default_effort);
  return {
    id: entry.id as string,
    name: stringOrNull(entry.name),
    isDefault: false,
    description: stringOrNull(entry.description),
    contextTokens: typeof maxInput === 'number' && Number.isFinite(maxInput) ? maxInput : null,
    efforts,
    defaultEffort: declaredDefault !== null && efforts.includes(declaredDefault) ? declaredDefault : null,
  };
}

/**
 * Pure: maps a parsed published-*.json catalogue file to a ProviderModels.
 * `fileJson` is the file content as parsed by JSON.parse (not yet base64-decoded).
 */
export function parseClaudeModelCatalog(
  fileJson: unknown,
  settingsModel: string | null,
  observedAt: string,
): ProviderModels {
  if (!isRecord(fileJson)) return errorModels(observedAt, UNRECOGNISED_MESSAGE);
  const doc = decodeDocument(fileJson.documentBytes);
  if (!isRecord(doc) || !isRecord(doc.surfaces)) return errorModels(observedAt, UNRECOGNISED_MESSAGE);
  const surface = doc.surfaces[SURFACE];
  if (!isRecord(surface)) return errorModels(observedAt, UNRECOGNISED_MESSAGE);

  const configs = surface.model_selector_config;
  const config = Array.isArray(configs) && isRecord(configs[0]) ? configs[0] : null;
  const entries = config && Array.isArray(config.models) ? config.models : null;
  if (!config || !entries || entries.length === 0) return errorModels(observedAt, UNRECOGNISED_MESSAGE);
  if (!entries.every((entry): entry is Json => isRecord(entry) && typeof entry.id === 'string')) {
    return errorModels(observedAt, UNRECOGNISED_MESSAGE);
  }

  const models = entries.map(buildModel);
  const ids = models.map((model) => model.id);
  const states = surface.model_selector_state;
  const state = Array.isArray(states) && isRecord(states[0]) ? states[0] : null;
  const catalogueDefault = state ? stringOrNull(state.model) : null;
  const aliasTargets = isRecord(config.provider_alias_targets) ? config.provider_alias_targets : {};

  const defaultId =
    resolveSettingsModel(settingsModel, aliasTargets, ids) ??
    (catalogueDefault !== null && ids.includes(catalogueDefault) ? catalogueDefault : null);
  if (defaultId !== null) {
    const index = ids.indexOf(defaultId);
    models[index] = { ...models[index], isDefault: true };
  }

  return {
    provider: 'claude',
    status: 'ok',
    models,
    source: 'cached',
    observedAt,
    message: null,
    modelFlag: MODEL_FLAG,
    effortFlag: EFFORT_FLAG,
  };
}

async function listCatalogueCandidates(dir: string): Promise<CatalogueCandidate[]> {
  const names = (await readdir(dir)).filter((name) => CATALOGUE_FILE_PATTERN.test(name));
  const candidates: CatalogueCandidate[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      candidates.push({ path, mtime: (await stat(path)).mtime });
    } catch {
      continue;
    }
  }
  return candidates.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

/** Pure: the catalogue's expires_at as an ISO instant, or null when absent or unparseable. */
export function claudeCatalogExpiry(fileJson: unknown): string | null {
  if (!isRecord(fileJson)) return null;
  const doc = decodeDocument(fileJson.documentBytes);
  if (!isRecord(doc) || typeof doc.expires_at !== 'string') return null;
  const ms = Date.parse(doc.expires_at);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

async function readSettingsModel(homeDir: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(homeDir, ...SETTINGS_PATH), 'utf8'));
    if (!isRecord(parsed)) return null;
    return typeof parsed.model === 'string' && parsed.model.trim() !== '' ? parsed.model : null;
  } catch {
    return null;
  }
}

async function readCatalogueJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function unavailable(observedAt: string): ProviderModels {
  return {
    provider: 'claude',
    status: 'unavailable',
    models: [],
    source: 'cached',
    observedAt,
    message: UNAVAILABLE_MESSAGE,
    modelFlag: MODEL_FLAG,
    effortFlag: EFFORT_FLAG,
  };
}

/** Reads the newest Claude model catalogue under options.homeDir. Never throws. */
export const fetchClaudeModels: ModelsFetcher = async (options: QuotaFetchOptions) => {
  const nowIso = new Date(options.now().getTime()).toISOString();
  try {
    const dir = join(options.homeDir, ...CATALOGUE_DIR);
    let candidates: CatalogueCandidate[];
    try {
      candidates = await listCatalogueCandidates(dir);
    } catch (error) {
      if (MISSING_CODES.has(errnoCode(error))) return unavailable(nowIso);
      return errorModels(nowIso, `could not read Claude model catalogue (${errnoCode(error)})`);
    }
    if (candidates.length === 0) return unavailable(nowIso);

    const settingsModel = await readSettingsModel(options.homeDir);
    for (const candidate of candidates) {
      const fileJson = await readCatalogueJson(candidate.path);
      const parsed = parseClaudeModelCatalog(fileJson, settingsModel, candidate.mtime.toISOString());
      if (parsed.status !== 'ok') continue;
      const expiresAt = claudeCatalogExpiry(fileJson);
      if (expiresAt !== null && Date.parse(expiresAt) < options.now().getTime()) {
        const day = expiresAt.slice(0, 10);
        return { ...parsed, message: `Claude model catalogue expired on ${day}; open claude to refresh it` };
      }
      return parsed;
    }
    return errorModels(nowIso, UNRECOGNISED_MESSAGE);
  } catch (error) {
    return errorModels(nowIso, `could not read Claude model catalogue (${errnoCode(error)})`);
  }
};
