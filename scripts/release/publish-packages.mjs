import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const PACKAGE_NAMES = ['ftown', 'ftown-bridge'];
const bridgeDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../bridge');

function command(program, args, cwd = bridgeDirectory, timeoutMs) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', timeout: timeoutMs });
  if (result.error) throw result.error;
  return result;
}

function checked(program, args, cwd) {
  const result = command(program, args, cwd);
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

/** Only npm's structured E404 means absent; authentication/network failures stop release. */
export function lookupVersion(name, version, run = command) {
  const result = run('npm', ['view', `${name}@${version}`, '--json']);
  let value;
  try { value = JSON.parse(result.stdout); } catch { /* Invalid output fails closed below. */ }
  if (result.status !== 0) {
    if (value?.error?.code === 'E404') return undefined;
    throw new Error(`Cannot inspect ${name}@${version}: ${result.stderr || result.stdout}`);
  }
  // npm11 returns one record; npm12 returns a singleton array for an exact view.
  if (Array.isArray(value) && value.length === 1) value = value[0];
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.name !== name || value.version !== version) {
    throw new Error(`Invalid registry metadata for ${name}@${version}`);
  }
  return value;
}

/** npm11 pack arrays and npm12 name-keyed maps must identify exactly one artifact. */
export function parsePackResult(output, name, version) {
  let result;
  try { result = JSON.parse(output); } catch { throw new Error(`Invalid npm pack result for ${name}@${version}`); }
  let artifact;
  if (Array.isArray(result) && result.length === 1) artifact = result[0];
  else if (result && typeof result === 'object' && !Array.isArray(result)
    && Object.keys(result).length === 1 && Object.hasOwn(result, name)) artifact = result[name];
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)
    || artifact.name !== name || artifact.version !== version || artifact.filename !== `${name}-${version}.tgz`) {
    throw new Error(`Invalid npm pack result for ${name}@${version}`);
  }
  return artifact;
}

/** PR versions must be unused under both names, regardless of existing gitHead. */
export function assertUnpublishedVersion(version, lookup = lookupVersion) {
  for (const name of PACKAGE_NAMES) {
    if (lookup(name, version) !== undefined) {
      throw new Error(`${name}@${version} is already published. Bump bridge/package.json and its lockfile before merging.`);
    }
  }
}

/** Pure planning seam: an exact existing version is reusable only from this commit. */
export function releasePlan(version, commit, lookup = lookupVersion) {
  return PACKAGE_NAMES.map((name) => {
    const existing = lookup(name, version);
    if (existing !== undefined && existing.gitHead !== commit) {
      throw new Error(`${name}@${version} has a different or missing gitHead. Bump bridge/package.json and its lockfile before releasing this commit.`);
    }
    return { name, publish: existing === undefined };
  });
}

/** After publishing, tolerate only temporarily absent versions, never registry errors/collisions. */
export async function waitForPublishedPackages(version, commit, {
  lookup = (name, version, remaining) => lookupVersion(name, version,
    (program, args) => command(program, args, bridgeDirectory, Math.ceil(remaining))),
  sleep = delay, now = () => performance.now(),
  timeoutMs = 300_000, intervalMs = 10_000, log = console.log,
} = {}) {
  const deadline = now() + timeoutMs;
  const confirmed = new Map();
  const timeoutError = () => new Error(`Timed out waiting for npm visibility: ${PACKAGE_NAMES.filter((name) => !confirmed.has(name)).map((name) => `${name}@${version}`).join(', ')}. Retry this same source commit after registry metadata is visible.`);
  const remainingBudget = () => {
    const remaining = deadline - now();
    if (remaining <= 0) throw timeoutError();
    return remaining;
  };
  for (;;) {
    const pending = releasePlan(version, commit, (name) => {
      if (confirmed.has(name)) return confirmed.get(name);
      let metadata;
      try { metadata = lookup(name, version, remainingBudget()); }
      catch (error) { if (error.code === 'ETIMEDOUT') throw timeoutError(); throw error; }
      remainingBudget();
      if (metadata !== undefined) confirmed.set(name, metadata);
      return metadata;
    }).filter(({ publish }) => publish).map(({ name }) => `${name}@${version}`);
    if (pending.length === 0) return;
    const remaining = remainingBudget();
    log(`Waiting for npm visibility: ${pending.join(', ')} (${Math.ceil(remaining / 1000)}s remaining)`);
    await sleep(Math.min(intervalMs, remaining));
  }
}

