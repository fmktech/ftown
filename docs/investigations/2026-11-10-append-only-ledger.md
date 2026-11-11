# Append-only account ledger: design of record

Status: implemented on branch `feat/append-only-ledger`, bridge 0.22.0. It replaces the fork-choice rule of `2026-11-10-passkey-ledger-contract.md` (section 6: "longer chain wins, more revokes, smaller head"). Where the two documents disagree, this one wins. The ledger format, the passkey signature rule, authority consent, the key-possession proof and the server's sealed checkpoint are unchanged; read the older contract for them.

Source of truth is the code. The modules named below are the places to read.

| Concern | Module |
|---|---|
| Relations, `chooseLedger`, `resolve_fork`, `seen` | `bridge/src/security/ledger/ledger.ts` (shared; the UI imports it as `@security/ledger/ledger`) |
| `resolve_fork` and the other operations | `bridge/src/security/ledger/protocol.ts` |
| Head announcements | `bridge/src/security/ledger/announce.ts`, `proof.ts` |
| Server store and route | `ui/src/lib/account-ledger-store.ts`, `ui/src/app/api/account/ledger/route.ts`, `ui/src/app/api/auth/relay-token/route.ts` |
| Browser | `ui/src/lib/ledger-client.ts`, `ledger-replica.ts`, `ledger-peers.ts`, `ledger-runtime.ts` |
| Browser screens | `ui/src/components/ForkResolution.tsx`, `SecurityDevices.tsx`, `SecurityPanel.tsx`, `DashboardClient.tsx` |
| Bridge | `bridge/src/security/bridge/ledger-store.ts`, `security.ts`, `ledger-rpc.ts`, and `bridge/src/ledger-relay.ts`, `ledger-reoffer.ts`, `ledger-startup.ts`, `identity-reset.ts`, `relay-token.ts` |

## (a) Rules

The owner's words, kept as the statement of intent:

- What is written is never rewritten.
- A change whose past does not match is rejected. The past is named by `previousHead`.
- Every replica validates each change itself.
- Concurrency is rare, so a concurrent writer simply signs again.
- Agreement among replicas is best effort. The more replicas answer, the better. Silence never blocks and never asks the owner anything.
- If two valid histories exist, the owner chooses one.

The same rules, precisely. A replica is a server, a browser or a bridge.

1. **Append-only.** A replica never removes or rewrites a record it holds. The only exception is rule 4, and only the owner's passkey can trigger it.
2. **Adopt only an extension.** A replica adopts a candidate chain only if it is valid and strictly extends the chain the replica holds. "Extends" means: same genesis, more records, and the candidate's record at the replica's tip has the replica's head (`previousHead` links match). Only the new records are verified.
3. **Best effort agreement.** Replicas ask each other for their heads (computers by encrypted RPC, browsers by signed announcement). A replica that proves a longer valid chain is adopted through rule 2. A replica that is silent, late, wrong or invalid is ignored. Nothing waits for it.
4. **A different valid history is never adopted.** If a candidate is valid but diverges from the held chain, the replica keeps its own chain and records the divergence. Length, age and content do not matter. The divergence ends only when the owner signs a `resolve_fork` record that chooses one side (section g). A replica adopts such a record only under the rules listed there.
5. **An invalid chain is ignored.** It is treated like silence and logged once.
6. **No tie-break exists.** The code that compared length, number of removals and smallest head is deleted.
7. **Removals are never undone.** A removal signed by an authority that existed at the fork point is enforced by every replica that sees it, even on a history the replica refuses (section f). A resolution must carry every removal of the history it discards.

## (b) Relations and `chooseLedger`

`relate(localHeads, candidateHeads)` compares two lists of record heads (index = revision; index 0 is the accountId). It hashes nothing and checks no signature. A different accountId is not a relation: it throws `ledger_other_account`.

| Relation | Meaning |
|---|---|
| `same` | identical heads |
| `ahead` | candidate strictly extends local |
| `behind` | local strictly extends candidate |
| `diverged` | both have a record at some revision and the heads differ |

`chooseLedger(local, candidate, now, cache)` returns `{ decision, relation, checkpoint, discarded, ledger, seen }`.

