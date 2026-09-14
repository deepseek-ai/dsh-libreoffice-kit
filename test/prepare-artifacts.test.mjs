import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { npmDirectoryFixture } from './archive-fixture.mjs';
import { spawnSync } from 'node:child_process';
import { artifactPlan, fetchPrebuilt, verifyPreparedEngine } from '../scripts/prepare-artifacts.mjs';
import { packEngineArchive } from '../scripts/engine-archive.mjs';
import { readJson, releaseRepository, releaseTag, root } from '../scripts/platform-matrix.mjs';
import { sha256 } from '../scripts/verify-artifacts.mjs';
import { source, configureFlags } from '../engine/native/configure.mjs';
import { corePatchFiles } from '../engine/native/core-patches.mjs';
import { run } from '../scripts/pack-utils.mjs';

test('runtime targets select the entry release matrix and mandatory WASM', () => {
  assert.deepEqual(artifactPlan('node24-linux-x64,node24-win-x64'), ['win32-x64', 'wasm']);
  assert.deepEqual(artifactPlan('node24-macos-arm64,node24-linux-arm64'), ['darwin-arm64', 'wasm']);
  assert.throws(() => artifactPlan('node24-linux-x64,'), /Unknown or empty/);
  assert.throws(() => artifactPlan('node24-freebsd-x64'), /Unknown or empty/);
});

test('CI explicitly builds source without configured credentials and still rejects unknown targets', t => {
  const directory = mkdtempSync(join(tmpdir(), 'office-unconfigured-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'output');
  const env = { ...process.env, LIBREOFFICE_KIT_GITHUB_TOKEN: '', GITHUB_OUTPUT: output };
  const cli = platform => spawnSync(process.execPath, [join(root, 'scripts/prepare-artifacts.mjs'), platform, '--build-if-unconfigured'], { env, encoding: 'utf8' });
  const result = cli('wasm');
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Internal release access is not configured/);
  assert.equal(readFileSync(output, 'utf8'), 'found=false\n');
  const invalid = cli('unknown');
  assert.equal(invalid.signal, null);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Unknown engine platform/);
});

