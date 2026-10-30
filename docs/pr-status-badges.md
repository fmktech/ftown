# Pull request status badges

Linked GitHub PRs show CI running, CI failed, CI passed, Merged, Closed, or No checks in the session list and terminal header. Clicking the badge still opens the PR. A PR without checks is never shown as passed.

Status comes from the connected computer's GitHub CLI (`gh`) authentication. Tokens stay on that computer. If GitHub or the CLI is unavailable, the link still works; an existing result remains visible with a stale-status tooltip. Older bridges fall back to the plain PR link.

The dashboard requests statuses only while visible, online, and connected to an approved bridge. Requests are batched and cached on the bridge across browser tabs and sessions:

- At most one GitHub query per minute and 60 launches per rolling hour per bridge process, including failures; each query covers up to 20 due PRs.
- Running/no-check states refresh after a minute; open passed/failed states after five minutes; closed PRs after an hour. Cached merged PRs do not refresh.
- Missing authentication and connection errors back off for at least five minutes. GitHub rate-limit/reset signals and low remaining quota can delay refresh further.
- Cached results become stale locally without an extra GitHub request. Duplicate links on multiple connected computers use one deterministic available bridge in each dashboard.

GitHub counts GraphQL points, not just requests; query costs can vary. Limits above apply per bridge process, so multiple computers and other GitHub tools share the account's quota. The bounded in-memory cache resets when the bridge restarts. GitHub.com PRs are supported; GitHub Enterprise hosts are not queried.
