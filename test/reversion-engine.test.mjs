import assert from 'node:assert/strict';
import test from 'node:test';
import { tarFixture } from './archive-fixture.mjs';
import { visitTar } from '../scripts/publication-privacy.mjs';
import { reversionEngineTar } from '../scripts/reversion-engine.mjs';

const options = { name: '@deepseek-ai/libreoffice-kit-darwin-arm64', platform: 'darwin-arm64', fromVersion: '0.0.1', version: '0.0.1-1' };
const manifest = { name: options.name, version: '0.0.1', files: ['bin', 'sources'], description: 'x'.repeat(440) };
const prebuild = { version: '0.0.1', platform: options.platform, status: 'built', files: { 'bin/helper': 'unchanged digest' }, source: { revision: 'a'.repeat(40) } };
const json = value => JSON.stringify(value, null, 2) + '\n';
const fixture = (pkg = manifest, pre = prebuild) => tarFixture({
  'package/package.json': json(pkg), 'package/bin/helper': Buffer.from([0, 1, 2, 255]),
  'package/prebuilds.json': json(pre), 'package/sources/recipe.mjs': 'original recipe\n',
});

test('version repacking changes only metadata versions and preserves payload headers, modes and bytes', () => {
  const before = fixture();
  const after = reversionEngineTar(before, options);
  const original = new Map();
  visitTar(before, e => original.set(e.name, before.subarray(e.headerOffset, e.endOffset)));
  let count = 0;
  visitTar(after, e => {
    count++;
    if (e.name === 'package/package.json') assert.deepEqual(JSON.parse(e.data), { ...manifest, version: options.version });
    else if (e.name === 'package/prebuilds.json') assert.deepEqual(JSON.parse(e.data), { ...prebuild, version: options.version });
    else assert.deepEqual(after.subarray(e.headerOffset, e.endOffset), original.get(e.name));
  });
  assert.equal(count, 4);
  assert.deepEqual(reversionEngineTar(after, { ...options, fromVersion: options.version, version: '0.0.1' }), before);
});

test('version repacking rejects a different engine, base release, missing metadata and corrupt tar', () => {
  assert.throws(() => reversionEngineTar(fixture(), { ...options, version: '0.0.2' }), /same base/);
  assert.throws(() => reversionEngineTar(fixture(), { ...options, version: '0.0.1' }), /distinct/);
  assert.throws(() => reversionEngineTar(fixture({ ...manifest, name: 'wrong' }), options), /identity/);
  assert.throws(() => reversionEngineTar(fixture(manifest, { ...prebuild, version: '0.0.0' }), options), /version mismatch/);
  assert.throws(() => reversionEngineTar(fixture(manifest, { ...prebuild, status: 'unbuilt' }), options), /status/);
  assert.throws(() => reversionEngineTar(tarFixture({ 'package/package.json': json(manifest) }), options), /both/);
  const corrupt = fixture(); corrupt[0] ^= 1;
  assert.throws(() => reversionEngineTar(corrupt, options), /checksum/);
});
