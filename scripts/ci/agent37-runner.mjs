import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { chmod, cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactInspectionSource, createPrivateControllerDir, historyRestoreScript, parseArtifactInspection } from "./boat-runner.mjs";

// Agent37 backend mirroring boat-runner.mjs's contract: same job inputs, exit
// code propagation, and cleanup-always orchestration. Unlike Boat's sandbox
// per job, instances are long-lived and reused: one auto-sleeping instance per
// job kind (per e2e shard), a per-run remote directory, and a remote flock so
// concurrent runs on one instance serialize instead of colliding on ports.
// Instances are never destroyed here; the platform's auto-sleep parks them.
const jobs = new Set(["e2e", "release-artifacts", "gitleaks", "bridge-version", "centrifugo"]);
const shaPattern = /^[0-9a-f]{40}$/;
const shardPattern = /^([1-9])\/([1-9])$/;
const instanceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const templatePattern = /^[a-z][a-z0-9-]{1,62}$/;
const artifacts = ["playwright-report", "test-results", "ui.log", "bridge.log", "ci-infra.log"];
export const defaultTemplate = "ftown-ci";

export function validate(input) {
  if (!jobs.has(input.job)) throw new Error("Invalid CI job");
  if (input.job === "release-artifacts" && !["11", "latest"].includes(input.npmVersion)) throw new Error("Invalid npm version");
  if (input.job === "bridge-version" && (!shaPattern.test(input.baseSha || "") || !shaPattern.test(input.headSha || ""))) throw new Error("Invalid base/head SHA");
  if (input.shard) {
    const shard = shardPattern.exec(input.shard);
    if (input.job !== "e2e" || !shard || Number(shard[1]) > Number(shard[2])) throw new Error("Invalid shard");
  }
  if (!/^\d+$/.test(input.runId || "") || !/^\d+$/.test(input.runAttempt || "")) throw new Error("Invalid run identifiers");
  const template = input.template || defaultTemplate;
  if (!templatePattern.test(template) || template.startsWith("agent37-")) throw new Error("Invalid Agent37 template");
  if (input.event === "pull_request") {
    if (!input.repository || !input.headRepository || !input.author || !input.sender || !input.actor) throw new Error("Missing PR routing identity");
    return input.headRepository === input.repository && ![input.author, input.sender, input.actor].includes("dependabot[bot]") ? "agent37" : "local";
  }
  if (input.event === "push" || input.event === "workflow_dispatch") return "agent37";
  throw new Error("Unsupported event");
}

export function remoteEnvironment(input, workspace) {
  if (!workspace || typeof workspace !== "string") throw new Error("Invalid remote workspace");
  const env = ["CI=true", `GITHUB_WORKSPACE=${workspace}`, `GITHUB_RUN_ID=${input.runId}`, `GITHUB_RUN_ATTEMPT=${input.runAttempt}`];
  if (input.shard) env.push(`E2E_SHARD=${input.shard}`);
  if (input.job === "release-artifacts") env.push(`NPM_VERSION=${input.npmVersion}`);
  if (input.job === "bridge-version") env.push(`BASE=${input.baseSha}`, `HEAD=${input.headSha}`);
  return env;
}

export function instanceNameFor(input) {
  if (input.job === "e2e") {
    const index = input.shard ? shardPattern.exec(input.shard)[1] : "1";
    return `ftown-ci-e2e-${index}`;
  }
  return "ftown-ci-unit";
}

export function runKeyFor(input) {
  const shard = input.shard ? `-${input.shard.replace("/", "-of-")}` : "";
  return `${input.job}-${input.runId}-${input.runAttempt}${shard}`;
}

export function remoteRunDir(input) { return `ci/runs/${runKeyFor(input)}`; }
export function remoteUploadDir(input) { return `ci/uploads/${runKeyFor(input)}`; }

export function apiErrorCode(bodyText) {
  try {
    const body = JSON.parse(bodyText);
    if (!body || typeof body !== "object") return "unknown";
    const error = body.error;
    if (error && typeof error === "object") return typeof error.code === "string" && error.code ? error.code : (typeof error.message === "string" && error.message ? error.message : "unknown");
    if (typeof error === "string" && error) return error;
    return typeof body.message === "string" && body.message ? body.message : "unknown";
  } catch { return "unknown"; }
}

