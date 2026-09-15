import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildCacheKeys } from '../scripts/ci-build-cache.mjs';
import { root } from '../scripts/platform-matrix.mjs';

function fixture(t) {
  const repo = mkdtempSync(join(tmpdir(), 'kit-cache-'));
  t.after(() => rmSync(repo, { recursive: true, force: true, maxRetries: 3 }));
  for (const directory of ['scripts', 'engine/native', 'engine/wasm-source'])
    cpSync(join(root, directory), join(repo, directory), { recursive: true });
  for (const file of ['package.json', 'NOTICE', 'engine/core-source.mjs', 'engine/build-identity.mjs']) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    copyFileSync(join(root, file), join(repo, file));
  }
  for (const platform of ['wasm', 'darwin-arm64']) {
    const directory = `packages/${platform}`;
    mkdirSync(join(repo, directory), { recursive: true });
    for (const file of readdirSync(join(root, directory), { withFileTypes: true }).filter(entry => entry.isFile()))
      copyFileSync(join(root, directory, file.name), join(repo, directory, file.name));
  }
  const git = args => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git(['init', '-q']);
  writeFileSync(join(repo, '.gitmodules'), '[submodule "libreoffice"]\npath = engine/core\nurl = https://example.invalid/core.git\n');
  const pin = revision => git(['update-index', '--add', '--cacheinfo', `160000,${revision},engine/core`]);
  pin('a'.repeat(40));
  const keys = platform => buildCacheKeys(platform, { repo });
  return { repo, keys, pin, git };
}

test('cache identity reads the gitlink before checkout and ignores the disposable Core tree', t => {
  const { repo, keys, pin, git } = fixture(t);
  const wasm = keys('wasm');
  const native = keys('darwin-arm64');
  mkdirSync(join(repo, 'engine/core'), { recursive: true });
  writeFileSync(join(repo, 'engine/core/arbitrary.cxx'), 'unrelated checkout bytes');
  assert.deepEqual(keys('wasm'), wasm);
  assert.deepEqual(keys('darwin-arm64'), native);
  pin('b'.repeat(40));
  assert.notEqual(keys('wasm')['engine-key'], wasm['engine-key']);
  assert.notEqual(keys('darwin-arm64')['download-key'], native['download-key']);
  assert.equal(keys('wasm')['toolchain-key'], wasm['toolchain-key']);
  const changedPin = keys('wasm');
  git(['config', '--file', '.gitmodules', 'submodule.libreoffice.url', 'https://example.invalid/other.git']);
  assert.notEqual(keys('wasm')['engine-key'], changedPin['engine-key']);
});

test('native and WASM recipe changes invalidate only their own engines and preserve download reuse', t => {
  const { repo, keys } = fixture(t);
  const wasm = keys('wasm');
  const native = keys('darwin-arm64');
  appendFileSync(join(repo, 'engine/native/worker.cxx'), '\n// changed helper\n');
  assert.notEqual(keys('darwin-arm64')['engine-key'], native['engine-key']);
  assert.equal(keys('darwin-arm64')['download-key'], native['download-key']);
  assert.deepEqual(keys('wasm'), wasm);
  const changedNative = keys('darwin-arm64');
  appendFileSync(join(repo, 'engine/wasm-source/lok.cxx'), '\n// changed shim\n');
  assert.notEqual(keys('wasm')['engine-key'], wasm['engine-key']);
  assert.equal(keys('wasm')['download-key'], wasm['download-key']);
  assert.deepEqual(keys('darwin-arm64'), changedNative);
  writeFileSync(join(repo, 'engine/native/patches/9999-cache-test.patch'), 'a new reviewed patch');
  assert.notEqual(keys('darwin-arm64')['engine-key'], changedNative['engine-key']);
  assert.notEqual(keys('darwin-arm64')['download-key'], changedNative['download-key']);
});

test('versions, SDKs and package metadata invalidate caches while adapter edits and generated payload do not', t => {
  const { repo, keys } = fixture(t);
  const initial = keys('wasm');
  for (const directory of ['packages/entry/src', 'packages/wasm/assets', '.build']) {
    mkdirSync(join(repo, directory), { recursive: true });
    writeFileSync(join(repo, directory, 'ignored.txt'), 'not a source recipe');
  }
  assert.deepEqual(keys('wasm'), initial);
  const packageFile = join(repo, 'package.json');
  const manifest = JSON.parse(readFileSync(packageFile, 'utf8'));
  writeFileSync(packageFile, JSON.stringify({ ...manifest, version: '0.0.2' }));
  assert.notEqual(keys('wasm')['engine-key'], initial['engine-key']);
  assert.equal(keys('wasm')['download-key'], initial['download-key']);
  const sourceFile = join(repo, 'engine/wasm-source/source.json');
  const source = JSON.parse(readFileSync(sourceFile, 'utf8'));
  source.emsdk.version = '99.0.0';
  writeFileSync(sourceFile, JSON.stringify(source));
  assert.notEqual(keys('wasm')['toolchain-key'], initial['toolchain-key']);
  const beforeReadme = keys('wasm')['engine-key'];
  writeFileSync(join(repo, 'packages/wasm/README.md'), 'updated package documentation');
  assert.notEqual(keys('wasm')['engine-key'], beforeReadme);
  assert.throws(() => keys('unknown'), /Unknown build platform/);
});
