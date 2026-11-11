# Multi-account operations

For the operator of an ftown server. One server hosts many independent accounts. Each account is its own passkey-rooted ledger; accounts cannot see each other's data. Technical details: the amendment at the end of `docs/investigations/2026-11-10-passkey-ledger-contract.md`. The one-time cut-over from passwords is in `docs/runbooks/passkey-ledger-cutover.md` (its setup-secret steps are obsolete). The append-only ledger (bridge 0.22.0) is described in `docs/investigations/2026-11-10-append-only-ledger.md`; its roll-out is in `docs/runbooks/append-only-ledger-cutover.md`.

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

Each account can make 60 ledger writes per 10 minutes. A write is a chain that the server adopts: one that extends the stored chain, or an owner-signed resolution of two histories. A chain the server only keeps (the same chain, or a prefix of it), a refused different history, and the sticky-only write that records removals seen on a refused history spend nothing. Over the limit, the server answers 429 `rate_limited` and the Security panel shows "Too many changes in a short time. Wait a few minutes and try again." Waiting up to 10 minutes clears it. Only valid, signed chains count, so another person cannot use up an account's budget with junk.

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

What happens by itself. Any replica of the account that holds a chain ahead of the restored row repairs the server, with no passkey and without creating an account.

- A browser does it when it reads the server: opening the Security panel, renewing its relay token, subscribing to the ledger channel, signing in.
- A computer on bridge 0.22.0 does it when a server read shows the server behind it: the hourly relay-token answer (the server sends its chain only when the head differs), a relay notice, a resubscribe. It sends its chain with `expectHead` and never creates an account. So an account with no browser open is repaired by any online computer.
- The server adopts the chain because it strictly extends the stored one, and the account's write limit allows it. The row's `revision` and `head` move forward again.

What does not happen.
- An account with no replica online (no browser, no 0.22.0 computer) stays at the restored state until one connects.
- A browser with no local copy of the chain (new browser, cleared site data) cannot notice anything by itself. It notices as soon as a computer is online: on connect it compares heads with each online computer, adopts a longer valid chain from one, and the re-offer brings the server forward.
- A restore followed by a write from a browser with no history, while no computer with the dropped records is online, creates two histories. That browser signs on the restored head and the server accepts it, because it extends the restored chain. The computers hold records past the restore point, so their chains and the server's now differ. They refuse each other and the owner must choose one. See "When two histories exist".
- No chain wins by being longer. A shorter chain that has a later revocation is not replaced by a longer one that lacks it. If the other history held removals, replicas that saw them keep enforcing them.

What to check.
- Record `SELECT account_id, revision, head FROM account_ledger` before the restore and again after the users have reconnected. A `revision` that went back and then forward again is a re-offer that landed.
- The server logs nothing for a re-offer. It logs `[ledger] checkpoint healed: account <first 8 characters of account_id> reason <absent|mac_mismatch|stale_head|chain_mismatch> revision <old>-><new>` (one line, `console.warn`) when a restored row's sealed checkpoint cannot be trusted, for example after a restore from another `AUTH_SECRET`. That line is about the checkpoint, not about the re-offer.
- On a computer, a re-offer that fails prints `[ledger] could not send our account history to the server (<reason>); retrying in N s`. Success prints nothing. Its local API (`GET /api/security/info`, `.ledger.serverBehind`) stays `true` until the server has taken the chain.
- A user can see an unapplied removal in Security as "Removal not saved to the server yet" and press "Retry now".

## When two histories exist

Two valid histories of one account share a prefix and then differ. This is rare. It needs a database restore (or a bug) and then a write from a replica that did not hold the records the restore dropped. Nothing is lost by itself: every replica keeps the history it holds and refuses the other one, and you choose.

**What each terminal prints.** A computer that refuses a different history prints one line per refused head:

```
[ledger] REFUSED a different account history from server (head 3fa91c02, revision 9); keeping ours (head b7e0d114, revision 12)
```

`from relay` instead of `from server` means a relay publisher showed it. If the other history removes this computer, the line ends with `; that history removes this computer`. The computer keeps trusting its own members and keeps working. If the server refuses the computer's key at start, it starts offline and prints:

```
[Bridge] The ftown server refused this computer's key, and this computer holds account history the server does not have: 1 removal and 0 passkeys among 2 changes after revision 10.
[Bridge] Do NOT run --new-identity: this computer may hold the only copy. Open Security in the dashboard to choose a history.
[Bridge] Starting offline: local sessions keep working, and the relay is retried in the background.
```

Ask the computer directly: `curl -s http://127.0.0.1:$(cat ~/.ftown/data/local-api-port)/api/security/info`. `.ledger.divergence` is `null`, or `{ source, otherHead, otherRevision, ourRevision, firstSeen, forkRevision, removedOnOtherHistory }`.

The server logs `[ledger] account <8 characters> enforces N removal(s) seen on a different history` when a refused history carried removals it did not have yet. A browser prints nothing for a valid different history.

**What the dashboard shows.** There is no badge on the computer. A browser that has learned both histories, from its own read of the server, from a computer when it connects, or from a relay push, shows this in Security: "Two different histories of this account exist". Everything else in Security is turned off: "Other changes to your account are turned off until you choose one history." If your browser holds the server's history and does not show the screen, open the dashboard while the computer that refused it is online. The browser asks each online computer for its head when it connects and raises the screen when one proves a different valid history.

