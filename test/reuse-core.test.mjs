import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { source, configureFlags } from '../engine/native/configure.mjs';
import { corePatchFiles } from '../engine/native/core-patches.mjs';
import { root } from '../scripts/platform-matrix.mjs';
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
  const files = ['engine/native/configure.mjs', 'scripts/stage-native.mjs', 'scripts/slim-native.mjs', ...corePatchFiles()];
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
  writeFileSync(join(directory, 'sources/core.json'), JSON.stringify({ configure: configureFlags(platform, '/tarballs', 8) }));
  const sourceFiles = [...files.map(file => `sources/${file}`), 'sources/core-changes.patch', 'sources/core.json'];
  const prebuild = { platform, source: { ...source, files: sourceFiles }, files: Object.fromEntries(sourceFiles.map(file => [file, sha256(join(directory, file))])) };
  const write = () => writeFileSync(join(directory, 'prebuilds.json'), JSON.stringify(prebuild));
  write();
  return { directory, core, prebuild, write };
}

for (const platform of ['darwin-arm64', 'linux-x64-glibc']) test(`${platform} reuse accepts matching receipts and the complete applied source diff`, t => {
  const { directory, core } = fixture(t, platform);
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

test('Core reuse refuses a payload produced by another pruning or symbol recipe', t => {
  const { directory, core } = fixture(t, 'darwin-arm64');
  writeFileSync(join(directory, 'sources/scripts/slim-native.mjs'), 'outdated shaping recipe');
  assert.throws(() => verifyCoreReuse(directory, core), /source receipt changed: scripts\/slim-native.mjs/);
});

for (const name of ['0001-disable-external-updates.patch', '0002-macos-main-thread-init.patch']) test(`Core reuse refuses missing ${name} receipts and incorrect declared or actual hashes`, t => {
  const { directory, core, prebuild, write } = fixture(t, 'linux-x64-glibc');
  const patch = `sources/engine/native/patches/${name}`;
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

test('Core reuse rejects a tampered full-diff receipt hash', t => {
  const { directory, core, prebuild, write } = fixture(t, 'linux-x64-glibc');
  prebuild.files['sources/core-changes.patch'] = '0'.repeat(64); write();
  assert.throws(() => verifyCoreReuse(directory, core), /diff receipt hash changed/);
});

test('Core reuse rejects old component selection despite matching recipe source files', t => {
  const { directory, core, prebuild, write } = fixture(t, 'darwin-arm64');
  const file = 'sources/core.json';
  writeFileSync(join(directory, file), JSON.stringify({ configure: configureFlags('darwin-arm64', '/cache', 8).filter(flag => flag !== '--disable-scripting') }));
  prebuild.files[file] = sha256(join(directory, file)); write();
  assert.throws(() => verifyCoreReuse(directory, core), /rebuild Core/);
});
