import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import test from 'node:test';
import { npmFixture } from './archive-fixture.mjs';
import { packEngineArchive } from '../scripts/engine-archive.mjs';
import { prepareNpmRelease } from '../scripts/prepare-npm-release.mjs';
import { enginePrefix, kitManifest, releaseTag, releaseTargets, sourceRepository, tarballName } from '../scripts/platform-matrix.mjs';
import { sha256 } from '../scripts/verify-artifacts.mjs';
import { downloadRegistryArchive, npmRegistry, npmVersionState, publishNpmPackages, publishNpmRelease, validateDistTag, validateNpmPublication } from '../scripts/publish-npm-release.mjs';

// These small archives test the publication boundary, not real engine qualification.
function fixture(t, changeManifest = manifest => manifest) {
  const directory = mkdtempSync(join(tmpdir(), 'kit-npm-publisher-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));
  const destination = join(directory, 'npm');
  const adapterManifest = kitManifest();
  const version = adapterManifest.version;
  const env = { GITHUB_REF: `refs/tags/${releaseTag(version)}`, GITHUB_SHA: '1'.repeat(40) };
  const platforms = releaseTargets([]);
  const packages = platforms.map((platform, index) => {
    const manifest = changeManifest({ name: `${enginePrefix}-${platform}`, version, publishConfig: { access: 'public' },
      repository: { type: 'git', url: `git+https://github.com/${sourceRepository}.git` } }, index);
    const gzip = join(directory, tarballName(manifest));
    writeFileSync(gzip, npmFixture(manifest, { 'package/bin/worker': 'fixture engine' }));
    const record = { name: manifest.name, version, platform, ...packEngineArchive(gzip, directory, manifest) };
    rmSync(gzip);
    return record;
  });
  const release = { schemaVersion: 1, version, platforms, packages, dependencies: [] };
  const save = (file, value) => writeFileSync(join(directory, file), `${JSON.stringify(value)}\n`);
  save('release.json', release);
  const releaseManifestSha256 = sha256(join(directory, 'release.json'));
  const adapterFile = tarballName(adapterManifest);
  writeFileSync(join(directory, adapterFile), npmFixture(adapterManifest, { 'package/lib/index.js': 'export const fixture = true;' }));
  const adapter = { sha256: sha256(join(directory, adapterFile)) };
  save('verification.json', { sourceCommit: env.GITHUB_SHA, releaseManifestSha256, platforms: platforms.map(platform => ({
    platform, sourceCommit: env.GITHUB_SHA, releaseManifestSha256, nativeInstalled: platform !== 'wasm', wasmInstalled: platform === 'wasm', passed: true,
    [platform === 'wasm' ? 'wasm' : 'native']: { adapter, embeddedGraphics: { pdfInEmf: true },
      formats: Object.fromEntries(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].map(format => [format, { backend: platform === 'wasm' ? 'wasm' : 'native', pdfBytes: 200 }])) },
  })) });
  const publication = prepareNpmRelease(directory, destination, env);
  const savePublication = () => writeFileSync(join(destination, 'npm-publication.json'), `${JSON.stringify(publication)}\n`);
  return { directory, destination, env, release, publication, savePublication };
}

test('npm validation binds every prepared archive to the qualified candidate and keeps engines before the adapter', async t => {
  const { directory, destination, env, publication, release } = fixture(t);
  const validated = await validateNpmPublication(directory, destination, env);
  assert.deepEqual(validated.packages.map(record => record.name), publication.packages.map(record => record.name));
  assert.equal(validated.packages.at(-1).name, kitManifest().name);
  assert.equal(validated.packages.at(-1).engineInstall, undefined);
  assert.deepEqual(validated.packages[0].engineInstall, { bytes: release.packages[0].install.bytes, sha256: release.packages[0].install.sha256 });
  for (const record of validated.packages) {
    assert.equal(record.integrity, `sha512-${createHash('sha512').update(readFileSync(record.path)).digest('base64')}`);
  }
  const result = await publishNpmRelease(directory, destination, { env, tag: 'latest', validateOnly: true,
    run() { assert.fail('validation must not contact npm'); } });
  assert.deepEqual(result, { validated: publication.packages.length, version: kitManifest().version, tag: 'latest' });
});

test('npm validation rejects the wrong source, candidate, inventory, order and archive checksum', async t => {
  const value = fixture(t);
  const { directory, destination, env, publication, savePublication } = value;
  const original = structuredClone(publication);
  for (const [change, message] of [
    [() => { publication.sourceCommit = '2'.repeat(40); }, /different source commit/],
    [() => { publication.releaseManifestSha256 = '2'.repeat(64); }, /different qualified candidate/],
    [() => { publication.packages.pop(); }, /every declared package/],
    [() => { publication.packages.reverse(); }, /identity or canonical order/],
    [() => { publication.packages[0].file = '../wrong.tgz'; }, /identity or canonical order/],
    [() => { publication.packages[0].sha256 = '2'.repeat(64); }, /checksum mismatch/],
  ]) {
    Object.assign(publication, structuredClone(original));
    change();
    savePublication();
    await assert.rejects(validateNpmPublication(directory, destination, env), message);
  }
  Object.assign(publication, original);
  savePublication();
  writeFileSync(join(destination, 'publish-order.txt'), `${publication.packages.toReversed().map(record => record.file).join('\n')}\n`);
  await assert.rejects(validateNpmPublication(directory, destination, env), /publish order/);
});

test('a rehashed replacement npm engine still fails the qualified inner-tar comparison', async t => {
  const { directory, destination, env, publication, savePublication } = fixture(t);
  const record = publication.packages[0];
  const file = join(destination, record.file);
  writeFileSync(file, npmFixture({ name: record.name, version: record.version }, { 'package/bin/worker': 'different engine' }));
  record.bytes = statSync(file).size;
  record.sha256 = sha256(file);
  savePublication();
  await assert.rejects(validateNpmPublication(directory, destination, env), /qualified installation tar|qualified engine tar size/);
});

test('a rehashed replacement Node API still fails the qualified archive comparison', async t => {
  const { directory, destination, env, publication, savePublication } = fixture(t);
  const record = publication.packages.at(-1);
  const file = join(destination, record.file);
  writeFileSync(file, npmFixture(kitManifest(), { 'package/lib/index.js': 'different API' }));
  record.bytes = statSync(file).size;
  record.sha256 = sha256(file);
  savePublication();
  await assert.rejects(validateNpmPublication(directory, destination, env), /Node API differs/);
});

test('npm validation rejects private archives, alternate registries and an unrelated repository', async t => {
  for (const [change, message] of [
    [manifest => ({ ...manifest, private: true }), /permit public publication/],
    [manifest => ({ ...manifest, publishConfig: { access: 'public', registry: 'https://example.com/' } }), /unexpected publication registry/],
    [manifest => ({ ...manifest, repository: 'https://github.com/example/another' }), /match the source repository/],
  ]) {
    const { directory, destination, env } = fixture(t, (manifest, index) => index === 0 ? change(manifest) : manifest);
    await assert.rejects(validateNpmPublication(directory, destination, env), message);
  }
});

const integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
const otherIntegrity = `sha512-${Buffer.alloc(64, 2).toString('base64')}`;
const family = () => ({ version: '1.0.0', packages: ['engine-a', 'engine-b', 'entry'].map(name => ({ name: `@deepseek-ai/${name}`,
  version: '1.0.0', path: `/temporary/${name}.tgz`, integrity })) });
const absent = () => ({ status: 1, stdout: JSON.stringify({ error: { code: 'E404' } }), stderr: '' });
const present = (value = integrity) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
const failure = code => ({ status: 1, stdout: JSON.stringify({ error: { code, summary: 'diagnostic-redacted-value' } }), stderr: '' });
const quiet = { sleep: async () => {}, log() {} };

test('the entire registry family is preflighted before any publish, in engine-first order', async () => {
  const calls = [];
  const publication = family();
  const result = await publishNpmPackages(publication, { ...quiet, tag: 'latest', run(args) {
    calls.push(args);
    return args[0] === 'view' ? absent() : { status: 0 };
  } });
  assert.deepEqual(calls.slice(0, 3).map(args => args[0]), ['view', 'view', 'view']);
  assert.deepEqual(calls.slice(3), publication.packages.map(record => ['publish', record.path, '--ignore-scripts', '--access', 'public',
    '--tag', 'latest', '--registry', npmRegistry, '--provenance=false', '--json']));
  assert.deepEqual(result, { published: 3, skipped: 0 });
});

test('a conflict on the last version rejects before writing any package', async () => {
  let writes = 0;
  await assert.rejects(publishNpmPackages(family(), { ...quiet, tag: 'latest', run(args) {
    if (args[0] === 'publish') writes++;
    return args[1].startsWith('@deepseek-ai/entry@') ? present(otherIntegrity) : absent();
  } }), /already exists with different bytes/);
  assert.equal(writes, 0);
});

test('identical versions are skipped so a partially published artifact can be retried', async () => {
  const calls = [];
  const result = await publishNpmPackages(family(), { ...quiet, tag: 'latest', run(args) {
    calls.push(args);
    return args[0] === 'view' ? (args[1].includes('engine-a@') ? present() : absent()) : { status: 0 };
  } });
  assert.deepEqual(result, { published: 2, skipped: 1 });
  assert.deepEqual(calls.filter(args => args[0] === 'publish').map(args => args[1]), ['/temporary/engine-b.tgz', '/temporary/entry.tgz']);
});

test('only an explicit npm 404 establishes absence; authentication and transport failures stop', () => {
  const record = family().packages[0];
  assert.deepEqual(npmVersionState(record, absent), { kind: 'absent' });
  for (const code of ['E401', 'E403', 'E429', 'E503', 'ETIMEDOUT']) {
    assert.throws(() => npmVersionState(record, () => failure(code)), error => error.message.includes(code) && !error.message.includes('diagnostic-redacted-value'));
  }
  assert.throws(() => npmVersionState(record, () => ({ status: 1, stderr: 'Some text mentioned E404 but no registry response' })), /UNKNOWN/);
  assert.throws(() => npmVersionState(record, () => ({ status: 0, stdout: '""' })), /invalid integrity/);
});

test('a failed response after a landed write is accepted only when the registry integrity matches', async () => {
  const publication = family();
  publication.packages = publication.packages.slice(0, 1);
  let writes = 0;
  const result = await publishNpmPackages(publication, { ...quiet, tag: 'latest', run(args) {
    if (args[0] === 'view') return writes ? present() : absent();
    writes++;
    return failure('E409');
  } });
  assert.equal(writes, 1);
  assert.deepEqual(result, { published: 1, skipped: 0 });
});

test('transient failures retry with bounded backoff and registry rechecks', async () => {
  const publication = family();
  publication.packages = publication.packages.slice(0, 1);
  const sleeps = [];
  let writes = 0;
  let reads = 0;
  const result = await publishNpmPackages(publication, { log() {}, tag: 'next', sleep: async ms => { sleeps.push(ms); }, run(args) {
    if (args[0] === 'view') { reads++; return absent(); }
    writes++;
    return writes < 3 ? failure('E503') : { status: 0 };
  } });
  assert.equal(writes, 3);
  assert.equal(reads, 5);
  assert.deepEqual(sleeps, [2_000, 4_000]);
  assert.deepEqual(result, { published: 1, skipped: 0 });
});

test('permanent failures are not retried and transient retries stop after four writes', async () => {
  for (const [code, expectedWrites] of [['E403', 1], ['E409', 4]]) {
    const publication = family();
    publication.packages = publication.packages.slice(0, 1);
    let writes = 0;
    await assert.rejects(publishNpmPackages(publication, { ...quiet, tag: 'latest', run(args) {
      if (args[0] === 'view') return absent();
      writes++;
      return failure(code);
    } }), error => error.message.includes(code) && !error.message.includes('diagnostic-redacted-value'));
    assert.equal(writes, expectedWrites);
  }
});

test('a raced conflicting write fails immediately without retry', async () => {
  const publication = family();
  publication.packages = publication.packages.slice(0, 1);
  let writes = 0;
  await assert.rejects(publishNpmPackages(publication, { ...quiet, tag: 'latest', run(args) {
    if (args[0] === 'view') return writes ? present(otherIntegrity) : absent();
    writes++;
    return failure('E409');
  } }), /already exists with different bytes/);
  assert.equal(writes, 1);
});

test('dist-tags are explicit and prereleases never advance latest', () => {
  assert.doesNotThrow(() => validateDistTag('1.0.0', 'latest'));
  assert.doesNotThrow(() => validateDistTag('1.0.0-beta.1', 'next'));
  assert.throws(() => validateDistTag('1.0.0-beta.1', 'latest'), /prerelease/);
  for (const tag of [undefined, 'beta', '--tag=latest']) assert.throws(() => validateDistTag('1.0.0', tag), /--tag latest or --tag next/);
});

function gzipVariant() {
  const publication = family();
  const record = publication.packages[1];
  const inner = gunzipSync(npmFixture({ name: record.name, version: record.version }, { 'package/bin/worker': 'fixture engine bytes\n'.repeat(20_000) }));
  const local = gzipSync(inner, { level: 1 });
  const remote = gzipSync(inner, { level: 9 });
  const integrityOf = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  record.integrity = integrityOf(local);
  record.engineInstall = { bytes: inner.length, sha256: createHash('sha256').update(inner).digest('hex') };
  assert.notEqual(record.integrity, integrityOf(remote));
  return { publication, record, inner, remote, integrityOf };
}

test('gzip-only engine differences are skipped after the registry digest and qualified tar match', async () => {
  const { publication, record, remote, integrityOf } = gzipVariant();
  const calls = [];
  const logs = [];
  let temporary;
  let downloaded = false;
  const result = await publishNpmPackages(publication, { ...quiet, tag: 'latest', log: line => logs.push(line), run(args) {
    calls.push(args);
    if (args[0] === 'publish') { assert.equal(downloaded, true); return { status: 0 }; }
    if (!args[1].startsWith(`${record.name}@`)) return absent();
    return args[2] === 'dist.tarball' ? { status: 0, stdout: JSON.stringify(`${npmRegistry}engine.tgz`) } : present(integrityOf(remote));
  }, download: async (url, file, maximumBytes) => {
    assert.equal(url, `${npmRegistry}engine.tgz`);
    assert.ok(remote.length < maximumBytes);
    temporary = file;
    writeFileSync(file, remote);
    downloaded = true;
  } });
  assert.deepEqual(result, { published: 2, skipped: 1 });
  assert.equal(existsSync(temporary), false);
  assert.equal(calls.filter(args => args[0] === 'publish').length, 2);
  assert.ok(logs.some(line => line.includes('identical qualified engine tar (gzip differs)')));
});

test('registry digest and exact inner-tar conflicts are rejected before any write', async () => {
  for (const failureKind of ['registry', 'inner', 'size', 'privacy']) {
    const { publication, record, inner, remote, integrityOf } = gzipVariant();
    let bytes = remote;
    if (failureKind === 'inner') {
      const changed = Buffer.from(inner);
      changed[1100] ^= 1;
      bytes = gzipSync(changed);
    } else if (failureKind === 'size') bytes = gzipSync(Buffer.concat([inner, Buffer.alloc(512)]));
    else if (failureKind === 'privacy') {
      const header = Buffer.from(remote.subarray(0, 10));
      header[3] |= 8; // FNAME metadata is forbidden, even when the inner tar is identical.
      bytes = Buffer.concat([header, Buffer.from('filename\0'), remote.subarray(10)]);
    }
    let writes = 0;
    let temporary;
    await assert.rejects(publishNpmPackages(publication, { ...quiet, tag: 'latest', run(args) {
      if (args[0] === 'publish') { writes++; return { status: 0 }; }
      if (!args[1].startsWith(`${record.name}@`)) return absent();
      return args[2] === 'dist.tarball' ? { status: 0, stdout: JSON.stringify(`${npmRegistry}engine.tgz`) }
        : present(failureKind === 'registry' ? otherIntegrity : integrityOf(bytes));
    }, download: async (url, file) => { temporary = file; writeFileSync(file, bytes); } }),
    /disagrees with registry integrity|different qualified installation bytes|qualified engine tar size|privacy check failed/);
    assert.equal(writes, 0);
    assert.equal(existsSync(temporary), false);
  }
});

test('alternate-host and credential-bearing registry URLs cannot start an engine download', async () => {
  for (const url of ['https://example.com/engine.tgz', 'http://registry.npmjs.org/engine.tgz', 'https://user:password@registry.npmjs.org/engine.tgz']) {
    const { publication, record, remote, integrityOf } = gzipVariant();
    await assert.rejects(publishNpmPackages(publication, { ...quiet, tag: 'latest', run(args) {
      assert.equal(args[0], 'view');
      if (!args[1].startsWith(`${record.name}@`)) return absent();
      return args[2] === 'dist.tarball' ? { status: 0, stdout: JSON.stringify(url) } : present(integrityOf(remote));
    }, download: async () => { assert.fail('untrusted URLs must not download'); } }), /unexpected engine archive URL/);
  }
});

test('engine downloads bound both declared and streamed bytes, and never follow redirects', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'kit-npm-download-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [index, response] of [
    new Response(Buffer.alloc(20), { headers: { 'content-length': '20' } }),
    new Response(Buffer.alloc(20)),
    new Response(null, { status: 302, headers: { location: 'https://example.com/' } }),
  ].entries()) {
    await assert.rejects(downloadRegistryArchive(`${npmRegistry}engine.tgz`, join(directory, `${index}.tgz`), 10, async (url, options) => {
      assert.equal(options.redirect, 'error');
      return response;
    }), /within its size limit/);
  }
  const file = join(directory, 'good.tgz');
  await downloadRegistryArchive(`${npmRegistry}engine.tgz`, file, 10, async () => new Response(Buffer.from('bounded')));
  assert.equal(readFileSync(file, 'utf8'), 'bounded');
});

test('the Node API never accepts a gzip-only equivalence exception', async () => {
  const { publication, record, remote, integrityOf } = gzipVariant();
  delete record.engineInstall;
  await assert.rejects(publishNpmPackages(publication, { ...quiet, tag: 'latest', run(args) {
    assert.equal(args[0], 'view');
    assert.equal(args[2], 'dist.integrity');
    return args[1].startsWith(`${record.name}@`) ? present(integrityOf(remote)) : absent();
  }, download: async () => { assert.fail('only qualified engines may compare inner tar bytes'); } }), /already exists with different bytes/);
});
