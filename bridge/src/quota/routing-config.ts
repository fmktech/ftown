import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import {
  DEFAULT_ROUTING_TIERS,
  MODEL_ROUTING_LIMITS,
  MODEL_ROUTING_RELATIVE_PATH,
  QUOTA_PROVIDER_IDS,
  ROUTING_TIER_NAME_PATTERN,
} from './types.js';
import type {
  ModelRoutingConfig,
  ProviderModels,
  QuotaProviderId,
  RoutingConfigParseResult,
  RoutingConfigState,
  RoutingPick,
  RoutingTier,
} from './types.js';

const MAX_FILE_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_MODEL_LENGTH = 200;
const MAX_ERRORS = 50;
const EFFORT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,30}$/;
const TEMP_PREFIX = '.model-routing.';
const CONFIG_UNREADABLE = 'could not read the config';
const HOME_NOT_SET = 'home directory is not set';

/**
 * Control and invisible characters, as code point ranges: C0 and DEL, C1, bidi controls
 * (LRM, RLM, LRE..RLO, LRI..PDI), zero-width characters, word joiner, BOM, and the line
 * and paragraph separators.
 */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2028, 0x2029],
  [0x2060, 0x2060],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];
/** Same set, but tab and newline are kept (used for steering). */
const STEERING_INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x0008],
  [0x000b, 0x001f],
  ...INVISIBLE_RANGES.slice(1),
];
function characterClass(ranges: readonly (readonly [number, number])[]): string {
  const hex = (code: number): string => `\\u${code.toString(16).padStart(4, "0")}`;
  return `[${ranges.map(([from, to]) => `${hex(from)}-${hex(to)}`).join("")}]`;
}
const CONTROL_OR_INVISIBLE = new RegExp(characterClass(INVISIBLE_RANGES));
const CONTROL_OR_INVISIBLE_GLOBAL = new RegExp(characterClass(INVISIBLE_RANGES), "g");
const STEERING_INVISIBLE_GLOBAL = new RegExp(characterClass(STEERING_INVISIBLE_RANGES), "g");

type LoadResult = { state: RoutingConfigState; config: ModelRoutingConfig | null };
type ReadOutcome =
  | { kind: 'text'; text: string }
  | { kind: 'missing' }
  | { kind: 'error'; errors: string[] };

/** Collects validation errors, keeping at most MAX_ERRORS of them. */
class ErrorCollector {
  private readonly messages: string[] = [];
  private total = 0;

  add(message: string): void {
    this.total += 1;
    if (this.messages.length < MAX_ERRORS) this.messages.push(message);
  }

  get count(): number {
    return this.total;
  }

