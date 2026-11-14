# Agent notes — repo-wide

## Public repository: never commit security findings

`fmktech/ftown` is a **public** repository. Do not commit security reviews,
threat models, attack-surface maps, penetration notes, or vulnerability
write-ups — publishing them discloses unfixed issues.

- Store all security findings in the git-ignored `.security-notes/` folder at
  the repo root. It is excluded by `.gitignore` (`.security-notes/`).
- `.gitignore` additionally blocks:
  - `docs/security-review*.md`
  - `docs/*security-review*.md`
  - `docs/**/security-review*.md`
  - `docs/security-fixes-*/`
  - `docs/investigations/security-*/`
  - `docs/investigations/*security*.md`
- Architecture/controls documents such as `docs/**/security-design.md` are
  allowed and may be committed.
- On finding a vulnerability: write it to `.security-notes/`, report it to the
  maintainer, and do **not** open a public issue or PR that contains the
  details. Remediation code (with no finding narrative) is fine.

## CI flakiness is a failure

- A flaky test or job in CI is a bug, not noise. Never re-run CI blindly to get
  green.
- On a failure that "passes locally" or "passes on retry": find the cause from
  the failed logs (timing assumption, missing await, shared state, network),
  fix it deterministically (explicit synchronisation, not longer sleeps), and
  prove it with repeated and parallel runs under load.
- A re-run is acceptable only for a failure proven to be outside the repo
  (registry/network outage, runner crash), and the reason must be stated
  where the re-run is reported.

See `bridge/AGENTS.md` for bridge-specific notes.
