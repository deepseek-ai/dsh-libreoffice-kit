import assert from 'node:assert/strict';
import test from 'node:test';
import { enginePrefix, hostTarget, kitManifest, kitNativeTargets, releaseTargets, targets } from '../scripts/platform-matrix.mjs';
import { githubMatrix } from '../scripts/github-matrix.mjs';

test('platform matrix preserves libc rather than guessing glibc', () => {
  assert.equal(hostTarget('linux', 'x64', { header: { glibcVersionRuntime: '2.39' } }), 'linux-x64-glibc');
  assert.equal(hostTarget('linux', 'arm64', { sharedObjects: ['/lib/ld-musl-aarch64.so.1'] }), undefined);
  assert.equal(hostTarget('linux', 'x64', { header: {}, sharedObjects: [] }), undefined);
  assert.equal(hostTarget('linux', 'riscv64', { header: { glibcVersionRuntime: '2.39' } }), undefined);
  assert.equal(hostTarget('darwin', 'arm64', {}), 'darwin-arm64');
  assert.equal(hostTarget('win32', 'arm64', {}), 'win32-arm64');
  assert.equal(hostTarget('freebsd', 'x64', {}), undefined);
});

test('release selection follows the adapter while explicit development scopes can select every recipe', () => {
  assert.deepEqual(releaseTargets([]), ['darwin-arm64', 'wasm']);
  const adapter = structuredClone(kitManifest());
  adapter.optionalDependencies = { [`${enginePrefix}-linux-x64-glibc`]: 'workspace:*' };
  assert.deepEqual(releaseTargets([], kitNativeTargets(adapter)), ['linux-x64-glibc', 'wasm']);
  assert.deepEqual(releaseTargets(['--platform', 'darwin-arm64']), ['darwin-arm64', 'wasm']);
  for (const platform of Object.keys(targets)) assert.deepEqual(releaseTargets(['--platform', platform]), [platform, 'wasm']);
  assert.deepEqual(releaseTargets(['--wasm-only']), ['wasm']);
  assert.throws(() => releaseTargets(['--platform', 'freebsd-x64']), /Unknown native platform/);
  assert.throws(() => releaseTargets(['--platform']), /Unknown native platform/);
  assert.throws(() => releaseTargets(['--wasm-only', '--platform', 'darwin-arm64']), /mutually exclusive/);
});

test('CI build selection retains unfinished recipes while publication selects released natives', () => {
  assert.deepEqual(githubMatrix().include.map(row => row.platform).sort(), [...Object.keys(targets), 'wasm'].sort());
  assert.equal(githubMatrix(['--native-only']).include.length, 6);
  assert.deepEqual(githubMatrix(['--released-only']).include.map(row => row.platform).sort(), releaseTargets([]).sort());
  assert.deepEqual(githubMatrix(['--released-only', '--native-only']).include.map(row => row.platform), ['darwin-arm64']);
});

test('removed musl targets cannot enter development or release selection', () => {
  for (const platform of ['linux-arm64-musl', 'linux-x64-musl']) {
    assert.throws(() => releaseTargets(['--platform', platform]), /Unknown native platform/);
    const adapter = structuredClone(kitManifest());
    adapter.optionalDependencies = { [`${enginePrefix}-${platform}`]: 'workspace:*' };
    assert.throws(() => kitNativeTargets(adapter), /Unknown native optional dependency/);
  }
});
