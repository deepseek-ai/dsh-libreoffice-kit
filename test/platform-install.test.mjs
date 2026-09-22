import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { npmFixture } from './archive-fixture.mjs';
import { kitManifest, kitNativeTargets, packageMatrix } from '../scripts/platform-matrix.mjs';
import { npm } from '../scripts/pack-utils.mjs';

// Tiny package archives exercise npm's real OS/CPU selection without engine binaries or registry access.
for (const [os, cpu, expected] of [
  ['darwin', 'arm64', 'darwin-arm64'], ['darwin', 'x64', 'darwin-x64'],
  ['win32', 'arm64', 'win32-arm64'], ['win32', 'x64', 'win32-x64'],
  ['linux', 'x64', 'wasm'], ['linux', 'arm64', 'wasm'],
]) test(`npm installs only ${expected} for ${os}/${cpu}`, t => {
  const work = mkdtempSync(join(tmpdir(), 'kit-platform-install-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const entry = kitManifest();
  const declared = [...kitNativeTargets(entry), 'wasm'];
  const engines = packageMatrix().filter(row => declared.includes(row.prebuild.platform));
  const optionalDependencies = {};
  for (const { manifest, prebuild } of engines) {
    const archive = join(work, `${prebuild.platform}.tgz`);
    writeFileSync(archive, npmFixture(manifest));
    optionalDependencies[manifest.name] = `file:${archive}`;
  }
  const adapter = join(work, 'adapter.tgz');
  writeFileSync(adapter, npmFixture({ ...entry, dependencies: {}, optionalDependencies }));
  const consumer = join(work, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, dependencies: { [entry.name]: `file:${adapter}` } }));
  npm(['install', '--offline', '--ignore-scripts', '--package-lock=false', `--os=${os}`, `--cpu=${cpu}`], consumer, work);
  for (const { manifest, prebuild } of engines)
    assert.equal(existsSync(join(consumer, 'node_modules', manifest.name, 'package.json')), prebuild.platform === expected, manifest.name);
});