| Situation | decision | relation | `choice.ledger` |
|---|---|---|---|
| no local chain (first bind), candidate valid | `adopt` | `null` | the parsed candidate |
| no local chain, candidate invalid | throws | | |
| candidate malformed or of another account | `reject` | `null` | local |
| `same` | `keep` | `same` | local |
| `behind` | `keep` | `behind` | local. The caller may re-offer its own chain. |
| `ahead`, new records valid | `adopt` | `ahead` | local prefix + verified new records |
| `ahead`, any new record invalid | `reject` | `ahead` | local |
| `diverged`, a record after the fork invalid | `reject` | `diverged` | local |
| `diverged`, valid, no applicable `resolve_fork` | `keep` | `diverged` | local. `seen` is filled. |
| `diverged`, valid, applicable `resolve_fork` | `adopt` | `diverged` | local prefix up to the fork + the candidate's verified records after it. `discarded` is filled. |

Meaning of the result fields:

- `choice.ledger` is the chain to store. It is never the candidate as passed in. On `adopt` it is the local prefix byte for byte, followed by the candidate's verified suffix, because the candidate's copy of the shared prefix is not verified and may carry re-encoded signatures. On `keep` and `reject` it is local. On a first bind it is the parsed candidate.
- `choice.checkpoint` is the raw checkpoint of `choice.ledger` (no sticky ids applied). Use it as the next cache. Never pass a trusted checkpoint as a cache.
- `choice.discarded.records` lists the local records after the fork point that a divergent adoption dropped. It is empty in every other case. `discarded.deviceIds` and `discarded.bridgeIds` are always empty now, because a resolution is adopted only if it already carries every removal of the discarded branch. Callers still merge them.
- `choice.seen` lists the device ids and bridge ids revoked on a refused (`keep`, `diverged`) candidate after the fork, by an authority that existed at the fork point. It is empty in every other case. Section f.

Verification cost:

- Every call hashes the records of the candidate and of local (SHA-256, linear, no signatures). That is enough for `same`, `behind` and the relation.
- `ahead`: one passkey assertion check per new record (two for an `add_authority`: the signature and the consent). Local is not re-verified when the cache vouches for it (same last head and hash-linked records); otherwise local is verified from genesis first.
- `diverged`: the local prefix up to the fork is replayed without signature work. Only the candidate's records after the fork are verified.
- First bind: the whole chain is verified.
- Limits: 1,024 transitions, 2 MiB, 8 authorities, 128 devices, 128 bridges. Sticky sets are bounded by 8 x 1,024 ids.

## (c) The server is a sequencer, not an authority

The server stores one chain per account and serves it. It verifies what it writes, but nobody trusts it: browsers and bridges verify every chain they receive. The server never rewrites a stored chain. A database restored to an older prefix is repaired only when some client offers a chain that extends it.

`POST /api/account/ledger` takes `{ ledger, expectHead? }`. `expectHead` is the 43-character head the client just read (any other value is 400). Every write or re-offer that a browser or bridge makes for an account it already holds carries it. Only an account creation does not.

Answers for an existing account:

| Status | Body | Meaning | What is written |
|---|---|---|---|
| 200 | `{ decision: 'adopt', ledger, discarded }` | valid chain that extends the stored one, or an applicable `resolve_fork`. `discarded` is the number of stored records replaced (0 unless a resolution). | The chain (`choice.ledger`), the sticky set (its revocations), the sealed checkpoint. Spends one write of the account's budget. Published on the ledger channel. |
| 200 | `{ decision: 'keep', ledger, discarded: 0 }` | same or behind | Nothing. |
| 201 | `{ decision: 'created', ledger, discarded: 0 }` | account creation (no row, no `expectHead`) | The account row, chain, sticky set, sealed checkpoint. Published. |
| 409 | `{ error: 'diverged', ledger }` | valid different history, no applicable `resolve_fork` | No chain write. If the refused chain shows removals by a fork-point authority that the sticky set lacks, a sticky-only write adds them (logged). No budget spent. Nothing published. |
| 409 | `{ error: 'ledger_rejected', ledger }` | invalid chain (a bad record, or it would overflow the sticky set) | Nothing. |
| 409 | `{ error: 'head_changed', ledger }` | the stored head is not `expectHead` | Nothing. Checked before `chooseLedger` and before any budget. |
| 404 | `{ error: 'account_unknown' }` | `expectHead` given and no account exists | Nothing. A re-offer never creates an account. |
| 429 | `{ error: 'rate_limited' }` + `Retry-After` | per-IP (30 writes per minute) or per-account budget (`FTOWN_ACCOUNT_WRITES_PER_10MIN`, default 60) | Nothing. |

Every 409 carries the stored chain, so the client can run fork choice on it at once.

