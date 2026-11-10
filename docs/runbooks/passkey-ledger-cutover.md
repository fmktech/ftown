# Passkey ledger cut-over (release 0.21.0)

For the owner (one developer, one account). This is a one-way switch from passwords to a passkey. Read the whole page once before starting. Technical details are in `docs/investigations/2026-11-10-passkey-ledger-contract.md`.

Anything marked "confirm before use" is not defined in this repository; check it yourself before relying on it.

## 0. What will be destroyed, and what is kept

Destroyed by the database migration (`ui/migrations/0011_passkey_ledger.sql`), with no way back except a database backup:
- Every existing account and password (`users`), all bridge refresh tokens (`bridge_refresh`), all pairing requests (`pairing_requests`), the old trust history, enrollments and pending approvals (`security_account_*`, `security_pending_approvals`).
- The endpoint directory, device names and all push tables (push subscriptions, push events, push deliveries). Rows are dropped, not converted. Push notifications stop until each browser enables them again (confirm in the app how to re-enable).
- Login and register rate-limit rows.

Kept:
- Sessions, transcripts and everything else on each computer (`~/.ftown/data`). Only the account identity files are replaced (section 6).
- Solo and `--local` modes are unaffected.

After the switch every computer and every browser must be re-added by you with your passkey.

Take a database backup first (Neon: branch or snapshot; confirm the exact steps in the Neon console). Check: you can name where the backup is and how to restore it.

## 1. Before you start (checklist)

1. You have a device that holds an iCloud Keychain (or other synced) passkey capability, and you can open the production site over https on it. Check: Safari/Chrome on that device loads the production URL with a lock icon. Passkeys do not work on plain http except `localhost`.
2. The GitHub repository secrets `MIGRATION_DATABASE_URL` (a direct `postgresql://` Neon connection string) and `DATABASE_URL` exist, because the migration job needs them (`.github/workflows/migrate.yml`). Check: `gh secret list` shows both names (confirm before use; needs `gh` logged in with access).
3. The branch with release 0.21.0 is ready to merge, its checks are green, and `bridge/package.json` says version `0.21.0`.
4. You have a free hour and all your computers are reachable.

## 2. Set environment variables in Vercel (before merging)

Set these for the Production environment of the UI project (Vercel dashboard, Project, Settings, Environment Variables; the `vercel env` CLI also exists but is not used by this repo: confirm before use). The two `NEXT_PUBLIC_` values are baked into the browser bundle at build time, so they must exist BEFORE the build that you deploy.

| Variable | Required in production | Example shape | Notes |
|---|---|---|---|
| `FTOWN_PUBLIC_URL` | Yes | `https://ftown.example.com` | The exact public origin: scheme and host only, no trailing slash, no path. A wrong value (trailing slash, http on a non-loopback host) makes the server fail closed. |
| `NEXT_PUBLIC_FTOWN_PUBLIC_URL` | Yes | the same value | Must be identical to `FTOWN_PUBLIC_URL`. If it is missing, "First time setup" shows "This server is not configured for account creation". |
| `FTOWN_RP_ID` | No | `ftown.example.com` | Server-side passkey domain. Default: the host of `FTOWN_PUBLIC_URL`. Leave it unset unless you really need a different registrable domain. |
| `NEXT_PUBLIC_FTOWN_RP_ID` | No | `ftown.example.com` | Browser-side twin of the above. Same default. If you set one of the two, set both to the same value. Warning: the passkey is permanently tied to this domain; choose it once. |
| `FTOWN_BOOTSTRAP_SECRET` | Yes, until the account exists | 64 random characters | At least 32 characters. Generate: `openssl rand -base64 48`. Keep a copy in your password manager; you type it once on the login page. |
| `REGISTRATION_ENABLED` | Yes, set to `true` | `true` | In production account creation is closed unless this is exactly `true`. You turn it off after step 5. |
| `AUTH_SECRET` | Yes | 48+ random characters | Change it now (new value from `openssl rand -base64 48`). This invalidates every old login cookie, which is wanted. Must be at least 32 characters and must not contain `change-me`. |
| `CENTRIFUGO_TOKEN_SECRET` | Yes | existing value | Do not change it unless you also change the Centrifugo server's matching secret (not part of this cut-over). At least 32 characters. |
| `NEXT_PUBLIC_CENTRIFUGO_URL` | Yes | `wss://your-centrifugo-host/connection/websocket` | Existing value. The relay-token route returns 503 without it. |
| `DATABASE_URL` | Yes | existing value | Existing. |

