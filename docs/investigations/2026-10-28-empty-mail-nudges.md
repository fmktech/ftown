---
type: investigation
symptom: 'Generic new-mail nudge followed by ftown harness mail read returning (no mail), reportedly frequent'
slug: empty-mail-nudges
date: 2026-10-28T13:35:44-03:00
git_commit: 678c716123e3b799273428cab50c11d5993553e5
branch: feat/bridge-update-flow
status: root-cause-proven
hypotheses_formed: 3
hypotheses_rejected: 1
hypotheses_proven: 1
---

# Empty mail after a nudge

## Symptom and limits

Reported by root from the user's screenshot: a generic new-mail nudge followed by `ftown harness mail read` → `(no mail)`, reportedly frequent. Expected: an agent should receive unread mail once and a pointer should not confidently require another read when its associated mail was already consumed. An empty second read is not by itself evidence of lost mail. The screenshot's machine, actual FTown/native session IDs, adapter, inbox state and preceding hook events are unknown; no conclusion below attributes that screenshot to this Mac or a specific adapter.

## Deterministic reproduction: current Claude Mod pending wake

Read-only, inert exercise of the actual current `bridge/claude-mod/hooks/register.js` with a mocked loopback heartbeat and `$.prompt.submit` that stays pending, modeling the documented wait for idle. No native/provider subprocess, real bridge, real session, mail body, file or external request is used. From `bridge/`, with Node 24.22.1:

```sh
node --input-type=module <<'JS'
import { register } from './claude-mod/hooks/register.js';
async function run(initial) {
  const hooks = {}; register((name, fn) => { hooks[name] = fn; });
  let tick, unread = initial ? ['m1'] : [], queued = [], release;
  const pending = new Promise(ok => { release = ok; });
  const env = { FTOWN_SESSION_ID:'session1', FTOWN_HOOK_PORT:'1234', FTOWN_HOOK_TOKEN:'inert', HOME:'/inert' };
  const api = {
    env:{get:async k=>env[k]}, session:{id:async()=> 'native1'},
    clock:{every:(_ms,cb)=>{tick=cb},now:async()=>0}, fs:{read:async()=> '{}'},
    http:{fetch:async()=>({ok:true,text:JSON.stringify({messages:unread.map(id=>({id}))})})},
    prompt:{submit:async ({text})=>{queued.push(text);return pending;}}
  };
  await hooks['session.start'](api, {}, async e=>e);
  await tick(); await Promise.resolve(); await Promise.resolve();
  const before=queued.length; unread=[]; await tick();
  if (before) release({text:queued[0]});
  await new Promise(ok=>setImmediate(ok));
  return {initialUnread:initial,queuedBeforeDrain:before,unreadAfterDrain:unread.length,queuedAfterDrain:queued.length};
}
console.log(JSON.stringify(await run(true)));
console.log(JSON.stringify(await run(false)));
JS
```

Observed:

```json
{"initialUnread":true,"queuedBeforeDrain":1,"unreadAfterDrain":0,"queuedAfterDrain":1}
{"initialUnread":false,"queuedBeforeDrain":0,"unreadAfterDrain":0,"queuedAfterDrain":0}
```

The first wake contains `ftown harness mail read` (separate run returned `genericReadInstruction:true`). The mock changes the heartbeat response to represent another consumer's drain; it does **not** execute the real native prompt, real mail store or CLI. This proves the submitted/pending adapter behavior under that controlled interleaving, not frequency or actual occurrence in the screenshot. Source and prior runtime evidence establish why the modeled interleaving is plausible; a root-owned real native test is needed before claiming a user-session reproduction.

## Hypotheses and evidence

### H1 — old installed bridge causes the particular screenshot

- **Layer:** configuration/version.
- **Prediction:** the relevant session runs pre-#149 bridge code that can queue a Codex native wake while busy and uses the original mandatory-read text.
- **Verification:** read only this Mac's installed package metadata and compiled nudge code; compare to `ce62d9d` (#149), root-provided live bridge process start, and existing controlled historical regression.
- **Evidence:** installed metadata is `{ "name": "ftown", "version": "0.19.55" }`; installed `~/.ftown/cli/dist/mail-delivery.js:18` contains `You have new ftown mail — run ...`; its native dispatch is lines 428–452, before busy guard at 470–473. Root verified PID 86247 started 2026-10-26T14:53:29.499Z. #149 dated 2026-10-28 changed guard order and wording; previous investigation `2026-10-27-stale-mail-notification.md:58–60` records old-code deterministic 2-fail/1-pass busy-queue regression. Current `node --import tsx --test --test-name-pattern='busy native wake regression' src/mail-delivery.test.ts` passes 3/3, including the unread/fresh-batch controls (`mail-delivery.test.ts:772–825`).
- **Verdict:** INCONCLUSIVE for the screenshot. Version skew and the old code's vulnerability are demonstrated on this Mac, but the screenshot is not linked to this machine, process, Codex or exact schedule. A setup/restart to a fixed published release is a reasonable operational remedy only after confirming the affected machine/runtime; it cannot be claimed as a complete diagnosis or done without the owning coordinator.

### H2 — current Claude Mod retains a queued pointer after its inbox is consumed

