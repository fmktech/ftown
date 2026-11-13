import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { HarnessModel, ModelsFetcher, ProviderModels } from './types.js';

/**
 * Codex (OpenAI Codex CLI) model list provider.
 *
 * Source: `codex debug models`, which prints the model catalogue as one JSON
 * line and needs no network or model turn. Observed shape (codex-cli 0.167.2):
 *   { "models": [ { "slug", "display_name", "description",
 *       "default_reasoning_level", "supported_reasoning_levels": [{ "effort", "description" }],
 *       "visibility": "list" | "hide", "context_window", "max_context_window", ... } ] }
 *
 * The user's default model and reasoning effort come from the top-level
 * `model` and `model_reasoning_effort` keys of `<homeDir>/.codex/config.toml`.
 */

const PROVIDER = 'codex' as const;
const MODEL_FLAG = '-m <id>';
const EFFORT_FLAG = '-c model_reasoning_effort=<level>';
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

const NO_MODELS_MESSAGE = 'Codex returned no models';
const UNEXPECTED_DATA_MESSAGE = 'unexpected model data from Codex';
const NOT_FOUND_MESSAGE = 'codex CLI not found';
const TIMEOUT_MESSAGE = 'codex model listing timed out';
const OUTPUT_TOO_LARGE_MESSAGE = 'codex model listing output was too large';
const UNEXPECTED_OUTPUT_MESSAGE = 'unexpected output from `codex debug models`';
const START_FAILED_MESSAGE = 'codex model listing failed to start';

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function positiveFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function listOf(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (!isRecord(data)) return null;
  for (const key of ['models', 'data']) {
    const list = data[key];
    if (Array.isArray(list)) return list;
  }
  return null;
}

function isHidden(entry: Json): boolean {
  if (entry.hidden === true) return true;
  return entry.visibility === 'hide' || entry.visibility === 'hidden';
}

function readEfforts(entry: Json): string[] {
  const raw = entry.supportedReasoningEfforts ?? entry.supported_reasoning_levels;
  if (!Array.isArray(raw)) return [];
  const efforts: string[] = [];
  for (const item of raw) {
    const level = isRecord(item)
      ? nonEmptyString(item.reasoningEffort ?? item.reasoning_effort ?? item.effort)
      : nonEmptyString(item);
    if (level !== null && !efforts.includes(level)) efforts.push(level);
  }
  return efforts;
}

/**
 * The model's usable context window: context_window, falling back to
 * max_context_window only when context_window is missing or not a finite
 * positive number. Null when neither is present.
 */
function readContextTokens(entry: Json): number | null {
  return (
    positiveFinite(entry.contextWindow ?? entry.context_window) ??
    positiveFinite(entry.maxContextWindow ?? entry.max_context_window)
  );
}

function failure(
  status: 'unavailable' | 'error',
  message: string,
  observedAt: string,
): ProviderModels {
  return {
    provider: PROVIDER,
    status,
    models: [],
    source: 'live',
    observedAt,
    message,
    modelFlag: MODEL_FLAG,
    effortFlag: EFFORT_FLAG,
  };
}

interface VisibleEntry {
  id: string;
  entry: Json;
  flaggedDefault: boolean;
}

/**
 * Pure: maps the parsed model catalogue onto a ProviderModels. Accepts an
 * array, or an object holding the array under `models` or `data`. Hidden
 * entries are excluded. Never throws.
 */
export function parseCodexModels(
  data: unknown,
  configModel: string | null,
  configEffort: string | null,
  source: 'live' | 'cached',
  observedAt: string,
): ProviderModels {
  const base = {
    provider: PROVIDER,
    source,
    observedAt,
    modelFlag: MODEL_FLAG,
    effortFlag: EFFORT_FLAG,
  };

  const list = listOf(data);
  if (list === null) {
    return { ...base, status: 'error', models: [], message: UNEXPECTED_DATA_MESSAGE };
  }

  const visible: VisibleEntry[] = [];
  for (const item of list) {
    if (!isRecord(item) || isHidden(item)) continue;
    const id = nonEmptyString(item.model) ?? nonEmptyString(item.id) ?? nonEmptyString(item.slug);
    if (id === null) continue;
    visible.push({
      id,
      entry: item,
      flaggedDefault: item.isDefault === true || item.is_default === true,
    });
  }

  if (visible.length === 0) {
    return { ...base, status: 'error', models: [], message: NO_MODELS_MESSAGE };
  }

  let defaultIndex = visible.findIndex((v) => configModel !== null && v.id === configModel);
  if (defaultIndex < 0) defaultIndex = visible.findIndex((v) => v.flaggedDefault);

  const models: HarnessModel[] = visible.map((v, index) => {
    const isDefault = index === defaultIndex;
    const efforts = readEfforts(v.entry);
    const ownDefault = nonEmptyString(
      v.entry.defaultReasoningEffort ?? v.entry.default_reasoning_level,
    );
    let defaultEffort: string | null = null;
    if (isDefault && configEffort !== null && efforts.includes(configEffort)) {
      defaultEffort = configEffort;
    } else if (ownDefault !== null && efforts.includes(ownDefault)) {
      defaultEffort = ownDefault;
    }
    return {
      id: v.id,
      name: nonEmptyString(v.entry.displayName ?? v.entry.display_name),
      isDefault,
      description: nonEmptyString(v.entry.description),
      contextTokens: readContextTokens(v.entry),
      efforts,
      defaultEffort,
    };
  });

  return { ...base, status: 'ok', models, message: null };
}

