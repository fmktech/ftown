import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { HarnessModel, ModelsFetcher, ProviderModels, QuotaFetchOptions } from './types.js';

/**
 * Muse (Meta "Muse Code" CLI) model list.
 *
 * Muse has no `models` subcommand. It keeps a catalogue cache under
 * `<home>/.local/share/muse/model-catalog/` (one `*.json` file per profile) and
 * the user's selection in `<home>/.config/muse/settings.json`. Both are read
 * locally: nothing is executed and no network is used.
 */

const CATALOG_SEGMENTS = ['.local', 'share', 'muse', 'model-catalog'] as const;
const SETTINGS_SEGMENTS = ['.config', 'muse', 'settings.json'] as const;
const MODEL_FLAG = '--model <id>';
const EFFORT_FLAG = '--reasoning-effort <level>';
const FORMAT_MESSAGE = 'unrecognised muse model catalogue format';
const MISSING_MESSAGE = 'muse model catalogue not found (open muse once to create it)';

type Json = Record<string, unknown>;

interface VisibleRow {
  id: string;
  row: Json;
}

interface SettingsSelection {
  model: string | null;
  effort: string | null;
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readEfforts(row: Json): string[] {
  const variants = row.reasoning_effort_variants;
  if (!Array.isArray(variants)) return [];
  const tiers: string[] = [];
  for (const variant of variants) {
    if (!isRecord(variant)) continue;
    const tier = nonEmptyString(variant.tier);
    if (tier !== null && !tiers.includes(tier)) tiers.push(tier);
  }
  return tiers;
}

function readContextTokens(row: Json): number | null {
  const limit = row.context_limit;
  return typeof limit === 'number' && Number.isFinite(limit) ? limit : null;
}

function failureModels(status: 'error', observedAt: string, message: string): ProviderModels {
  return {
    provider: 'muse',
    status,
    models: [],
    source: 'cached',
    observedAt,
    message,
    modelFlag: MODEL_FLAG,
    effortFlag: EFFORT_FLAG,
  };
}

/**
 * Pure: maps the parsed JSON of a muse model catalogue file onto a ProviderModels.
 * Only visible rows are listed (a missing `visibility` counts as visible), in
 * the catalogue's order. The default is the row named by `settingsModel`, or the
 * row flagged `is_default` when that id is null or not a visible row. Never throws.
 */
export function parseMuseModelCatalog(
  catalogJson: unknown,
  settingsModel: string | null,
  settingsEffort: string | null,
  observedAt: string,
): ProviderModels {
  if (!isRecord(catalogJson) || !Array.isArray(catalogJson.rows)) {
    return failureModels('error', observedAt, FORMAT_MESSAGE);
  }

  const visible: VisibleRow[] = [];
  for (const row of catalogJson.rows) {
    if (!isRecord(row)) continue;
    const id = nonEmptyString(row.model_id);
    if (id === null) continue;
    if (row.visibility !== undefined && row.visibility !== null && row.visibility !== 'visible') {
      continue;
    }
    visible.push({ id, row });
  }

  if (visible.length === 0) {
    return failureModels('error', observedAt, FORMAT_MESSAGE);
  }

  const settingsIndex =
    settingsModel === null ? -1 : visible.findIndex((entry) => entry.id === settingsModel);
  const defaultIndex =
    settingsIndex >= 0 ? settingsIndex : visible.findIndex((entry) => entry.row.is_default === true);

  const models: HarnessModel[] = visible.map((entry, index) => {
    const efforts = readEfforts(entry.row);
    const isDefault = index === defaultIndex;
    return {
      id: entry.id,
      name: nonEmptyString(entry.row.display_label),
      isDefault,
      description: nonEmptyString(entry.row.description),
      contextTokens: readContextTokens(entry.row),
      efforts,
      defaultEffort:
        isDefault && settingsEffort !== null && efforts.includes(settingsEffort) ? settingsEffort : null,
    };
  });

  return {
    provider: 'muse',
    status: 'ok',
    models,
    source: 'cached',
    observedAt,
    message: null,
    modelFlag: MODEL_FLAG,
    effortFlag: EFFORT_FLAG,
  };
}

function errnoCode(error: unknown): string {
  const code = isRecord(error) ? error.code : undefined;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : 'UNKNOWN';
}

function observedNow(options: QuotaFetchOptions): string {
  try {
    return options.now().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function unavailableModels(observedAt: string): ProviderModels {
  return {
    provider: 'muse',
    status: 'unavailable',
    models: [],
    source: 'cached',
    observedAt,
    message: MISSING_MESSAGE,
    modelFlag: MODEL_FLAG,
    effortFlag: EFFORT_FLAG,
  };
}

async function newestCatalogFile(
  dir: string,
  names: readonly string[],
): Promise<{ path: string; mtimeMs: number } | null> {
  // Newest mtime wins; on equal mtimes the file name sorted later wins (descending).
  let newest: { path: string; name: string; mtimeMs: number } | null = null;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    const info = await stat(path);
    if (!info.isFile()) continue;
    const beats =
      newest === null ||
      info.mtimeMs > newest.mtimeMs ||
      (info.mtimeMs === newest.mtimeMs && name > newest.name);
    if (beats) {
      newest = { path, name, mtimeMs: info.mtimeMs };
    }
  }
  return newest === null ? null : { path: newest.path, mtimeMs: newest.mtimeMs };
}

async function readSettings(homeDir: string): Promise<SettingsSelection> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(homeDir, ...SETTINGS_SEGMENTS), 'utf8'));
    if (!isRecord(parsed)) return { model: null, effort: null };
    return {
      model: nonEmptyString(parsed.model),
      effort: nonEmptyString(parsed.reasoning_effort),
    };
  } catch {
    return { model: null, effort: null };
  }
}

async function readMuseModels(options: QuotaFetchOptions): Promise<ProviderModels> {
  const catalogDir = join(options.homeDir, ...CATALOG_SEGMENTS);
  const now = observedNow(options);

  let names: string[];
  try {
    names = await readdir(catalogDir);
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return unavailableModels(now);
    return failureModels('error', now, `muse model catalogue read failed (${code})`);
  }

  const newest = await newestCatalogFile(catalogDir, names);
  if (newest === null) return unavailableModels(now);

  const raw = await readFile(newest.path, 'utf8');
  let catalogJson: unknown;
  try {
    catalogJson = JSON.parse(raw);
  } catch {
    catalogJson = undefined;
  }

  const settings = await readSettings(options.homeDir);
  return parseMuseModelCatalog(
    catalogJson,
    settings.model,
    settings.effort,
    new Date(newest.mtimeMs).toISOString(),
  );
}

/**
 * Reads the newest muse catalogue file under `homeDir` and the user's selection
 * from settings.json. Never throws or rejects.
 */
export const fetchMuseModels: ModelsFetcher = async (options) => {
  try {
    return await readMuseModels(options);
  } catch (error) {
    return failureModels('error', observedNow(options), `muse model catalogue read failed (${errnoCode(error)})`);
  }
};
