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

Set in the server environment. Each must be a plain positive integer. Anything else (0, negative, decimal, empty, too large) falls back to the default and the server logs a warning once per process. A limit cannot be switched off with 0. `REGISTRATION_ENABLED` is the only off switch.

| Env var | Default | Meaning |
|---|---|---|
| `FTOWN_MAX_ACCOUNTS` | 1000 | Soft cap. Over it: `server_full` (503). |
| `FTOWN_ACCOUNT_CREATE_PER_IP_HOUR` | 5 | Attempts per client IP per hour. Over it: 429. |
| `FTOWN_ACCOUNT_CREATE_GLOBAL_DAY` | 200 | Attempts per day, all clients together. Over it: 429. |
| `FTOWN_ACCOUNT_WRITES_PER_10MIN` | 60 | Ledger writes to one existing account per 10 minutes. Over it: 429, and the Security panel shows "Too many changes in a short time. Wait a few minutes and try again." |

If the server is not behind a proxy that ftown trusts (Vercel, Fly, or `FTOWN_TRUSTED_PROXY=1`), every client has the same IP key. Then the per-IP limit is shared by everyone and the global daily limit is the real limit. Set `FTOWN_TRUSTED_PROXY=1` only when your proxy overwrites `X-Forwarded-For` / `X-Real-IP`.

IPv6 clients are counted by /64, not by full address. All clients in one /64 (usually one household or one office) share one budget. IPv4 clients are counted by address.

The per-IP and global creation budgets are spent only by a request whose chain verified, after the signature check. Malformed or unsigned requests do not use them. Other answers on account creation: `server_misconfigured` (503, the public origin or RP ID is not set up; see the server log), `origin_mismatch` (400), `creation_too_large` (413), `handle_taken` (409).

## Limit on changes to an existing account

Each account can make 60 ledger writes per 10 minutes (a write is a chain that the server adopts, or one that adds revocations it did not have). Over it, the server answers 429 `rate_limited` and the Security panel shows "Too many changes in a short time. Wait a few minutes and try again." Waiting up to 10 minutes clears it. Only valid, signed chains count, so another person cannot use up an account's budget with junk.

## Rotating AUTH_SECRET and mixed deploys

The server keeps a sealed copy of each account's checkpoint, keyed from `AUTH_SECRET` (see "Server reads: sealed checkpoint" in the contract amendment).

- Rotating `AUTH_SECRET` does not damage stored accounts. Each row is re-sealed on its first read after the change, which costs one verification of that account's chain. Expect a short burst of CPU after the change if many accounts are active.
- It signs everyone out, because sessions are signed with the same secret. Users sign in again with their passkey.
- During a rolling deploy where two instances run with different `AUTH_SECRET` values, each instance finds the other's seal invalid and re-seals the row. Nothing is lost, but each read can cost a chain verification and rows are written repeatedly. Give all instances the same value, and finish the roll quickly.

## What a new user does

1. Open the site, go to `/login`, open "Create an account".
2. Enter an account name (it only labels the passkey on their device; the server never sees it), a passkey label and a label for this browser. Create the passkey and sign. This signs in the browser.
3. Add a second passkey right away (Security). The passkey is the only key to the account. Authorities are add-only, and a lost or stolen sole passkey cannot be recovered.
4. Pair each computer: run `ftown start`, open the link, type the code, approve with the passkey. Check that the terminal prints the right account ("Paired with account ...").
5. Sign in on other browsers with "Sign in with passkey". The passkey adds that browser to the account.

A browser profile belongs to one account. To use another account in the same profile, reset the browser in Security first.

## After a database restore

Restoring `account_ledger` from a backup can put an account back to an older signed prefix of its chain. The server then authorizes the state of that older chain, for example a key that was revoked later.

What happens by itself. The first browser of the account that reads its ledger, with a copy of the chain that is ahead of the restored row, sends that chain back. This happens when the browser opens the Security panel, renews its relay token, subscribes to the ledger channel or signs in. It needs no passkey and creates no account. The server adopts the chain if it wins fork choice and the account's write limit allows it. The row's `revision` and `head` move forward again.

