import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiErrorCode, apiFailureMessage, instanceNameFor, isRetryableApiError, main, orchestrate, parseInstances, remoteEnvironment, remoteRunDir, resourcesFor, runKeyFor, validate } from "./agent37-runner.mjs";

const base = { job: "e2e", event: "pull_request", repository: "fmktech/ftown", headRepository: "fmktech/ftown", author: "alice", sender: "alice", actor: "alice", runId: "123", runAttempt: "1", key: "secret" };
test("routes internal, fork, each Dependabot identity, push and dispatch correctly", () => {
  assert.equal(validate(base), "agent37");
  assert.equal(validate({ ...base, headRepository: "other/ftown" }), "local");
  for (const field of ["author", "sender", "actor"]) assert.equal(validate({ ...base, [field]: "dependabot[bot]" }), "local");
  for (const event of ["push", "workflow_dispatch"]) assert.equal(validate({ ...base, event }), "agent37");
  assert.throws(() => validate({ ...base, event: "pull_request_target" }));
  assert.throws(() => validate({ ...base, author: "" }));
});
test("rejects malformed jobs, versions, SHAs, run identifiers and templates", () => {
  assert.throws(() => validate({ ...base, job: "echo x" }));
  assert.throws(() => validate({ ...base, job: "release-artifacts", npmVersion: "latest;echo" }));
  assert.throws(() => validate({ ...base, job: "bridge-version", baseSha: "a".repeat(40), headSha: "A".repeat(40) }));
  assert.throws(() => validate({ ...base, runId: "1;touch" }));
  assert.throws(() => validate({ ...base, template: "agent37-base" }), /Invalid Agent37 template/);
  assert.throws(() => validate({ ...base, template: "Bad_Name" }), /Invalid Agent37 template/);
});
test("an e2e shard is validated and forwarded; other jobs and malformed shards are refused", () => {
  assert.equal(validate({ ...base, shard: "2/3" }), "agent37");
  assert.deepEqual(remoteEnvironment({ ...base, shard: "2/3" }, "/home/node/ci/runs/x/repo"), ["CI=true", "GITHUB_WORKSPACE=/home/node/ci/runs/x/repo", "GITHUB_RUN_ID=123", "GITHUB_RUN_ATTEMPT=1", "E2E_SHARD=2/3"]);
  for (const shard of ["4/3", "0/3", "1/0", "1/10", "1", "1/3 --grep x", "1/3;id"]) assert.throws(() => validate({ ...base, shard }), /Invalid shard/);
  assert.throws(() => validate({ ...base, job: "gitleaks", shard: "1/3" }), /Invalid shard/);
});
test("remote environment is an explicit allowlist, with no key", () => {
  const i = { ...base, job: "bridge-version", baseSha: "a".repeat(40), headSha: "b".repeat(40) };
  assert.deepEqual(remoteEnvironment(i, "/w"), ["CI=true", "GITHUB_WORKSPACE=/w", "GITHUB_RUN_ID=123", "GITHUB_RUN_ATTEMPT=1", `BASE=${i.baseSha}`, `HEAD=${i.headSha}`]);
  assert(!remoteEnvironment(i, "/w").join(" ").includes(i.key));
});
test("instance sizes use valid platform combinations", () => {
  assert.deepEqual(resourcesFor("e2e"), { cpu: 4, memory: 16, disk: 40 });
  assert.deepEqual(resourcesFor("centrifugo"), { cpu: 2, memory: 4, disk: 12 });
});
test("one long-lived instance serves each job kind and e2e shard, with a per-run directory", () => {
  assert.equal(instanceNameFor({ job: "e2e", shard: "2/3" }), "ftown-ci-e2e-2");
  assert.equal(instanceNameFor({ job: "e2e" }), "ftown-ci-e2e-1");
  assert.equal(instanceNameFor({ job: "centrifugo" }), "ftown-ci-unit");
  assert.equal(instanceNameFor({ job: "gitleaks" }), "ftown-ci-unit");
  assert.equal(runKeyFor({ job: "e2e", runId: "123", runAttempt: "1", shard: "2/3" }), "e2e-123-1-2-of-3");
  assert.equal(remoteRunDir({ job: "e2e", runId: "123", runAttempt: "1", shard: "2/3" }), "ci/runs/e2e-123-1-2-of-3");
});
test("only wake races are retryable; exec-style 502/504 are not", () => {
  assert.equal(isRetryableApiError(409, "try_again"), true);
  assert.equal(isRetryableApiError(503, "try_again"), true);
  assert.equal(isRetryableApiError(503, "wake_failed"), true);
  assert.equal(isRetryableApiError(503, "wake_timeout"), true);
  assert.equal(isRetryableApiError(502, "try_again"), false);
  assert.equal(isRetryableApiError(504, "try_again"), false);
  assert.equal(isRetryableApiError(409, "instance_limit_reached"), false);
  assert.equal(apiErrorCode('{"error":{"code":"try_again","message":"later"}}'), "try_again");
  assert.equal(apiErrorCode('{"error":"capacity_unavailable"}'), "capacity_unavailable");
  assert.equal(apiErrorCode('{"message":"boom"}'), "boom");
  assert.equal(apiErrorCode("not json"), "unknown");
});
test("API failure messages are actionable and carry the instance id", () => {
  assert.match(apiFailureMessage("start instance", { status: 402, code: "insufficient_balance", instanceId: "inst_1" }), /instance inst_1/);
  assert.match(apiFailureMessage("start instance", { status: 402, code: "insufficient_balance", instanceId: "inst_1" }), /Top up/);
  assert.match(apiFailureMessage("create instance", { status: 409, code: "instance_limit_reached" }), /instance limit/);
  assert.match(apiFailureMessage("create instance", { status: 404, code: "template_not_found", template: "ftown-ci" }), /a37 image build scripts\/ci\/agent37\/Dockerfile ftown-ci/);
  assert.match(apiFailureMessage("get instance", { status: 500, code: "boom", instanceId: "inst_9" }), /instance inst_9/);
});
test("instance lists accept the documented envelope shapes", () => {
  assert.deepEqual(parseInstances('[{"id":"a","name":"n"}]').map(i => i.id), ["a"]);
  assert.deepEqual(parseInstances('{"instances":[{"id":"b"}]}').map(i => i.id), ["b"]);
  assert.deepEqual(parseInstances('{"data":[{"id":"c"}]}').map(i => i.id), ["c"]);
  assert.throws(() => parseInstances('{"nope":1}'));
});
function fixture(overrides = {}) {
  const calls = [];
  const io = {
    warning: message => calls.push(["warning", message]),
    recordId: id => calls.push(["record", id]),
    local: async () => { calls.push(["local"]); },
    prepare: async i => { calls.push(["prepare"]); i.revision = "a".repeat(40); },
    ensure: async (_i, cb) => { calls.push(["ensure"]); cb("inst_abc123"); },
    upload: async (id, i) => { calls.push(["upload", id, i.revision]); },
    execute: async id => { calls.push(["execute", id]); return 0; },
    artifacts: async id => { calls.push(["artifacts", id]); },
    cleanup: async id => { calls.push(["cleanup", id]); },
    ...overrides,
  };
  return { io, calls };
}
test("fork fallback does not prepare or touch an instance", async () => {
  const { io, calls } = fixture();
  await orchestrate({ ...base, headRepository: "fork/ftown" }, io);
  assert.deepEqual(calls, [["local"]]);
});
test("trusted runs require the Agent37 key and clean up the run directory after the exact revision upload", async () => {
  const { io, calls } = fixture();
  await assert.rejects(orchestrate({ ...base, key: "" }, io), /AGENT37_API_KEY/);
  await orchestrate({ ...base }, io);
  assert.deepEqual(calls, [["prepare"], ["ensure"], ["record", "inst_abc123"], ["upload", "inst_abc123", "a".repeat(40)], ["execute", "inst_abc123"], ["artifacts", "inst_abc123"], ["cleanup", "inst_abc123"]]);
});
test("ensure failure after the ID is known still cleans up", async () => {
  const { io, calls } = fixture({ ensure: async (_i, cb) => { cb("inst_abc123"); throw new Error("wake failed"); } });
  await assert.rejects(orchestrate({ ...base }, io), /wake failed/);
  assert.deepEqual(calls.at(-1), ["cleanup", "inst_abc123"]);
});
test("rejects a malformed instance ID before cleanup and never targets another instance", async () => {
  const { io, calls } = fixture({ ensure: async (_i, cb) => cb("../../bad") });
  await assert.rejects(orchestrate({ ...base }, io), /Invalid instance ID/);
  assert(!calls.some(c => c[0] === "cleanup"));
});
test("preserves remote failure despite artifact error and cleans up", async () => {
  const { io, calls } = fixture({ execute: async () => 42, artifacts: async () => { throw new Error("transfer"); } });
  await assert.rejects(orchestrate({ ...base }, io), e => e.exitCode === 42);
  assert(calls.some(c => c[0] === "warning"));
  assert.deepEqual(calls.at(-1), ["cleanup", "inst_abc123"]);
});
test("artifact and cleanup failure fail successful jobs", async () => {
  let f = fixture({ artifacts: async () => { throw new Error("transfer"); } });
  await assert.rejects(orchestrate({ ...base }, f.io), /transfer/);
  assert.deepEqual(f.calls.at(-1), ["cleanup", "inst_abc123"]);
  f = fixture({ cleanup: async () => { throw new Error("delete"); } });
  await assert.rejects(orchestrate({ ...base }, f.io), /delete/);
});

