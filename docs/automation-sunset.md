# Factory and recurring automation retirement

Bridge 0.19.38 removes FTown factory orchestration and recurring interval/cron
loops. The dashboard, CLI help, Pi tools, bundled factory template and active
skills no longer offer them. Stale `/api/loops` requests return HTTP 410 with
`automation_removed`; stale RPC/CLI loop requests return an explicit removal error.

Upgrading a bridge does not delete or rewrite saved `loops.json`, `loop-runs.json`,
project `factory/` definitions or `.ffactory/` ticket databases/history, artifacts,
worktrees and worker maps. New code never loads or schedules those definitions.
Independent FTS installations and ordinary manually started sessions remain
available. The later agent surface simplification below also retires the
deterministic workflow runner. Historical loop-owned sessions appear in normal session history;
their `loopId` metadata remains readable and archived.

Before ordinary startup resurrection, the upgraded bridge stops only exact known
FTown tmux jobs whose stored sessions carry nonempty `loopId` provenance, and marks
running/pending records error with a retirement reason while keeping their history.
Stop failures are reported explicitly and retried on the next startup. Those
historical records cannot be retried, revived or automatically resumed. Names,
prompts and factory-looking project paths are never used to infer ownership;
ordinary factory stage agents without `loopId` remain ordinary sessions.

Installed cleanup removes only exact bridge skill links or byte-for-byte
recognized shipped factory assets and the old loop reference. Customized or
unrecognized files/directories and symlink parents are preserved; they may still contain old
instructions, but the retired bridge APIs cannot schedule them.

Retirement takes effect separately on each upgraded bridge. Existing older bridges
continue their old behavior until an operator deliberately upgrades/restarts them.
This code change does not stop remote old processes or deploy to production.

Do not silently downgrade: old code can resume preserved schedules, including
enabled or manually queued definitions. Before a rollback, review every affected
bridge and explicitly disable or otherwise isolate old scheduling through a planned
operational procedure. Preserve backups and project history. There is no schema
migration or automatic data purge in this release.


## Agent surface simplification

ftown no longer bundles or installs fticket, and the ftown workflow runner,
workflow CLI, reference and example have been retired. Use `ftown sessions`,
`ftown harness`, and `ftown env`; the existing nonworkflow launchers remain
compatible. The ftown skill is the authoritative agent guide. Child briefings
carry identity and result/escalation reporting; session cleanup is explicit.

Upgrade cleanup recognizes exact shipped skill trees, reference/example hashes,
workflow runtime hashes and generated workflow launcher content. Customized or
unrecognized assets, foreign links, symlink parents, independently installed
skills, shared runtime files and all `~/.ftown/workflows/` run data survive.
Unrecognized legacy files may remain on disk, but the new `ftown` dispatcher has
no workflow route.

## Explicit setup lifecycle

Bridge 0.19.41 moves integration installation and the retirement checks above to
`ftown setup`. Ordinary startup requires matching completed setup before data
migration, auth or listeners. Stable cleanup migration IDs run once, separately
from package-version readiness; `ftown setup --repair` deliberately rechecks
current installation and cleanup. Failed setup remains retryable. Missing optional
harness binaries and user-disabled plugins are intentional skips. No special
orchestrator briefing or injected environment remains; task and parent links
provide ordinary coordination.
