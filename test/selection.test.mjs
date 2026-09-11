import assert from 'node:assert/strict';
import test from 'node:test';
import { hostTarget, releaseTargets, targets } from '../scripts/platform-matrix.mjs';

test('platform matrix preserves libc rather than guessing glibc', () => {
  assert.equal(hostTarget('linux', 'x64', { header: { glibcVersionRuntime: '2.39' } }), 'linux-x64-glibc');
  assert.equal(hostTarget('linux', 'arm64', { sharedObjects: ['/lib/ld-musl-aarch64.so.1'] }), 'linux-arm64-musl');
  assert.equal(hostTarget('linux', 'x64', { header: {}, sharedObjects: [] }), undefined);
  assert.equal(hostTarget('linux', 'riscv64', { header: { glibcVersionRuntime: '2.39' } }), undefined);
  assert.equal(hostTarget('darwin', 'arm64', {}), 'darwin-arm64');
  assert.equal(hostTarget('win32', 'arm64', {}), 'win32-arm64');
  assert.equal(hostTarget('freebsd', 'x64', {}), undefined);
});

test('release selection includes every declared target by default', () => {
  assert.deepEqual(releaseTargets([]), [...Object.keys(targets), 'wasm']);
  assert.deepEqual(releaseTargets(['--platform', 'darwin-arm64']), ['darwin-arm64', 'wasm']);
  assert.deepEqual(releaseTargets(['--wasm-only']), ['wasm']);
  assert.throws(() => releaseTargets(['--platform', 'freebsd-x64']), /Unknown native platform/);
  assert.throws(() => releaseTargets(['--platform']), /Unknown native platform/);
  assert.throws(() => releaseTargets(['--wasm-only', '--platform', 'darwin-arm64']), /mutually exclusive/);
});
