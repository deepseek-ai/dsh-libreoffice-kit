import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { coreSubmodule, readCoreSource } from '../engine/core-source.mjs';
import { readWasmSource } from '../engine/wasm-source/source.mjs';
import { source } from '../engine/native/configure.mjs';
import { checkoutCore } from '../scripts/core-checkout.mjs';
import { root } from '../scripts/platform-matrix.mjs';
import { run } from '../scripts/pack-utils.mjs';

const upstreamUrl = 'https://example.invalid/libreoffice/core.git';
const git = (cwd, args) => run('git', args, { cwd }).trim();
function scratch(t) {
  const directory = mkdtempSync(join(tmpdir(), 'libreoffice-submodule-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));
  return directory;
}
function fixture(t) {
  const repo = scratch(t);
  git(repo, ['init', '-q']);
  writeFileSync(join(repo, '.gitmodules'), `[submodule "libreoffice"]\n\tpath = ${coreSubmodule}\n\turl = ${upstreamUrl}\n\tshallow = true\n`);
  const core = join(repo, coreSubmodule);
  mkdirSync(core, { recursive: true });
  git(core, ['init', '-q']);
  writeFileSync(join(core, '.gitattributes'), '*.cxx -text\n');
  writeFileSync(join(core, 'source.cxx'), 'upstream\n');
  git(core, ['add', '.gitattributes', 'source.cxx']);
  const commit = () => git(core, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qam', 'fixture']);
  commit();
  const revision = git(core, ['rev-parse', 'HEAD']);
  git(repo, ['add', '.gitmodules']);
  git(repo, ['update-index', '--add', '--cacheinfo', `160000,${revision},${coreSubmodule}`]);
  return { repo, core, revision, commit };
}

test('native and WASM resolve the same gitlink without initializing Core', () => {
  const pin = readCoreSource();
  assert.deepEqual(source, pin);
  assert.equal(readWasmSource().libreoffice.repository, pin.repository);
  assert.equal(readWasmSource().libreoffice.commit, pin.revision);
});

test('the staged gitlink and .gitmodules own the pin, independent of the submodule checkout', t => {
  const { repo, core, revision, commit } = fixture(t);
  assert.deepEqual(readCoreSource(repo), { repository: upstreamUrl, revision });
  writeFileSync(join(core, 'source.cxx'), 'next upstream version\n');
  commit();
  assert.equal(readCoreSource(repo).revision, revision);
  assert.throws(() => checkoutCore(join(repo, '.build/core'), repo), /different revision/);
  git(repo, ['add', coreSubmodule]);
  const next = git(core, ['rev-parse', 'HEAD']);
  assert.equal(readCoreSource(repo).revision, next);
  rmSync(core, { recursive: true });
  assert.equal(readCoreSource(repo).revision, next);
  git(repo, ['config', '--file', '.gitmodules', 'submodule.libreoffice.url', 'https://example.invalid/new/core.git']);
  assert.equal(readCoreSource(repo).repository, 'https://example.invalid/new/core.git');
  git(repo, ['update-index', '--force-remove', coreSubmodule]);
  assert.throws(() => readCoreSource(repo), /submodule gitlink/);
});

test('build checkouts detach at the pin, preserve local patches on reuse, and leave the submodule pristine', t => {
  const { repo, core, revision } = fixture(t);
  const native = join(repo, '.build/core');
  const wasm = join(repo, '.build/wasm/core');
  checkoutCore(native, repo);
  checkoutCore(wasm, repo);
  for (const checkout of [native, wasm]) {
    assert.equal(git(checkout, ['rev-parse', 'HEAD']), revision);
    assert.equal(git(checkout, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD');
    assert.equal(git(checkout, ['remote', 'get-url', 'origin']), upstreamUrl);
  }
  writeFileSync(join(native, 'source.cxx'), 'native patch\n');
  checkoutCore(native, repo);
  assert.equal(readFileSync(join(native, 'source.cxx'), 'utf8'), 'native patch\n');
  assert.equal(readFileSync(join(wasm, 'source.cxx'), 'utf8'), 'upstream\n');
  assert.equal(git(core, ['status', '--porcelain']), '');
  git(native, ['add', 'source.cxx']);
  git(native, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'wrong revision']);
  assert.throws(() => checkoutCore(native, repo), /different revision/);
});

test('a dirty upstream submodule is rejected before creating a build checkout', t => {
  const { repo, core } = fixture(t);
  writeFileSync(join(core, 'source.cxx'), 'accidental upstream edit\n');
  const output = join(repo, '.build/core');
  assert.throws(() => checkoutCore(output, repo), /submodule must be clean/);
  assert.equal(existsSync(output), false);
});

test('uninitialized submodules are fetched at the gitlink before cloning the build tree', t => {
  const { repo, core, revision } = fixture(t);
  const mirror = join(scratch(t), 'mirror.git');
  git(repo, ['clone', '--bare', '--', core, mirror]);
  rmSync(core, { recursive: true });
  // Local-only fixture transport; production .gitmodules remains HTTPS.
  git(repo, ['config', 'submodule.libreoffice.url', mirror]);
  const output = join(repo, '.build/core');
  const result = run(process.execPath, ['--input-type=module', '-e',
    `import { checkoutCore } from ${JSON.stringify(pathToFileURL(join(root, 'scripts/core-checkout.mjs')).href)}; checkoutCore(${JSON.stringify(output)}, ${JSON.stringify(repo)});`],
  { env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' } });
  assert.equal(result, '');
  assert.equal(git(core, ['rev-parse', 'HEAD']), revision);
  assert.equal(git(output, ['rev-parse', 'HEAD']), revision);
});

test('packaged native and WASM recipes resolve their exported pin without Git metadata', async t => {
  const repo = scratch(t);
  const pin = readCoreSource();
  writeFileSync(join(repo, 'core-source.json'), JSON.stringify(pin));
  for (const file of ['engine/build-identity.mjs', 'engine/core-source.mjs', 'engine/native/configure.mjs', 'engine/wasm-source/source.json', 'engine/wasm-source/source.mjs']) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    copyFileSync(join(root, file), join(repo, file));
  }
  const native = await import(pathToFileURL(join(repo, 'engine/native/configure.mjs')).href);
  const wasm = await import(pathToFileURL(join(repo, 'engine/wasm-source/source.mjs')).href);
  assert.deepEqual(native.source, pin);
  assert.equal(wasm.readWasmSource().libreoffice.commit, pin.revision);
  writeFileSync(join(repo, 'core-source.json'), JSON.stringify({ ...pin, revision: 'invalid' }));
  assert.throws(() => readCoreSource(repo), /full commit/);
});
