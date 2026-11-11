# Append-only ledger cut-over (bridge 0.22.0)

For the owner and only operator. This is a one-way change: server, UI and bridges move together. Design: `docs/investigations/2026-11-10-append-only-ledger.md`. Day-to-day operations: `docs/runbooks/multi-account-operations.md`.

What changes for you. A replica no longer picks a winner between two histories of the account. It adopts only a chain that extends its own. If two valid histories ever exist, every replica keeps its own and you choose one in Security.

There is no database migration. The server change and the browser change ship in one deploy. The bridge change ships as `ftown` 0.22.0.

## 1. Order of operations

1. **Before you start.** On each computer, copy the replica so you have it if you must go back (section 5):

   ```bash
   cp -p ~/.ftown/data/security/ledger.json ~/.ftown/data/security/ledger.before-0.22.0.json
   ```

   Check: the copy exists. (Use your `--data-dir` if you start with one.)
2. **Merge** the branch `feat/append-only-ledger`. It is stacked on `feat/browser-reoffer`: merge that first if it is not in `main` yet. Check: CI is green and `bridge/package.json` says `0.22.0`.
3. **Deploy the server.** Vercel deploys the UI and the API together from `main`. There is nothing to migrate and no environment variable to add. Check: sign in on one browser and open Security. It loads, with no "Two different histories" screen.
4. **Reload every open dashboard tab.** A tab that still runs the old script keeps the old rules until it reloads.
5. **Update each computer, one at a time.** On the computer:

   ```bash
   npx ftown@0.22.0 setup
   ftown start
   ```

   Stop the old `ftown start` first if one is running. Do not run `--new-identity`: the computer keeps its identity and its pairing.
6. **Verify** (section 3) after each computer, before the next one.

Keep the time between step 3 and the last computer short, and do not remove devices or add passkeys during it (section 2).

## 2. Why 0.21.0 bridges must not stay

A 0.21.0 bridge still has three behaviours that the new server and browsers no longer assume.

- It breaks forks by length, then by number of removals, then by smallest head. A replica on 0.22.0 never does that. After any divergence the two kinds of replica can end up on different histories.
- It cannot read a chain that contains a `resolve_fork`, the record you sign to choose between two histories. It treats that chain as invalid and keeps its old one. After a resolution it stops following the account.
- After a plain 401 it POSTs its own chain once per head, without `expectHead`. That POST can re-create an account that was deleted (while registration is open and the chain has at most 16 records). A 0.22.0 bridge first reads the server and posts only if the server is behind.

It also has no `ledger_head` or `ledger_chain` and makes no head announcements, so it takes no part in the best-effort agreement. Browsers treat it as silent. Nothing breaks and nothing blocks: it is just not checked against.

So update every computer, then stop thinking about it. Do not leave one on 0.21.0 "for later".

## 3. What to expect and how to verify

**In each computer's terminal, after `ftown start`.** The normal start is the one you know:

```
[Bridge] Local API server started on port <port>
[Bridge] Ready and listening for commands
[Bridge] Encrypted endpoint ready. Browsers signed in to your account with a passkey can reach this computer.
```

No `[ledger]` line is expected. A first start after the update reads the version 1 `ledger.json` and rewrites it as version 3 by itself. Lines you can see, and what they mean:

| Line | Meaning |
|---|---|
| `[ledger] REFUSED a different account history from server (head …, revision N); keeping ours (head …, revision M)` | The server holds a valid other history. See "When two histories exist" in `multi-account-operations.md`. Do not reset the computer. |
| `[ledger] could not send our account history to the server (<reason>); retrying in N s` | The server was behind this computer and the re-offer failed. It retries with a backoff up to 10 minutes. |
| `[ledger] the server does not know this account (404); this computer will not send its account history to it for an hour` | The server has no row for the account. |
| `[Bridge] The ftown server refused this computer's key, and this computer holds account history the server does not have: …` followed by `[Bridge] Do NOT run --new-identity …` and `[Bridge] Starting offline …` | The computer holds records the server lacks. Read section 2 of the multi-account runbook. |

**What the dashboard shows during the window.** Nothing changes for a normal day. A computer on 0.21.0 looks the same as before (online, usable). There is no badge for a computer that holds a different history: that shows only in its terminal and in its local API (below). The two-histories screen appears in the Security panel only when a browser learns of two valid histories.

**Verify on each computer.**

1. The terminal shows the three lines above and no `[ledger] REFUSED`.
2. Ask the computer's local API. The port is in `~/.ftown/data/local-api-port`:

   ```bash
   curl -s http://127.0.0.1:$(cat ~/.ftown/data/local-api-port)/api/security/info
   ```

   A 0.22.0 bridge in account mode answers with a `ledger` object. A 0.21.0 bridge has none, which is how you spot one that was not updated. Expected:

   ```json
   "ledger": { "divergence": null, "serverBehind": false, "removedOnOtherHistory": false }
   ```

   `divergence` set means that computer refused a different history. `serverBehind: true` means the server's chain is a prefix of the computer's: the computer is re-offering it, and it clears by itself once the server takes it.
3. In the dashboard, open Security. Every computer is listed and online, and the panel shows no "Two different histories of this account exist" screen.

## 4. If something is wrong

- A computer prints `Local account ledger is corrupted.` after you started an older `ftown` on it: see section 5.
- A computer prints the "Do NOT run --new-identity" notice, or `[ledger] REFUSED …`: stop and use "When two histories exist". Do not reset.
- A removed-by-mistake or "not saved" notice in Security: press "Retry now", or "Discard this change" and sign again.

## 5. Rollback limits

Going back is not clean. The store formats moved, and nothing converts them back.

**Bridge.** `~/.ftown/data/security/ledger.json` is version 3 once a 0.22.0 bridge has written it (its first server read does). Version 3 has seven keys, `divergences` and `refused` among them. The 0.21.0 loader accepts only a version 1 file with exactly five keys. It cannot read a version 3 file. It does not guess or convert: loading fails with `Local account ledger is corrupted.` (`ledger_store_corrupt`), and the bridge does not start. It does not delete the file. A 0.22.0 bridge reads version 1 and version 2 files, so the move forward is safe and the move back is not.

To return a computer to 0.21.0 you have two choices, both worse than staying:

- Put back the copy you made in step 1 (`ledger.before-0.22.0.json`) as `ledger.json`. It loses everything that computer learned since the update, and it is only safe if no chain written since then matters to that computer.
- Run `ftown start --new-identity` on 0.21.0 and pair the computer again. 0.21.0 deletes the old replica and does not archive it.

**Browser.** The browser's stored record is version 2 (it adds `pending`, `divergence`, `blocked`). The previous build accepts only version 1 and rejects version 2 as corrupt, so a rolled-back server build makes browsers that already wrote version 2 show "This browser's copy of your account could not be read. Sign in again with your passkey." (`ledger_replica_corrupt`). Signing in again rebuilds the replica from the server and the passkey. A signed change that was pending, a local block and a divergence on that browser are lost with it. Records are public and signed, so nothing is lost from the account itself.

**Server.** No schema change, so the database is safe either way. But once an owner has resolved a divergence, the account's chain holds a `resolve_fork` record, and the old server build cannot parse it: it reports that account's row as corrupt (503) until you deploy the new build again. Before any resolution, a rolled-back server still works.

In short: roll forward. If 0.22.0 fails on one computer, fix it, or pair that computer again, rather than going back to 0.21.0.