- **Layer:** state/concurrency and native adapter.
- **Prediction:** if an unread-ID poll calls a pending `$.prompt.submit`, and another consumer drains that ID before submit resolves, the adapter cannot retract that already-submitted text and it still instructs a read.
- **Verification:** reproduction above and direct source inspection. `bridge/claude-mod/hooks/register.js:91–113` polls opaque unread IDs, checks freshness/pending/generation, then calls `$.prompt.submit({ text: WAKE })`; comments explicitly state submit waits for idle. Later polls prune `handled` (`:91–94`) but never cancel `pending` or update the queued prompt. `:3` instructs a read unconditionally. This Mac's installed `~/.ftown/claude-plugin/hooks/register.js` and current source share SHA-256 `58117a4c419b2f69ae30df51d5ba290e97800a9b5e7ce61f8eff809a9dba963f`; this proves matching assets on disk, not that any screenshot session loaded them.
- **Evidence:** reproduction above returns one pending wake after unread becomes zero; absent-initial-mail control returns zero wakes. `bridge/src/harness-commands.ts:493–539` shows Stop/UserPromptSubmit/SessionStart pump can non-peek `fetchInbox` and inject actual `[ftown mail]` context. `bridge/src/mail-delivery.ts:346–380` calls `markDelivered` for non-peek reads; `bridge/src/mail-store.ts:86–89,99–120` filters delivered records and only marks previously unread IDs. A later same-session CLI read therefore legitimately returns no unread messages (`harness-commands.ts:416–438`).
- **Verdict:** PROVEN for the controlled adapter schedule, not proven for the user's screenshot or real prompt cancellation capabilities. #149 affects Codex/Muse service scheduling and text; it does not change Claude Mod's `WAKE` or queued-submit behavior. Accepted Codex queues also have a documented post-admission race: `native-mail.ts:122–130` checks before `codex queue`, while `stale-mail-repair-review.md` residual-limits section states admitted native prompts cannot be cancelled through that interface.

### H3 — wrong session identity is required for an empty read

- **Layer:** integration/identity.
- **Prediction:** a nudge followed by empty mail can occur only when wake and read use different FTown session identities.
- **Verification/evidence:** H2's controlled model uses one unchanged `FTOWN_SESSION_ID`/native ID and produces the stale pending wake after the same mocked inbox changes to empty. The established prior Codex regression uses one `session.id`, reads that same inbox once, and observes the queued wake (`mail-delivery.test.ts:773–788`; historical old-version result in `2026-10-27-stale-mail-notification.md:58–60`).
- **Verdict:** REJECTED as a necessary cause of the reproduced schedules, not ruled out for the unknown screenshot. `harness-commands.ts:366–369` chooses `FTOWN_SESSION_ID` before workspace registry fallback; the hook pump chooses that same env first, then conversation-ID lookup (`:470–487`). Different environment, workspace or bridge pointer remains an untested screenshot-specific alternative. The Claude Mod registration includes both IDs and bridge validation checks them (`mail-delivery.ts:214–226`).

## 5 Whys — controlled current adapter schedule

1. A generic wake can lead to an empty subsequent read because the associated unread ID was consumed before the pending prompt executes.
2. The adapter submits a pointer based on a heartbeat snapshot, and `$.prompt.submit` can wait for idle while another reader or hook consumes the ID.
3. The heartbeat and consuming read are independent operations; later heartbeat results update local seen state but do not retract a pending submit.
4. The submitted text assumes unread mail still exists and always says to run a read, rather than accounting for hook-supplied mail or a competing consumer.
5. The contract deliberately makes the durable inbox the consumption authority and wake a separate pointer (`docs/investigations/native-mail-delivery/contract.md:25`); it does not establish an atomic inbox/LLM prompt transaction or a supported cancellation interface. Thus already-admitted wake delivery can race consumption. Whether the native API offers a safe cancellable or pre-idle mechanism beyond the used interface remains unproven.

## Falsification and rejected alternatives

The absent-initial-mail control produced no wake, so an unconditional adapter timer is not necessary. One-session reproduction and the earlier busy-Codex unit test reject wrong identity as necessary. Current Codex busy-regression 3/3 shows #149 fixes that specific known-busy schedule, but does not falsify an independently queued Claude Mod pointer; the #149 diff did not modify this Mod. An independently accepted wake can still become stale after its final check. None of these experiments identifies the screenshot's adapter or proves actual wake cancellation is available.

## Proposed bounded next step (not implemented)

Confirm the affected machine, adapter/session generation, installed and running bridge versions without consuming live inboxes or exposing bodies/tokens; ask root to own any observation or runtime work. For the proven Claude Mod path, an independently reviewed minimal mitigation scope is `bridge/claude-mod/hooks/register.js` and `bridge/src/claude-mod.test.ts`: use a hook-aware, conditional pointer like the reviewed Codex wording (process supplied `[ftown mail]` context without rereading; otherwise read once; an empty result needs no action), and extend the existing pending-submit test to cover a heartbeat becoming empty and a fresh later unread ID. This does **not** cancel an already submitted prompt or guarantee zero stale wake turns; it avoids asserting an unread message and unnecessary rereads when the hook supplied it. Verify any stronger idle detection/cancellation against actual native API before promising it; preserve unknown-admission suppression, identity fencing, leases, unread liveness, and no body exposure. `bridge/opencode-plugin/ftown.js:66,144–177` also uses mandatory-read text and a separate poll→prompt boundary; investigate/test it independently before broadening fixes. An upgrade to a release containing #149 addresses its demonstrated old Codex busy dispatch but does not eliminate these post-admission or other-adapter limits. Hook and CLI same-inbox reads can legitimately return empty after the first consumer; do not hide empty output or consume/replay messages to make the symptom disappear.

Sole report lease released. No live mail consumption, session messages, setup, bridge restart, services, browser, E2E, Git mutation, dependency installation or application/test edits were performed. Checks: current Codex busy regression 3/3 and the inert actual-Mod experiment/control above.