  list(): string[] {
    const messages = this.messages.slice();
    if (this.total > MAX_ERRORS) messages[MAX_ERRORS - 1] = '... and more';
    return messages;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isProviderId(value: unknown): value is QuotaProviderId {
  return (QUOTA_PROVIDER_IDS as readonly unknown[]).includes(value);
}

function homeIsSet(homeDir: unknown): homeDir is string {
  return typeof homeDir === 'string' && homeDir !== '' && isAbsolute(homeDir);
}

/** Short rendering of an arbitrary input value for an error message. */
function show(value: unknown): string {
  let text: string;
  if (typeof value === 'string') text = JSON.stringify(value);
  else if (typeof value === 'object' && value !== null) text = Array.isArray(value) ? 'array' : 'object';
  else text = String(value);
  return text.length > 60 ? `${text.slice(0, 60)}...` : text;
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code: unknown = error.code;
    if (typeof code === 'string' && code !== '') return code;
  }
  return 'UNKNOWN';
}

export function parseModelRoutingConfig(json: unknown): RoutingConfigParseResult {
  try {
    if (!isPlainObject(json)) {
      return { ok: false, errors: ['the routing file must contain a JSON object'] };
    }
    const errors = new ErrorCollector();
    if (json.version !== 1) errors.add('version must be 1');
    const tiers = parseTiers(json.tiers, errors);
    const steering = parseSteering(json.steering, errors);
    if (errors.count > 0) return { ok: false, errors: errors.list() };
    return { ok: true, config: { version: 1, tiers, steering } };
  } catch {
    return { ok: false, errors: [CONFIG_UNREADABLE] };
  }
}

function parseTiers(value: unknown, errors: ErrorCollector): RoutingTier[] {
  if (!Array.isArray(value)) {
    errors.add('tiers must be an array');
    return [];
  }
  const { maxTiers } = MODEL_ROUTING_LIMITS;
  if (value.length > maxTiers) {
    errors.add(`tiers has ${value.length} entries; the limit is ${maxTiers}`);
    return [];
  }
  const namesToIndex = new Map<string, number>();
  const tiers: RoutingTier[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const tier = parseTier(value[index], index, namesToIndex, errors);
    if (tier) tiers.push(tier);
  }
  return tiers;
}

function parseTier(
  entry: unknown,
  index: number,
  namesToIndex: Map<string, number>,
  errors: ErrorCollector,
): RoutingTier | null {
  const at = `tiers[${index}]`;
  if (!isPlainObject(entry)) {
    errors.add(`${at} must be an object`);
    return null;
  }
  const name = parseTierName(entry.name, at, index, namesToIndex, errors);
  const description = parseDescription(entry.description, at, errors);
  const picks = parsePicks(entry.picks, at, errors);
  const guidance = parseGuidance(entry.guidance, at, errors);
  if (name === null) return null;
  return { name, description, picks, guidance };
}

function parseTierName(
  value: unknown,
  at: string,
  index: number,
  namesToIndex: Map<string, number>,
  errors: ErrorCollector,
): string | null {
  if (typeof value !== 'string') {
    errors.add(`${at}.name must be a string`);
    return null;
  }
  const name = value.trim();
  const { maxTierNameLength } = MODEL_ROUTING_LIMITS;
  if (name === '') {
    errors.add(`${at}.name must not be empty`);
    return null;
  }
  if (name.length > maxTierNameLength) {
    errors.add(`${at}.name is longer than ${maxTierNameLength} characters`);
    return null;
  }
  if (!ROUTING_TIER_NAME_PATTERN.test(name)) {
    errors.add(
      `${at}.name ${show(name)} must use only lowercase letters, digits, "-" and "_", and start with a letter or digit`,
    );
    return null;
  }
  const firstIndex = namesToIndex.get(name);
  if (firstIndex !== undefined) {
    errors.add(`${at}.name ${show(name)} is already used by tiers[${firstIndex}]`);
    return null;
  }
  namesToIndex.set(name, index);
  return name;
}

function parseDescription(value: unknown, at: string, errors: ErrorCollector): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') {
    errors.add(`${at}.description must be a string`);
    return '';
  }
  const description = value
    .replace(/\s+/g, ' ')
    .replace(CONTROL_OR_INVISIBLE_GLOBAL, '')
    .replace(/\s+/g, ' ')
    .trim();
  const { maxTierDescriptionLength } = MODEL_ROUTING_LIMITS;
  if (description.length > maxTierDescriptionLength) {
    errors.add(`${at}.description is longer than ${maxTierDescriptionLength} characters`);
  }
  return description;
}

/** Same cleaning as steering: invisible characters stripped (newlines and tabs kept), then trimmed. */
function parseGuidance(value: unknown, at: string, errors: ErrorCollector): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    errors.add(`${at}.guidance must be a string`);
    return '';
  }
  const guidance = value.replace(STEERING_INVISIBLE_GLOBAL, '').trim();
  const { maxTierGuidanceLength } = MODEL_ROUTING_LIMITS;
  if (guidance.length > maxTierGuidanceLength) {
    errors.add(`${at}.guidance is longer than ${maxTierGuidanceLength} characters`);
  }
  return guidance;
}