// Wake/availability races are safe to retry: the command never started.
// 502/504 from the exec API are not: the command may still be running.
export function isRetryableApiError(status, code) {
  if (code === "try_again") return status === 409 || status === 503;
  return status === 503 && (code === "wake_failed" || code === "wake_timeout");
}

export function apiFailureMessage(action, { status, code, instanceId, template } = {}) {
  const where = instanceId ? ` for instance ${instanceId}` : "";
  if (status === 402 || code === "insufficient_balance" || code === "instance_suspended") {
    return `Agent37 ${action} failed${where}: workspace funding is exhausted (HTTP ${status} ${code}). Top up the Agent37 wallet, then re-run the job.`;
  }
  if (code === "instance_limit_reached") {
    return `Agent37 ${action} failed: the workspace instance limit is reached (HTTP 409 instance_limit_reached). Sleep or destroy an unused instance, then re-run the job.`;
  }
  if (code === "capacity_unavailable") {
    return `Agent37 ${action} failed${where}: capacity is temporarily unavailable (HTTP 409 capacity_unavailable). Re-run the job later.`;
  }
  if (code === "template_not_found" || (action === "create instance" && status === 404)) {
    return `Agent37 create instance failed: template '${template || defaultTemplate}' was not found. Build it once with: a37 image build scripts/ci/agent37/Dockerfile ${template || defaultTemplate} scripts/ci/agent37 — then re-run the job.`;
  }
  return `Agent37 ${action} failed${where} (HTTP ${status} ${code}). Re-run the job; if it repeats, report instance ${instanceId || "unknown"} to Agent37 support.`;
}

export function parseInstances(bodyText) {
  const body = JSON.parse(bodyText);
  const list = Array.isArray(body) ? body : (body?.instances ?? body?.data ?? body?.items);
  if (!Array.isArray(list)) throw new Error("Invalid instance list");
  return list.filter(item => item && typeof item === "object" && typeof item.id === "string");
}

export async function orchestrate(input, io) {
  const route = validate(input);
  if (route === "local") return io.local(input);
  if (!input.key) throw new Error("AGENT37_API_KEY is required for trusted jobs: add the AGENT37_API_KEY repo secret (the repo owner must do this), or set CI_RUNNER=boat to use the Boat fallback");
  let id;
  let outcome;
  let failure;
  try {
    await io.prepare(input);
    await io.ensure(input, value => {
      if (!instanceIdPattern.test(value)) throw new Error("Invalid instance ID");
      if (id && id !== value) throw new Error("Instance ID changed");
      id = value;
      io.recordId(value);
    });
    if (!id) throw new Error("Instance lookup did not return an ID");
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
    try { await io.cleanup(id, input); }
    catch (error) {
      if (!failure) failure = error;
      else io.warning("Remote run directory cleanup failed; the next run uses a fresh directory");
    }
  }
  if (failure) throw failure;
}

function inputFromEnv(env) {
  return {
    job: env.INPUT_JOB, shard: env.INPUT_SHARD || undefined, npmVersion: env.INPUT_NPM_VERSION, baseSha: env.INPUT_BASE_SHA, headSha: env.INPUT_HEAD_SHA,
    key: env.AGENT37_API_KEY, template: env.AGENT37_TEMPLATE || undefined, event: env.CI_EVENT, repository: env.CI_REPOSITORY,
    headRepository: env.CI_HEAD_REPOSITORY, author: env.CI_PR_AUTHOR, sender: env.CI_SENDER, actor: env.CI_ACTOR,
    runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
  };
}