Other answers: 400 `invalid_request` (bad body or bad `expectHead`), 413 `payload_too_large`, 503 `ledger_unavailable`. An unparseable chain, or a creation that fails admission, is answered by its creation reason: `invalid_ledger` 400, `registration_closed` 403, `creation_too_large` 413, `origin_mismatch` 400, `server_misconfigured` 503, `server_full` 503, `handle_taken` 409, `rate_limited` 429.

Concurrency. The write is guarded by the row's `(version, revision, head)`. A lost race re-reads the row and runs once more. With `expectHead` the second round answers `head_changed`. Without it, `chooseLedger` sees the other writer's record and answers `diverged`. A second lost race is a 503.

`GET /api/account/ledger` is public and unchanged (the ids are unguessable and the ledger holds only public data).

The relay-token route answers a plain 401 (no ledger) for a key that is revoked only through the sticky set. Only a key whose revocation is in the stored chain gets `key_revoked` with the chain as evidence.

## (d) Browser

Every browser trust decision uses `replica.trusted()`: the raw checkpoint, minus the sticky set, minus the local block.

**Server-sequenced writes.** A user-signed change is not put in the replica before the server accepts it. Flow: fresh read of the server (a server chain that extends the local one is adopted) -> agreement step (section h) -> passkey prompt -> the signed record is stored as the one pending write -> POST of local chain + record with `expectHead` -> the replica offers the chain the server answered through fork choice.

**The single pending write.** At most one signed change waits for the server. It is persisted with the replica, so a reload resumes it and every tab sees it. While it exists, other writes are refused with `write_pending` ("Finish saving the previous change first.").

| State | How it is reached | What the user sees |
|---|---|---|
| pending | signed, not yet accepted | A removal: "Removal not saved to the server yet. It can still connect. Retrying…" on its row, with "Retry now" and "Discard this change". An addition: "Adding a computer is not saved to the server yet. Retrying…" (likewise "Adding a browser…", "Adding a passkey…"), with "Discard this change". |
| delivered | the server's answer holds the record | the change appears in the account |
| dropped: `write_conflict` | the local chain moved past the head the record was signed on (another change landed first) | "Something else changed first. Confirm again." |
| dropped: `ledger_diverged` | a different history appeared | "This change was not saved: a different history of this account appeared." |
| dropped: definitive refusal (400, 403, 413, `ledger_rejected`, `ledger_limit`) | the server refused the record | "This change was not saved: the server refused it." |
| discarded | the owner pressed "Discard this change" | "The change was discarded. It was not saved to your account." |
| account missing | 404 `account_unknown` | "Your account was not found on the server, so this change cannot be saved. You can discard it." Not retried. |

A dropped or discarded record is kept in the replica's `discarded` list so the owner can sign it again. It is never re-signed or re-sent automatically. A persisted record is verified again (it must be an `ahead` extension of the current head) before it is sent. Discarding does a fresh read first: if the server already holds the record, nothing is withdrawn ("The server had already saved this change."). If the server received the record but the answer was lost, it can still apply it until another change is saved on top.

**Retry.** The same (local head, server head) pair is sent at most once per 30 s. After a failure the wait is 30 s, doubling to 10 min, each multiplied by 0.8 to 1.2. A `Retry-After` later than that wait wins (at most one hour). "Retry now" skips the pair window and the backoff, never a `Retry-After`. Every attempt starts with a fresh read. A POST for a bound account never goes out without `expectHead`; with no server state known it waits for the next read. Backoff and the timer are per tab. A write left pending when the browser signs out is held and sent after the next sign-in of the same account.

**The local block.** A removal the owner signed is enforced on this browser at once, before the server has it: from the pending write, and from a dropped or discarded removal until its entry is dismissed. The block is never part of the chain or the sticky set and is never sent. It lifts when the removal is in the raw chain or the owner dismisses the entry. A removal of this browser itself shows "This browser's removal was not saved" and "Keep this browser".

**Re-offer when the server is behind.** When a read or a POST answer shows the server's chain is a strict prefix of the local chain (or a different history that a local `resolve_fork` already discarded), the client POSTs its own chain with `expectHead`. It needs no passkey (the records are signed and public). One run at a time. It never runs while a divergence holds, and only when this browser's own keys are a trusted device of its chain, or its own chain revokes them (not when its own removal exists only in the sticky set). Delivering a pending write needs neither: any bound client may do it. A 404 stops it. After `head_changed` it re-evaluates once.

