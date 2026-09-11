import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { source } from '../engine/native/configure.mjs';
import { root } from '../scripts/platform-matrix.mjs';
import { verifyCoreReuse } from '../scripts/rebuild-native-helper.mjs';

test('Core reuse rejects a changed source pin, patch set, or recorded configure input', t => {
  const directory = mkdtempSync(join(tmpdir(), 'libreoffice-core-reuse-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = ['engine/native/configure.mjs', ...readdirSync(join(root, 'engine/native/patches')).filter(file => file.endsWith('.patch')).map(file => `engine/native/patches/${file}`)];
  for (const file of files) {
    mkdirSync(join(directory, 'sources', file, '..'), { recursive: true });
    copyFileSync(join(root, file), join(directory, 'sources', file));
  }
  const prebuild = { source: { ...source, files: files.map(file => `sources/${file}`) } };
  const manifest = join(directory, 'prebuilds.json');
  const write = value => writeFileSync(manifest, JSON.stringify(value));
  write(prebuild);
  assert.doesNotThrow(() => verifyCoreReuse(directory));
  write({ source: { ...prebuild.source, revision: '0'.repeat(40) } });
  assert.throws(() => verifyCoreReuse(directory), /source pin differs/);
  write({ source: { ...prebuild.source, files: [...prebuild.source.files, 'sources/engine/native/patches/unrecorded.patch'] } });
  assert.throws(() => verifyCoreReuse(directory), /patch receipt set differs/);
  write(prebuild);
  writeFileSync(join(directory, 'sources/engine/native/configure.mjs'), 'changed flags');
  assert.throws(() => verifyCoreReuse(directory), /source receipt changed/);
  copyFileSync(join(root, 'engine/native/configure.mjs'), join(directory, 'sources/engine/native/configure.mjs'));
  writeFileSync(join(directory, prebuild.source.files.find(file => file.endsWith('.patch'))), 'changed patch');
  assert.throws(() => verifyCoreReuse(directory), /source receipt changed/);
});
