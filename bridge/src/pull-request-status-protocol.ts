/** Cached read-only GitHub status; never contains credentials or check logs. */
export type PullRequestState = 'in_progress' | 'failed' | 'passed' | 'merged' | 'closed' | 'unknown';
export type PullRequestStatusReason = 'no_checks' | 'unavailable' | 'rate_limited' | 'unauthenticated';
export interface PullRequestStatus {
  url: string;
  state: PullRequestState;
  checkedAt: string | null;
  stale: boolean;
  reason?: PullRequestStatusReason;
}
export interface GetPullRequestStatusesPayload {
  bridgeId: string;
  sessionIds: string[];
}
export interface PullRequestStatusesResponse {
  bridgeId: string;
  statuses: PullRequestStatus[];
  /** Earliest useful refresh; ISO timestamp. Clients must not force a refresh. */
  nextRefreshAt: string;
}