test('only a GitHub Release index 404 authorizes compilation', async () => {
  assert.equal(await fetchPrebuilt('wasm', { fetchImpl: async () => new Response(null, { status: 404 }) }), false);
  for (const status of [401, 403, 429, 500, 503]) {
    await assert.rejects(fetchPrebuilt('wasm', { fetchImpl: async () => new Response(null, { status }) }), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(fetchPrebuilt('wasm', { fetchImpl: async () => { throw new Error('network unavailable'); } }), /network unavailable/);
  await assert.rejects(fetchPrebuilt('wasm', { fetchImpl: async () => new Response('not json') }), SyntaxError);
});

function fixture(t, platform = 'darwin-arm64') {
  const work = mkdtempSync(join(tmpdir(), 'office-artifacts-test-'));
  t.after(() => rmSync(work, { recursive: true, force: true, maxRetries: 3 }));
  const repo = join(work, 'repo');
  const directory = join(work, 'package');
  mkdirSync(directory);
  cpSync(join(root, 'engine'), join(repo, 'engine'), { recursive: true,
    filter: file => file !== join(root, 'engine/core') && !file.includes('/reference/') });
  writeFileSync(join(repo, 'core-source.json'), JSON.stringify(source));
  mkdirSync(join(repo, 'scripts'));
  for (const file of ['stage-native.mjs', 'slim-native.mjs']) cpSync(join(root, 'scripts', file), join(repo, 'scripts', file));
  writeFileSync(join(repo, 'package.json'), JSON.stringify(readJson(join(root, 'package.json'))));
  const manifest = readJson(join(root, 'packages', platform, 'package.json'));
  const target = join(repo, 'packages', platform);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
  const prebuild = { ...readJson(join(root, 'packages', platform, 'prebuilds.json')), status: 'built', files: {} };
  if (platform !== 'wasm') prebuild.engine = { kind: 'native', executable: 'bin/libreoffice-kit', programDirectory: 'program' };
  const put = (path, bytes) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), bytes);
    prebuild.files[path] = sha256(join(directory, path));
  };
  if (platform === 'wasm') {
    // Stub exports validate packaging without executing an Office conversion.
    put(prebuild.engine.wasm, Buffer.from('AGFzbQEAAAABBAFgAAADCQgAAAAAAAAAAAeXAQgSZHNoX2xva19pbml0aWFsaXplAAAVZHNoX2xva19kb2N1bWVudF9sb2FkAAEZZHNoX2xva19kb2N1bWVudF9zYXZlX3BkZgACGGRzaF9sb2tfZG9jdW1lbnRfZGVzdHJveQADD2RzaF9sb2tfZGVzdHJveQAEDWRzaF9sb2tfZXJyb3IABQZtYWxsb2MABgRmcmVlAAcKGQgCAAsCAAsCAAsCAAsCAAsCAAsCAAsCAAs=', 'base64'));
    put(prebuild.engine.loader, 'module.exports = () => {};');
    put(prebuild.engine.data, 'fixture');
    put(prebuild.engine.metadata, JSON.stringify({ remote_package_size: 7, files: [{ filename: '/instdir/program/resource', start: 0, end: 7 }] }));
  } else {
    // A complete Mach-O code segment passes packaging validation without executing native code.
    const binary = Buffer.alloc(104);
    binary.writeUInt32LE(0xfeedfacf, 0); binary.writeUInt32LE(0x0100000c, 4); binary.writeUInt32LE(2, 12);
    binary.writeUInt32LE(1, 16); binary.writeUInt32LE(72, 20); binary.writeUInt32LE(0x19, 32);
    binary.writeUInt32LE(72, 36); binary.writeBigUInt64LE(104n, 80); binary.writeUInt32LE(4, 92);
    put('bin/libreoffice-kit', binary);
    chmodSync(join(directory, 'bin/libreoffice-kit'), 0o755);
    put('program/resource', 'fixture');
  }
  put('licenses/MPL.txt', 'MPL-2.0 fixture');
  prebuild.licenses = [{ component: 'LibreOffice', spdx: 'MPL-2.0', path: 'licenses/MPL.txt' }];
  const wasm = platform === 'wasm';
  const files = ['engine/build-identity.mjs', ...(wasm
    ? ['engine/core-source.mjs', ...['source.json', 'source.mjs', 'autogen.input', 'lok.cxx', 'build.mjs', 'stage.mjs', 'slim.mjs', ...readdirSync(join(root, 'engine/wasm-source/patches')).map(file => `patches/${file}`)].map(file => `engine/wasm-source/${file}`)]
    : ['engine/core-source.mjs', 'engine/native/worker.cxx', 'engine/native/configure.mjs', 'engine/native/core-patches.mjs', 'scripts/stage-native.mjs', 'scripts/slim-native.mjs', ...corePatchFiles()])];
  for (const file of files) put(`sources/${file}`, readFileSync(join(root, file)));
  put('sources/core-source.json', JSON.stringify(source));
  if (!wasm) {
    put('sources/core.json', JSON.stringify({ configure: configureFlags(platform, '/tarballs', 8) }));
  }
  prebuild.source = { ...source, version: '26.8.0.3', files: ['sources/core-source.json', ...files.map(file => `sources/${file}`)] };
  writeFileSync(join(directory, 'prebuilds.json'), JSON.stringify(prebuild));
  const archive = join(work, 'engine.tgz');
  writeFileSync(archive, npmDirectoryFixture(directory));
  const record = { name: manifest.name, version: manifest.version, platform, ...packEngineArchive(archive, work, manifest) };
  const bytes = readFileSync(join(work, record.file));
  const metadata = { repository: releaseRepository, tag: releaseTag(manifest.version), version: manifest.version,
    packages: [record] };
  const fetchImpl = async url => String(url).endsWith('.tar.xz') ? new Response(bytes) : Response.json(metadata);
  return { work, repo, directory, target, metadata, fetchImpl };
}

