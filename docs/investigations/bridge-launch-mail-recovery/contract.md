# Bridge launch ownership and mail recovery

2026-10-19. Scope: the two recommended priorities accepted by the user: standard launch commands belong to the bridge; pending mailbox wakes recover when receivers become available. Status/upgrade commands and New Session UI changes are deferred. No dependency changes, schema changes, automatic setup, merge or publication.

## Launch contract

- Browser standard launches send existing structured fields: shellType, prompt, model, workingDir, native resume IDs, name, environment and createMissingWorkingDir. They omit generated command, initialInput and initialInputDelay. Make the UI wire command field optional; explicitly supplied custom/legacy commands remain supported by existing bridge behavior.
- Existing bridge registry/create logic remains authoritative for flags, quoting, prompt arguments versus delayed input, shell defaults, models and resume targeting. Initial task must be submitted once and never replayed automatically on resurrection. Retain cached-browser explicit command/raw-input behavior, including Claude compatibility handling.
- Remove the now-unused browser builders and their mirror tests/snapshot. Replace coverage with actual request payload assertions and bridge launch behavior. Tagged bridge 0.19.44 already supports this commandless request; compatibility with older releases is unverified.

## Mail recovery contract

- Add typed ProcessRunner event `ready: [sessionId: string]` after actual process attachment/activeProcesses registration and data/exit handler installation for both direct spawn and tmux attachment, including reattachment. Do not signal readiness for failed launches. Calling runner.run is insufficient because tmux startup is asynchronous.
- Add internal `MailDeliveryService.recoverPendingMail(sessionId: string): Promise<void>`. It checks current session/process and durable pending mail, schedules existing wake machinery, and never marks payload delivered. Ignore absent/stopped receivers, empty inboxes and Pi (its extension owns wake/retry). Preserve current sender label where present; otherwise derive it from pending mail.
- LocalApiServer binds/unbinds runner ready notifications and performs a bounded initial recovery pass when store, mail store and runner are fully wired, covering processes attached before binding. No periodic whole-store scanner. Replacing dependencies/stopping the server must fence stale asynchronous work through awaited reads/scheduling and remove listeners; keep one listener per current runner. Current startup wires setDependencies before setMailStore, so wait for all three dependencies.
- Reuse existing wake serialization, native leases, busy/rate-limit/backoff gates and accepted/unknown native batch suppression. Repeated readiness/idle events must not produce concurrent wakes or repeated accepted batches. Waiting/drained/deleted sessions must not receive stale notifications. Recovery errors are isolated per session and cannot fail successful launches.
- Wake-attempt suppression is currently in memory. After a bridge restart an unread inbox may generate another pointer; this is at-least-once notification, not a second payload delivery. Do not introduce a persistent wake-attempt schema or claim exactly-once notification. Mail remains durable and only inbox consumption marks delivery.

## Acceptance and integration

Launch units cover standard harnesses, quoted paths/models/prompts, one prompt, resume IDs, provider environment, raw/custom compatibility, and UI omission of executable strings. Recovery units cover offline arrival -> timer expires -> ready -> wake; ready after restart/reattach; fully wired initial recovery; failed launches; stopped/deleted/drained sessions; duplicate events; native accepted/unknown suppression; plugin lease/busy gates; Pi exclusion; listener cleanup and dependency races.

Workers implement isolated root-run runtime fixtures; root alone executes them against a copied installed package with a temporary HOME/PATH and harmless fake harness executables, local-only bridge and loopback API. Exercise real launch argv/input/resume plus mail parked while stopped and recovered on retry/restart, inbox semantics and harness status. No real models, user bridge, cloud account or database. Root owns process/port/environment/fixture cleanup and any CI E2E execution. Reuse automatic PR browser E2E for combined UI lifecycle coverage instead of duplicating a database environment locally.

Integration owner bumps package/lock from 0.19.48 to 0.19.49 once, builds after source writers stop, runs required package checks, then commits/pushes authorized files and opens PR against main after independent review and root runtime gates. Preserve four pre-existing dirty investigation notes. No worker independently installs, commits, pushes or starts E2E.
