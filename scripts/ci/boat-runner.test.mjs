import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactInspectionSource, createPrivateControllerDir, historyRestoreScript, main, orchestrate, parseArtifactInspection, parseExecFrame, parseExecResult, remoteEnvironment, validate } from "./boat-runner.mjs";

const base = { job: "e2e", event: "pull_request", repository: "fmktech/ftown", headRepository: "fmktech/ftown", author: "alice", sender: "alice", actor: "alice", runId: "123", runAttempt: "1", key: "secret" };
test("short private controller directory supports Boat's SSH socket with a long runner temp", async () => {
  const previousRunnerTemp = process.env.RUNNER_TEMP, previousTmpdir = process.env.TMPDIR;
  const suffix = "a_97b_dcd9002d_52ae87477d0b6aa10199481bfcde2ebd07546944.kQurjyh3s0jF5TmJ";
  process.env.RUNNER_TEMP = "/home/runner/work/_temp/ftown-boat-ci-XXXXXX";
  process.env.TMPDIR = process.env.RUNNER_TEMP;
  let dir, server;
  try {
    assert(Buffer.byteLength(join(process.env.RUNNER_TEMP, ".ssh", suffix)) > 108);
    dir = await createPrivateControllerDir();
    assert.match(dir, /^\/tmp\/fci-[^/]+$/);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    mkdirSync(join(dir, ".ssh"), { mode: 0o700 });
    const socket = join(dir, ".ssh", suffix);
    assert(Buffer.byteLength(socket) < 104);
    server = createServer();
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    assert(statSync(socket).isSocket());
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server = undefined;
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP; else process.env.RUNNER_TEMP = previousRunnerTemp;
    if (previousTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmpdir;
  }
});
test("bundle restoration preserves remote-only history and verifies revision objects", () => {
  const temp = mkdtempSync(join(tmpdir(), "boat-history-test-"));
  const env = { PATH: process.env.PATH, HOME: temp, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "init.defaultBranch", GIT_CONFIG_VALUE_0: "main", GIT_AUTHOR_NAME: "CI Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "CI Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
  const run = (cwd, command, args, input) => execFileSync(command, args, { cwd, env, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }).trim();
  try {
    const src = join(temp, "source"); mkdirSync(src);
    run(src, "git", ["init", "-b", "main"]);
    writeFileSync(join(src, "tracked"), "base\n");
    run(src, "git", ["add", "tracked"]);
    run(src, "git", ["commit", "-m", "base"]);
    const revision = run(src, "git", ["rev-parse", "HEAD"]);
    const tree = run(src, "git", ["rev-parse", "HEAD^{tree}"]);
    const remoteOnly = run(src, "git", ["commit-tree", tree, "-p", revision], "remote-only\n");
    run(src, "git", ["update-ref", "refs/remotes/origin/unmerged", remoteOnly]);
    run(src, "git", ["bundle", "create", join(temp, "history.bundle"), "--all", "HEAD"]);
    run(temp, "bash", ["-c", historyRestoreScript(revision, revision, remoteOnly)]);
    const restored = join(temp, "repo");
    assert.equal(run(restored, "git", ["rev-parse", "HEAD"]), revision);
    assert.equal(run(restored, "git", ["rev-parse", "refs/remotes/origin/unmerged"]), remoteOnly);
    assert(run(restored, "git", ["rev-list", "--all"]).split("\n").includes(remoteOnly));
    assert.equal(run(restored, "git", ["remote"]), "");
    assert.throws(() => historyRestoreScript("not-a-sha"));
    rmSync(restored, { recursive: true, force: true });
    assert.throws(() => run(temp, "bash", ["-c", historyRestoreScript(revision, revision, "a".repeat(40))]));
    assert.equal(run(restored, "git", ["rev-parse", "HEAD"]), revision);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
test("remote artifact inspection accepts regular entries and rejects links and special files", () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "boat-artifacts-test-")));
  const root = join(temp, "e2e");
  const inspect = (dir = root) => parseArtifactInspection(execFileSync(process.execPath, ["-", dir], { input: artifactInspectionSource, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }));
  try {
    mkdirSync(root); mkdirSync(join(root, "playwright-report"));
    writeFileSync(join(root, "playwright-report", "index.html"), "report");
    writeFileSync(join(root, "ui.log"), "log");
    assert.deepEqual(inspect(), ["playwright-report", "ui.log"]);
    symlinkSync(root, join(temp, "linked-root"));
    assert.throws(() => inspect(join(temp, "linked-root")));
    symlinkSync(join(temp, "outside"), join(root, "playwright-report", "link"));
    assert.throws(inspect);
    rmSync(join(root, "playwright-report", "link"));
    symlinkSync(join(temp, "outside"), join(root, "bridge.log"));
    assert.throws(inspect);
    rmSync(join(root, "bridge.log"));
    execFileSync("mkfifo", [join(root, "playwright-report", "pipe")]);
    assert.throws(inspect);
    assert.throws(() => parseArtifactInspection('["../outside"]'));
    assert.throws(() => parseArtifactInspection('["ui.log","ui.log"]'));
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
function fixture(overrides = {}) {
  const calls = [];
  const io = {
    warning: message => calls.push(["warning", message]),
    recordId: id => calls.push(["record", id]),
    local: async () => { calls.push(["local"]); },
    prepare: async i => { calls.push(["prepare"]); i.revision = "a".repeat(40); },
    create: async (_i, cb) => { calls.push(["create"]); cb("bx_abc123"); },
    upload: async (id, i) => { calls.push(["upload", id, i.revision]); },
    execute: async id => { calls.push(["execute", id]); return 0; },
    artifacts: async id => { calls.push(["artifacts", id]); },
    cleanup: async id => { calls.push(["cleanup", id]); },
    ...overrides,
  };
  return { io, calls };
}
test("routes internal, fork, each Dependabot identity, push and dispatch correctly", () => {
  assert.equal(validate(base), "boat");
  assert.equal(validate({ ...base, headRepository: "other/ftown" }), "local");
  for (const field of ["author", "sender", "actor"]) assert.equal(validate({ ...base, [field]: "dependabot[bot]" }), "local");
  for (const event of ["push", "workflow_dispatch"]) assert.equal(validate({ ...base, event }), "boat");
  assert.throws(() => validate({ ...base, event: "pull_request_target" }));
  assert.throws(() => validate({ ...base, author: "" }));
});
test("rejects malformed jobs, versions, SHAs and run identifiers", () => {
  assert.throws(() => validate({ ...base, job: "echo x" }));
  assert.throws(() => validate({ ...base, job: "release-artifacts", npmVersion: "latest;echo" }));
  assert.throws(() => validate({ ...base, job: "bridge-version", baseSha: "a".repeat(40), headSha: "A".repeat(40) }));
  assert.throws(() => validate({ ...base, runId: "1;touch" }));
});
test("remote environment is an explicit allowlist, with no key", () => {
  const i = { ...base, job: "bridge-version", baseSha: "a".repeat(40), headSha: "b".repeat(40) };
  assert.deepEqual(remoteEnvironment(i), ["CI=true", "GITHUB_WORKSPACE=/home/user/repo", "GITHUB_RUN_ID=123", "GITHUB_RUN_ATTEMPT=1", `BASE=${i.baseSha}`, `HEAD=${i.headSha}`]);
  assert(!remoteEnvironment(i).join(" ").includes(i.key));
});
test("execution frames require a real terminal exit and reject malformed values", () => {
  assert.equal(parseExecFrame('{"type":"started","commandId":"cmd"}').type, "started");
  assert.equal(parseExecFrame('{"processId":6614,"stderrOffset":0,"stdoutOffset":0,"type":"attached"}').processId, 6614);
  assert.equal(parseExecFrame('{"data":"hello","nextOffset":5,"type":"stdout"}').data, "hello");
  assert.equal(parseExecFrame('{"exitCode":23,"signal":null,"status":"exited","stderrOffset":0,"stdoutOffset":5,"type":"exit"}').exitCode, 23);
  assert.equal(parseExecFrame('{"type":"stdout","data":"hello"}').data, "hello");
  assert.equal(parseExecFrame('{"type":"exit","exitCode":23}').exitCode, 23);
  assert.throws(() => parseExecFrame('{"type":"attached","processId":0,"stdoutOffset":0,"stderrOffset":0}'));
  assert.throws(() => parseExecFrame('{"type":"exit","exitCode":0,"status":"running"}'));
  assert.throws(() => parseExecFrame('{"type":"exit","exitCode":"0"}'));
  assert.throws(() => parseExecFrame('{"type":"stdout","data":{}}'));
});
test("nonstream JSON response is decoded and reconciled with CLI status", () => {
  const ok = JSON.stringify({ commandId: "cmd", cwd: "/home/user", exitCode: 0, stdout: "ui.log\n", stderr: "", success: true });
  assert.equal(parseExecResult(ok, 0), "ui.log\n");
  const empty = JSON.stringify({ commandId: "cmd", cwd: "/home/user", exitCode: 0, stdout: "", stderr: "", success: true });
  assert.equal(parseExecResult(empty, 0), "");
  assert.throws(() => parseExecResult(ok, 23));
  assert.throws(() => parseExecResult(JSON.stringify({ exitCode: 0, stdout: "", stderr: "", success: false }), 0));
  assert.throws(() => parseExecResult('{"stdout":[]}', 0));
});
test("fork fallback does not create or prepare a sandbox", async () => {
  const { io, calls } = fixture();
  await orchestrate({ ...base, headRepository: "fork/ftown" }, io);
  assert.deepEqual(calls, [["local"]]);
});
test("trusted runs require key and clean up only created sandbox after exact revision upload", async () => {
  const { io, calls } = fixture();
  await assert.rejects(orchestrate({ ...base, key: "" }, io), /BOAT_API_KEY/);
  await orchestrate({ ...base }, io);
  assert.deepEqual(calls, [["prepare"], ["create"], ["record", "bx_abc123"], ["upload", "bx_abc123", "a".repeat(40)], ["execute", "bx_abc123"], ["artifacts", "bx_abc123"], ["cleanup", "bx_abc123"]]);
});
test("create failure after created event still deletes its sandbox", async () => {
  const { io, calls } = fixture({ create: async (_i, cb) => { cb("bx_abc123"); throw new Error("ready failed"); } });
  await assert.rejects(orchestrate({ ...base }, io), /ready failed/);
  assert.deepEqual(calls.at(-1), ["cleanup", "bx_abc123"]);
});
test("rejects malformed ID before cleanup and never targets another sandbox", async () => {
  const { io, calls } = fixture({ create: async (_i, cb) => cb("../../bad") });
  await assert.rejects(orchestrate({ ...base }, io), /Invalid sandbox ID/);
  assert(!calls.some(c => c[0] === "cleanup"));
});
test("preserves remote failure despite artifact error and cleans up", async () => {
  const { io, calls } = fixture({ execute: async () => 42, artifacts: async () => { throw new Error("transfer"); } });
  await assert.rejects(orchestrate({ ...base }, io), e => e.exitCode === 42);
  assert(calls.some(c => c[0] === "warning"));
  assert.deepEqual(calls.at(-1), ["cleanup", "bx_abc123"]);
});
test("artifact and cleanup failure fail successful jobs", async () => {
  let f = fixture({ artifacts: async () => { throw new Error("transfer"); } });
  await assert.rejects(orchestrate({ ...base }, f.io), /transfer/);
  assert.deepEqual(f.calls.at(-1), ["cleanup", "bx_abc123"]);
  f = fixture({ cleanup: async () => { throw new Error("delete"); } });
  await assert.rejects(orchestrate({ ...base }, f.io), /delete/);
});
test("cancellation and upload failure clean up after created event", async () => {
  for (const error of [Object.assign(new Error("cancelled"), { exitCode: 130 }), new Error("upload")]) {
    const { io, calls } = fixture({ upload: async () => { throw error; } });
    await assert.rejects(orchestrate({ ...base }, io), e => e === error);
    assert.deepEqual(calls.at(-1), ["cleanup", "bx_abc123"]);
  }
});

// Drives the real main() against a fake `curl` (installs a fake `boat`) so the actual run/checked/retry code is exercised.
async function bootstrapRun({ loginFails = 0, loginStderr = "login rejected", key = "sk-test-secret", loginSleep = 0, timeoutMs } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "boat-bootstrap-test-")));
  const bin = join(dir, "bin"); mkdirSync(bin);
  const boat = `#!/bin/sh
echo "$@" >> "${dir}/boat-calls"
for a in "$@"; do case "$a" in -*) ;; *) sub="$a"; break;; esac; done
case "$sub" in
  login) cat > "${dir}/stdin"; [ ${loginSleep} -gt 0 ] && sleep ${loginSleep}; echo x >> "${dir}/login-count"; n=$(wc -l < "${dir}/login-count"); if [ "$n" -le ${loginFails} ]; then echo "${loginStderr}" >&2; exit 1; fi ;;
  new) echo x >> "${dir}/new-count"; echo "new failed" >&2; exit 1 ;;
  "") echo "boat 1.0.0" ;;
esac
`;
  writeFileSync(join(dir, "boat-src"), boat);
  // Fake curl records its args and copies the fake boat to the -o target.
  writeFileSync(join(bin, "curl"), `#!/bin/sh
echo "$@" > "${dir}/curl-args"
while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then cp "${dir}/boat-src" "$2"; fi; shift; done
`);
  chmodSync(join(bin, "curl"), 0o755);
  // main() archives the cwd repo; the sandbox copy has no .git, so run against a throwaway repo.
  const repo = join(dir, "repo"); mkdirSync(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore", env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "CI Test", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "CI Test", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
  writeFileSync(join(repo, "f"), "x\n"); git("init"); git("add", "f"); git("commit", "-m", "init");
  const previousPath = process.env.PATH, previousError = console.error, previousCwd = process.cwd();
  process.chdir(repo);
  const logged = [];
  process.env.PATH = `${bin}:${previousPath}`;
  console.error = message => logged.push(String(message));
  const env = { INPUT_JOB: "centrifugo", CI_EVENT: "push", GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1", BOAT_API_KEY: key };
  let error;
  try { await main({ env, retryDelaysMs: [1, 1], ...(timeoutMs && { timeoutMs }) }); } catch (e) { error = e; }
  finally { process.chdir(previousCwd); process.env.PATH = previousPath; console.error = previousError; }
  const count = name => existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8").trim().split("\n").length : 0;
  const result = { error, logged, logins: count("login-count"), creates: count("new-count"), curlArgs: readFileSync(join(dir, "curl-args"), "utf8"), stdin: existsSync(join(dir, "stdin")) ? readFileSync(join(dir, "stdin"), "utf8") : "" };
  rmSync(dir, { recursive: true, force: true });
  return result;
}
test("a failing quiet command reports its subcommand and stderr tail, never stdin", async () => {
  const r = await bootstrapRun({ loginFails: 9, loginStderr: "invalid credentials from server" });
  assert.match(r.error.message, /^login: Command failed \(1\)\ninvalid credentials from server/);
  assert(!r.error.message.includes("--key-stdin"));
});
test("API key is redacted from failure messages and retry log lines", async () => {
  const r = await bootstrapRun({ loginFails: 9, loginStderr: "bad key sk-test-secret rejected", key: "sk-test-secret" });
  assert.match(r.error.message, /bad key \*\*\* rejected/);
  assert(!r.error.message.includes("sk-test-secret"));
  assert(r.logged.length > 0 && r.logged.every(line => !line.includes("sk-test-secret")));
});
test("a key straddling the 2000-char tail cut leaves no key fragment", async () => {
  const key = "sk-test-secret";
  const r = await bootstrapRun({ loginFails: 9, key, loginStderr: "A".repeat(1990) + key + "B".repeat(1995) });
  assert(r.error.message.includes("***"));
  for (let i = 0; i + 5 <= key.length; i++) assert(!r.error.message.includes(key.slice(i, i + 5)), key.slice(i, i + 5));
});
test("a login that times out is attempted exactly once", async () => {
  const r = await bootstrapRun({ loginSleep: 10, timeoutMs: 1000 });
  assert.equal(r.logins, 0);
  assert.equal(r.logged.length, 0);
  assert.match(r.error.message, /^login: Command timed out/);
  assert.equal(r.error.exitCode, 124);
});
test("login failing once is retried and the run continues to sandbox creation", async () => {
  const r = await bootstrapRun({ loginFails: 1 });
  assert.equal(r.logins, 2);
  assert.equal(r.creates, 1);
  assert.deepEqual(r.logged, ["Boat login attempt 1/3 failed: login: Command failed (1)\nlogin rejected; retrying in 0.001s"]);
  assert.match(r.error.message, /^new: Command failed/);
});
test("login failing three times throws after exactly three attempts", async () => {
  const r = await bootstrapRun({ loginFails: 9 });
  assert.equal(r.logins, 3);
  assert.equal(r.logged.length, 2);
  assert.equal(r.creates, 0);
  assert.match(r.error.message, /^login: Command failed \(1\)/);
});
test("sandbox creation is not retried", async () => {
  const r = await bootstrapRun();
  assert.equal(r.creates, 1);
  assert.equal(r.logged.length, 0);
});
test("CLI download is quiet but still reports errors", async () => {
  const r = await bootstrapRun();
  const args = r.curlArgs.split(" ");
  for (const flag of ["--fail", "--silent", "--show-error", "--location"]) assert(args.includes(flag), flag);
});