function parsePicks(value: unknown, at: string, errors: ErrorCollector): RoutingPick[] {
  if (!Array.isArray(value)) {
    errors.add(`${at}.picks must be an array`);
    return [];
  }
  const { maxPicksPerTier } = MODEL_ROUTING_LIMITS;
  if (value.length > maxPicksPerTier) {
    errors.add(`${at}.picks has ${value.length} entries; the limit is ${maxPicksPerTier}`);
    return [];
  }
  const seen = new Set<string>();
  const picks: RoutingPick[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const pickAt = `${at}.picks[${index}]`;
    const entry = value[index];
    if (!isPlainObject(entry)) {
      errors.add(`${pickAt} must be an object`);
      continue;
    }
    const pick = parsePick(entry, pickAt, errors);
    if (!pick) continue;
    const key = JSON.stringify([pick.provider, pick.model, pick.effort]);
    if (seen.has(key)) {
      errors.add(`${pickAt} repeats an earlier pick for the same provider, model and effort`);
      continue;
    }
    seen.add(key);
    picks.push(pick);
  }
  return picks;
}

function parsePick(entry: Record<string, unknown>, at: string, errors: ErrorCollector): RoutingPick | null {
  const before = errors.count;
  const provider = parseProvider(entry.provider, at, errors);
  const model = parseModel(entry.model, at, errors);
  const effort = parseEffort(entry.effort, at, errors);
  if (errors.count > before || provider === null || model === null) return null;
  return { provider, model, effort };
}

function parseProvider(value: unknown, at: string, errors: ErrorCollector): QuotaProviderId | null {
  if (isProviderId(value)) return value;
  errors.add(`${at}.provider ${show(value)} is not a known CLI`);
  return null;
}

function parseModel(value: unknown, at: string, errors: ErrorCollector): string | null {
  if (typeof value !== 'string') {
    errors.add(`${at}.model must be a string`);
    return null;
  }
  if (CONTROL_OR_INVISIBLE.test(value)) {
    errors.add(`${at}.model contains control or invisible characters`);
    return null;
  }
  const model = value.trim();
  if (model === '') {
    errors.add(`${at}.model must not be empty`);
    return null;
  }
  if (model.length > MAX_MODEL_LENGTH) {
    errors.add(`${at}.model is longer than ${MAX_MODEL_LENGTH} characters`);
    return null;
  }
  return model;
}

function parseEffort(value: unknown, at: string, errors: ErrorCollector): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    errors.add(`${at}.effort must be a string or null`);
    return null;
  }
  if (!EFFORT_PATTERN.test(value)) {
    errors.add(
      `${at}.effort ${show(value)} must be 1 to 31 characters: lowercase letters, digits, "-" or "_", starting with a letter or digit`,
    );
    return null;
  }
  return value;
}

function parseSteering(value: unknown, errors: ErrorCollector): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') {
    errors.add('steering must be a string');
    return '';
  }
  const steering = value.replace(STEERING_INVISIBLE_GLOBAL, '').trim();
  const { maxSteeringLength } = MODEL_ROUTING_LIMITS;
  if (steering.length > maxSteeringLength) {
    errors.add(`steering is longer than ${maxSteeringLength} characters`);
  }
  return steering;
}