**The divergence state.** A valid different history learned from the server (read or 409), from a computer (`ledger_chain`) or from a relay push is kept, one per source. While one exists, nothing is POSTed and user writes are refused with `ledger_diverged` ("Two different histories of this account exist. Choose one before making changes."). The Security panel shows the two-histories screen (section g). An entry is removed when its source later serves a chain that is the same, ahead or behind, or when the local chain's own resolution already covers it. A relayed head or a shorter pushed chain never changes local state; it only causes a paced read.

A new browser's first `add_device` is sent with `expectHead` too. If another change landed first the answer is `write_conflict`.

## (e) Bridge

**Refusal.** `BridgeLedgerStore.offer` applies the same rule to a chain from the server or the relay. A valid diverged chain is refused: the stored chain, its checkpoint and every trust decision stay as they were. What is taken from it is the list of removals (`seen`, section f). One log line is printed per refused head:

```
[ledger] REFUSED a different account history from <server|relay> (head <8 chars>, revision N); keeping ours (head <8 chars>, revision M)
```

`; that history removes this computer` is appended when the refused history removes this bridge. Limits on the line: once per head (the last 16 heads per source are persisted, so it is not repeated after a restart) and at most once a minute per source. An invalid chain logs `[ledger] ignored an invalid chain from <server|relay>` at most once a minute per source. An owner-chosen adoption logs `[ledger] adopted an owner-chosen history: fork at revision N, discarded M of our records`.

**Status.** `GET /api/security/info` on the bridge's local API (127.0.0.1, port in `<data dir>/local-api-port`) gains, in account mode only:

```
ledger: {
  divergence: null | { source: 'server'|'relay', otherHead: <8 chars>, otherRevision, ourRevision, firstSeen (ms), forkRevision | null, removedOnOtherHistory },
  serverBehind: boolean,
  removedOnOtherHistory: boolean
}
```

The server's entry is shown in preference to the relay's. An entry is cleared when a later chain from the same source is the same, ahead or behind, and by any owner-chosen adoption. `serverBehind` is true while the last server chain the bridge evaluated is a strict prefix of its own chain (the bridge then re-offers).

**Own-removal evidence.** A bridge resets its identity (revoked restart) only on proof in its raw stored chain: an `add_bridge` with exactly its keys (bridgeId, endpoint id, endpoint public key, auth key) followed by a `revoke_bridge` of its bridgeId. That chain must have been adopted: it extended the stored chain, or it was an owner-chosen history. Never evidence:

- a tombstone (a `revoke_bridge` of an id the chain never added with these keys);
- a refused (diverged) history, which only sets `removedOnOtherHistory`;
- a sticky entry;
- a missing entry. A bridge the chain does not list fails closed (devices are refused) and is not reset.

The same rule runs at startup and while running.

**Re-offer.** When a server read shows the server behind (hourly relay-token answer, a relay notice that leads to a paced read, a resubscribe, an unknown-endpoint refresh), the bridge POSTs its own chain with `expectHead` set to the head it just read. Relay input never causes a POST by itself. Rules: a fresh read first; at most one POST per 30 s whatever the heads, and the same pair at most once per 30 s; failures wait 30 s doubling to 10 min with jitter, `Retry-After` honoured up to an hour; a 2xx after which the next read still shows the server behind counts as a failure; a 404 stops it for an hour or until a read finds the account. A bridge that is not an active member of its own chain sends nothing. The old blind POST after a plain 401 is gone: that 401 only starts the same checked attempt. Log lines: `[ledger] could not send our account history to the server (<reason>); retrying in N s`, `[ledger] the server does not know this account (404); this computer will not send its account history to it for an hour`, `[ledger] the server rejected our account history; retrying later`.

**Offline start and "do not reset".** If the server refuses a computer's key (a plain 401 or 403 on the first relay token, or on endpoint registration) and the computer is still an active member of its own chain, it does not exit and does not print the reset advice. It starts offline with the saved relay URL, prints the notice below once, and keeps retrying in the background:

```
[Bridge] The ftown server refused this computer's key, and this computer holds account history the server does not have: R removals and P passkeys among K changes after revision N.
[Bridge] Do NOT run --new-identity: this computer may hold the only copy. Open Security in the dashboard to choose a history.
[Bridge] Starting offline: local sessions keep working, and the relay is retried in the background.
```

(The first line reads "holds changes the server does not have" when the count is unknown.) With no saved relay URL it exits after printing `[Bridge] No relay URL was saved by an earlier start, so this computer cannot start offline. Run `ftown start` again later.` A computer whose stored chain does not list it still exits with "This computer is not in your account's ledger. Run `ftown start --new-identity` to pair it again."

