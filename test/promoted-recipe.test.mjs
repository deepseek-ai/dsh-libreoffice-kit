import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { tarFixture } from './archive-fixture.mjs';
import { verifyPromotedRecipe } from '../scripts/assemble-prebuilt-release.mjs';

test('promotion rejects an engine whose build fixes have not been saved in the source checkout', t => {
  const repo = mkdtempSync(join(tmpdir(), 'kit-promoted-recipe-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, 'engine/native/patches'), { recursive: true });
  const files = ['engine/native/worker.cxx', 'engine/native/build-helper.mjs', 'engine/native/patches/fix.patch'];
  const archive = join(repo, 'engine.tar');
  writeFileSync(archive, tarFixture(Object.fromEntries(files.map(file => [`package/sources/${file}`, 'reviewed source']))));
  assert.throws(() => verifyPromotedRecipe(archive, repo), /differs from checkout/);
  for (const file of files) writeFileSync(join(repo, file), 'reviewed source');
  assert.deepEqual(verifyPromotedRecipe(archive, repo), files);
  writeFileSync(join(repo, files[1]), 'reviewed source\n');
  writeFileSync(archive, tarFixture(Object.fromEntries(files.map(file => [`package/sources/${file}`, file.endsWith('.mjs') ? 'reviewed source\r\n' : 'reviewed source']))));
  assert.deepEqual(verifyPromotedRecipe(archive, repo), files);
  writeFileSync(join(repo, files[2]), 'reviewed source\r\n');
  assert.throws(() => verifyPromotedRecipe(archive, repo), /differs from checkout/);
  writeFileSync(join(repo, files[2]), 'reviewed source');
  writeFileSync(join(repo, files[0]), 'different helper');
  assert.throws(() => verifyPromotedRecipe(archive, repo), /differs from checkout/);
  writeFileSync(archive, tarFixture({ 'package/package.json': '{}' }));
  assert.throws(() => verifyPromotedRecipe(archive, repo), /lacks its native source recipe/);
});
