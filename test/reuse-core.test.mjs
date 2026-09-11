import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { source } from '../engine/native/configure.mjs';
import { corePatchFiles } from '../engine/native/core-patches.mjs';
import { root, targets } from '../scripts/platform-matrix.mjs';
import { sha256 } from '../scripts/verify-artifacts.mjs';
import { verifyCoreReuse } from '../scripts/rebuild-native-helper.mjs';

function git(core, args) {
  const result = spawnSync('git', args, { cwd: core, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout;
}
function fixture(t, platform) {
  const directory = mkdtempSync(join(tmpdir(), 'libreoffice-core-reuse-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));
  const files = ['engine/native/configure.mjs', ...corePatchFiles(platform)];
  for (const file of files) {
    mkdirSync(join(directory, 'sources', file, '..'), { recursive: true });
    copyFileSync(join(root, file), join(directory, 'sources', file));
  }
  const core = join(directory, 'core');
  mkdirSync(core);
  git(core, ['init', '-q']);
  writeFileSync(join(core, 'tracked.txt'), 'upstream\n');
  git(core, ['add', 'tracked.txt']);
  git(core, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  writeFileSync(join(core, 'tracked.txt'), 'recorded source change\n');
  writeFileSync(join(directory, 'sources/core-changes.patch'), git(core, ['diff', '--binary', 'HEAD', '--']));
  const sourceFiles = [...files.map(file => `sources/${file}`), 'sources/core-changes.patch'];
  const prebuild = { platform, source: { ...source, files: sourceFiles }, files: Object.fromEntries(sourceFiles.map(file => [file, sha256(join(directory, file))])) };
  const write = () => writeFileSync(join(directory, 'prebuilds.json'), JSON.stringify(prebuild));
  write();
  return { directory, core, prebuild, write };
}

test('only musl builds select the additional gettext and thread stack patches', () => {
  const common = ['engine/native/patches/0001-disable-external-updates.patch', 'engine/native/patches/0002-macos-main-thread-init.patch'];
  const musl = ['engine/native/patches/musl/0001-link-gettext.patch', 'engine/native/patches/musl/0002-thread-stacksize.patch'];
  for (const platform of Object.keys(targets)) assert.deepEqual(corePatchFiles(platform), [...common, ...(platform.endsWith('-musl') ? musl : [])]);
  assert.throws(() => corePatchFiles('linux-x64'), /Unknown Core patch platform/);
});

for (const platform of ['darwin-arm64', 'linux-x64-glibc', 'linux-arm64-musl']) test(`${platform} reuse accepts matching receipts and the complete applied source diff`, t => {
  const { directory, core, prebuild } = fixture(t, platform);
  assert.equal(prebuild.source.files.includes('sources/engine/native/core-patches.mjs'), false);
  // Existing non-musl receipts predate the selector; their actual patch bytes remain authoritative.
  assert.doesNotThrow(() => verifyCoreReuse(directory, core));
  writeFileSync(join(core, 'tracked.txt'), 'unrecorded source change\n');
  assert.throws(() => verifyCoreReuse(directory, core), /changes differ/);
});

test('Core reuse rejects a changed source pin, patch set, or recorded configure input', t => {
  const { directory, core, prebuild, write } = fixture(t, 'darwin-arm64');
  prebuild.source.revision = '0'.repeat(40); write();
  assert.throws(() => verifyCoreReuse(directory, core), /source pin differs/);
  prebuild.source.revision = source.revision;
  prebuild.source.files.push('sources/engine/native/patches/unrecorded.patch'); write();
  assert.throws(() => verifyCoreReuse(directory, core), /patch receipt set differs/);
  prebuild.source.files.pop(); write();
  writeFileSync(join(directory, 'sources/engine/native/configure.mjs'), 'changed flags');
  assert.throws(() => verifyCoreReuse(directory, core), /source receipt changed/);
  copyFileSync(join(root, 'engine/native/configure.mjs'), join(directory, 'sources/engine/native/configure.mjs'));
  const patch = prebuild.source.files.find(file => file.startsWith('sources/engine/native/patches/'));
  writeFileSync(join(directory, patch), 'changed patch');
  assert.throws(() => verifyCoreReuse(directory, core), /source receipt changed/);
});

for (const name of ['0001-link-gettext.patch', '0002-thread-stacksize.patch']) test(`musl reuse refuses missing ${name} receipts and incorrect declared or actual hashes`, t => {
  const { directory, core, prebuild, write } = fixture(t, 'linux-x64-musl');
  const patch = `sources/engine/native/patches/musl/${name}`;
  prebuild.source.files = prebuild.source.files.filter(file => file !== patch); write();
  assert.throws(() => verifyCoreReuse(directory, core), /patch receipt set differs/);
  prebuild.source.files.push(patch);
  const digest = prebuild.files[patch];
  prebuild.files[patch] = '0'.repeat(64); write();
  assert.throws(() => verifyCoreReuse(directory, core), /source receipt changed/);
  prebuild.files[patch] = digest; write();
  writeFileSync(join(directory, patch), readFileSync(join(directory, patch), 'utf8') + '\n');
  assert.throws(() => verifyCoreReuse(directory, core), /source receipt changed/);
});

test('a musl patch receipt cannot be reused by a glibc target', t => {
  const { directory, core, prebuild, write } = fixture(t, 'linux-x64-musl');
  prebuild.platform = 'linux-x64-glibc'; write();
  assert.throws(() => verifyCoreReuse(directory, core), /patch receipt set differs/);
});

test('Core reuse rejects a tampered full-diff receipt hash', t => {
  const { directory, core, prebuild, write } = fixture(t, 'linux-x64-musl');
  prebuild.files['sources/core-changes.patch'] = '0'.repeat(64); write();
  assert.throws(() => verifyCoreReuse(directory, core), /diff receipt hash changed/);
});