Unused now, remove after the cut-over works: `SLACK_SIGNUP_WEBHOOK_URL` (signup webhook is gone). Any password or email related variable from the old setup that you added yourself (none is read by the code any more). `VAPID_*` stay (push is kept).

Behind Vercel the client IP for rate limits is read from Vercel's headers automatically. `FTOWN_TRUSTED_PROXY=1` is only for self-hosted proxies.

Check: re-read the list in the dashboard. `FTOWN_PUBLIC_URL` and `NEXT_PUBLIC_FTOWN_PUBLIC_URL` are identical, start with `https://` and have no trailing slash.

## 3. Apply the migration and deploy

What triggers the migration: the GitHub workflow `migrate` (`.github/workflows/migrate.yml`) runs on every push to `main` that changes `ui/migrations/**`, `ui/scripts/migrate.mjs` or the workflow file, and can also be started by hand (`workflow_dispatch`). It runs `node scripts/migrate.mjs` in `ui/`, which applies every `ui/migrations/*.sql` not yet listed in the `schema_migrations` table, each file in one transaction (a failure rolls back and stops). Merging the 0.21.0 branch therefore triggers it.

Vercel builds and deploys the same push at the same time; the migration job does not gate the deploy. For a short window the new app may run on the old schema (or the reverse). Plan for it: do not try to sign in until the migration finished.

1. Merge the branch to `main`.
2. Watch the migration: `gh run list --workflow migrate.yml --limit 3` and open the latest run. Check: it finished with success and its log contains `applied 0011_passkey_ledger.sql` (or `skip 0011_passkey_ledger.sql (already applied)` on a re-run). If it failed, do not continue: see section 8, "Migration failed".
3. If the migration job did not start (for example the push did not touch a watched path), start it by hand: `gh workflow run migrate.yml` (runs on `main`). Check as in step 2.
4. Wait for the Vercel deployment to be Ready (Vercel dashboard). If you changed env vars after the build started, redeploy so the build sees them. Check: opening `https://<your-domain>/login` shows "Sign in with your passkey" and a "First time setup" section.
5. The bridge package is published to npm by `.github/workflows/publish-bridge.yml` on the same merge when `bridge/` changed. Check: `npm view ftown@0.21.0 version` prints `0.21.0` (confirm before use; the publish job may take a few minutes). Do not run `npx ftown@0.21.0 setup` on a computer before this works.

## 4. Create the account (once)

On the device that has your synced passkey, open `https://<your-domain>/login`.

1. Open "First time setup".
2. Fill "Passkey label" (for example `iCloud Keychain`), "This browser label" (for example `MacBook Safari`), and "Setup secret" (the value of `FTOWN_BOOTSTRAP_SECRET`).
3. Click "1. Create passkey". The system asks to create a passkey: approve with Touch ID.
4. Click "2. Sign the account". Approve with Touch ID again.
5. Click "3. Add this browser". Approve with Touch ID a third time. You land on the dashboard.

Check: the dashboard opens and the Security panel lists one passkey and one browser (this one). If "3. Add this browser" fails with a network error the page offers "3. Retry with this secret" with the same signed account; no new prompt is needed. "Discard this setup and create a new passkey" starts over (it creates another passkey in your keychain).

## 5. Add a second passkey (recommended) and close registration

There is no way to remove or replace a lost passkey inside the account (the ledger is add-only). Add a second one now, preferably stored somewhere different from the first (for example a hardware security key; it must be a resident ES256 passkey usable on this domain: confirm your key supports that before relying on it).

1. Open the Security panel, "Add another passkey", enter a label.
2. Three prompts: create the new passkey, let the new passkey agree to join, then an existing passkey signs the addition.

Check: the Security panel lists two passkeys.

