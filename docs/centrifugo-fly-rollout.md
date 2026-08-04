# Centrifugo Fly.io rollout

This runbook moves only the Centrifugo WebSocket broker from AWS to Fly.io.
The Next.js app, database, local bridges, signing code, channel names, and
existing client URLs stay unchanged. The current HMAC signing secret is copied
to Fly so already-issued tokens continue to work during cutover and rollback.

The target is one `shared-cpu-1x` Machine with 256 MB in `gru`. Centrifugo uses
its memory engine, so the app must stay at exactly one Machine. A rolling deploy
causes a brief client reconnect; it does not provide zero-downtime failover.

## What is deployed

| Path | Purpose |
| --- | --- |
| `centrifugo/config.fly.json` | Hardened Centrifugo v5 runtime config. Admin and HTTP API are disabled; secrets are absent. |
| `centrifugo/Dockerfile.fly` | Reproducible image pinned to the Centrifugo v5.4.9 multi-platform digest. |
| `centrifugo/fly.toml` | Fly service, checks, region, resource limits, and one-Machine policy. |
| `.github/workflows/deploy-centrifugo-fly.yml` | PR/push validation plus an explicitly approved manual production deploy. |

The threat model, reviewed findings, and full absence checklist are in
[`centrifugo-fly-security-review.md`](./centrifugo-fly-security-review.md).

Fly terminates TLS on port 443 and forwards to Centrifugo on port 8000. Only
`/connection/websocket` is useful publicly. Admin, the Centrifugo HTTP API, and
the health endpoint are not exposed. Health listens on `127.0.0.1:9000` inside
the Machine.

## One-time setup

Run these commands from a trusted workstation while authenticated to the
correct Fly organization:

```sh
fly apps create ftown-centrifugo --org <organization-slug>
```

Import the **exact current production HMAC secret**. Do not generate a new
value during migration and do not copy the old API key or admin credentials.
This form avoids putting the secret in shell history:

```sh
read -r -s CENTRIFUGO_HMAC_VALUE
printf '\n'
printf 'CENTRIFUGO_TOKEN_HMAC_SECRET_KEY=%s\n' "$CENTRIFUGO_HMAC_VALUE" \
  | fly secrets import --stage -a ftown-centrifugo
unset CENTRIFUGO_HMAC_VALUE
```

Create a short-lived, app-scoped deploy token and store it as the repository
secret `FLY_API_TOKEN`. Never use an organization token:

```sh
fly tokens create deploy -a ftown-centrifugo -x 720h \
  | gh secret set FLY_API_TOKEN
```

Confirm that only the required runtime secret exists:

```sh
fly secrets list -a ftown-centrifugo
```

Expected secret name: `CENTRIFUGO_TOKEN_HMAC_SECRET_KEY`.

## First deployment

The normal path is GitHub Actions: run **Validate and deploy Centrifugo to
Fly**, choose **Run workflow**, and check the `deploy` input. Pushes and pull
requests validate but never deploy.

For a controlled first deployment from a trusted workstation:

```sh
cd centrifugo
fly deploy --remote-only --ha=false
fly scale count 1 -a ftown-centrifugo
fly status -a ftown-centrifugo
fly checks list -a ftown-centrifugo
```

Do not add a volume: the memory engine intentionally has no persistent broker
state. Do not scale above one Machine without first moving to a shared engine
such as Redis and revisiting the failure model.

Before DNS changes, verify the Fly hostname:

```sh
for path in / /api /health; do
  curl -sS -o /dev/null -w "$path %{http_code}\n" \
    "https://ftown-centrifugo.fly.dev$path"
done
```

All three responses must be `404`. The deployment workflow also verifies a
successful WebSocket upgrade for `Origin: https://ftown.ia.br`.

## Certificates and DNS cutover

Keep AWS running throughout the rollback window. Add both hostnames because
both have been used by clients/configuration:

```sh
fly certs add centrifugo.webcraw.ai -a ftown-centrifugo
fly certs add wss.ftown.ia.br -a ftown-centrifugo
fly certs list -a ftown-centrifugo
```

Follow the ownership-validation and DNS records printed by `fly certs add`.
Complete certificate validation before changing production traffic. Lower DNS
TTL ahead of the window if the provider permits it.

Cut over `centrifugo.webcraw.ai` first because it is the current production UI
endpoint, then `wss.ftown.ia.br`. Preserve the hostname in
`NEXT_PUBLIC_CENTRIFUGO_URL`; only its DNS target changes, so no UI deployment
is required.

During and after cutover, watch:

```sh
fly status -a ftown-centrifugo
fly checks list -a ftown-centrifugo
fly logs -a ftown-centrifugo
```

Verify a real browser session can connect, open a terminal, receive output,
send input, and reconnect after a page refresh. Verify each active local bridge
reconnects to the same hostname. A short reconnect during the DNS/deploy window
is expected.

## Go/no-go gate

- Fly has exactly one running Machine in `gru`.
- The sole Fly runtime secret is the current production HMAC signing secret.
- `/`, `/api`, and `/health` return `404` on the public Fly hostname.
- The allowed web origin connects and an unrelated origin is rejected.
- Both custom certificates are valid before their DNS records move.
- AWS remains healthy and its DNS targets are recorded for rollback.
- Production `REGISTRATION_ENABLED` is absent or `false`; use `true` only for a
  controlled onboarding window, then disable it again.
- The production database contains only the intended account; disabling future
  registration does not remove accounts created earlier.

The current channel model permits authenticated browser clients to publish to
several user-scoped namespaces. Production registration is therefore
fail-closed for today's single-user operation, but this is not a tenant-isolation
boundary. Add server-enforced publisher ownership checks before intentionally
inviting untrusted additional users; the Fly migration itself does not fix that
application-level authorization gap.

## Rollback

Restore both custom-hostname DNS records to their recorded AWS targets. Because
Fly and AWS share the same HMAC secret and protocol configuration, clients can
reconnect without re-pairing. Leave the Fly Machine running until DNS caches
have converged and AWS traffic is confirmed.

If only the new Fly release is bad, use Fly's release rollback while leaving
DNS in place:

```sh
fly releases -a ftown-centrifugo
fly deploy --image <previous-image-reference> -a ftown-centrifugo --ha=false
```

## Decommission AWS

After 24–48 hours of healthy Fly traffic and an expired DNS rollback window:

1. Disable the legacy `Deploy Centrifugo Config` workflow.
2. Stop the AWS Centrifugo container, then remove the host only after a final
   verification period.
3. Delete the obsolete SSH, API, admin-password, and admin-secret values from
   GitHub. Keep only the Fly app-scoped token and runtime HMAC secret.
4. Rotate the Fly deploy token on its expiry schedule.

Rotating the HMAC signing secret is a separate coordinated operation because it
invalidates existing connection tokens and may require bridge/client re-pairing.
