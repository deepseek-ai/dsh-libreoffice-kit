import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { tarFixture } from './archive-fixture.mjs';
import { supplementalEngine, verifyPromotedRecipe } from '../scripts/assemble-prebuilt-release.mjs';

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
  const gzip = join(repo, 'engine.tgz');
  writeFileSync(gzip, gzipSync(readFileSync(archive)));
  assert.deepEqual(verifyPromotedRecipe(gzip, repo), files);
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

test('supplemental Windows receipts must identify exactly one matching engine', () => {
  for (const platform of ['win32-arm64', 'win32-x64', 'darwin-x64']) {
    const engine = { name: `@deepseek-ai/libreoffice-kit-${platform}`, version: '0.0.1', platform };
    const receipt = { version: '0.0.1', platform, engines: [engine] };
    assert.deepEqual(supplementalEngine(receipt, platform, '0.0.1'), engine);
    assert.throws(() => supplementalEngine(receipt, 'linux-x64-glibc', '0.0.1'), /Invalid supplemental/);
    assert.throws(() => supplementalEngine(receipt, platform, '0.0.2'), /Invalid supplemental/);
    assert.throws(() => supplementalEngine({ ...receipt, engines: [engine, engine] }, platform, '0.0.1'), /Invalid supplemental/);
    assert.throws(() => supplementalEngine({ ...receipt, engines: [{ ...engine, platform: 'wasm' }] }, platform, '0.0.1'), /identity mismatch/);
  }
});

test('a previously saved complete recipe remains usable, but mixed historical files do not', t => {
  const repo = mkdtempSync(join(tmpdir(), 'kit-recipe-history-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = args => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'pipe' });
  git(['init', '--quiet']);
  git(['config', 'user.name', 'Recipe Test']);
  git(['config', 'user.email', 'recipe@example.invalid']);
  mkdirSync(join(repo, 'engine/native/patches'), { recursive: true });
  const files = ['engine/native/worker.cxx', 'engine/native/build-helper.mjs', 'engine/native/patches/fix.patch'];
  for (const file of files) writeFileSync(join(repo, file), 'first version\n');
  git(['add', 'engine']); git(['commit', '--quiet', '-m', 'original recipe']);
  writeFileSync(join(repo, files[1]), 'second version\n');
  git(['add', 'engine']); git(['commit', '--quiet', '-m', 'extend helper for another platform']);
  writeFileSync(join(repo, files[0]), 'second version\n');
  git(['add', 'engine']); git(['commit', '--quiet', '-m', 'extend worker']);
  const archive = join(repo, 'engine.tar');
  writeFileSync(archive, tarFixture(Object.fromEntries(files.map(file => [`package/sources/${file}`, 'first version\n']))));
  assert.deepEqual(verifyPromotedRecipe(archive, repo), files);
  writeFileSync(archive, tarFixture(Object.fromEntries(files.map(file => [`package/sources/${file}`, file.endsWith('.cxx') ? 'second version\n' : 'first version\n']))));
  assert.throws(() => verifyPromotedRecipe(archive, repo), /saved history/);
});
