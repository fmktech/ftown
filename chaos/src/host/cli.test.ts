import assert from 'node:assert/strict';
import test from 'node:test';
import type { BuildInfo, SourceFingerprint } from './build.ts';
import { ensureBuild, type EnsureBuildDeps } from './cli.ts';

function sampleBuild(overrides: Partial<BuildInfo> = {}): BuildInfo {
  return {
    image: 'ftown-chaos-box:dev',
    imageId: 'sha256:img1111111111',
    kernelVersion: '6.1.0-54-cloud-amd64',
    vmlinuzSha256: 'vmlinuz',
    initramfsSha256: 'initrd',
    initramfsBytes: 100,
    qemuImageId: 'sha256:qemu1111',
    qemuVersion: '7.2.22',
    sourceFingerprint: '11111111aaaa',
    chaosFingerprint: '22222222bbbb',
    sourceHead: 'head1234',
    sourceDirty: false,
    ...overrides,
  };
}

function sampleFp(overrides: Partial<SourceFingerprint> = {}): SourceFingerprint {
  return {
    sha256: '11111111aaaa',
    chaosSha256: '22222222bbbb',
    head: 'head1234',
    dirty: false,
    chaosDirty: false,
    fileCount: 10,
    ...overrides,
  };
}

test('ensureBuild returns cached build when fingerprint matches', async () => {
  const logs: string[] = [];
  let built = 0;
  const cached = sampleBuild();
  const deps: EnsureBuildDeps = {
    readBuildInfo: () => cached,
    computeFingerprint: async () => sampleFp(),
    build: async () => { built++; return cached; },
    inspectImageId: async () => cached.imageId,
    log: (m) => logs.push(m),
  };
  const info = await ensureBuild(false, deps);
  assert.equal(built, 0);
  assert.equal(info, cached);
  assert.equal(logs.length, 1);
});

test('ensureBuild auto-builds when no cached build exists, and rejects with --no-build', async () => {
  const logs: string[] = [];
  let buildArg: string | null | undefined;
  const fresh = sampleBuild();
  const deps: EnsureBuildDeps = {
    readBuildInfo: () => null,
    computeFingerprint: async () => sampleFp(),
    build: async (img) => { buildArg = img; return fresh; },
    inspectImageId: async () => null,
    log: (m) => logs.push(m),
  };

  await assert.rejects(ensureBuild(true, deps), /no cached build: run `npm run test:chaos -- build` first/);
  assert.equal(buildArg, undefined);

  const info = await ensureBuild(false, deps);
  assert.equal(buildArg, null);
  assert.equal(info, fresh);
  assert.equal(logs[0], 'no cached build: building');
});

test('ensureBuild auto-rebuilds when cached build is stale, and rejects with --no-build', async () => {
  const logs: string[] = [];
  let built = 0;
  const cached = sampleBuild({ sourceFingerprint: 'aaaaaaaa0000' });
  const fresh = sampleBuild({ sourceFingerprint: 'bbbbbbbb1111' });
  const deps: EnsureBuildDeps = {
    readBuildInfo: () => cached,
    computeFingerprint: async () => sampleFp({ sha256: 'bbbbbbbb1111' }),
    build: async () => { built++; return fresh; },
    inspectImageId: async () => cached.imageId,
    log: (m) => logs.push(m),
  };

  await assert.rejects(
    ensureBuild(true, deps),
    /chaos build is stale \(cached aaaaaaaa != current bbbbbbbb\): run `npm run test:chaos -- build` first/,
  );
  assert.equal(built, 0);

  const info = await ensureBuild(false, deps);
  assert.equal(built, 1);
  assert.equal(info, fresh);
  assert.equal(logs[0], 'chaos build is stale (cached aaaaaaaa != current bbbbbbbb): rebuilding');
});

test('ensureBuild checks only chaosFingerprint and imageId for custom-image builds', async () => {
  const logs: string[] = [];
  let builtWith: string | null | undefined;
  const cached = sampleBuild({
    image: 'my-custom:latest',
    imageId: 'sha256:custom999',
    sourceFingerprint: 'custom-image:sha256:custom999',
    chaosFingerprint: '22222222bbbb',
  });
  const deps: EnsureBuildDeps = {
    readBuildInfo: () => cached,
    // Bridge sha256 changed, chaosSha256 unchanged -> NOT stale for custom image
    computeFingerprint: async () => sampleFp({ sha256: 'bridgechanged', chaosSha256: '22222222bbbb' }),
    build: async (img) => { builtWith = img; return cached; },
    inspectImageId: async () => 'sha256:custom999',
    log: (m) => logs.push(m),
  };
  await ensureBuild(false, deps);
  assert.equal(builtWith, undefined);

  // Now chaosSha256 changes -> stale, rebuilds with cached.image
  deps.computeFingerprint = async () => sampleFp({ sha256: 'bridgechanged', chaosSha256: '33333333cccc' });
  await ensureBuild(false, deps);
  assert.equal(builtWith, 'my-custom:latest');
  assert.equal(logs[1], 'chaos build is stale (cached 22222222 != current 33333333): rebuilding');
});