export function validatePicksAgainstModels(
  config: ModelRoutingConfig,
  models: readonly ProviderModels[],
): string[] {
  const listByProvider = new Map<QuotaProviderId, ProviderModels>();
  for (const list of models) {
    if (!listByProvider.has(list.provider)) listByProvider.set(list.provider, list);
  }
  const errors: string[] = [];
  for (const tier of config.tiers) {
    for (const pick of tier.picks) {
      const list = listByProvider.get(pick.provider);
      if (!list || list.status !== 'ok') continue;
      const where = `tiers.${tier.name}`;
      const model = list.models.find((candidate) => candidate.id === pick.model);
      if (!model) {
        errors.push(`${where}: ${pick.provider} has no model "${pick.model}"`);
        continue;
      }
      if (pick.effort === null) continue;
      if (model.efforts.length === 0) {
        errors.push(`${where}: ${pick.provider} model "${pick.model}" takes no effort setting`);
      } else if (!model.efforts.includes(pick.effort)) {
        errors.push(
          `${where}: ${pick.provider} model "${pick.model}" does not support effort "${pick.effort}" (supported: ${model.efforts.join(', ')})`,
        );
      }
    }
  }
  return errors;
}

export function starterRoutingConfig(): ModelRoutingConfig {
  return {
    version: 1,
    tiers: DEFAULT_ROUTING_TIERS.map((tier) => ({
      name: tier.name,
      description: tier.description,
      picks: [],
      guidance: '',
    })),
    steering: '',
  };
}

/** The routing file path, or "" when homeDir is not an absolute path (never relative to the working directory). */
export function resolveRoutingPath(homeDir: string): string {
  return homeIsSet(homeDir) ? join(homeDir, MODEL_ROUTING_RELATIVE_PATH) : '';
}

/**
 * Opens without blocking (a FIFO or device at the path cannot hang the read),
 * then checks the opened handle is a regular file and reads at most
 * MAX_FILE_BYTES + 1 bytes.
 */
async function readRoutingFile(filePath: string): Promise<ReadOutcome> {
  let handle: FileHandle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'missing' };
    return { kind: 'error', errors: [`could not read the file (${errorCode(error)})`] };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { kind: 'error', errors: ['routing file is not a regular file'] };
    if (info.size > MAX_FILE_BYTES) return { kind: 'error', errors: ['file is too large'] };
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= MAX_FILE_BYTES) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, MAX_FILE_BYTES + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > MAX_FILE_BYTES) return { kind: 'error', errors: ['file is too large'] };
    return { kind: 'text', text: Buffer.concat(chunks, total).toString('utf8') };
  } catch (error) {
    return { kind: 'error', errors: [`could not read the file (${errorCode(error)})`] };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function loadRoutingConfig(homeDir: string): Promise<LoadResult> {
  const filePath = resolveRoutingPath(homeDir);
  const invalid = (errors: string[]): LoadResult => ({
    state: { status: 'invalid', path: filePath, errors },
    config: null,
  });
  if (filePath === '') return invalid([HOME_NOT_SET]);
  try {
    const outcome = await readRoutingFile(filePath);
    if (outcome.kind === 'missing') {
      return { state: { status: 'missing', path: filePath, errors: [] }, config: null };
    }
    if (outcome.kind === 'error') return invalid(outcome.errors);
    let json: unknown;
    try {
      json = JSON.parse(outcome.text);
    } catch {
      return invalid(['not valid JSON']);
    }
    const result = parseModelRoutingConfig(json);
    if (!result.ok) return invalid(result.errors);
    return { state: { status: 'ok', path: filePath, errors: [] }, config: result.config };
  } catch (error) {
    return invalid([`could not read the file (${errorCode(error)})`]);
  }
}

export async function saveRoutingConfig(
  homeDir: string,
  config: ModelRoutingConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const target = resolveRoutingPath(homeDir);
  if (target === '') return { ok: false, error: HOME_NOT_SET };
  let temp = '';
  try {
    const result = parseModelRoutingConfig(config);
    if (!result.ok) return { ok: false, error: result.errors[0] ?? CONFIG_UNREADABLE };
    const directory = dirname(target);
    temp = join(directory, `${TEMP_PREFIX}${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temp, `${JSON.stringify(result.config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, target);
    return { ok: true };
  } catch (error) {
    if (temp !== '') await rm(temp, { force: true }).catch(() => undefined);
    return { ok: false, error: `could not write the routing file (${errorCode(error)})` };
  }
}
