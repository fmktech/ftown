import type { ProviderQuota, QuotaFetchOptions, QuotaFetcher } from './types.js';
import { resolveOpencodeBinary } from './models-opencode.js';

/**
 * opencode subscription quota provider.
 *
 * opencode exposes no plan usage to scripts: `opencode stats` reports token and
 * cost totals, not plan limits, and its local server has no such route. So this
 * provider reports `unavailable` with no windows, and says so. It only checks
 * that the CLI is installed.
 */

const NO_USAGE_MESSAGE = 'opencode has no usage command for its subscription plans';
const NOT_FOUND_MESSAGE = 'opencode CLI not found';
const CHECK_FAILED_MESSAGE = 'opencode CLI check failed';

function observedNow(options: QuotaFetchOptions): string {
  try {
    return options.now().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function quotaWith(status: ProviderQuota['status'], observedAt: string, message: string): ProviderQuota {
  return {
    provider: 'opencode',
    status,
    plan: null,
    windows: [],
    source: 'live',
    observedAt,
    message,
  };
}

/**
 * Reports opencode's subscription quota as unavailable, because opencode has no
 * usage source to read. Only the CLI's presence is checked; nothing is spawned.
 * Never throws or rejects.
 */
export const fetchOpencodeQuota: QuotaFetcher = async (options) => {
  const observedAt = observedNow(options);
  try {
    const binary = await resolveOpencodeBinary(options.homeDir, process.env.PATH);
    return quotaWith('unavailable', observedAt, binary === null ? NOT_FOUND_MESSAGE : NO_USAGE_MESSAGE);
  } catch {
    return quotaWith('error', observedAt, CHECK_FAILED_MESSAGE);
  }
};