// `env`, `retryDelaysMs`, `timeoutMs` (default command timeout), `pollIntervalMs`
// and `fetchImpl` are test seams; production uses the defaults.
export async function main({ env = process.env, retryDelaysMs = [5000, 15000], timeoutMs = 120000, pollIntervalMs = 5000, fetchImpl = globalThis.fetch } = {}) {
  const input = inputFromEnv(env);
  const root = process.cwd();
  const apiUrl = (env.A37_API_URL || "https://api.agent37.com").replace(/\/$/, "");
  const sandboxUrl = (env.A37_SANDBOX_URL || "https://sandbox.agent37.app").replace(/\/$/, "");
  const sshUser = env.A37_SSH_USER || "node";
  const temp = await createPrivateControllerDir();
  let child;
  let interrupted = false;
  let removeSignals;
  // Reserve time inside the GitHub job deadline for remote cleanup.
  const activeDeadline = Date.now() + (input.job === "e2e" ? 2620000 : 1110000);
  const run = (program, args, { env: runEnv, stdin, timeout = timeoutMs, stream = true, onLine, cleanup = false } = {}) => new Promise((done, reject) => {
    if (interrupted && !cleanup) return reject(Object.assign(new Error("Cancelled"), { exitCode: 130 }));
    if (!cleanup) {
      timeout = Math.min(timeout, activeDeadline - Date.now());
      if (timeout <= 0) return reject(Object.assign(new Error("CI budget exhausted"), { exitCode: 124 }));
    }
    let stdout = "", stderr = "", lines = "";
    let parseError;
    const consume = line => { try { onLine?.(line); } catch (error) { parseError = error; active.kill("SIGTERM"); } };
    child = spawn(program, args, { cwd: root, env: runEnv || { HOME: temp, PATH: process.env.PATH || "/usr/bin:/bin", LANG: "C.UTF-8" }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
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
      if (timedOut) return reject(Object.assign(new Error("Command timed out"), { exitCode: 124, stdout, stderr }));
      if (interrupted && !cleanup) return reject(Object.assign(new Error("Cancelled"), { exitCode: 130 }));
      done({ code: code ?? (signal ? 130 : 1), stdout, stderr });
    });
    active.stdin.end(stdin);
  });
  const redact = text => input.key ? text.split(input.key).join("***") : text;
  // Streamed calls already showed their output live; for quiet calls surface the tail of it in the error.
  const describeFailure = (program, args, opts, message, output) => {
    const label = basename(program);
    const detail = opts?.stream === false ? redact((output.stderr || "").trim() || (output.stdout || "").trim()).slice(-2000).trim() : "";
    return `${label}: ${message}${detail ? `\n${detail}` : ""}`;
  };
  const checked = async (program, args, opts) => {
    let result;
    try { result = await run(program, args, opts); }
    catch (error) {
      if (error.exitCode === 124 && error.stderr !== undefined) error.message = describeFailure(program, args, opts, error.message, error);
      throw error;
    }
    if (result.code !== 0) throw Object.assign(new Error(describeFailure(program, args, opts, `Command failed (${result.code})`, result)), { exitCode: result.code });
    return result;
  };
  // Retry only retryable platform races (never cancellations or timeouts); the remote job itself is never retried.
  const retrying = async (name, fn, shouldRetry) => {
    const attempts = retryDelaysMs.length + 1;
    for (let attempt = 1; ; attempt++) {
      try { return await fn(); }
      catch (error) {
        if (attempt >= attempts || interrupted || error.exitCode === 130 || error.exitCode === 124 || (shouldRetry && !shouldRetry(error))) throw error;
        const delay = retryDelaysMs[attempt - 1];
        console.error(`Agent37 ${name} attempt ${attempt}/${attempts} failed: ${redact(error.message)}; retrying in ${delay / 1000}s`);
        await new Promise(done => setTimeout(done, delay));
      }
    }
  };
  const api = async (method, path, { body, sandbox = false, timeout = 120000 } = {}) => {
    const base = sandbox ? sandboxUrl : apiUrl;
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${input.key}`, ...(sandbox ? { "X-Agent37-Key": input.key } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw Object.assign(new Error(redact(`Agent37 API request failed (${method} ${path}): ${error.message}`)), { retryable: true });
    }
    const text = await response.text();
    return { status: response.status, text };
  };
  const apiJson = async (action, method, path, opts = {}) => {
    const { status, text } = await api(method, path, opts);
    if (status < 200 || status >= 300) {
      const code = apiErrorCode(text);
      throw Object.assign(new Error(apiFailureMessage(action, { status, code, instanceId: opts.instanceId, template: input.template })), { status, code, retryable: isRetryableApiError(status, code) });
    }
    return text ? JSON.parse(text) : {};
  };
  let sshConfig;
  let sshEnv;
  const ssh = (args, opts) => checked("ssh", ["-F", sshConfig, ...args], { env: sshEnv, ...opts });
  const instanceState = async id => {
    try {
      const info = await apiJson("get instance", "GET", `/v1/instances/${id}`, { instanceId: id });
      return typeof info.status === "string" && info.status ? info.status : "unknown";
    } catch { return "unknown"; }
  };
  const io = {
    warning: message => console.error(message),
    recordId: id => {
      console.log(`Agent37 instance: ${id}`);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `instance-id=${id}\n`);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Agent37 instance: ${id}\n`);
    },
    local: async i => {
      const localEnv = { HOME: process.env.HOME, PATH: process.env.PATH, CI: "true", GITHUB_WORKSPACE: root, GITHUB_RUN_ID: i.runId, GITHUB_RUN_ATTEMPT: i.runAttempt };
      if (i.shard) localEnv.E2E_SHARD = i.shard;
      if (i.job === "release-artifacts") localEnv.NPM_VERSION = i.npmVersion;
      if (i.job === "bridge-version") { localEnv.BASE = i.baseSha; localEnv.HEAD = i.headSha; }
      await checked("bash", ["scripts/ci/run-job.sh", i.job], { env: localEnv, timeout: i.job === "e2e" ? 2100000 : 900000 });
    },
    prepare: async () => {
      const revision = (await checked("git", ["rev-parse", "HEAD"], { stream: false })).stdout.trim();
      if (!shaPattern.test(revision)) throw new Error("Invalid source revision");
      input.revision = revision;
      console.log(`Source revision: ${revision}`);
      await checked("git", ["archive", "--format=tar", "-o", join(temp, "source.tar"), revision], { timeout: 120000 });
      if (["gitleaks", "bridge-version"].includes(input.job)) await checked("git", ["bundle", "create", join(temp, "history.bundle"), "--all", "HEAD"], { timeout: 120000 });
      // Ephemeral per-run SSH identity; only the public key leaves this runner.
      await checked("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "ftown-ci", "-f", join(temp, "id_ed25519")], { timeout: 30000 });
    },
    ensure: async (i, onId) => {
      const name = instanceNameFor(i);
      const template = i.template || defaultTemplate;
      const resources = i.job === "e2e" ? { cpu: 4, memory: 16 } : { cpu: 2, memory: 8 };
      const listByName = async () => {
        const { status, text } = await api("GET", "/v1/instances");
        if (status === 404 || status === 405) return undefined;
        if (status < 200 || status >= 300) {
          const code = apiErrorCode(text);
          throw Object.assign(new Error(apiFailureMessage("list instances", { status, code, template })), { status, code, retryable: isRetryableApiError(status, code) });
        }
        return parseInstances(text).find(item => item.name === name);
      };
      let instance = await retrying("list instances", listByName, error => error.retryable);
      if (!instance) {
        const createOnce = async () => {
          const created = await apiJson("create instance", "POST", "/v1/instances", { body: { template, name, resources, auto_sleep: true, idle_timeout_seconds: 300 } });
          if (!created || typeof created.id !== "string") throw new Error(`Agent37 create instance for '${name}' returned no ID. Re-run the job; if it repeats, report template '${template}' to Agent37 support.`);
          return created;
        };
        try {
          instance = await retrying("create instance", createOnce, error => error.retryable);
        } catch (error) {
          // A retryable create may have succeeded server-side; adopt the named instance instead of duplicating it.
          if (!error.retryable) throw error;
          instance = await listByName();
          if (!instance) throw error;
        }
      }
      const id = instance.id;
      onId(id);
      const startOnce = async () => apiJson("start instance", "POST", `/v1/instances/${id}/start`, { instanceId: id, body: {} });
      for (let poll = 0; poll < 60; poll++) {
        const info = await apiJson("get instance", "GET", `/v1/instances/${id}`, { instanceId: id });
        const status = info.status;
        if (status === "running") break;
        if (status === "sleeping" || status === "stopped") { await retrying("start instance", startOnce, error => error.retryable); }
        else if (status === "failed") throw new Error(`Agent37 instance ${id} ('${name}') is failed: ${JSON.stringify(info.status_reason ?? {})}. Check the template entrypoint and instance logs, recreate the instance from template '${template}', then re-run the job.`);
        else if (status === "deleting" || status === "deleted") throw new Error(`Agent37 instance ${id} ('${name}') is ${status}. It will not be recreated automatically because CI never destroys instances; recreate it from template '${template}', then re-run the job.`);
        if (poll === 59) throw new Error(`Agent37 instance ${id} ('${name}') did not reach running state in time (last state: ${status || "unknown"}). Re-run the job; if it repeats, report instance ${id} to Agent37 support.`);
        await new Promise(done => setTimeout(done, pollIntervalMs));
      }
      const publicKey = (await readFile(join(temp, "id_ed25519.pub"), "utf8")).trim();
      try {
        await apiJson("register SSH key", "POST", "/v1/ssh-keys", { body: { public_key: publicKey, name: `ftown-ci-${i.runId}-${i.runAttempt}` } });
      } catch (error) {
        if (error.code !== "ssh_key_exists") throw error;
      }
      const tunnel = env.A37_TUNNEL || "npx --yes agent37 tunnel %h";
      sshConfig = join(temp, "ssh_config");
      await writeFile(sshConfig, [
        "Host a37",
        `  HostName ${id}.agent37.app`,
        `  User ${sshUser}`,
        `  ProxyCommand ${tunnel}`,
        `  IdentityFile ${join(temp, "id_ed25519")}`,
        "  IdentitiesOnly yes",
        "  StrictHostKeyChecking no",
        "  UserKnownHostsFile /dev/null",
        "  LogLevel ERROR",
        "  ServerAliveInterval 30",
        "  ControlMaster auto",
        "  ControlPath /tmp/a37-%C",
        "  ControlPersist 120",
        "",
      ].join("\n"), { mode: 0o600 });
      // The tunnel reads the key from its own environment; it is never logged or sent to the remote job.
      sshEnv = { HOME: temp, PATH: process.env.PATH || "/usr/bin:/bin", LANG: "C.UTF-8", AGENT37_API_KEY: input.key };
      let reachable = false;
      for (let attempt = 0; attempt < 12 && !reachable; attempt++) {
        const probe = await run("ssh", ["-F", sshConfig, "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "a37", "true"], { env: sshEnv, timeout: 30000, stream: false }).catch(() => ({ code: 1 }));
        reachable = probe.code === 0;
        if (!reachable && attempt < 11) await new Promise(done => setTimeout(done, pollIntervalMs));
      }
      if (!reachable) throw new Error(`Agent37 instance ${id} ('${name}') is running but SSH is not reachable. Confirm template '${template}' serves SSH on port 22022 and that the registered key is injected, then re-run the job. Instance state: ${await instanceState(id)}.`);
      return id;
    },
    upload: async (id, i) => {
      const runDir = remoteRunDir(i);
      const uploadDir = remoteUploadDir(i);
      await ssh(["a37", `mkdir -p "$HOME/${uploadDir}" "$HOME/${runDir}"`], { timeout: 60000 });
      await checked("scp", ["-F", sshConfig, join(temp, "source.tar"), `a37:${uploadDir}/source.tar`], { env: sshEnv, timeout: 180000 });
      const history = ["gitleaks", "bridge-version"].includes(i.job);
      if (history) await checked("scp", ["-F", sshConfig, join(temp, "history.bundle"), `a37:${uploadDir}/history.bundle`], { env: sshEnv, timeout: 180000 });
      const init = history
        ? `cd "$HOME/${runDir}" && cp "$HOME/${uploadDir}/history.bundle" history.bundle && ${historyRestoreScript(i.revision, i.job === "bridge-version" ? i.baseSha : undefined, i.job === "bridge-version" ? i.headSha : undefined)} && tar -xf "$HOME/${uploadDir}/source.tar" -C repo`
        : `mkdir -p "$HOME/${runDir}/repo" && tar -xf "$HOME/${uploadDir}/source.tar" -C "$HOME/${runDir}/repo"`;
      await ssh(["a37", "bash", "-c", init], { timeout: 190000 });
    },
    execute: async (id, i) => {
      const available = Math.floor((activeDeadline - Date.now() - 10000) / 1000);
      if (available < 1) return 124;
      const remoteTimeout = Math.min(i.job === "e2e" ? 2100 : 900, available);
      const runDir = remoteRunDir(i);
      const lockName = instanceNameFor(i);
      const workspace = `$HOME/${runDir}/repo`;
      // Values are validated (digits, hex, fixed enums) or the intentional $HOME workspace, so no quoting is needed.
      const envArgs = remoteEnvironment(i, workspace).join(" ");
      const inner = `cd "$HOME/${runDir}/repo" && env -i HOME="$HOME" PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin ${envArgs} bash scripts/ci/run-job.sh ${i.job}`;
      const script = `mkdir -p "$HOME/ci/locks" && echo "Waiting for instance ${id} lock (${lockName})..." && exec flock "$HOME/ci/locks/${lockName}.lock" bash -lc '${inner.replaceAll("'", "'\\''")}'`;
      let result;
      try {
        result = await run("ssh", ["-F", sshConfig, "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "a37", "bash", "-lc", script], { env: sshEnv, timeout: (remoteTimeout + 10) * 1000 });
      } catch (error) {
        if (error.exitCode === 124) throw new Error(`Remote execution completion unconfirmed for instance ${id} after timeout: the SSH session ended without the remote job reporting a result. The job may still be running under the instance lock — this is not a test failure. Check instance ${id}, then re-run the job.`);
        throw error;
      }
      return result.code;
    },
    artifacts: async (id, i) => {
      const runDir = remoteRunDir(i);
      const list = await ssh(["a37", "node", "-", `$HOME/${runDir}/repo/e2e`], { timeout: 40000, stream: false, stdin: artifactInspectionSource });
      const names = parseArtifactInspection(list.stdout.trim());
      const stage = join(temp, "artifacts"); await mkdir(stage, { mode: 0o700 });
      await chmod(stage, 0o700);
      async function assertSafe(path) {
        const stat = await lstat(path);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error("Unsafe artifact");
        if (stat.isDirectory()) for (const name of await readdir(path)) await assertSafe(join(path, name));
      }
      for (const name of names) {
        if (!artifacts.includes(name)) throw new Error("Unexpected artifact name");
        const dest = join(stage, name);
        await checked("scp", ["-F", sshConfig, "-r", `a37:${runDir}/repo/e2e/${name}`, dest], { env: sshEnv, timeout: 180000 });
        await assertSafe(dest);
        const target = join(root, "e2e", name);
        await rm(target, { recursive: true, force: true });
        await cp(dest, target, { recursive: true, errorOnExist: true, force: false, dereference: false });
      }
    },
    cleanup: async (id, i) => {
      const script = `rm -rf "$HOME/${remoteRunDir(i)}" "$HOME/${remoteUploadDir(i)}"`;
      try {
        await ssh(["a37", "bash", "-c", script], { timeout: 60000, cleanup: true, stream: false });
      } catch (sshError) {
        // SSH may be gone with the job; the exec API can still remove the run directory.
        // A 502/504 here is not retried: the delete may already be running.
        const { status, text } = await api("POST", `/v1/instances/${id}/exec`, { sandbox: true, body: { command: script }, timeout: 60000 });
        if (status < 200 || status >= 300) {
          const code = apiErrorCode(text);
          throw new Error(`Agent37 cleanup failed for instance ${id} (SSH: ${redact(sshError.message)}; exec API: HTTP ${status} ${code}). Remove ~/${remoteRunDir(i)} on instance ${id} manually.`);
        }
      }
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

