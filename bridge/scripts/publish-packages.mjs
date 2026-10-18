import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAMES = ['ftown', 'ftown-bridge'];
const bridgeDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function command(program, args, cwd = bridgeDirectory) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' });
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

function main() {
  const [action, outputDirectory] = process.argv.slice(2);
  const { version } = JSON.parse(readFileSync(join(bridgeDirectory, 'package.json'), 'utf8'));
  const commit = checked('git', ['rev-parse', 'HEAD']);
  if (action === 'pack') {
    if (!outputDirectory) throw new Error('Usage: node scripts/publish-packages.mjs pack OUTPUT_DIRECTORY');
    console.log(JSON.stringify(packPackages(version, commit, outputDirectory), null, 2));
    return;
  }
  if (!['preflight', 'publish', 'tag'].includes(action)) throw new Error('Expected preflight, pack, publish or tag');
  const plan = releasePlan(version, commit);
  const tagged = checkReleaseTag(version, commit);
  if (action === 'preflight') {
    console.log(JSON.stringify({ version, commit, plan, tagged }));
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
  } else if (action === 'publish') {
    const temporary = mkdtempSync(join(tmpdir(), 'ftown-artifacts-'));
    try { publishPackages(plan, packPackages(version, commit, temporary)); }
    finally { rmSync(temporary, { recursive: true, force: true }); }
  } else {
    if (plan.some(({ publish }) => publish)) throw new Error('Both npm packages must exist from this commit before tagging');
    if (!tagged) checked('git', ['push', 'origin', `${commit}:refs/tags/bridge-v${version}`]);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
