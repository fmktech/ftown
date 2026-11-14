# Agent notes — chaos/

`chaos/` is ftown's deterministic chaos test type: a seed drives a fault schedule against a
real `ftown start --solo` bridge with scripted fake agents, inside a QEMU guest whose clock is
instruction-counted. Same seed, same commit, same guest image ⇒ byte-identical run.

## Rules for every task in this directory

1. **Never edit service code.** Nothing under `bridge/`, `ui/`, `e2e/`, `centrifugo/`, `docker/`,
   `scripts/` or `.github/` changes. Not even logging. The harness observes; it does not fix.
   A suspected bridge bug is written to `chaos/findings/` (or reported to the manager), not patched.
2. **The contract is frozen.** `chaos/src/contract.ts` is owned by the manager session. Implement
   against it. If it is wrong or missing something, stop and report; do not work around it.
3. **Own only your files.** Each task lists the files it owns. Create and edit only those.
4. **TypeScript, no dependencies.** Node 24 runs `.ts` directly. Erasable syntax only (no enums,
   namespaces, parameter properties). Relative imports end in `.ts`. Node built-ins only at
   runtime. Shell is fine for guest init and image build glue.
5. **Determinism.** Code that runs in the guest reads time only through the `Clock` it is given,
   and randomness only through `deriveRng`. No `Date.now()`, `Math.random()`, `setTimeout` with
   host meaning, or unordered iteration (sort object keys and directory listings) in anything
   that feeds the canonical log.
6. **Hermetic.** At run time the guest has no network. Nothing may need one. Image builds may
   use the network; every downloaded binary is pinned by version and sha256.
7. **No secrets, no local paths** in committed files. No names of the company or services the
   reference chaos skill came from; call it "the reference chaos skill" if it must be mentioned.
8. **Tests.** `cd chaos && npm test` (`node --test`), and `npm run typecheck`. Every property has
   a test that makes it fail and one that makes it pass. No stubs, no TODOs, no skipped tests.
9. **Git.** Commit locally on your task branch. Never push. Never squash.
10. **Flakes are bugs.** A test that passes on retry is a failure to root-cause, not to re-run.

## Reporting

Report to the parent with `ftown harness mail send --parent --type result "<text>"`: what
changed, files touched, the output of the gate commands, risks and anything you could not
verify. Use `--type escalation` when blocked. Keep your card current with `ftown status set`.
