# Multi-account operations

For the operator of an ftown server. One server hosts many independent accounts. Each account is its own passkey-rooted ledger; accounts cannot see each other's data. Technical details: the amendment at the end of `docs/investigations/2026-11-10-passkey-ledger-contract.md`. The one-time cut-over from passwords is in `docs/runbooks/passkey-ledger-cutover.md` (its setup-secret steps are obsolete).

## Opening and closing registration

`REGISTRATION_ENABLED` is the switch.

- In production, accounts can be created only when it is exactly `true`. Unset, `false`, `1` or `TRUE` all mean closed.
- Outside production, unset means open.
- It is read from the process environment on each account-creation request (`ui/src/lib/registration.ts`, called from the ledger store). It is not a `NEXT_PUBLIC_` variable and is not inlined at build time. Restarting or redeploying the server with the new value is enough; no rebuild is needed. (On Vercel, an env change applies to new deployments, so redeploy.)
- Closing registration blocks only new accounts. Existing accounts keep working, and existing accounts can still add browsers and computers.
- A closed server answers `registration_closed` (403). `/login` shows "Account creation is closed on this server."

## Limits on account creation

Set in the server environment. Each must be a plain positive integer. Anything else falls back to the default.

| Env var | Default | Meaning |
|---|---|---|
| `FTOWN_MAX_ACCOUNTS` | 1000 | Soft cap. Over it: `server_full` (503). |
| `FTOWN_ACCOUNT_CREATE_PER_IP_HOUR` | 5 | Attempts per client IP per hour. Over it: 429. |
| `FTOWN_ACCOUNT_CREATE_GLOBAL_DAY` | 200 | Attempts per day, all clients together. Over it: 429. |

If the server is not behind a proxy that ftown trusts (Vercel, Fly, or `FTOWN_TRUSTED_PROXY=1`), every client has the same IP key. Then the per-IP limit is shared by everyone and the global daily limit is the real limit. Set `FTOWN_TRUSTED_PROXY=1` only when your proxy overwrites `X-Forwarded-For` / `X-Real-IP`.

## What a new user does

1. Open the site, go to `/login`, open "Create an account".
2. Enter an account name (it only labels the passkey on their device; the server never sees it), a passkey label and a label for this browser. Create the passkey and sign. This signs in the browser.
3. Add a second passkey right away (Security). The passkey is the only key to the account. Authorities are add-only, and a lost or stolen sole passkey cannot be recovered.
4. Pair each computer: run `ftown start`, open the link, type the code, approve with the passkey. Check that the terminal prints the right account ("Paired with account ...").
5. Sign in on other browsers with "Sign in with passkey". The passkey adds that browser to the account.

A browser profile belongs to one account. To use another account in the same profile, reset the browser in Security first.

## Removing an account

There is no shipped command or UI for this. Accounts are not deleted automatically either, and abandoned accounts stay.

Deleting the row in `accounts` removes the account's data: in `ui/schema.sql` the tables `account_ledger`, `pair_mailbox`, `security_endpoint_directory`, `security_device_display_names`, `push_subscriptions` and `push_events` reference `accounts(account_id)` with `ON DELETE CASCADE`, and `push_deliveries` cascades from those. Verify before running; back up first.

```sql
-- verify before running; replace the id
DELETE FROM accounts WHERE account_id = '<accountId>';
```

This does not disconnect computers or browsers that are already connected, and relay tokens already issued stay valid until they expire (up to one hour). The people involved keep their passkeys and computers; the computers need `ftown start --new-identity` to join another account. `rate_limit_attempts` rows are keyed by scope and key, not by account, and are not removed.

## Before opening registration to strangers

Do not set `REGISTRATION_ENABLED=true` on a public server until these are done.

- [ ] Relay publish isolation. Centrifugo client publish is not limited per user, so one account can publish noise into another account's channels. Receivers drop it, but it can flood and poison history. Tracked as a separate change; see "Known gaps" in the contract amendment.
- [ ] Centrifugo connection limits. They are global and shared by all accounts. Size them for the expected number of users.
- [ ] A trusted proxy, so per-IP limits work (see above).
- [ ] You accept that there is no account deletion and no abandoned-account cleanup.
- [ ] Limits set to values you chose, not just the defaults.
