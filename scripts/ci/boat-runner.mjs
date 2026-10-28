import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const jobs = new Set(["e2e", "release-artifacts", "gitleaks", "bridge-version", "centrifugo"]);
const shaPattern = /^[0-9a-f]{40}$/;
const idPattern = /^bx_[a-z0-9]+$/;
const artifacts = ["playwright-report", "test-results", "ui.log", "bridge.log", "ci-infra.log"];
const cliUrl = "https://boat.dev/api/boat/cli/download?platform=linux-x64&channel=prod";

export function validate(input) {
  if (!jobs.has(input.job)) throw new Error("Invalid CI job");
  if (input.job === "release-artifacts" && !["11", "latest"].includes(input.npmVersion)) throw new Error("Invalid npm version");
  if (input.job === "bridge-version" && (!shaPattern.test(input.baseSha || "") || !shaPattern.test(input.headSha || ""))) throw new Error("Invalid base/head SHA");
  if (!/^\d+$/.test(input.runId || "") || !/^\d+$/.test(input.runAttempt || "")) throw new Error("Invalid run identifiers");
  if (input.event === "pull_request") {
    if (!input.repository || !input.headRepository || !input.author || !input.sender || !input.actor) throw new Error("Missing PR routing identity");
    return input.headRepository === input.repository && ![input.author, input.sender, input.actor].includes("dependabot[bot]") ? "boat" : "local";
  }
  if (input.event === "push" || input.event === "workflow_dispatch") return "boat";
  throw new Error("Unsupported event");
}

export function remoteEnvironment(input) {
  const env = ["CI=true", "GITHUB_WORKSPACE=/home/user/repo", `GITHUB_RUN_ID=${input.runId}`, `GITHUB_RUN_ATTEMPT=${input.runAttempt}`];
  if (input.job === "release-artifacts") env.push(`NPM_VERSION=${input.npmVersion}`);
  if (input.job === "bridge-version") env.push(`BASE=${input.baseSha}`, `HEAD=${input.headSha}`);
  return env;
}

export function parseExecFrame(line) {
  const frame = JSON.parse(line);
  if (!frame || typeof frame !== "object") throw new Error("Invalid execution frame");
  if (frame.type === "started") return frame;
  if (frame.type === "attached" && Number.isInteger(frame.processId) && frame.processId > 0 && Number.isInteger(frame.stdoutOffset) && frame.stdoutOffset >= 0 && Number.isInteger(frame.stderrOffset) && frame.stderrOffset >= 0) return frame;
  if (["stdout", "stderr"].includes(frame.type) && typeof frame.data === "string") return frame;
  if (frame.type === "exit" && Number.isInteger(frame.exitCode) && frame.exitCode >= 0 && frame.exitCode < 256 && (frame.status === undefined || frame.status === "exited")) return frame;
  throw new Error("Invalid execution frame");
}

export function parseExecResult(json, cliExit) {
  const result = JSON.parse(json);
  if (!result || typeof result !== "object" || typeof result.stdout !== "string" || typeof result.stderr !== "string" || !Number.isInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255 || typeof result.success !== "boolean" || result.success !== (result.exitCode === 0) || result.exitCode !== cliExit) throw new Error("Invalid execution result");
  return result.stdout;
}

export function historyRestoreScript(revision, baseSha, headSha) {
  if (!shaPattern.test(revision) || (baseSha !== undefined && !shaPattern.test(baseSha)) || (headSha !== undefined && !shaPattern.test(headSha)) || ((baseSha === undefined) !== (headSha === undefined))) throw new Error("Invalid history revision");
  const checks = baseSha === undefined ? "" : ` && git -C repo cat-file -e ${baseSha}^{commit} && git -C repo cat-file -e ${headSha}^{commit}`;
  return `git init repo && git -C repo fetch --update-head-ok ../history.bundle '+refs/*:refs/*' HEAD && git -C repo checkout --detach ${revision} && test "$(git -C repo rev-parse HEAD)" = ${revision}${checks} && git -C repo rev-parse HEAD`;
}