function nonEmptyTrimmed(text: string): string | null {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Reads one TOML string value (the text after `key =`). Basic `"` strings
 * honour \" and \\ escapes; literal `'` strings are taken as-is. Triple-quoted
 * values are read only when they close on the same line. Returns null for
 * anything else (unquoted, unterminated, empty).
 */
function readValue(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
    const delimiter = trimmed.slice(0, 3);
    const end = trimmed.indexOf(delimiter, 3);
    return end < 0 ? null : nonEmptyTrimmed(trimmed.slice(3, end));
  }
  const quote = trimmed.charAt(0);
  if (quote === "'") {
    const end = trimmed.indexOf("'", 1);
    return end < 0 ? null : nonEmptyTrimmed(trimmed.slice(1, end));
  }
  if (quote !== '"') return null;
  let out = '';
  for (let i = 1; i < trimmed.length; i += 1) {
    const ch = trimmed.charAt(i);
    if (ch === '"') return nonEmptyTrimmed(out);
    if (ch === '\\') {
      const next = trimmed.charAt(i + 1);
      if (next === '"' || next === '\\') {
        out += next;
        i += 1;
        continue;
      }
    }
    out += ch;
  }
  return null;
}

/**
 * Returns the triple-quote delimiter that opens a multi-line string on this
 * value, or null when the value does not open one (none, or it closes on the
 * same line).
 */
function openingMultilineDelimiter(valueText: string): string | null {
  for (const delimiter of ['"""', "'''"]) {
    if (valueText.startsWith(delimiter) && valueText.indexOf(delimiter, 3) < 0) {
      return delimiter;
    }
  }
  return null;
}

/**
 * Pure: reads the top-level `model` and `model_reasoning_effort` string values
 * from a Codex config.toml. Stops at the first `[section]` header, so keys
 * inside tables are ignored. Lines inside multi-line strings are skipped, so
 * keys written there are not read. Missing or unquoted values yield null.
 */
export function parseCodexConfigDefaults(tomlText: string): {
  model: string | null;
  effort: string | null;
} {
  let model: string | null = null;
  let effort: string | null = null;
  let openDelimiter: string | null = null;
  for (const rawLine of tomlText.split(/\r?\n/)) {
    if (openDelimiter !== null) {
      if (rawLine.includes(openDelimiter)) openDelimiter = null;
      continue;
    }
    const line = rawLine.trim();
    if (line.startsWith('[')) break;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    const key = match[1] ?? '';
    const rest = (match[2] ?? '').trim();
    const delimiter = openingMultilineDelimiter(rest);
    if (delimiter !== null) {
      openDelimiter = delimiter;
      continue;
    }
    if (key === 'model') {
      if (model === null) model = readValue(rest);
    } else if (key === 'model_reasoning_effort' && effort === null) {
      effort = readValue(rest);
    }
  }
  return { model, effort };
}

async function readConfigText(homeDir: string): Promise<string> {
  try {
    return await readFile(join(homeDir, '.codex', 'config.toml'), 'utf8');
  } catch {
    return '';
  }
}

type ListingResult =
  | { ok: true; stdout: string }
  | { ok: false; status: 'unavailable' | 'error'; message: string };

/** One execution of `codex debug models`. Never rejects; execFile reaps the child on every path. */
function runCodexDebugModels(timeoutMs: number): Promise<ListingResult> {
  return new Promise<ListingResult>((resolve) => {
    try {
      execFile(
        'codex',
        ['debug', 'models'],
        { timeout: timeoutMs, encoding: 'utf8', maxBuffer: MAX_BUFFER_BYTES, windowsHide: true },
        (error, stdout) => {
          if (!error) {
            resolve({ ok: true, stdout: String(stdout) });
            return;
          }
          const code = (error as { code?: unknown }).code;
          const killed = (error as { killed?: unknown }).killed === true;
          if (code === 'ENOENT') {
            resolve({ ok: false, status: 'unavailable', message: NOT_FOUND_MESSAGE });
          } else if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            resolve({ ok: false, status: 'error', message: OUTPUT_TOO_LARGE_MESSAGE });
          } else if (killed) {
            resolve({ ok: false, status: 'error', message: TIMEOUT_MESSAGE });
          } else if (typeof code === 'number') {
            resolve({
              ok: false,
              status: 'error',
              message: `\`codex debug models\` failed (exit ${code})`,
            });
          } else {
            resolve({ ok: false, status: 'error', message: '`codex debug models` failed' });
          }
        },
      );
    } catch {
      resolve({ ok: false, status: 'error', message: START_FAILED_MESSAGE });
    }
  });
}

export const fetchCodexModels: ModelsFetcher = async (options) => {
  const observedAt = options.now().toISOString();
  try {
    const defaults = parseCodexConfigDefaults(await readConfigText(options.homeDir));
    const listing = await runCodexDebugModels(options.timeoutMs);
    if (!listing.ok) return failure(listing.status, listing.message, observedAt);

    let parsed: unknown;
    try {
      parsed = JSON.parse(listing.stdout.trim());
    } catch {
      return failure('error', UNEXPECTED_OUTPUT_MESSAGE, observedAt);
    }
    return parseCodexModels(parsed, defaults.model, defaults.effort, 'live', observedAt);
  } catch {
    return failure('error', UNEXPECTED_OUTPUT_MESSAGE, observedAt);
  }
};