export function checkReleaseTag(version, commit, run = command) {
  const tag = `bridge-v${version}`;
  const result = run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  if (result.status !== 0) throw new Error(`Cannot inspect release tag ${tag}: ${result.stderr || result.stdout}`);
  const refs = new Map(result.stdout.trim().split('\n').filter(Boolean).map((line) => line.split(/\s+/).reverse()));
  const existing = refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`);
  if (existing !== undefined && existing !== commit) throw new Error(`${tag} points to another commit. Bump the package version before releasing.`);
  return existing !== undefined;
}

/** One npm-selected payload, repacked twice; only package.json.name differs. Build first. */
export function packPackages(version, commit, outputDirectory) {
  const output = resolve(outputDirectory);
  mkdirSync(output, { recursive: true });
  const temporary = mkdtempSync(join(tmpdir(), 'ftown-publish-'));
  try {
    const source = parsePackResult(checked('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary]), 'ftown-bridge', version);
    checked('tar', ['-xzf', join(temporary, source.filename), '-C', temporary]);
    const stage = join(temporary, 'package');
    const manifestPath = join(stage, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.name !== 'ftown-bridge' || manifest.version !== version) throw new Error('Canonical package name/version changed during release');
    manifest.gitHead = commit;
    return PACKAGE_NAMES.map((name) => {
      writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, name }, null, 2)}\n`);
      const artifact = parsePackResult(checked('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], stage), name, version);
      return { name, path: join(output, artifact.filename) };
    });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export function publishPackages(plan, artifacts, publish = (path) => checked('npm', ['publish', path, '--ignore-scripts', '--provenance', '--access', 'public'])) {
  for (const entry of plan) {
    if (entry.publish) {
      const artifact = artifacts.find(({ name }) => name === entry.name);
      if (!artifact) throw new Error(`Missing artifact for ${entry.name}`);
      publish(artifact.path);
    }
  }
}

async function main() {
  const [action, outputDirectory] = process.argv.slice(2);
  const { version } = JSON.parse(readFileSync(join(bridgeDirectory, 'package.json'), 'utf8'));
  if (action === 'check-version') {
    assertUnpublishedVersion(version);
    console.log(`Both npm package names are available at ${version}.`);
    return;
  }
  const commit = checked('git', ['rev-parse', 'HEAD']);
  if (action === 'pack') {
    if (!outputDirectory) throw new Error('Usage: node scripts/publish-packages.mjs pack OUTPUT_DIRECTORY');
    console.log(JSON.stringify(packPackages(version, commit, outputDirectory), null, 2));
    return;
  }
  if (!['preflight', 'publish', 'tag'].includes(action)) throw new Error('Expected check-version, preflight, pack, publish or tag');
  if (action === 'tag') {
    checkReleaseTag(version, commit);
    await waitForPublishedPackages(version, commit);
    if (!checkReleaseTag(version, commit)) checked('git', ['push', 'origin', `${commit}:refs/tags/bridge-v${version}`]);
    return;
  }
  const plan = releasePlan(version, commit);
  const tagged = checkReleaseTag(version, commit);
  if (action === 'preflight') {
    console.log(JSON.stringify({ version, commit, plan, tagged }));
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
  } else {
    const temporary = mkdtempSync(join(tmpdir(), 'ftown-artifacts-'));
    try { publishPackages(plan, packPackages(version, commit, temporary)); }
    finally { rmSync(temporary, { recursive: true, force: true }); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
