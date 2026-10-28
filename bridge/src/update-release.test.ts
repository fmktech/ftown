import { describe, it } from 'node:test';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChildProcess } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpdateReleaseApi, createStagingEnvironment, waitForUpdateChild, supportsNode, validateStableMetadata } from './update-release.js';

const tar = Buffer.from('fixture tarball');
const integrity = `sha512-${createHash('sha512').update(tar).digest('base64')}`;
const metadata = { name: 'ftown', version: '1.2.3', gitHead: 'a'.repeat(40), dist: { tarball: 'https://registry.npmjs.org/ftown/-/ftown-1.2.3.tgz', integrity }, engines: { node: '^24.22.1 || >=26.12.1' } };
describe('bounded stable update release', () => {
  it('uses separate private npm configs that the installed npm can read offline', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'ftown-npm-config-')));
    try {
      const env = await createStagingEnvironment(home, join(home, 'cache'));
      assert.notEqual(env.NPM_CONFIG_USERCONFIG, env.NPM_CONFIG_GLOBALCONFIG);
      const npm = join(process.execPath, '..', 'npm');
      const result = await promisify(execFile)(npm, ['config', 'get', 'registry'], { env, timeout: 10_000 });
      assert.equal(new URL(result.stdout.trim()).href, 'https://registry.npmjs.org/');
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('bounds missing child-exit proof and distinguishes a confirmed close', async () => {
    const noClose = new EventEmitter() as ChildProcess; let stops = 0;
    await assert.rejects(waitForUpdateChild(noClose, () => { stops++; }, 5, 5), (e: unknown) => (e as { code?: string }).code === 'update_process_uncertain');
    assert.equal(stops, 1);
    const closed = new EventEmitter() as ChildProcess;
    const result = waitForUpdateChild(closed, () => { closed.emit('close', null); }, 5, 5);
    await assert.rejects(result, (e: unknown) => (e as { code?: string }).code !== 'update_process_uncertain');
  });
  it('accepts canonical fixed-origin metadata and rejects unsafe or incompatible values', () => {
    assert.equal(validateStableMetadata(metadata, '24.22.1').version, '1.2.3');
    assert.equal(supportsNode(metadata.engines.node, '24.22.0'), false);
    for (const bad of [
      { ...metadata, version: '1.2.3-beta.1' }, { ...metadata, version: '01.2.3' },
      { ...metadata, gitHead: 'abc' }, { ...metadata, name: 'ftown-bridge' },
      { ...metadata, dist: { ...metadata.dist, tarball: 'https://example.invalid/file' } },
      { ...metadata, dist: { ...metadata.dist, integrity: 'sha512-invalid' } },
      { ...metadata, engines: { node: '>=999.0.0' } },
    ]) assert.throws(() => validateStableMetadata(bad, '24.22.1'));
  });
  it('stages only verified bytes and candidate protocol, and removes its own stage on failures', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'ftown-update-unit-'))); const previous = process.env.HOME; process.env.HOME = home;
    try {
      const root = join(home, '.ftown', 'updates'); const operationId = randomUUID();
      const release = validateStableMetadata(metadata, '24.22.1'); let nativeFailed = false; let protocol = 1;
      const api = createUpdateReleaseApi({ nowNode: '24.22.1', currentVersion: async () => '1.0.0',
        read: async url => url.endsWith('/latest') ? Buffer.from(JSON.stringify(metadata)) : tar,
        run: async (_binary, args, env, cwd) => {
          assert.equal(env.NPM_CONFIG_REGISTRY, 'https://registry.npmjs.org');
          assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.FTOWN_TOKEN, undefined);
          if (args[0] === 'install') {
            const candidate = join(cwd, 'install', 'node_modules', 'ftown'); await mkdir(join(candidate, 'dist'), { recursive: true });
            await writeFile(join(candidate, 'package.json'), JSON.stringify({ name: 'ftown', version: '1.2.3', ftownUpdateProtocol: protocol }));
            await writeFile(join(candidate, 'dist', 'ftown-cli.js'), '');
          } else if (nativeFailed) throw new Error('native failure');
        } });
      assert.deepEqual(await api.resolveStableRelease(new AbortController().signal), release);
      const stage = await api.prepareRelease(release, { operationId, stagingRoot: root, signal: new AbortController().signal });
      assert.equal(stage.targetVersion, '1.2.3'); await api.discardPreparedRelease(stage);
      await assert.rejects(access(stage.jobDir));
      protocol = 0; const incompatible = randomUUID();
      await assert.rejects(api.prepareRelease(release, { operationId: incompatible, stagingRoot: root, signal: new AbortController().signal }));
      await assert.rejects(access(join(root, incompatible)));
      const uncertain = randomUUID();
      const unproven = createUpdateReleaseApi({ nowNode: '24.22.1', currentVersion: async () => '1.0.0', read: async () => tar,
        run: async () => { throw Object.assign(new Error('unproven'), { code: 'update_process_uncertain' }); } });
      await assert.rejects(unproven.prepareRelease(release, { operationId: uncertain, stagingRoot: root, signal: new AbortController().signal }), (e: unknown) => (e as { code?: string }).code === 'update_process_uncertain');
      await access(join(root, uncertain, 'owner.json'));
      protocol = 1; nativeFailed = true; const failed = randomUUID();
      await assert.rejects(api.prepareRelease(release, { operationId: failed, stagingRoot: root, signal: new AbortController().signal }));
      await assert.rejects(access(join(root, failed)));
      await assert.rejects(api.prepareRelease({ ...release, tarballUrl: 'https://example.invalid/file' }, { operationId: randomUUID(), stagingRoot: root, signal: new AbortController().signal }));
      const wrong = randomUUID(); const corrupt = createUpdateReleaseApi({ nowNode: '24.22.1', currentVersion: async () => '1.0.0', read: async () => Buffer.from('wrong') });
      await assert.rejects(corrupt.prepareRelease(release, { operationId: wrong, stagingRoot: root, signal: new AbortController().signal }));
      await assert.rejects(access(join(root, wrong)));
      const aborted = new AbortController(); aborted.abort();
      await assert.rejects(api.prepareRelease(release, { operationId: randomUUID(), stagingRoot: root, signal: aborted.signal }));
      const noUpgrade = createUpdateReleaseApi({ nowNode: '24.22.1', currentVersion: async () => '1.2.3' });
      await assert.rejects(noUpgrade.prepareRelease(release, { operationId: randomUUID(), stagingRoot: root, signal: new AbortController().signal }));
    } finally { process.env.HOME = previous; await rm(home, { recursive: true, force: true }); }
  });
});