// Drives the real main() against a fake Agent37 API (local HTTP server) and fake
// ssh/scp binaries, so the actual HTTP, wake, upload, lock and cleanup code runs.
async function apiRun({ instances = [], startFailures = 0, execExit = 0, job = "centrifugo", shard, key = "test-key-123", sshRequiresKeyInstall = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent37-runner-test-")));
  const bin = join(dir, "bin"); mkdirSync(bin);
  const state = { instances: instances.map(i => ({ ...i })), requests: [], starts: 0, creates: 0, deletes: 0, execs: 0 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      state.requests.push(`${req.method} ${req.url} auth=${req.headers.authorization === `Bearer ${key}` ? "ok" : "bad"}`);
      const send = (status, value) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
      const parsed = body ? JSON.parse(body) : {};
      if (req.method === "GET" && req.url === "/v1/instances") return send(200, { instances: state.instances });
      if (req.method === "POST" && req.url === "/v1/instances") {
        state.creates++;
        const created = { id: "inst-created-1", name: parsed.name, template: parsed.template, status: "sleeping" };
        state.instances.push(created);
        return send(201, created);
      }
      if (req.method === "POST" && req.url === "/v1/ssh-keys") return send(200, {});
      const start = /^\/v1\/instances\/([^/]+)\/start$/.exec(req.url || "");
      if (req.method === "POST" && start) {
        state.starts++;
        if (state.starts <= startFailures) return send(503, { error: { code: "try_again", message: "waking" } });
        const found = state.instances.find(i => i.id === start[1]);
        if (found) found.status = "running";
        return send(200, found || {});
      }
      const exec = /^\/v1\/instances\/([^/]+)\/exec$/.exec(req.url || "");
      if (req.method === "POST" && exec) {
        state.execs++;
        if (typeof parsed.command === "string" && parsed.command.includes("authorized_keys")) writeFileSync(join(dir, "key-installed"), "1");
        return send(200, { stdout: "", stderr: "" });
      }
      const get = /^\/v1\/instances\/([^/]+)$/.exec(req.url || "");
      if (req.method === "GET" && get) {
        const found = state.instances.find(i => i.id === get[1]);
        return found ? send(200, found) : send(404, { error: { code: "not_found" } });
      }
      if (req.method === "DELETE") { state.deletes++; return send(200, {}); }
      return send(404, { error: { code: "not_found" } });
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(dir, "exec-exit"), `${execExit}\n`);
  if (sshRequiresKeyInstall) writeFileSync(join(dir, "ssh-mode"), "1\n");
  const ssh = `#!/bin/sh
echo "$@" >> "${dir}/ssh-calls"
if [ -f "${dir}/ssh-mode" ] && [ ! -f "${dir}/key-installed" ]; then exit 255; fi
case "$*" in
  *" rm -rf "*) echo clean >> "${dir}/cleanup-count"; exit 0 ;;
  *" node "*) echo '[]'; exit 0 ;;
  *run-job.sh*) echo "remote job output"; exit "$(cat "${dir}/exec-exit")" ;;
  *) exit 0 ;;
esac
`;
  writeFileSync(join(bin, "ssh"), ssh);
  writeFileSync(join(bin, "scp"), `#!/bin/sh\necho "$@" >> "${dir}/scp-calls"\nexit 0\n`);
  chmodSync(join(bin, "ssh"), 0o755);
  chmodSync(join(bin, "scp"), 0o755);
  const repo = join(dir, "repo"); mkdirSync(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore", env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "CI Test", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "CI Test", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
  writeFileSync(join(repo, "f"), "x\n"); git("init"); git("add", "f"); git("commit", "-m", "init");
  const previousPath = process.env.PATH, previousCwd = process.cwd(), previousLog = console.log, previousError = console.error;
  const logged = [];
  process.chdir(repo);
  process.env.PATH = `${bin}:${previousPath}`;
  console.log = (...args) => logged.push(args.join(" "));
  console.error = (...args) => logged.push(args.join(" "));
  const env = { INPUT_JOB: job, ...(shard ? { INPUT_SHARD: shard } : {}), CI_EVENT: "push", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", AGENT37_API_KEY: key, A37_API_URL: url, A37_SANDBOX_URL: url, A37_TUNNEL: "/usr/bin/false" };
  let error;
  try { await main({ env, retryDelaysMs: [1, 1], pollIntervalMs: 1 }); } catch (e) { error = e; }
  finally { process.chdir(previousCwd); process.env.PATH = previousPath; console.log = previousLog; console.error = previousError; }
  const read = name => existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "";
  const result = { error, logged, state, sshCalls: read("ssh-calls"), scpCalls: read("scp-calls"), cleanups: read("cleanup-count").trim() ? read("cleanup-count").trim().split("\n").length : 0 };
  await new Promise(resolve => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
  return result;
}
test("main reuses a sleeping instance, runs the job under its lock, and only cleans the run directory", async () => {
  const r = await apiRun({ instances: [{ id: "inst-unit-1", name: "ftown-ci-unit", status: "sleeping" }] });
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.state.creates, 0);
  assert.equal(r.state.starts, 1);
  assert.equal(r.state.deletes, 0);
  assert.match(r.sshCalls, /flock/);
  assert.match(r.sshCalls, /ftown-ci-unit\.lock/);
  assert.match(r.sshCalls, /run-job\.sh centrifugo/);
  assert.equal(r.cleanups, 1);
  assert(r.state.requests.every(line => line.includes("auth=ok")));
  assert(r.logged.every(line => !line.includes("test-key-123")), "API key must never be logged");
});
test("main creates the per-kind instance once with auto-sleep when none exists", async () => {
  const r = await apiRun();
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.state.creates, 1);
  const create = r.state.requests.find(line => line.startsWith("POST /v1/instances "));
  assert(create);
  assert.equal(r.state.deletes, 0);
  assert.equal(r.cleanups, 1);
});
test("main retries a try_again wake and propagates the remote exit code, cleaning up either way", async () => {
  const ok = await apiRun({ instances: [{ id: "inst-unit-1", name: "ftown-ci-unit", status: "sleeping" }], startFailures: 1 });
  assert.equal(ok.error, undefined, ok.error?.message);
  assert.equal(ok.state.starts, 2);
  const failed = await apiRun({ instances: [{ id: "inst-unit-1", name: "ftown-ci-unit", status: "sleeping" }], execExit: 42 });
  assert.equal(failed.error.exitCode, 42);
  assert.equal(failed.cleanups, 1);
  assert.equal(failed.state.deletes, 0);
});
test("main succeeds for e2e with an empty artifact set", async () => {
  const r = await apiRun({ instances: [{ id: "inst-e2e-1", name: "ftown-ci-e2e-1", status: "running" }], job: "e2e", shard: "1/3" });
  assert.equal(r.error, undefined, r.error?.message);
  assert.match(r.sshCalls, /E2E_SHARD=1\/3/);
  assert.equal(r.cleanups, 1);
});
test("main installs its key through the exec API when the template injects none", async () => {
  const r = await apiRun({ instances: [{ id: "inst-unit-1", name: "ftown-ci-unit", status: "running" }], sshRequiresKeyInstall: true });
  assert.equal(r.error, undefined, r.error?.message);
  assert(r.state.execs >= 1, "expected an exec-API key install");
  assert.equal(r.cleanups, 1);
});
test("main without a key fails before any API call with the secret action", async () => {
  const r = await apiRun({ key: "" });
  // An empty key reaches orchestrate, which must refuse before contacting the API.
  assert.match(r.error.message, /AGENT37_API_KEY is required/);
  assert.match(r.error.message, /CI_RUNNER=boat/);
});
