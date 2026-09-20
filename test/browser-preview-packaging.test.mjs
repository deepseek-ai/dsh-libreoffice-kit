/** Independent preview distribution rejects missing bytes and native dependency coupling. */
import assert from 'node:assert/strict';
import { browserReceiptFixture } from './release-browser-fixture.mjs';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { verifyFontMetadata, verifyFontPackage } from '../scripts/build-fonts.mjs';
import { BROWSER_PREVIEW_MAX_BYTES, verifyBrowserPreview } from '../scripts/verify-browser-preview.mjs';
import { verifyBrowserReceipt } from '../scripts/verify-browser-receipt.mjs';
import { readJson, root, tarballName } from '../scripts/platform-matrix.mjs';
import { sha256 } from '../scripts/verify-artifacts.mjs';

function temporary(t) {
  const path = mkdtempSync(join(tmpdir(), 'browser-preview-package-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test('font and browser entries belong to the existing main package', () => {
  const manifest = readJson(join(root, 'packages/entry/package.json'));
  verifyFontMetadata(manifest);
  assert.equal(manifest.exports['./browser'].import, './lib/browser/index.js');
  assert.equal(manifest.dependencies['@deepseek-ai/libreoffice-kit-wasm'], 'workspace:*');
  for (const name of ['browser', 'fonts']) assert.equal(readJson(join(root, 'packages', name, 'package.json')).private, true);
});

function candidateFixture(t) {
  const directory = temporary(t);
  const packages = Object.fromEntries(['kit', 'wasm'].map(kind => {
    const identity = { name: kind === 'kit' ? '@deepseek-ai/libreoffice-kit' : '@deepseek-ai/libreoffice-kit-wasm', version: '0.0.1-1' };
    const file = tarballName(identity);
    writeFileSync(join(directory, file), `synthetic ${kind} archive`);
    return [kind, { ...identity, file, bytes: statSync(join(directory, file)).size, sha256: sha256(join(directory, file)) }];
  }));
  mkdirSync(join(directory, 'dependencies'));
  const candidate = { schemaVersion: 1, kind: 'browser-preview', sourceCommit: '1'.repeat(40), sourceDirty: true, packages, dependencies: [] };
  const save = () => writeFileSync(join(directory, 'browser-preview.json'), JSON.stringify(candidate));
  save();
  const receipt = { ...browserReceiptFixture(packages.kit.sha256, packages.wasm.sha256, candidate.sourceCommit), sourceDirty: true };
  return { directory, candidate, receipt, save };
}

test('two-archive preview qualification accepts development evidence without native-platform records', t => {
  const { directory, candidate, receipt } = candidateFixture(t);
  assert.deepEqual(verifyBrowserPreview(directory, receipt), candidate);
  assert.equal(readJson(join(directory, 'browser-preview.json')).platforms, undefined);
  assert.throws(() => verifyBrowserReceipt(receipt, { browserSha256: candidate.packages.kit.sha256,
    wasmSha256: candidate.packages.wasm.sha256, sourceCommit: candidate.sourceCommit }), /clean source/);
});

test('preview verification rejects changed archives, wrong font evidence and injected engine packages', t => {
  const { directory, candidate, receipt, save } = candidateFixture(t);
  assert.throws(() => verifyBrowserPreview(directory, { ...receipt, wasmSha256: '0'.repeat(64) }), /different main or WASM bytes/);
  assert.throws(() => verifyBrowserPreview(directory, { ...receipt, sourceCommit: '2'.repeat(40) }), /different source commit/);
  assert.throws(() => verifyBrowserPreview(directory, { ...receipt, disposed: false }), /disposal evidence/);
  candidate.packages.native = { name: '@deepseek-ai/libreoffice-kit-darwin-arm64' }; save();
  assert.throws(() => verifyBrowserPreview(directory), /only the existing main and WASM/);
  delete candidate.packages.native; save();
  writeFileSync(join(directory, candidate.packages.wasm.file), 'changed archive');
  assert.throws(() => verifyBrowserPreview(directory), /archive checksum differs/);
});

test('preview verification bounds the existing main and WASM package archives', t => {
  for (const kind of ['kit', 'wasm']) {
    const { directory, candidate, save } = candidateFixture(t);
    const record = candidate.packages[kind];
    record.bytes = BROWSER_PREVIEW_MAX_BYTES[kind] + 1;
    truncateSync(join(directory, record.file), record.bytes);
    save();
    assert.throws(() => verifyBrowserPreview(directory), new RegExp(`${kind} size budget`));
  }
});


test('preview dependency manifests reject paths outside the pinned archive directory', t => {
  const { directory, candidate, save } = candidateFixture(t);
  candidate.dependencies.push({ name: 'fontkit', version: '../../escape', file: 'dependencies/fontkit-../../escape.tgz', sha256: '0'.repeat(64) });
  save();
  assert.throws(() => verifyBrowserPreview(directory), /Invalid preview dependency/);
});
