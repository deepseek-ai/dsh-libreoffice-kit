/** Independent preview distribution rejects missing bytes and native dependency coupling. */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { verifyFontMetadata, verifyFontPackage } from '../scripts/build-fonts.mjs';
import { verifyBrowserPreview } from '../scripts/verify-browser-preview.mjs';
import { verifyBrowserReceipt } from '../scripts/verify-browser-receipt.mjs';
import { readJson, root, tarballName } from '../scripts/platform-matrix.mjs';
import { sha256 } from '../scripts/verify-artifacts.mjs';

function temporary(t) {
  const path = mkdtempSync(join(tmpdir(), 'browser-preview-package-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function fontFixture(t) {
  const target = temporary(t);
  const original = join(root, 'packages/fonts');
  for (const path of ['package.json', 'lib', 'assets', 'sources', 'licenses', 'font-api.json', 'LICENSE', 'NOTICE'])
    cpSync(join(original, path), join(target, path), { recursive: true });
  return target;
}

test('portable font package carries its complete shared runtime and source without engine dependencies', t => {
  const target = fontFixture(t);
  const manifest = verifyFontPackage(target);
  assert.equal(manifest.name, '@deepseek-ai/libreoffice-kit-fonts');
  assert.deepEqual(Object.keys(manifest.dependencies), ['@unicode/unicode-17.0.0', 'fontkit']);
  assert.equal(manifest.optionalDependencies, undefined);
  for (const field of ['optionalDependencies', 'peerDependencies']) {
    assert.throws(() => verifyFontMetadata({ ...manifest, [field]: { '@deepseek-ai/libreoffice-kit': '0.0.1' } }), /must not depend/);
  }
  assert.throws(() => verifyFontMetadata({ ...manifest, dependencies: { ...manifest.dependencies, '@deepseek-ai/libreoffice-kit-wasm': '0.0.1' } }), /dependencies must match/);
  assert.throws(() => verifyFontMetadata({ ...manifest, os: ['linux'] }), /OS-independent/);
});

test('portable font integrity rejects changed runtime, missing declarations and undeclared engine payloads', t => {
  const target = fontFixture(t);
  const worker = join(target, 'lib/font-worker.js');
  const original = readFileSync(worker);
  writeFileSync(worker, 'export const changed = true;');
  assert.throws(() => verifyFontPackage(target), /checksum differs/);
  writeFileSync(worker, original);
  writeFileSync(join(target, 'assets/soffice.wasm'), 'unwanted engine');
  assert.throws(() => verifyFontPackage(target), /undeclared payloads/);
  rmSync(join(target, 'assets/soffice.wasm'));
  rmSync(join(target, 'lib/types/font-request.d.ts'));
  assert.throws(() => verifyFontPackage(target), /Incomplete portable font/);
});

function candidateFixture(t) {
  const directory = temporary(t);
  const packages = Object.fromEntries(['browser', 'fonts'].map(kind => {
    const identity = { name: `@deepseek-ai/libreoffice-kit-${kind}`, version: '0.0.1-1' };
    const file = tarballName(identity);
    writeFileSync(join(directory, file), `synthetic ${kind} archive`);
    return [kind, { ...identity, file, bytes: statSync(join(directory, file)).size, sha256: sha256(join(directory, file)) }];
  }));
  mkdirSync(join(directory, 'dependencies'));
  const candidate = { schemaVersion: 1, kind: 'browser-preview', sourceCommit: '1'.repeat(40), sourceDirty: true, packages, dependencies: [] };
  const save = () => writeFileSync(join(directory, 'browser-preview.json'), JSON.stringify(candidate));
  save();
  const receipt = { sourceCommit: candidate.sourceCommit, sourceDirty: true, archiveSha256: packages.browser.sha256, fontsSha256: packages.fonts.sha256,
    passed: true, isolated: true, fontSubsets: true, disposed: true,
    formats: Object.fromEntries(['doc', 'docx', 'ppt', 'pptx'].map(format => [format, { pages: 1, paintedPixels: 10 }])) };
  return { directory, candidate, receipt, save };
}

test('two-archive preview qualification accepts development evidence without native-platform records', t => {
  const { directory, candidate, receipt } = candidateFixture(t);
  assert.deepEqual(verifyBrowserPreview(directory, receipt), candidate);
  assert.equal(readJson(join(directory, 'browser-preview.json')).platforms, undefined);
  assert.throws(() => verifyBrowserReceipt(receipt, { browserSha256: candidate.packages.browser.sha256,
    fontsSha256: candidate.packages.fonts.sha256, sourceCommit: candidate.sourceCommit }), /clean source/);
});

test('preview verification rejects changed archives, wrong font evidence and injected engine packages', t => {
  const { directory, candidate, receipt, save } = candidateFixture(t);
  assert.throws(() => verifyBrowserPreview(directory, { ...receipt, fontsSha256: '0'.repeat(64) }), /different browser or adapter bytes/);
  assert.throws(() => verifyBrowserPreview(directory, { ...receipt, sourceCommit: '2'.repeat(40) }), /different source commit/);
  assert.throws(() => verifyBrowserPreview(directory, { ...receipt, disposed: false }), /disposal evidence/);
  candidate.packages.native = { name: '@deepseek-ai/libreoffice-kit-darwin-arm64' }; save();
  assert.throws(() => verifyBrowserPreview(directory), /only browser and portable-font/);
  delete candidate.packages.native; save();
  writeFileSync(join(directory, candidate.packages.fonts.file), 'changed archive');
  assert.throws(() => verifyBrowserPreview(directory), /archive checksum differs/);
});


test('preview dependency manifests reject paths outside the pinned archive directory', t => {
  const { directory, candidate, save } = candidateFixture(t);
  candidate.dependencies.push({ name: 'fontkit', version: '../../escape', file: 'dependencies/fontkit-../../escape.tgz', sha256: '0'.repeat(64) });
  save();
  assert.throws(() => verifyBrowserPreview(directory), /Invalid preview dependency/);
});
