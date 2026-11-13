import { execFile } from 'node:child_process';

import { resolveAgyBinary } from './agy.js';
import type { HarnessModel, ModelsFetcher, ProviderModels, QuotaFetchOptions } from './types.js';

/**
 * Google Antigravity (`agy` CLI) model list.
 *
 * Source: `agy models`, the CLI's own listing command. It makes a network call
 * but never starts a model turn. stdout carries one model per line as
 * `id<TAB>Display name`; the "Fetching available models..." progress line goes
 * to stderr. Reasoning effort is encoded as an id suffix (-low, -medium, -high,
 * -xhigh, -max), and each effort variant is its own selectable id.
 */

const MODEL_FLAG = '--model <id>';
const EFFORT_FLAG = '--effort <level>';
const UNEXPECTED_OUTPUT_MESSAGE = 'unexpected output from `agy models`';
const NOT_FOUND_MESSAGE = 'agy CLI not found';
const TIMED_OUT_MESSAGE = '`agy models` timed out';
const MAX_BUFFER_BYTES = 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EFFORT_SUFFIX_PATTERN = /-(low|medium|high|xhigh|max)$/;
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

function failure(status: 'unavailable' | 'error', observedAt: string, message: string): ProviderModels {
  return {
    provider: 'agy',
    status,
    models: [],
    source: 'live',
    observedAt,
    message,
    modelFlag: MODEL_FLAG,
    effortFlag: EFFORT_FLAG,
  };
}

function effortFromId(id: string): string | null {
  const match = EFFORT_SUFFIX_PATTERN.exec(id);
  return match === null ? null : match[1];
}

function toModel(line: string): HarnessModel | null {
  const tab = line.indexOf('\t');
  if (tab < 0) return null;
  const id = line.slice(0, tab);
  if (!ID_PATTERN.test(id)) return null;
  const name = line.slice(tab + 1).trim();
  const effort = effortFromId(id);
  return {
    id,
    name: name.length > 0 ? name : null,
    isDefault: false,
    description: null,
    contextTokens: null,
    efforts: effort === null ? [] : [effort],
    defaultEffort: effort,
  };
}

/**
 * Pure: maps the stdout of `agy models` onto a ProviderModels. ANSI escape
 * sequences are stripped; a model line is a line with a TAB whose first field
 * matches the id pattern; every other line is ignored. Output order is kept.
 * No model lines yields status `error`. Never throws.
 */
export function parseAgyModels(stdout: string, observedAt: string): ProviderModels {
  const models: HarnessModel[] = [];
  for (const raw of stdout.replace(ANSI_PATTERN, '').split(/\r?\n/)) {
    const model = toModel(raw);
    if (model !== null) models.push(model);
  }

  if (models.length === 0) {
    return failure('error', observedAt, UNEXPECTED_OUTPUT_MESSAGE);
  }

  return {
    provider: 'agy',
    status: 'ok',
    models,
    source: 'live',
    observedAt,
    message: null,
    modelFlag: MODEL_FLAG,
    effortFlag: EFFORT_FLAG,
  };
}

function observedNow(options: QuotaFetchOptions): string {
  try {
    return options.now().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function runAgyModels(binary: string, timeoutMs: number, observedAt: string): Promise<ProviderModels> {
  return new Promise<ProviderModels>((resolve) => {
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
            if (error) {
              const code = (error as { code?: unknown }).code;
              const killed = (error as { killed?: unknown }).killed === true;
              if (code === 'ENOENT') {
                resolve(failure('unavailable', observedAt, NOT_FOUND_MESSAGE));
                return;
              }
              if (killed) {
                resolve(failure('error', observedAt, TIMED_OUT_MESSAGE));
                return;
              }
              const shown = typeof code === 'number' ? String(code) : 'unknown';
              resolve(failure('error', observedAt, `\`agy models\` failed (exit ${shown})`));
              return;
            }
            resolve(parseAgyModels(String(stdout), observedAt));
          } catch {
            resolve(failure('error', observedAt, UNEXPECTED_OUTPUT_MESSAGE));
          }
        },
      );
    } catch {
      resolve(failure('error', observedAt, '`agy models` failed to start'));
    }
  });
}

/** Resolves the agy binary (same rules as fetchAgyQuota) and runs `agy models` with no shell. Never rejects. */
export const fetchAgyModels: ModelsFetcher = async (options) => {
  const observedAt = observedNow(options);
  let binary: string | null = null;
  try {
    binary = await resolveAgyBinary(options.homeDir, process.env.PATH);
  } catch {
    binary = null;
  }
  if (binary === null) return failure('unavailable', observedAt, NOT_FOUND_MESSAGE);
  return runAgyModels(binary, options.timeoutMs, observedAt);
};
