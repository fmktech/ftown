import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const query = `query($owner:String!, $repo:String!, $tag:String!) {
  repository(owner:$owner, name:$repo) {
    release(tagName:$tag) { isDraft releaseAssets(first:100) { nodes { name digest } } }
  }
}`;

async function fileDigest(name) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(name)) hash.update(bytes);
  return 'sha256:' + hash.digest('hex');
}

class ReleaseNotReady extends Error {}

function retryable(error) {
  if (error instanceof ReleaseNotReady) return true;
  return /\bHTTP (?:408|429|5\d\d)\b|\b(?:connection reset by peer|TLS handshake timeout|i\/o timeout|unexpected EOF)\b/i.test(String(error.stderr));
}

function gh(...args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export async function publishPanel({ repository, version, sha }, run = gh, sleep = delay) {
  const tag = 'ui-v' + version;
  const bundle = `ftown-ui-standalone-${version}.tar.gz`;
  const files = [bundle, bundle + '.sha256'];
  const digests = new Map(await Promise.all(files.map(async name => [name, await fileDigest(name)])));
  const [owner, repo] = repository.split('/');
  function lookup() {
    const output = run('api', 'graphql', '-f', 'query=' + query, '-f', 'owner=' + owner, '-f', 'repo=' + repo, '-f', 'tag=' + tag);
    return JSON.parse(output).data.repository.release;
  }
  function missing(release) {
    return files.filter(name => !release.releaseAssets.nodes.some(asset => asset.name === name && asset.digest === digests.get(name)));
  }

  // Re-read the release after an uncertain write. GitHub may already have applied it.
  for (let attempt = 1; ; attempt++) {
    try {
      let release = lookup();
      if (release === null) {
        run('release', 'create', tag, '--repo', repository, '--draft', '--target', sha, '--title', 'Solo panel ' + tag,
          '--notes', 'Standalone panel bundle for `ftown-bridge --solo`. Fetched automatically by bridge >= 0.19.20.');
        release = lookup();
        if (!release) throw new ReleaseNotReady('Created draft is not visible yet');
      }
      const pending = missing(release);
      if (pending.length) {
        run('release', 'upload', tag, ...pending, '--repo', repository, '--clobber');
        release = lookup();
        if (!release || missing(release).length) throw new ReleaseNotReady('Uploaded assets do not yet match the local SHA-256 digests');
      }
      if (release.isDraft) {
        run('release', 'edit', tag, '--repo', repository, '--draft=false');
        release = lookup();
        if (!release || release.isDraft || missing(release).length) throw new ReleaseNotReady('Published assets are not yet visible');
      }
      console.log(`Verified both assets of published release ${tag}`);
      return;
    } catch (error) {
      if (attempt >= 4 || !retryable(error)) throw error;
      const seconds = 2 ** attempt;
      console.warn(`Panel release attempt ${attempt} failed: ${error.stderr || error.message}. Checking again in ${seconds}s.`);
      await sleep(seconds * 1000);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await publishPanel({ repository: process.env.GITHUB_REPOSITORY, version: process.env.VERSION, sha: process.env.GITHUB_SHA });
}
