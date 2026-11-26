import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { publishPanel } from './publish-panel.mjs';

const release = { repository: 'owner/repo', version: '1.2.3', sha: '1'.repeat(40) };
const bundle = 'ftown-ui-standalone-1.2.3.tar.gz';
const sidecar = bundle + '.sha256';
const hash = text => createHash('sha256').update(text).digest('hex');
const checksum = hash('bundle bytes') + '\n';
const assets = [
  { name: bundle, digest: 'sha256:' + hash('bundle bytes') },
  { name: sidecar, digest: 'sha256:' + hash(checksum) },
];
const originalDir = process.cwd();
let scratch;
before(() => {
  scratch = mkdtempSync(join(tmpdir(), 'ftown-panel-release-'));
  process.chdir(scratch);
  writeFileSync(bundle, 'bundle bytes');
  writeFileSync(sidecar, checksum);
});
after(() => {
  process.chdir(originalDir);
  rmSync(scratch, { recursive: true, force: true });
});

const reply = release => JSON.stringify({ data: { repository: { release } } });
const httpError = code => Object.assign(new Error('gh failed'), { stderr: 'HTTP ' + code });

for (const createdBeforeError of [false, true]) {
  test(`recovers a create HTTP 500 with draft persisted = ${createdBeforeError}, then resumes partial writes`, async () => {
    let remote = null;
    let createCount = 0;
    const uploads = [];
    let publishCount = 0;
    const run = (command, action, ...args) => {
      if (command === 'api') return reply(remote);
      if (action === 'create') {
        assert.ok(args.includes('--draft'));
        assert.equal(args[args.indexOf('--target') + 1], release.sha);
        createCount++;
        if (createdBeforeError || createCount > 1) remote = { isDraft: true, releaseAssets: { nodes: [] } };
        if (createCount === 1) throw httpError(500);
        return;
      }
      if (action === 'upload') {
        const names = args.filter(arg => arg === bundle || arg === sidecar);
        uploads.push(names);
        remote.releaseAssets.nodes.push(assets.find(asset => asset.name === names[0]));
        if (uploads.length === 1) throw httpError(502);
        return;
      }
      assert.equal(action, 'edit');
      assert.deepEqual(remote.releaseAssets.nodes, assets);
      remote.isDraft = false;
      publishCount++;
      throw httpError(503);
    };
    await publishPanel(release, run, async () => {});
    assert.equal(createCount, createdBeforeError ? 1 : 2);
    assert.deepEqual(uploads, [[bundle, sidecar], [sidecar]]);
    assert.equal(publishCount, 1);
  });
}

test('a failed lookup never creates a release and persistent upstream failures stop after four attempts', async () => {
  for (const [code, attempts] of [[403, 1], [500, 4]]) {
    let reads = 0;
    await assert.rejects(publishPanel(release, command => {
      assert.equal(command, 'api');
      reads++;
      throw httpError(code);
    }, async () => {}), /gh failed/);
    assert.equal(reads, attempts);
  }
});

test('re-cutting a published release replaces only assets whose digest changed', async () => {
  const remote = { isDraft: false, releaseAssets: { nodes: [assets[0], { name: sidecar, digest: 'wrong' }] } };
  let uploads = 0;
  await publishPanel(release, (command, action, ...args) => {
    if (command === 'api') return reply(remote);
    assert.equal(action, 'upload');
    assert.ok(args.includes(sidecar) && !args.includes(bundle));
    remote.releaseAssets.nodes = assets;
    uploads++;
  }, async () => {});
  assert.equal(uploads, 1);
});