test('verified downloads stage payload while retaining workspace metadata', async t => {
  const f = fixture(t);
  const manifest = readFileSync(join(f.target, 'package.json'), 'utf8');
  assert.equal(await fetchPrebuilt('darwin-arm64', f), true);
  assert.equal(readFileSync(join(f.target, 'package.json'), 'utf8'), manifest);
  assert.equal(verifyPreparedEngine('darwin-arm64', f.target, f.repo).platform, 'darwin-arm64');
  writeFileSync(join(f.target, 'program/resource'), 'corrupt');
  assert.throws(() => verifyPreparedEngine('darwin-arm64', f.target, f.repo), /checksum mismatch/);
});

test('tarball failures and integrity errors never become source-build fallback', async t => {
  const f = fixture(t);
  for (const status of [404, 503]) await assert.rejects(fetchPrebuilt('darwin-arm64', {
    repo: f.repo,
    fetchImpl: async url => String(url).endsWith('.tar.xz') ? new Response(null, { status }) : Response.json(f.metadata),
  }), new RegExp(`tarball request failed: HTTP ${status}`));
  f.metadata.packages[0].sha256 = '0'.repeat(64);
  await assert.rejects(fetchPrebuilt('darwin-arm64', f), /integrity mismatch/);
});

test('the release index cannot redirect an engine to another repository, version, target or file', async t => {
  const f = fixture(t);
  for (const change of [
    index => { index.repository = 'other/repository'; },
    index => { index.version = '0.0.0'; },
    index => { index.tag = 'other-tag'; },
    index => { index.packages[0].file = '../../other.tgz'; },
    index => { index.packages[0].platform = 'wasm'; },
    index => { index.packages.push(index.packages[0]); },
    index => { index.packages[0].bytes = 0; },
    index => { index.packages[0].sha256 = 'unknown'; },
  ]) {
    const metadata = structuredClone(f.metadata);
    change(metadata);
    await assert.rejects(fetchPrebuilt('darwin-arm64', { repo: f.repo, fetchImpl: async () => Response.json(metadata) }),
      /mismatch|exactly once|byte count|integrity|transfer filename/);
  }
});

test('a changed patch or wrong package version rejects an otherwise valid engine', t => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'engine/native/worker.cxx'), 'different helper');
  assert.throws(() => verifyPreparedEngine('darwin-arm64', f.directory, f.repo), /source differs/);
  const manifest = readJson(join(f.directory, 'package.json'));
  writeFileSync(join(f.directory, 'package.json'), JSON.stringify({ ...manifest, version: '0.0.0' }));
  assert.throws(() => verifyPreparedEngine('darwin-arm64', f.directory, f.repo), /package\/version mismatch/);
});

for (const platform of ['wasm', 'darwin-arm64']) test(`${platform} prepared engines reject removed source patches`, t => {
  const f = fixture(t, platform);
  assert.equal(verifyPreparedEngine(platform, f.directory, f.repo).platform, platform);
  const patches = platform === 'wasm' ? 'engine/wasm-source/patches' : 'engine/native/patches';
  const patch = readdirSync(join(f.repo, patches)).find(file => file.endsWith('.patch'));
  assert.ok(patch);
  rmSync(join(f.repo, patches, patch));
  assert.throws(() => verifyPreparedEngine(platform, f.directory, f.repo), /patch set differs/);
});

test('native prepared engines reject obsolete recorded component selection even with current source scripts', t => {
  const { directory, repo } = fixture(t);
  const prebuild = readJson(join(directory, 'prebuilds.json'));
  const file = 'sources/core.json';
  writeFileSync(join(directory, file), JSON.stringify({ configure: configureFlags('darwin-arm64', '/cache', 8).filter(flag => flag !== '--disable-scripting') }));
  prebuild.files[file] = sha256(join(directory, file));
  writeFileSync(join(directory, 'prebuilds.json'), JSON.stringify(prebuild));
  assert.throws(() => verifyPreparedEngine('darwin-arm64', directory, repo), /rebuild Core/);
});