Then close account creation:
1. In Vercel set `REGISTRATION_ENABLED` to `false` and delete `FTOWN_BOOTSTRAP_SECRET`.
2. Redeploy production so the running deployment sees the change (confirm in the Vercel dashboard that the new deployment is live).

Check: after the redeploy, `/login` "First time setup" can still be opened but creating an account would be refused (the server answers `registration_closed`). Do not test with a real attempt unless you want to; the check is the Vercel env list. (The server also allows only one account at all: a second account cannot be created while the first exists.)

## 6. Re-pair every computer

Repeat on EACH computer. Do it in a terminal you can see, not through a background service.

1. Stop the bridge: stop the `ftown start` / `ftown-bridge` process you run (Ctrl-C in its terminal, or quit it the way you normally do). Do not kill unrelated processes by pattern. Sessions run in tmux and stay alive.
2. Install the new version: `npx ftown@0.21.0 setup`. Check: it finishes without an error (if it says to repair, run `ftown setup --repair`).
3. Start it by hand: `ftown start`. If you start with a custom API URL keep your usual flag, for example `ftown start --api-url https://<your-domain>`. A bridge that updated itself automatically will not pair: it exits with `ftown was updated to the passkey ledger; run ftown start to pair this computer.` Just run `ftown start` yourself.
4. The first start prints a line saying old account data was cleared (this deletes only account identity files, listed in section 12.4 of the contract; sessions stay). Then it prints:
   - a link `https://<your-domain>/pair#req=...`
   - `Type this code on the page to confirm it is this computer: NNNNNN`
5. Open the link on a device where you are signed in (or sign in first; the page sends you to `/login` and back). Type the 6-digit code from the terminal into the page. Do not approve a pairing you did not start. After 5 wrong codes the page discards the link and you must restart `ftown start`.
6. Click "Approve with passkey" and approve with Touch ID. The page shows "Computer added".
7. Within about 5 seconds the terminal prints `Paired with account xxxxxxxx (passkey "<label>")` and the bridge continues to start. The link expires after 10 minutes; if it does, run `ftown start` again.

Check: the computer appears in the Security panel under computers, with its hostname, and shows as online on the dashboard; your sessions are listed.

## 7. Sign in on each browser and installed web app (PWA)

The old login cookies no longer work. For each browser/PWA:
1. Open `https://<your-domain>/login` and click "Sign in with passkey". Approve with Touch ID (this identifies your account).
2. The page asks "Name this browser". Give it a name and click "Add this browser". Approve with Touch ID again.
3. Re-enable notifications in that browser if you used them (confirm where in the app).

After that, this browser signs in on its own without a passkey prompt, until you use the sign-out button (then "Sign in with passkey" again).

Check: the dashboard shows your computers; the Security panel lists the browser.

## 8. Verification checklist

Do all of these after section 7.
- [ ] `/login` in a private window offers "Sign in with passkey"; signing in works with one prompt for identify plus one for adding the browser.
- [ ] Security panel: 2 passkeys, every browser you use, every computer you use.
- [ ] A terminal on a computer: open a session from the dashboard and type; output appears (end-to-end works).
- [ ] Remove a test browser in the Security panel (Remove, confirm, passkey). It shows "This browser was removed from your account" when you open it, and "Reset this browser" lets it join again as a new browser.
- [ ] Remove nothing you still need. If you want to test computer removal, use a spare one: after the removal the bridge prints "This computer was removed from your ftown account. Creating a new identity; pair it again with the link below." and prints a new link.
- [ ] Vercel env: `REGISTRATION_ENABLED=false`, no `FTOWN_BOOTSTRAP_SECRET`.
- [ ] Solo (if you use it): `ftown start --solo` still starts as before.
- [ ] Note for the engineer: the tests use software passkeys only; no real iCloud Keychain assertion has been captured as a test vector. Your first successful sign-in on real hardware is the first real proof.

## 9. Rollback

What can be undone:
- Code: you can deploy the previous UI and publish/install the previous bridge version.