**Ledger archive.** An identity reset (`--new-identity` or a signed revocation) no longer deletes the replica. `security/ledger.json` is renamed to `security/ledger.<ISO time with dashes>.archived.json` (mode 0600). The newest five archives are kept. Nothing in ftown reads an archive; it exists so a computer that held the only copy of a history is not wiped.

**File format.** `security/ledger.json` is version 3 (`ledger`, `checkpoint`, `sticky`, `lastServerReadAt`, `divergences`, `refused`). Versions 1 and 2 are still read and are rewritten as version 3 on the next change.

## (f) Removals seen on a refused history (`seen`)

Rule. When `chooseLedger` keeps a valid diverged candidate, it reports the device ids and bridge ids that the candidate revokes after the fork point, signed by an authority that already existed at the fork point (tombstones included). Every replica adds them to its sticky set after every `chooseLedger` call. This is local enforcement only. Nothing is appended to any chain and the chain and its checkpoint do not change. Records signed by an authority added only on the candidate's branch contribute nothing.

Why it is safe:

- `chooseLedger` has just verified those records on top of the shared prefix, so they are signed by real authorities.
- Authorities are add-only. Whoever signed such a removal could append it to the replica's own chain just as well, so the replica learns nothing it would not have to accept anyway.
- A resolution must carry every removal of the history it discards. Whichever side the owner keeps, the removal ends up in the final chain, so enforcing it early agrees with every state the two chains can converge to.
- It can only remove access. It never adds a member.

A consequence to know: a removal the owner signed and then lost (a lost race, "Discard this change") can later be shown by a server that kept it, and replicas then enforce it. That is a denial of access to one device, never an escalation. Section i.

Where each replica enforces it:

| Replica | Where |
|---|---|
| Server | sticky-only write on a 409 `diverged` (version-guarded, re-sealed, outside the account budget, idempotent). If the sticky set is full it logs `[ledger] account <8 chars> cannot enforce N removal(s) seen on a different history: sticky set full` once per process. A success logs `[ledger] account <8 chars> enforces N removal(s) seen on a different history`. The relay-token route and session checks use the sticky-applied checkpoint. |
| Browser | the replica merges `seen` into its sticky set after every offer. The id is then untrusted for bridge access. On the two-histories screen the record is marked "Removed on the other history". |
| Bridge | `ledger.json` sticky set (the bridge's own bridgeId is never added: status only). A refused browser is refused at once. If the sticky set is full: `[ledger] could not enforce the removals of a refused history: too many removals recorded on this computer`. |

## (g) Resolving a divergence

Payload. A `resolve_fork` operation is appended to the chosen chain and signed with a passkey (one prompt). It changes no membership.

```
{ type: 'resolve_fork', forkHead, discardedFirst, discardedHead, discardedRevision }
```

- `forkHead`: head of the last record both histories share.
- `discardedFirst`: head of the discarded branch's first record after the fork. It identifies the branch.
- `discardedHead`, `discardedRevision`: the tip of the other chain as the signer saw it.

Rules, as implemented. A candidate is adopted over a diverged local chain only if all of these hold.

1. The candidate is valid from the fork point: every record after it links (`revision`, `previousHead`), is not older than its predecessor, is not more than 30 s in the future, is signed by an authority of the state before it, has valid key material, and (for `add_authority`) carries the new passkey's consent.
2. The `resolve_fork` record names a `forkHead` that is a head of the chain before the record, and `discardedRevision` is after the fork's revision.
3. `discardedFirst` and `discardedHead` are not heads of the chain that carries the record, and neither equals `forkHead`, the record's own previous head or the accountId.
4. `discardedHead` equals `discardedFirst` exactly when the discarded branch is one record long (`discardedRevision` = fork revision + 1).
5. The signer was already an authority at the fork point. A passkey that exists only on one branch cannot discard the other.
6. The candidate already holds every removal (device or bridge) and every passkey that the local branch makes. Nothing security-relevant is discarded. The owner's flow guarantees this through the carry-over below; a resolution that lacks one is not adopted.
7. The candidate carries a `resolve_fork` whose `forkHead` is the real fork point and whose `discardedFirst` is the local branch's first record after it.
8. If the local branch itself holds any `resolve_fork`, the new one must hash over it: its `discardedRevision` is at or after the latest local one, and its `discardedHead` is the local branch's own record at that revision. A revision number alone is not accepted.
9. No record of the local branch is newer than the resolution: its `issuedAt` is at most the resolution's `issuedAt` + 30 s.

When all hold, the replica replaces its branch after the fork with the candidate's records, `choice.discarded.records` lists what was dropped, and the replica extends normally from there.

Carry-over (`resolutionPlan(chosen, other)`). Keeping a side first re-signs, on top of it, the security operations of the other side that it lacks, in the other branch's order:

- one `revoke_device` or `revoke_bridge` per id the other branch revoked and the chosen chain has not (an id that is not a member of the chosen chain becomes a tombstone, so it can never be added there);
- one `add_authority` per passkey the other branch added and the chosen chain lacks, with the original authority and the original consent, so no new passkey prompt is needed for consent.

Then the `resolve_fork`. `resolveForkTransition` throws `resolution_incomplete` while the plan still has operations to carry. Added browsers and computers are not carried: they are what a choice discards. A side cannot be kept if a carried record cannot be built on it (for example past the passkey limit: "This history cannot be kept: it would exceed the limit of passkeys.").

Tombstones. A `revoke_device` or `revoke_bridge` of an id that is not a member only records the id as revoked. Adding that id later fails with `ledger_revoked`. A device revocation that names a bridge's endpoint id is invalid.

What the screen shows. The Security panel replaces the normal controls with "Two different histories of this account exist":

- the sentence "They cannot both be kept. Review what each one contains and keep one. Nothing changes until you confirm." and "Other changes to your account are turned off until you choose one history.";
- who holds the other history: "The server holds the other history.", "One of your computers holds the other history." or "Another replica announced the other history.";
- "N earlier changes are identical.";
- two columns, "This browser's history" and "The other history", from the fork, each record as a sentence with date and time ("Added computer “Mac Studio”", "Removed browser “iPhone Safari”", "Added passkey “YubiKey”");
- under each column, what keeping it re-applies from the other side, and a warning "Will be discarded:" listing the other side's added browsers and computers (or "Nothing will be lost.");
- a note when the other history contains only records this browser signed and lost ("You signed this on <date>. It was not saved."), with the recommendation to keep this browser's history;
- "Removed on the other history" on a removal this browser already enforces;
- a "Keep this history" button under each column.

Confirmations. One passkey prompt per carried record plus one for the resolution: the screen says "You will confirm N times." (N = carried records + 1). All records are built in memory and sent in one POST with `expectHead`. A cancelled prompt sends nothing. If the POST fails (network, 5xx, 429) the signed bundle is kept and sent again by itself ("Your choice is signed but not saved to the server yet. Retrying…"). If the other side changed while the owner looked, the answer is `resolution_outdated` ("The other history changed. Review it again.") before any prompt. After success: "History kept. Other replicas will follow."

Opposite and cyclic resolutions. Rule 8 means each adoption moves to a resolution that hashes over the one already held. Hashes cannot form a cycle, so no replica adopts its way back to a chain it held. Two owners (or one owner on two devices) who choose opposite sides at the same time produce two chains that each discard the other. Each signer saw the other side before it was resolved, so neither resolution hashes over the other's (rule 8) and neither is adopted by a replica on the other side. The replicas stay diverged until the owner chooses again.

Laggards. A replica on the discarded branch that is shorter than `discardedHead`, or that extended the branch past it, still matches rule 7 (it matches `discardedFirst`), so it converges too. A replica whose branch holds records newer than the resolution (rule 9), or its own resolution that the signer did not see (rule 8), stays diverged. The owner resolves again.

The resolution is one adopted write for the server and counts against the account's write budget.

## (h) Agreement

Agreement runs between replicas that are online. Nothing here is proof of a chain: adoption is only ever through `chooseLedger` on a full chain.

**Bridge RPCs.** Both are read-only commands over the existing end-to-end encrypted channel (route `{ kind: 'command', command, requestId, sessionId: null }`). The server and relay cannot read or alter them. Only a browser listed in the bridge's trusted checkpoint with exactly its endpoint key, not revoked, may ask. Others get `permission_denied`.

| Command | Payload | Answer `data` |
|---|---|---|
| `ledger_head` | exactly `{ bridgeId }` | `{ accountId, head, revision }` |
| `ledger_chain` | `{ bridgeId, fromRevision?, limit? }` (`fromRevision` 0 to 1,024, default 0; `limit` 1 to 1,025, default 1,025) | `{ accountId, head, revision, fromRevision, records, more }` |

`records[i]` is the record at revision `fromRevision + i` (revision 0 is the signed genesis; revision n is `transitions[n-1]`), each as stored. A page holds at most `limit` records and at most 98,304 bytes of record JSON after its first record, always at least one record, and never splits one. Past the tip: `records: []`, `more: false`. If `head` or `revision` changes between pages the client starts again from 0. A malformed request gets `success: false`, `error: 'Invalid ledger request'`, `data: { code: 'invalid' }`.

**Head announcements.** Every member replica (browser tab or bridge) announces its head on `bridges:ledger#<accountId>` after it subscribes and after every change of its head, at most once per 5 s, coalesced to the latest head. Only an active member announces.

| Field | Rule |
|---|---|
| `type` | `'ledger_head'` |
| `version` | `1` |
| `accountId` | 43-character canonical base64url |
| `kind` | `'device'` or `'bridge'` |
| `keyId` | device: its endpoint id (43 characters). Bridge: its bridgeId (`[A-Za-z0-9_-]{1,200}`). |
| `head` | 43-character canonical base64url |
| `revision` | integer 0 to 1,024 |
| `at` | epoch ms, integer |
| `signature` | canonical base64url of 64 bytes: ECDSA P-256 / SHA-256, raw r\|\|s, low S |

Exactly these nine keys. The signature covers the UTF-8 bytes of `'ftown-head-announce-v1\n'` followed by the JSON of `{ accountId, at, head, keyId, kind, revision }` in that key order. It is made with the member's auth key (the same key and encoding as auth proofs).

Verification. A receiver parses strictly, drops its own announcements, and checks the announcement against its own trusted checkpoint (sticky applied): the accountId matches, the member is listed under that `kind` and `keyId` and is not revoked, `|now - at|` is at most 120 s, and the signature verifies with the member's auth key. One signature check per announcement. A replayed signature is not checked again. A browser queues at most 20 announcements; a bridge keeps only the newest pending ledger work. A valid announcement whose head is the receiver's own head or an ancestor is recorded only. An unknown head causes: for a bridge, one paced server read; for a browser, a paced server read if the announcer is a browser, or `ledger_head` then `ledger_chain` to the announcing computer. A bridge never POSTs because of an announcement. The server and the relay can withhold announcements but cannot forge them.

Pacing of fetches: one chain fetch per computer per 10 s; one comparison per computer per minute unless its announced head changed; an RPC is given up after 5 s; a chain fetch stops after 12 pages, 2.5 MiB or 3 s.

**`prepare` before signing.** Every user-signed change runs the agreement step after the fresh read and before the passkey prompt. It asks every computer that is in the trusted checkpoint and present on the relay for `ledger_head`, and considers announcements from the last 10 s, for at most 2 s in total.

- Nobody objected (agree, behind or silent): sign on the current head.
- A computer proved a longer valid chain (`ahead`): the browser adopts it, the re-offer brings the server forward, and the change is built on that head before the prompt. No extra prompt, because nothing was signed yet.
- A computer proved a valid different history: nothing is signed, and the two-histories screen appears (`ledger_diverged`). This is the only case that blocks.
- If the longer chain turns up only after signing (the server answers `head_changed`, or a late answer arrives): the signed record is dropped as `write_conflict` and the owner confirms again on the new head.

**On connect.** When the dashboard's relay connection is up and when a computer appears in presence, the browser runs the same head comparison once, with no pending write. A browser with no prior history therefore notices a rolled-back server as soon as one computer is online. Nothing runs before the signed-in dashboard attaches its connection, or while the browser is not a member of its own chain.

**`peers`.** The client snapshot carries `peers`: `{ head, confirmed, online, diverged }`. `confirmed` lists members that reported exactly the current head (`kind`, `id`, `at`), cleared when the head changes. `online` lists the bridgeIds of trusted computers present on the relay. `diverged` lists members whose head is neither the current one, an ancestor, nor an extension (`kind`, `id`, `head` as 8 characters, `revision`). It is informational. No screen displays it yet and nothing waits on it.

## (i) Threat analysis

What each party can and cannot do now. "Replica with history" means a browser or bridge that holds a chain of the account.

**Untrusted server.**
- Cannot: forge a record, add or remove a member, make a replica drop a record, make a replica adopt a shorter or different chain, rewrite what a replica holds, or force a replica to adopt a resolution that the owner did not sign.
- Can: withhold or delay chains, serve a stale prefix (replicas keep their longer chain and re-offer it), serve a valid different history if the owner's passkey ever signed one (replicas refuse it and show the two-histories screen), and refuse service. Until a client re-offers, the server itself authorizes sessions and relay tokens from whatever state it holds, including a rolled-back one. A rolled-back state can revive a key that was revoked later, on the server only.

**Relay.**
- Cannot: forge a head announcement (signed by a member key, checked against the receiver's own chain), alter encrypted RPC answers, or cause a bridge to POST.
- Can: withhold or replay announcements (a replay within 120 s only repeats a comparison), publish hints, and flood. Receivers throttle. A bridge does relay-triggered ledger work at least 1 s apart, doubling to 60 s while nothing changes. A browser queues at most 20 announcements. Any chain it publishes goes through `chooseLedger`.

**Another account.**
- Cannot: write to this account (it needs a chain that verifies against this account's passkeys), cause its replicas to adopt anything, or spend its write budget (only an adopted chain spends it). Replaying a public discarded branch can at most add removals the owner signed (section f).
- Can: read this account's ledger by id (public by design) and flood the shared relay (see the open items).

**Removed device.**
- Cannot: write the ledger (it has no passkey), have its announcements accepted (a revoked member is dropped), pass bridge checks (they use the trusted checkpoint), or get a relay token once the server stores the removal (a token already issued lives up to one hour).
- Can: read the public ledger, and hold an old copy.

**Database-only writer** (no `AUTH_SECRET`).
- Cannot: make the server authorize a key that no passkey-signed chain of the account lists, or make a replica with history follow a rolled-back chain.
- Can: roll an account back to any signed prefix of its own chain, with the sticky set edited to match (the heal re-seals that state), and write sticky ids to deny access to a device (the sticky set is not passkey-signed). The server moves forward again when any client offers a chain that extends the rolled-back one.

**Single compromised passkey.**
- Can: everything one authority could sign before: add devices and computers, remove the owner's devices and computers, add passkeys. A compromised passkey still cannot be removed (authorities are add-only).
- Cannot: rewrite history or erase a removal or a passkey. A resolution must carry them. An authority that exists only on one branch cannot discard the other.

**Residual risks.** Accepted for this release.

1. A replica with no history can bind to a rewound chain when no member computer is online. It binds to what it reads first and has nothing to compare. Once a computer is online, the on-connect comparison finds the difference.
2. A compromised authority can reopen a divergence by signing a resolution that discards non-security records (added browsers and computers) of the owner's branch. Removals and passkeys cannot be discarded.
3. `/pair` approval runs no agreement. That page has no relay connection, so the step before the passkey prompt does nothing there. The `add_bridge` is written on the server's head. Computers judge it when they receive it.
4. A late proof after the 2 s budget. A computer that answers after `prepare` returned is used afterwards. If it proves a longer chain after the passkey prompt, the signed change is dropped as `write_conflict` and the owner confirms again. One extra prompt, never a wrong write.
5. A lost race lets a hostile server manufacture a divergence. Two owner-signed records can exist on the same head (a change that lost a race and was dropped, and the one that won). A server that kept the dropped one can show it to some replicas. Both histories are real and signed by the owner, so the screen appears. It labels records this browser signed and dropped: "You signed this on <date>. It was not saved.", and when the other history holds only such records it recommends keeping this browser's history. The effect is a blocked Security panel until the owner chooses, and the removal-only effect of section f.
6. Relay publish is not yet subscriber-only. The `bridges` Centrifugo namespace allows client publishing (`allow_publish_for_client`), so any connection with a valid relay token can publish on any account's channels. Receivers drop publications whose publisher is not the account, so a foreign account can flood but not inject. This must be closed before registration is opened to strangers.

## (j) Compatibility

None. The server, the UI and the bridges move together. Bridges must be 0.22.0.

- A 0.21.0 bridge keeps the old tie-break, so it can adopt a branch the owner discarded. It cannot parse a chain that contains a `resolve_fork` and then ignores it as invalid. It still POSTs blindly after a plain 401, without `expectHead`. It has no `ledger_head` or `ledger_chain` and makes no announcements.
- Bridge `ledger.json` is version 3. 0.22.0 reads versions 1 and 2. 0.21.0 cannot read version 3 (see `docs/runbooks/append-only-ledger-cutover.md`).
- The browser's record is version 2 (adds `pending`, `divergence`, `blocked`). A version 1 record loads unchanged and is rewritten as version 2 on the next write.
- No database migration. A server rolled back to the old build cannot verify an account whose chain holds a `resolve_fork`.
- Reload open tabs after the deploy. A tab still running the old script keeps the old rules until it reloads.

Cut-over steps are in `docs/runbooks/append-only-ledger-cutover.md`. Operating a divergence is in `docs/runbooks/multi-account-operations.md` ("When two histories exist").