// This source runs in the sandbox and is also exercised against isolated fixtures.
export const artifactInspectionSource = String.raw`
const fs = require("node:fs"), path = require("node:path");
const root = process.argv[2];
if (!root || !path.isAbsolute(root)) throw Error("Invalid artifact directory");
let current = path.parse(root).root;
for (const part of root.slice(current.length).split(path.sep).filter(Boolean)) {
  current = path.join(current, part);
  const stat = fs.lstatSync(current);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Unsafe artifact ancestor");
}
function inspect(p) {
  const stat = fs.lstatSync(p);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw Error("Unsafe artifact entry");
  if (stat.isDirectory()) for (const name of fs.readdirSync(p)) inspect(path.join(p, name));
}
const found = [];
for (const name of ["playwright-report", "test-results", "ui.log", "bridge.log", "ci-infra.log"]) {
  const p = path.join(root, name);
  try { fs.lstatSync(p); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
  inspect(p); found.push(name);
}
process.stdout.write(JSON.stringify(found));
`;

export function parseArtifactInspection(output) {
  const names = JSON.parse(output);
  if (!Array.isArray(names) || names.some(n => typeof n !== "string" || !artifacts.includes(n)) || new Set(names).size !== names.length) throw new Error("Unexpected artifact name");
  return names;
}

export async function orchestrate(input, io) {
  const route = validate(input);
  if (route === "local") return io.local(input);
  if (!input.key) throw new Error("BOAT_API_KEY is required for trusted jobs");
  let id;
  let outcome;
  let failure;
  try {
    await io.prepare(input);
    await io.create(input, value => {
      if (!idPattern.test(value)) throw new Error("Invalid sandbox ID");
      if (id && id !== value) throw new Error("Sandbox ID changed");
      id = value;
      io.recordId(value);
    });
    if (!id) throw new Error("Sandbox creation did not return an ID");
    await io.upload(id, input);
    outcome = await io.execute(id, input);
    if (input.job === "e2e") {
      try { await io.artifacts(id, input); }
      catch (error) {
        if (outcome !== 0) io.warning("Artifact transfer failed after test failure");
        else throw error;
      }
    }
    if (outcome !== 0) throw Object.assign(new Error(`Remote job failed (${outcome})`), { exitCode: outcome });
  } catch (error) { failure = error; }
  if (id) {
    try { await io.cleanup(id); }
    catch (error) {
      if (!failure) failure = error;
      else io.warning("Sandbox deletion failed; TTL remains active");
    }
  }
  if (failure) throw failure;
}

function inputFromEnv(env) {
  return {
    job: env.INPUT_JOB, npmVersion: env.INPUT_NPM_VERSION, baseSha: env.INPUT_BASE_SHA, headSha: env.INPUT_HEAD_SHA,
    key: env.BOAT_API_KEY, event: env.CI_EVENT, repository: env.CI_REPOSITORY,
    headRepository: env.CI_HEAD_REPOSITORY, author: env.CI_PR_AUTHOR, sender: env.CI_SENDER, actor: env.CI_ACTOR,
    runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
  };
}

