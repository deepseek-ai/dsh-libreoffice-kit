import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectNativeLogs } from '../scripts/collect-native-logs.mjs';

test('native log collection retains compiler logs and skips external-project symlinks', t => {
  const repo = mkdtempSync(join(tmpdir(), 'libreoffice-native-logs-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const build = join(repo, '.build/native-win32-arm64');
  const source = join(build, 'workdir_for_build/UnpackedTarball/icu/source');
  const unrelated = join(repo, 'unrelated');
  mkdirSync(source, { recursive: true });
  mkdirSync(unrelated);
  writeFileSync(join(build, 'build.log'), 'Core failed\n');
  writeFileSync(join(source, 'config.log'), 'compiler diagnostics\n');
  writeFileSync(join(source, 'Cargo.toml'), 'unrelated source');
  writeFileSync(join(unrelated, 'config.log'), 'outside the build tree');
  symlinkSync(unrelated, join(source, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(build, join(source, 'cycle'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = collectNativeLogs('win32-arm64', repo);
  assert.deepEqual(result.files, ['build.log', join('workdir_for_build/UnpackedTarball/icu/source/config.log')]);
  assert.equal(readFileSync(join(repo, '.build/ci-logs-win32-arm64', result.files[1]), 'utf8'), 'compiler diagnostics\n');
  assert.equal(result.files.some(file => file.includes('external') || file.includes('Cargo')), false);
});

test('an inaccessible external project does not discard other native failure logs', {
  skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'requires enforced POSIX directory permissions' : false,
}, t => {
  const repo = mkdtempSync(join(tmpdir(), 'libreoffice-native-log-access-'));
  const build = join(repo, '.build/native-linux-arm64-glibc');
  const blocked = join(build, 'workdir/UnpackedTarball/blocked');
  mkdirSync(blocked, { recursive: true });
  t.after(() => { chmodSync(blocked, 0o700); rmSync(repo, { recursive: true, force: true }); });
  writeFileSync(join(build, 'build.log'), 'original compiler failure\n');
  chmodSync(blocked, 0o000);
  const result = collectNativeLogs('linux-arm64-glibc', repo);
  assert.deepEqual(result.files, ['build.log']);
  assert.ok(result.warnings.some(warning => warning.path.endsWith('blocked') && warning.code === 'EACCES'));
  assert.equal(readFileSync(join(repo, '.build/ci-logs-linux-arm64-glibc/build.log'), 'utf8'), 'original compiler failure\n');
});
