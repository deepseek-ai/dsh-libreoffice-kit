import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { verifyFontSubset } from '../scripts/build-font-subset.mjs';
import { root } from '../scripts/platform-matrix.mjs';
import { run } from '../scripts/pack-utils.mjs';
import { sha256 } from '../scripts/verify-artifacts.mjs';

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

test('Windows Git checkout preserves the font subset recipe bytes hashed by Linux', t => {
  const target = mkdtempSync(join(tmpdir(), 'kit-font-recipe-checkout-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  const recipe = 'scripts/build-font-subset.mjs';
  mkdirSync(join(target, 'scripts'));
  cpSync(join(root, '.gitattributes'), join(target, '.gitattributes'));
  cpSync(join(root, recipe), join(target, recipe));
  writeFileSync(join(target, 'control.mjs'), 'export const control = true;\n');
  run('git', ['init', '--quiet'], { cwd: target });
  run('git', ['-c', 'core.autocrlf=false', 'add', '.gitattributes', recipe, 'control.mjs'], { cwd: target });
  rmSync(join(target, recipe));
  rmSync(join(target, 'control.mjs'));
  run('git', ['-c', 'core.autocrlf=true', 'checkout-index', '--all', '--force'], { cwd: target });
  assert.equal(readFileSync(join(target, 'control.mjs'), 'utf8'), 'export const control = true;\r\n');
  assert.equal(readFileSync(join(target, recipe), 'utf8').includes('\r\n'), false);
  assert.equal(sha256(join(target, recipe)), sha256(join(root, recipe)));
});