What does not happen.
- An account with no browser online stays at the restored state until one connects.
- A browser with no local copy of the chain (new browser, cleared site data) cannot notice anything.
- Bridges do not send their chain ahead of the server. They read it.
- A longer chain without a later revocation can win over a shorter one that had it. Check the revocations of important accounts by hand.

What to check.
- Record `SELECT account_id, revision, head FROM account_ledger` before the restore and again after the users have reconnected. A `revision` that went back and then forward again is a re-offer that landed.
- The server logs nothing for a re-offer. It logs `[ledger] checkpoint healed: account <first 8 characters of account_id> reason <absent|mac_mismatch|stale_head|chain_mismatch> revision <old>-><new>` (one line, `console.warn`) when a restored row's sealed checkpoint cannot be trusted, for example after a restore from another `AUTH_SECRET`. That line is about the checkpoint, not about the re-offer.
- A user can see an unapplied removal in Security as "Removal not saved to the server yet" and press "Retry now".

## Removing an account

There is no shipped command or UI for this. Accounts are not deleted automatically either, and abandoned accounts stay.

Deleting the row in `accounts` removes the account's data: in `ui/schema.sql` the tables `account_ledger`, `pair_mailbox`, `security_endpoint_directory`, `security_device_display_names`, `push_subscriptions` and `push_events` reference `accounts(account_id)` with `ON DELETE CASCADE`, and `push_deliveries` cascades from those. Verify before running; back up first.

```sql
-- verify before running; replace the id
DELETE FROM accounts WHERE account_id = '<accountId>';
```

A browser re-offering its chain cannot bring the account back: its POST carries `expectHead`, and for an unknown account the server answers 404 `account_unknown` before genesis admission. The browser also reads first, and a 404 stops it. A normal user-signed change from a still-signed-in browser reads first too, so it fails before the passkey prompt with `account_not_found`. Two paths do send a plain POST (no `expectHead`) that goes through genesis admission and can re-create the account while `REGISTRATION_ENABLED` allows it and the chain has at most 16 records: a change signed after the account was deleted during the passkey prompt, and a bridge of the account that sends its chain once per local head after its relay token request is refused. Close registration (or accept the re-creation) before deleting, and stop the computers of that account.

This does not disconnect computers or browsers that are already connected, and relay tokens already issued stay valid until they expire (up to one hour). The people involved keep their passkeys and computers; the computers need `ftown start --new-identity` to join another account. `rate_limit_attempts` rows are keyed by scope and key, not by account, and are not removed.

## Before opening registration to strangers

Do not set `REGISTRATION_ENABLED=true` on a public server until these are done.

- [ ] Relay publish isolation (PR B). Centrifugo client publish is not limited per user, so one account can publish noise into another account's channels. Receivers drop it, but it can flood and poison history. Tracked as a separate change; see "Known gaps" in the contract amendment.
- [ ] Relay connection and memory limits. Centrifugo connection limits are global and shared by all accounts. Size them, and the relay's memory, for the expected number of users.
- [ ] A trusted proxy, so per-IP limits work (see above).
- [ ] Account removal and abandoned-account cleanup. Neither exists. The soft cap (1000 accounts by default) can be filled for good: at the default global budget of 200 creations per day, it takes about five days. Until cleanup exists, raise `FTOWN_MAX_ACCOUNTS` or delete rows by hand (see "Removing an account").
- [ ] Pairing confirmation on the bridge. A computer pairs when someone with the link and the account's passkey approves. The terminal only prints the account afterwards; it does not ask. Anyone who has the link can compute the 6-digit code, so a leaked link is enough. Tell users to keep the link private and to check the printed account.
- [ ] Automatic retry of pending revocations. A revocation that the server rejects or rate-limits is not retried by the browser until its next write, and bridges learn new chains only through the server. The server can keep authorizing a just-revoked key until a later write succeeds. Tell users to confirm in Security that a removal took effect.
- [ ] Limits set to values you chose, not just the defaults.
