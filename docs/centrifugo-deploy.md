# Centrifugo config deploy

> This is the legacy AWS/EC2 runbook. New deployments use the hardened Fly.io
> package and cutover procedure in
> [`centrifugo-fly-rollout.md`](./centrifugo-fly-rollout.md). Keep this runbook
> until the Fly migration has passed its rollback window.

Automated, drift-proof deployment of the Centrifugo (v5) configuration to the
production EC2 host.

The problem this solves: the live server config drifted from the repo. Newer
namespaces existed in the repo but were **missing on the server**
(`loops`, `events`, `commands`, `bridges`), silently breaking features. From now
on the repo is the single source of truth and CI re-applies it on every merge to
`main` that touches the config, so drift can never silently accumulate again.
**The first run fixes the current drift.**

> There is **no secret leak** here. `centrifugo/config.json` and
> `.secrets/config.prod.json` only ever contained placeholder values, and the
> single real secret — `.secrets/centrifugo.pem` — is gitignored and has never
> been committed. This is a **config sync**, not a security incident.

---

## Components

| Path | Role |
| --- | --- |
| `centrifugo/config.prod.json` | Committed **template**. The four secret fields are explicit `__CENTRIFUGO_*__` placeholders; CI renders them from GitHub secrets. |
| `centrifugo/config.json` | Local dev config (docker-compose). Obviously-dev placeholder values, never used in prod. |
| `.github/workflows/deploy-centrifugo.yml` | The pipeline (render → validate → deploy → health → rollback). |
| `scripts/deploy/centrifugo-remote.sh` | Runs **on the host**; self-detects layout, swaps config, restarts, rolls back. |
| GitHub Actions **secrets** | The four Centrifugo secret values + the SSH private key. |
| GitHub Actions **variables** | The host name and SSH user (non-secret). |

The template is deliberately un-ignored in `.gitignore`
(`!centrifugo/config.prod.json`) so it is tracked and CI can check it out. Every
other `config.prod.json` and all of `.secrets/` stay ignored.

---

## How the pipeline works

Trigger: `push` to `main` that touches `centrifugo/**`, this workflow, or
`scripts/deploy/**`, plus manual `workflow_dispatch`. There is **no**
`pull_request` / `pull_request_target` / `workflow_run` trigger — the repo is
public and the workflow handles real secrets, so only trusted refs may run it. A
`concurrency` group serializes deploys (never two config swaps at once), and the
job runs with `permissions: contents: read`.

1. **Checkout** the repo.
2. **Render** — a small Python step reads `centrifugo/config.prod.json` and
   replaces each `__CENTRIFUGO_*__` placeholder with the matching GitHub secret.
   It **fails** if any secret is empty or if any `__` placeholder survives, and
   it **never prints** the rendered file (only field/env names). Output is
   written mode `0600` outside the checkout.
3. **Validate** — `jq empty` on the rendered JSON, then `centrifugo checkconfig`
   inside `centrifugo/centrifugo:v5`. `checkconfig` is a purely **structural**
   check, so it runs against the committed **placeholder template** — the
   real-secret render is never mounted into the third-party image.
4. **Install SSH key** — the `CENTRIFUGO_SSH_KEY` secret is written to a `600`
   keyfile in the runner temp dir.
5. **Deploy** — create a `700` per-run scratch dir on the host, `scp` the
   rendered config into it and `chmod 600`, `scp` `centrifugo-remote.sh`, then
   `ssh` runs the remote script against the uploaded config path.
6. **Health + rollback** happen inside the remote script (see below). The remote
   script also self-deletes the uploaded secret config on exit.
7. **Cleanup** (`if: always()`) removes the host scratch dir (best-effort) and
   deletes the local SSH keyfile.

Any error fails the job loudly.

**SSH host-key verification.** The workflow requires the repo variable
`CENTRIFUGO_KNOWN_HOSTS` (host public keys are not secret):