**How to choose.**
1. Open Security in a browser that shows the screen. It says which side holds the other history: the server, one of your computers, or another replica.
2. Read both columns. Each lists, from the point where the histories part, what that history added and removed, with date and time. "N earlier changes are identical" counts the shared part.
3. Pick the history that holds the changes you made last, and the computers and browsers you still use. If the other column holds only records marked "You signed this on <date>. It was not saved.", the screen recommends this browser's history. Keep this browser's.
4. Read what keeping a history does. Under each column, "Will be discarded:" lists the other side's added browsers and computers that you lose. Removals and passkeys of the other side are not lost: the screen says they are re-applied, and each one needs a passkey confirmation.
5. Press "Keep this history" under your choice and confirm with your passkey as many times as the screen says ("You will confirm N times"). All the signed records are sent in one request. If it cannot be saved yet, the screen says "Your choice is signed but not saved to the server yet. Retrying…" and sends it again by itself.
6. When it is saved the screen says "History kept. Other replicas will follow." Computers follow on their next read of the server (relay notice, hourly token, or restart `ftown start`). A computer that still prints REFUSED after your choice holds records newer than your choice, or a resolution you did not see. Open the screen again and choose again.
7. A computer that was added only on the history you discarded is no longer in the account. It says "This computer is not in your account's ledger. Run `ftown start --new-identity` to pair it again." Only then, run `ftown start --new-identity` and pair it again. Its old replica is archived.

**What not to do.**
- Never run `ftown start --new-identity` on a computer that says it holds history the server lacks. It may hold the only copy of records you signed. The reset archives the replica, but nothing in ftown loads an archive.
- Do not clear site data, or press "Reset this browser", on a browser that holds records the server lacks.
- Do not restore the database again, and do not delete the account row, to make the message go away.
- Do not guess. Both histories are real and signed by you. Choosing keeps one and discards the added browsers and computers of the other.
- Do not choose opposite histories from two browsers at once. Neither resolution is accepted by the replicas on the other side, and you start again.

**Where the archived ledger files are.** An identity reset (`ftown start --new-identity`, or a signed removal of the computer) moves `<data dir>/security/ledger.json` to `<data dir>/security/ledger.<YYYY-MM-DDTHH-MM-SS.mmmZ>.archived.json` (mode 0600; colons in the time become dashes). The default data dir is `~/.ftown/data`. The newest five archives are kept. Nothing reads them back. They hold the full signed chain, so keep them until you are sure the account is right.

## Removing an account

There is no shipped command or UI for this. Accounts are not deleted automatically either, and abandoned accounts stay.

Deleting the row in `accounts` removes the account's data: in `ui/schema.sql` the tables `account_ledger`, `pair_mailbox`, `security_endpoint_directory`, `security_device_display_names`, `push_subscriptions` and `push_events` reference `accounts(account_id)` with `ON DELETE CASCADE`, and `push_deliveries` cascades from those. Verify before running; back up first.

```sql
-- verify before running; replace the id
DELETE FROM accounts WHERE account_id = '<accountId>';
```

A browser or a computer re-offering its chain cannot bring the account back: the POST carries `expectHead`, and for an unknown account the server answers 404 `account_unknown` before genesis admission. They also read first, and a 404 stops them (a computer for an hour). A normal user-signed change from a still-signed-in browser reads first too, so it fails before the passkey prompt with `account_not_found`, and one signed during the prompt is sent with `expectHead` and answered 404. Bridge 0.22.0 has no path that sends a plain POST. A bridge on 0.21.0 does: it sends its chain once per local head after its relay token request is refused, without `expectHead`, and that can re-create the account while `REGISTRATION_ENABLED` allows it and the chain has at most 16 records. Update or stop those computers, and close registration (or accept the re-creation), before deleting.

This does not disconnect computers or browsers that are already connected, and relay tokens already issued stay valid until they expire (up to one hour). The people involved keep their passkeys and computers; the computers need `ftown start --new-identity` to join another account. `rate_limit_attempts` rows are keyed by scope and key, not by account, and are not removed.

## Before opening registration to strangers

Do not set `REGISTRATION_ENABLED=true` on a public server until these are done.

- [ ] Relay publish isolation (PR B). Centrifugo client publish is not limited per user, so one account can publish noise into another account's channels. Receivers drop it, but it can flood and poison history. Tracked as a separate change; see "Known gaps" in the contract amendment.
- [ ] Relay connection and memory limits. Centrifugo connection limits are global and shared by all accounts. Size them, and the relay's memory, for the expected number of users.
- [ ] A trusted proxy, so per-IP limits work (see above).
- [ ] Account removal and abandoned-account cleanup. Neither exists. The soft cap (1000 accounts by default) can be filled for good: at the default global budget of 200 creations per day, it takes about five days. Until cleanup exists, raise `FTOWN_MAX_ACCOUNTS` or delete rows by hand (see "Removing an account").
- [ ] Pairing confirmation on the bridge. A computer pairs when someone with the link and the account's passkey approves. The terminal only prints the account afterwards; it does not ask. Anyone who has the link can compute the 6-digit code, so a leaked link is enough. Tell users to keep the link private and to check the printed account.
- [ ] Pending revocations. A signed removal that the server did not take is kept as the one pending write and retried by the browser on its own (30 s, doubling to 10 min), and enforced on that browser meanwhile. Other replicas learn it from the server, so the server can keep authorizing a just-revoked key until the write lands. Tell users to confirm in Security that a removal took effect.
- [ ] Limits set to values you chose, not just the defaults.
