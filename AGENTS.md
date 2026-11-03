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

See `bridge/AGENTS.md` for bridge-specific notes.