- The key is pinned and the handshake runs with `StrictHostKeyChecking=yes`,
  which **authenticates the host and blocks an on-path MITM** from capturing the
  rendered secrets. Populate it with:

  ```sh
  ssh-keyscan -t ed25519,ecdsa,rsa ec2-56-124-107-237.sa-east-1.compute.amazonaws.com
  gh variable set CENTRIFUGO_KNOWN_HOSTS < <(ssh-keyscan -t ed25519 ec2-56-124-107-237.sa-east-1.compute.amazonaws.com)
  ```

  (Run `ssh-keyscan` from a trusted network and verify the fingerprint out of
  band first.) If the variable is absent, the workflow fails before uploading
  the rendered secret configuration.

### The remote script (`centrifugo-remote.sh`)

Because CI cannot know the host layout ahead of time, the script
**self-detects** it at deploy time rather than assuming:

1. **docker** — a running container whose image matches `centrifugo`. It reads
   the container's `-c`/`--config` arg (resolving a **relative** arg such as
   `-c config.json` against the container `WorkingDir`) and maps it to the host
   path via the container `Mounts`, backs it up (`.bak.<timestamp>`), atomically
   swaps in the new config, and `docker restart`s the container.
2. **systemd** — a service unit matching `centrifugo`. It reads the config path
   from the unit's `ExecStart -c` flag (default `/etc/centrifugo/config.json`),
   backs up + replaces with `sudo`, and `sudo systemctl restart`s.
3. **neither** — exits `1` printing exactly what was checked.

**Health check:** up to ~30 attempts, every 2s. Healthy = the process/container
is up **and** an HTTP probe answers on `/health` (`internal_port`), falling back
to the public websocket endpoint where **any** HTTP status (e.g. `400`) proves
Centrifugo is answering. For the **docker** layout the probe runs **inside the
container** (`docker exec … wget/curl`) so it is correct whether or not the host
publishes centrifugo's ports; a bridged container without published ports no
longer causes a spurious rollback. For a **systemd** layout the host loopback is
authoritative. When no HTTP client is available at all, it degrades to
process/container-running state rather than rolling back a config it cannot
disprove.

**Rollback:** on health failure the script restores the timestamped backup
(atomically, via a temp file + `mv`), restarts again, and exits `1`. The script
never prints the config (it only reads the numeric port fields).

### Hardening follow-up: `allowed_origins`

`centrifugo/config.prod.json` currently ships `allowed_origins: ["*"]` while the
admin UI (`admin: true`) is served on the public `443` port. Connections still
require a token (`allow_anonymous_connect_without_token: false`), so the main
residual surface is cross-origin/CSRF against the admin interface. This was left
as `*` **on purpose**: tightening it needs the real production UI origin(s) (the
Vercel app domain), which is not committed anywhere in this repo, and guessing
wrong would break live browser websocket connections. When the app origin is
known, restrict it to that origin plus the WSS hosts
(`https://centrifugo.webcraw.ai`, `https://wss.ftown.ia.br`) and re-deploy.

---

## First run

The secrets and variables are **already set** (see the next section for the exact
names). To do the first deploy — which fixes the current namespace drift:

1. **Merge to `main`** touching `centrifugo/**` (this branch's changes qualify).
   The path filter auto-triggers the deploy on merge; **or**
2. **Manually** — GitHub → **Actions** → **Deploy centrifugo config** → **Run
   workflow** → branch `main` (`workflow_dispatch`).

Watch the run: `render OK` → `checkconfig` passes → the remote script logs the
detected layout, the backup path, the restart, and `deploy OK`. After it
completes, the server has the full namespace set (`terminal`, `sessions`,
`loops`, `terminal-input`, `events`, `commands`, `bridges`).

---

## GitHub secrets & variables

These are **already configured** by the user; the workflow references these exact
names. If you ever need to re-set them, every command below reads from a file or
stdin so **nothing is echoed** to your terminal or shell history. Requires the
GitHub CLI (`gh auth login` first) run from inside the repo.

**Secrets** (values are secret):

| Name | Value source |
| --- | --- |
| `CENTRIFUGO_SSH_KEY` | `.secrets/centrifugo.pem` (the deploy SSH private key). |
| `CENTRIFUGO_TOKEN_HMAC_SECRET_KEY` | Centrifugo JWT HMAC secret. |
| `CENTRIFUGO_API_KEY` | Centrifugo server HTTP API key. |
| `CENTRIFUGO_ADMIN_PASSWORD` | Centrifugo admin web UI password. |
| `CENTRIFUGO_ADMIN_SECRET` | Centrifugo admin web UI secret. |

**Variables** (non-secret):

| Name | Value |
| --- | --- |
| `CENTRIFUGO_HOST` | `ec2-56-124-107-237.sa-east-1.compute.amazonaws.com` |
| `CENTRIFUGO_SSH_USER` | `ec2-user` |
| `CENTRIFUGO_KNOWN_HOSTS` | **Optional** but recommended — `ssh-keyscan` output for the host. Pins the SSH host key so the deploy authenticates it (blocks MITM). If unset, the deploy still runs (trust-on-first-use) with a loud warning. |

```sh
# SSH private key (straight from the gitignored keyfile):
gh secret set CENTRIFUGO_SSH_KEY < .secrets/centrifugo.pem

# The four Centrifugo secret values (pipe each in from a file so it never prints):
gh secret set CENTRIFUGO_TOKEN_HMAC_SECRET_KEY < path/to/token_hmac_secret_key
gh secret set CENTRIFUGO_API_KEY               < path/to/api_key
gh secret set CENTRIFUGO_ADMIN_PASSWORD        < path/to/admin_password
gh secret set CENTRIFUGO_ADMIN_SECRET          < path/to/admin_secret

# Non-secret variables:
gh variable set CENTRIFUGO_HOST     --body 'ec2-56-124-107-237.sa-east-1.compute.amazonaws.com'
gh variable set CENTRIFUGO_SSH_USER --body 'ec2-user'

# Optional (recommended) host-key pin — authenticates the SSH handshake:
gh variable set CENTRIFUGO_KNOWN_HOSTS < <(ssh-keyscan -t ed25519 ec2-56-124-107-237.sa-east-1.compute.amazonaws.com)

# Verify (names only, never values):
gh secret list
gh variable list
```

---

## Same-key config sync = brief reconnect blip (no bridge re-pair)

For this deploy the GitHub secrets hold the **existing** key values, so the
`token_hmac_secret_key` is **unchanged**. Applying the config restarts
Centrifugo, which drops live websocket connections — but because the signing key
did not change, everything re-attaches on its own:

- **Bridges** auto-reconnect and re-authenticate with their **still-valid**
  tokens. No Bridge Command re-pair is needed.
- **Browser tabs** re-attach automatically. The only exception: a tab that has
  been open **past the 24h token expiry** needs a page reload to mint a fresh
  token.

Net effect: a **brief reconnect blip** measured in seconds, no manual
intervention.

---

## (Optional) Key rotation

Rotating `token_hmac_secret_key` is a **separate, scheduled operation** — not
part of a config sync, and not required here. It is more expensive because of how
bridge auth currently works.

The UI signs the Centrifugo JWT **and** the bridge refresh token with the same
`CENTRIFUGO_TOKEN_SECRET` (`ui/src/app/api/auth/bridge/route.ts:67-74`; the
shared `secret` argument is on line 73), and the refresh flow verifies the
incoming token with that same secret and never re-issues the refresh token under
a new key. So rotating the key **invalidates
every outstanding bridge refresh token**: bridges can no longer silently refresh.

**Cost of a rotation:**

- **Every bridge** must be restarted and re-paired with a fresh **Bridge
  Command** (its old refresh token no longer verifies). Sessions themselves
  survive because the bridge id is persisted at `~/.ftown/data/bridge-id`, so a
  re-paired bridge re-attaches to its existing session.
- **Every browser tab** must reload to obtain a token signed with the new key.

Coordinate it so the UI host's `CENTRIFUGO_TOKEN_SECRET` env is updated to the
new value and the UI is restarted right after the server flips, to keep the
rejection window short.

**Recommended long-term fix:** sign the bridge **refresh token** with a
**separate, non-rotated secret** (distinct from `CENTRIFUGO_TOKEN_SECRET`). Then
rotating the Centrifugo signing key no longer invalidates refresh tokens, and a
rotation becomes **auto-recover** — bridges refresh through the restart with no
re-pair, exactly like a same-key sync.