What cannot be undone:
- The database changes are one-way. The migration drops the old tables and their data. Old code on the new schema (or new code on the old schema) does not work.
- After a code rollback you must re-register under the old model: restore the database from the backup you took in section 0 (or recreate the user and pair every bridge again) and set the old environment variables. The old password and refresh tokens are gone unless you restore the backup.
- New ledger accounts and pairings made with 0.21.0 are lost by a database restore; you would re-pair under the old model.

If something fails before step 4 of section 3, nothing has changed in the database yet. Rolling forward (fixing the cause) is almost always easier than rolling back.

## 10. Troubleshooting

The passkey prompt does not appear, or "Passkeys need a secure connection":
- Use the https production address (or `localhost` for local development). Open the site in the top-level window, not in an iframe or embedded preview. Check that the browser supports passkeys and that iCloud Keychain / password manager passkeys are enabled in its settings.
- If you see "This page address does not match the server's public address", you opened a different address than `FTOWN_PUBLIC_URL` (for example a Vercel preview URL). Passkeys are tied to the production domain; open the official address.

"This passkey is already registered":
- You already created this passkey. Use "Sign in with passkey" instead. If it persists after "Discard this setup and create a new passkey", remove the stale passkey entry for this site in your keychain settings first (outside ftown).

"Account creation is closed" (`registration_closed`):
- Check in Vercel that `REGISTRATION_ENABLED` is `true`, that `FTOWN_BOOTSTRAP_SECRET` is set and at least 32 characters, that you typed it exactly, and that the deployment is the one built after the env change. The same message appears if an account already exists (only one account can exist). If the secret was wrong, fix the field and use "3. Retry with this secret".

"The setup secret is wrong":
- Retype `FTOWN_BOOTSTRAP_SECRET` exactly; the value in Vercel must be the one you generate in section 2.

The bridge says "This computer is not in your account's ledger. Run `ftown start --new-identity` to pair it again." (also: "The server's account ledger does not list this computer"):
- Run `ftown start --new-identity` on that computer. It forgets this computer's account identity (not your sessions), gives it a new bridge id and shows a new pairing link. Approve it as in section 6. If you use a custom API URL, repeat the same flags (`--api-url`, `--data-dir`).

A bridge says it could not reach the server:
- If it has been paired before it starts offline using the last known relay URL and keeps retrying. Browsers can use it only while the 24 hour rule below holds. Check the network and `--api-url`.

Lost passkey:
- If you have another passkey in the account, you are fine; sign in with it.
- If you lost all of them, or one was stolen: the account cannot be repaired from inside (authorities are add-only). Recovery is a new account: (1) delete the old account in the database so a new one may be created (the server allows only one account at all; manual SQL, for example deleting the single row from `accounts`, which cascades to the ledger, mailbox, directory and push rows: confirm before use and back up first); (2) set `REGISTRATION_ENABLED=true` and a `FTOWN_BOOTSTRAP_SECRET` again and redeploy; (3) create the account as in section 4; (4) on EACH computer run `ftown start --new-identity` and pair it again (section 6); (5) sign in on each browser (section 7); (6) close registration again (section 5).

Clock problems and the 24 hour rule:
- A computer lets your browsers in only if it has talked to the server within the last 24 hours, by its own clock and by its own elapsed time. After a longer outage the browsers get an offline-expired error until the computer reaches the server again (it renews automatically on the next relay token, normally within the hour).
- If a computer's clock jumps backwards by more than 30 seconds (or the clock file was lost) it refuses browsers until it has contacted the server in the running process. Fix the system time (turn on automatic time), then restart `ftown start` and let it reach the server.
- A passkey signature or a new record is refused if its time is more than 30 seconds ahead of the checking machine's clock. If sign-in or pairing fails oddly, check the clock of the device you are using.

Migration failed:
- The migration runs in one transaction, so a failure leaves the database as it was. Read the job log (`gh run view --log` for the migrate run), fix the cause, and run `gh workflow run migrate.yml` again. Until it succeeds the new app cannot work.

Something looks wrong with the ledger in the browser (a notice listing "changes that were replaced" or "Removed on this browser only"):
- Two devices wrote at the same time and the longer history won. The notice lists what was lost; use "Sign again" on each entry you still want. A removal shown as "not yet applied to your account" still blocks that device or computer on this browser; sign the removal again to apply it everywhere.
