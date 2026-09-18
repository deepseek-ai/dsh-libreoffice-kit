/** Untrusted dependency inventories must be rejected before extraction writes paths. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { tarFixture } from './archive-fixture.mjs';
import { extractOfflineDependencies } from '../scripts/download-preview.mjs';
import { sha256 } from '../scripts/verify-artifacts.mjs';
function fixture(t, archive = tarFixture({ 'dependencies/fontkit-2.0.4.tgz': 'dependency' })) {
  const directory = mkdtempSync(join(tmpdir(), 'kit-preview-download-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'offline-dependencies.tar');
  writeFileSync(path, archive);
  const candidate = { dependencies: [{ name: 'fontkit', version: '2.0.4', file: 'dependencies/fontkit-2.0.4.tgz',
    sha256: createHash('sha256').update('dependency').digest('hex') }],
  dependencyArchive: { file: 'offline-dependencies.tar', bytes: archive.length, sha256: sha256(path) } };
  return { directory, candidate };
}
test('offline dependency extraction checks canonical files and exact contents', t => {
  const f = fixture(t);
  extractOfflineDependencies(f.directory, f.candidate);
  assert.equal(readFileSync(join(f.directory, f.candidate.dependencies[0].file), 'utf8'), 'dependency');
});
test('dependency paths and archive inventory cannot escape or introduce files', t => {
  for (const file of ['../escape.tgz', '/tmp/escape.tgz', 'dependencies/../escape.tgz', 'dependencies\\escape.tgz']) {
    const f = fixture(t); f.candidate.dependencies[0].file = file;
    assert.throws(() => extractOfflineDependencies(f.directory, f.candidate), /Noncanonical/);
    assert.equal(existsSync(join(f.directory, 'dependencies')), false);
  }
  for (const archive of [tarFixture({ 'extra': 'x' }), tarFixture({ 'dependencies/fontkit-2.0.4.tgz': 'dependency', 'unexpected': 'x' })]) {
    const f = fixture(t, archive);
    assert.throws(() => extractOfflineDependencies(f.directory, f.candidate), /Unexpected/);
    assert.equal(existsSync(join(f.directory, 'dependencies')), false);
  }
});
test('matching dependency names cannot conceal a symbolic link', t => {
  const archive = tarFixture({ 'dependencies/fontkit-2.0.4.tgz': '' });
  archive[156] = '2'.charCodeAt(0);
  archive.write('/tmp/escaped', 157, 'utf8');
  archive.fill(32, 148, 156);
  const sum = archive.subarray(0, 512).reduce((total, value) => total + value, 0);
  archive.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8');
  const f = fixture(t, archive);
  assert.throws(() => extractOfflineDependencies(f.directory, f.candidate), /Unsupported tar entry type/);
  assert.equal(existsSync(join(f.directory, 'dependencies')), false);
});
