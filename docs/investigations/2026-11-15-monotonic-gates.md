# Monotonic elapsed-time gates

Elapsed-time gates used wall-clock timestamps. A backward wall-clock step
extended pending delays and leases; a forward step expired them prematurely.
In-process duration checks now use a monotonic clock. Persisted and displayed
calendar timestamps retain wall time.

## Gates moved

All paths below are relative to `bridge/src/`.

| File | Functions and gates |
| --- | --- |
| `mail-delivery.ts` | `notifyCommittedMail` / `recoverPendingMail`: legacy readiness; `scheduleMailNudge` / `wakeSession` / `wakeCodex`: rate limits and retries; `markAgentBusy` / `isAgentRecentlyBusy`: stale windows; `registerNativeWake` / `pluginLeaseRemaining`: native wake leases; `recordInjection` / `isInjectedPrompt`: injection fallback age |
| `native-mail.ts` | `createNativeMailWaker`: capability probe cache TTL |
| `attention-store.ts` | `AttentionStore.scheduleIdle` / `emitIdle`: new and recovered idle deadlines and rechecks; `hasLiveWaiter` / `waitForItem`: waiter TTL and poller pruning; `wait` / `waitForItem`: long-poll budgets |
| `ask-question-hook.ts` | `runAskHook`: overall deadline and bridge outage window |
| `coordination-cli.ts` | `waitForBoard` / `waitForEvents`: command wait budgets |
| `sessions-commands.ts` | `waitForAttentionAnswer`: answer timeout |
| `push-notifier.ts` | `BridgePushNotifier.notify` / `drain`: queue TTL, retries and request budgets |
| `spawn-stagger.ts` | `staggerSpawn`: spawn slot reservations |
| `claude-mod-installer.ts` | `claudeModLaunchPath`: capability probe cache TTL |

## Wall-time boundaries

- Persisted mail identity, mail/nudge timestamps, nudge tokens and public
  injection timestamps represent calendar time.
- Filesystem epoch comparisons, including file-stamp cache windows, must use
  the same clock as filesystem timestamps.
- Attention idle `startedAt`, `dueAt` and `notifiedAt`, answers, resolutions
  and activity timestamps remain durable calendar records. Restart recovery
  converts the remaining wall delay once into a monotonic deadline. The
  explicit numeric `hasLiveWaiter` compatibility override retains wall-time
  semantics; ordinary runtime liveness checks use monotonic time.
- Coordination cards, routing, tree events and plans persist calendar
  timestamps. Displayed ages and stale classifications compare those epochs.
  Usage collection timestamps and calendar token expiry also retain wall time.
- Relative subprocess timers, tree-event waits and harness mail-pump timeouts
  already avoid wall-clock deadline rechecks. Unrelated modules were outside
  this change; this is not a claim of repository-wide clock-step immunity.

## Validation

Injected-clock unit tests stepped wall time backward and forward by ten
minutes while advancing monotonic time independently. Tests checked exact
boundaries, early wakeups, recovery, expiry and unchanged no-step behavior.
The fixed bridge passed installation, build and the full bridge unit suite
(3,159 passing tests, four platform skips, zero failures). UI type-check and
focused fixture tests passed.

Chaos seeds 6 and 10, profile `soak`, level `high`, passed on the fixed bridge
both with and without the backward clock jump.