async function main() {
  const input = inputFromEnv(process.env);
  const root = process.cwd();
  const temp = await mkdtemp(join(process.env.RUNNER_TEMP || "/tmp", "ftown-boat-ci-"));
  await chmod(temp, 0o700);
  const boat = join(temp, "boat");
  const cliEnv = { HOME: temp, PATH: process.env.PATH || "/usr/bin:/bin", LANG: "C.UTF-8" };
  let child;
  let interrupted = false;
  let removeSignals;
  // Reserve time inside the GitHub job deadline for sandbox deletion.
  const activeDeadline = Date.now() + (input.job === "e2e" ? 2620000 : 1110000);
  const run = (program, args, { env = cliEnv, stdin, timeout = 120000, stream = true, onLine, cleanup = false } = {}) => new Promise((done, reject) => {
    if (interrupted && !cleanup) return reject(Object.assign(new Error("Cancelled"), { exitCode: 130 }));
    if (!cleanup) {
      timeout = Math.min(timeout, activeDeadline - Date.now());
      if (timeout <= 0) return reject(Object.assign(new Error("CI budget exhausted"), { exitCode: 124 }));
    }
    let stdout = "", stderr = "", lines = "";
    let parseError;
    const consume = line => { try { onLine?.(line); } catch (error) { parseError = error; active.kill("SIGTERM"); } };
    child = spawn(program, args, { cwd: root, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    const active = child;
    const killGroup = signal => { try { process.kill(-active.pid, signal); } catch { active.kill(signal); } };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup("SIGKILL"); }, timeout);
    active.stdout.on("data", data => {
      const chunk = data.toString(); stdout += chunk;
      if (stream) process.stdout.write(chunk);
      if (onLine) { lines += chunk; const parts = lines.split("\n"); lines = parts.pop(); for (const part of parts) consume(part); }
    });
    active.stderr.on("data", data => { stderr += data.toString(); if (stream) process.stderr.write(data); });
    active.on("error", error => { clearTimeout(timer); child = undefined; reject(error); });
    active.on("close", (code, signal) => {
      clearTimeout(timer); child = undefined;
      if (onLine && lines) consume(lines);
      if (parseError) return reject(parseError);
      if (timedOut) return reject(Object.assign(new Error("Command timed out"), { exitCode: 124 }));
      if (interrupted && !cleanup) return reject(Object.assign(new Error("Cancelled"), { exitCode: 130 }));
      done({ code: code ?? (signal ? 130 : 1), stdout, stderr });
    });
    active.stdin.end(stdin);
  });
  const checked = async (program, args, opts) => {
    const result = await run(program, args, opts);
    if (result.code !== 0) throw Object.assign(new Error(`Command failed (${result.code})`), { exitCode: result.code });
    return result;
  };
  const bc = (args, opts) => checked(boat, ["--no-update", ...args], opts);
  const io = {
    warning: message => console.error(message),
    recordId: id => {
      console.log(`Boat sandbox: ${id}`);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sandbox-id=${id}\n`);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Boat sandbox: ${id}\n`);
    },
    local: async i => {
      const env = { HOME: process.env.HOME, PATH: process.env.PATH, CI: "true", GITHUB_WORKSPACE: root, GITHUB_RUN_ID: i.runId, GITHUB_RUN_ATTEMPT: i.runAttempt };
      if (i.job === "release-artifacts") env.NPM_VERSION = i.npmVersion;
      if (i.job === "bridge-version") { env.BASE = i.baseSha; env.HEAD = i.headSha; }
      await checked("bash", ["scripts/ci/run-job.sh", i.job], { env, timeout: i.job === "e2e" ? 2100000 : 900000 });
    },
    prepare: async () => {
      await checked("curl", ["--fail", "--location", "--retry", "3", "--connect-timeout", "15", "--max-time", "180", cliUrl, "-o", boat], { timeout: 190000 });
      await chmod(boat, 0o700);
      await bc(["--version"]);
      await bc(["login", "--key-stdin"], { stdin: input.key + "\n", stream: false });
      const revision = (await checked("git", ["rev-parse", "HEAD"], { stream: false })).stdout.trim();
      if (!shaPattern.test(revision)) throw new Error("Invalid source revision");
      input.revision = revision;
      console.log(`Source revision: ${revision}`);
      await checked("git", ["archive", "--format=tar", "-o", join(temp, "source.tar"), revision], { timeout: 120000 });
      if (["gitleaks", "bridge-version"].includes(input.job)) await checked("git", ["bundle", "create", join(temp, "history.bundle"), "--all", "HEAD"], { timeout: 120000 });
    },
    create: async (i, onId) => {
      let seen = false;
      await bc(["--json", "new", "--ttl", i.job === "e2e" ? "2700" : "1200", "--type", i.job === "e2e" ? "default" : "small", "--no-env", "--no-snapshots"], {
        timeout: 180000, stream: false, onLine: line => {
          let record; try { record = JSON.parse(line); } catch { return; }
          if (record.event === "created") { onId(record.id); seen = true; }
        },
      });
      if (!seen) throw new Error("Missing created event");
    },
    upload: async (id, i) => {
      await bc(["scp", join(temp, "source.tar"), `${id}:/home/user/source.tar`], { timeout: 180000 });
      const history = ["gitleaks", "bridge-version"].includes(i.job);
      if (history) await bc(["scp", join(temp, "history.bundle"), `${id}:/home/user/history.bundle`], { timeout: 180000 });
      const init = history
        ? `cd /home/user && ${historyRestoreScript(i.revision, i.job === "bridge-version" ? i.baseSha : undefined, i.job === "bridge-version" ? i.headSha : undefined)} && tar -xf /home/user/source.tar -C /home/user/repo`
        : "mkdir -p /home/user/repo && tar -xf /home/user/source.tar -C /home/user/repo";
      await bc(["exec", "--timeout", "180", id, "--", "bash", "-c", init], { timeout: 190000 });
    },
    execute: async (id, i) => {
      const available = Math.floor((activeDeadline - Date.now() - 10000) / 1000);
      if (available < 1) return 124;
      const remoteTimeout = Math.min(i.job === "e2e" ? 2100 : 900, available);
      let result, remoteExit;
      try { result = await run(boat, ["--no-update", "--json", "exec", "--stream", "--timeout", String(remoteTimeout), "--cwd", "repo", id, "--",
        "env", "-i", "HOME=/home/user", "PATH=/home/user/.nvm/versions/node/v24.22.1/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", ...remoteEnvironment(i), "bash", "scripts/ci/run-job.sh", i.job],
        { timeout: (remoteTimeout + 10) * 1000, stream: false, onLine: line => {
          const frame = parseExecFrame(line);
          if (frame.type === "stdout") process.stdout.write(frame.data);
          if (frame.type === "stderr") process.stderr.write(frame.data);
          if (frame.type === "exit") {
            if (remoteExit !== undefined) throw new Error("Duplicate execution exit");
            remoteExit = frame.exitCode;
          }
        } }); }
      catch (error) { if (error.exitCode === 124) throw new Error("Remote execution completion unconfirmed after timeout"); throw error; }
      if (remoteExit === undefined || result.code !== remoteExit) throw new Error("Remote execution completion unconfirmed");
      return remoteExit;
    },
    artifacts: async id => {
      const inspect = `PATH=/home/user/.nvm/versions/node/v24.22.1/bin:/usr/local/bin:/usr/bin:/bin node - /home/user/repo/e2e <<'FTOWN_CI_ARTIFACTS'\n${artifactInspectionSource}\nFTOWN_CI_ARTIFACTS`;
      const list = await bc(["--json", "exec", "--timeout", "30", id, "--", "bash", "-c", inspect], { timeout: 40000, stream: false });
      const names = parseArtifactInspection(parseExecResult(list.stdout, list.code));
      const stage = join(temp, "artifacts"); await mkdir(stage, { mode: 0o700 });
      async function assertSafe(path) {
        const stat = await lstat(path);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error("Unsafe artifact");
        if (stat.isDirectory()) for (const name of await readdir(path)) await assertSafe(join(path, name));
      }
      for (const name of names) {
        const dest = join(stage, name);
        await bc(["scp", "-r", `${id}:/home/user/repo/e2e/${name}`, dest], { timeout: 180000 });
        await assertSafe(dest);
        const target = join(root, "e2e", name);
        await rm(target, { recursive: true, force: true });
        await cp(dest, target, { recursive: true, errorOnExist: true, force: false, dereference: false });
      }
    },
    cleanup: async id => {
      await bc(["delete", "--yes", id], { timeout: 30000, cleanup: true });
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        const result = await run(boat, ["--no-update", "info", id, "--json"], { timeout: 10000, cleanup: true, stream: false });
        let info; try { info = JSON.parse((result.stdout || result.stderr).trim()); } catch { throw new Error("Cannot verify sandbox deletion"); }
        if (result.code !== 0 && info.code === "not_found" && info.status === 404) return;
        if (result.code !== 0) throw new Error("Cannot verify sandbox deletion");
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      throw new Error("Sandbox deletion unconfirmed");
    },
  };
  const onSignal = () => {
    if (interrupted) return;
    interrupted = true;
    if (child) {
      const active = child;
      try { process.kill(-active.pid, "SIGTERM"); } catch { active.kill("SIGTERM"); }
      const timer = setTimeout(() => { if (child === active) { try { process.kill(-active.pid, "SIGKILL"); } catch { /* already exited */ } } }, 2000);
      timer.unref();
    }
  };
  process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
  removeSignals = () => { process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal); };
  try { await orchestrate(input, io); if (interrupted) throw Object.assign(new Error("Cancelled"), { exitCode: 130 }); }
  finally { removeSignals(); await rm(temp, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = Number.isInteger(error.exitCode) && error.exitCode > 0 && error.exitCode < 256 ? error.exitCode : 1; });
}
