# Deployment failure after PR 126

Task: investigate and repair the deployment CI failure reported by the user. Shared checkout: `/Users/fkesheh/projects/ftown-simplify-all`; branch `fix/centrifugo-deploy-routing`, base `c2814df1829a385b65f98b5d0e17dea91ef7a285`. Four existing unrelated investigation notes remain byte-identical and excluded from staging.

Evidence: [legacy AWS run 39961413221](https://github.com/fmktech/ftown/actions/runs/39961413221) stopped before SSH because `CENTRIFUGO_KNOWN_HOSTS` is empty. Config validation passed. The failure did not reach the v6 runtime guard or modify the remote host. The runbook contradicts this required pin with old optional/TOFU text.

Read-only live checks: `wss.ftown.ia.br` resolves to `66.241.125.206`, the assigned IPv4 of `ftown-centrifugo`, and answers with Fly headers. Fly app has one started Machine in `gru`; authenticated `centrifugo version` returned 5.4.9 (Go 1.23.4). The older alias `centrifugo.webcraw.ai` still resolves to the AWS IP; HTTPS and strict-host-key SSH both timed out from this Mac. A trusted matching host key already exists in local known_hosts, but no GitHub variable was created or security control weakened. Timeouts do not prove AWS is decommissioned.

Repository rollout instructions retain AWS as rollback and call for disabling its legacy workflow after a healthy Fly rollback window. Root asked whether AWS should still receive deployments or remain manual fallback. No production deploy, DNS change, secret mutation or server shutdown has occurred.

Native agents retain explicit gpt-6.1-sol/high selections. Canonical completed read-only topology investigation; npm implementation prepared the new branch as sole Git owner and stopped. Reviewer will independently check the bounded repair. Root alone executes CI/runtime verification and owns cleanup. No source write leases have been released while the routing decision is pending.

## Approved repair contract

Independent reviewer approved a reversible four-file PR. Treat the topology question as optional steering on this reviewable change, not authorization to alter live infrastructure. Make the legacy workflow manual with a default-false `deploy_legacy_aws` input and explicit deployment job gate. Keep strict host-key verification and >=6.10.2 runtime guard. Retain automatic secret-free validation by adding legacy template/workflow/script paths to the existing Fly validator triggers. Keep Fly deployment manual. Correct contradictory optional/TOFU documentation and distinguish unverified AWS availability from proven decommissioning. No DNS, secret, repository-variable or production-server changes.

Canonical owns the four exact files in the manifest; root owns these two coordination files. All six leases were mechanically checked for equal/ancestor overlap. Git operations remain solely with npm implementation. No dependencies, generated files, schema or app source changes. Validation: workflow syntax/expressions and independent source review; root-run real Fly/config validation with deploy=false, plus legacy default-false dry run verifying no deployment. Existing passing browser suite remains valid because application/dependency/config contents are unchanged. Workers do not execute CI/E2E or start servers.

## Implementation handoff

Canonical completed the four assigned files and stopped writing. AWS deployment requires workflow_dispatch, explicit boolean true, and refs/heads/main; its false default creates no deployment job. Fly changes only add legacy paths to its existing validation triggers. Both runbooks now require independently verified pins and document the manual fallback without claiming AWS retirement. Actionlint, YAML parsing and bounded routing/default/main assertions passed. No application, dependency, server, DNS, secret or runtime mutation occurred.

Final independent source review is pending. After approval the Git owner will commit/push only the six task files; root will dispatch Fly validation with deploy=false and the legacy workflow with deploy_legacy_aws=false on the repair branch. The latter must skip its deployment job before secret access. These are the focused runtime acceptance checks for this workflow-only change; the passing main application/browser checks remain applicable.
