import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { verifyFontSubset } from '../scripts/build-font-subset.mjs';
import { root } from '../scripts/platform-matrix.mjs';

function fixture(t) {
  const target = mkdtempSync(join(tmpdir(), 'kit-font-subset-package-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  for (const name of ['assets', 'sources/font-subset', 'licenses/font-subset']) cpSync(join(root, 'packages/entry', name), join(target, name), { recursive: true });
  return target;
}

test('font subset source receipts verify every staged module, recipe and license file', t => {
  const target = fixture(t);
  assert.equal(verifyFontSubset(target).source.algorithm, 'harfbuzzjs-1.6.1-hb-36cb489-growth-v1');
  writeFileSync(join(target, 'assets/font-subset.wasm'), Buffer.from('changed module'));
  assert.throws(() => verifyFontSubset(target), /checksum differs/);
});

test('font subset packing refuses absent notices and obsolete source recipes', t => {
  const target = fixture(t);
  const path = join(target, 'assets/font-subset.json');
  const receipt = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...receipt, recipe: 'old' }));
  assert.throws(() => verifyFontSubset(target), /recipe changed/);
  writeFileSync(path, JSON.stringify({ ...receipt, source: { ...receipt.source, algorithm: 'other' } }));
  assert.throws(() => verifyFontSubset(target), /source receipt differs/);
  writeFileSync(path, JSON.stringify(receipt));
  rmSync(join(target, 'licenses/font-subset/harfbuzz-COPYING'));
  assert.throws(() => verifyFontSubset(target), /Missing package artifact/);
});
