import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { npmFixture } from './archive-fixture.mjs';
import { sourceRepository, tarballName } from '../scripts/platform-matrix.mjs';
import { sha256 } from '../scripts/verify-artifacts.mjs';
import { previewRuntimeFixture } from './preview-runtime-fixture.mjs';
import { stageBrowserNpmRelease, validateBrowserNpmCandidate, validateCliReceipts } from '../scripts/stage-browser-npm.mjs';

function fixture(t, alter = value => value) {
  const directory = mkdtempSync(join(tmpdir(), 'browser-npm-stage-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const version = '0.0.2-rc4', tag = `v${version}`;
  const packages = Object.fromEntries(['kit', 'wasm'].map(kind => {
    const manifest = alter({ name: kind === 'kit' ? '@deepseek-ai/libreoffice-kit' : '@deepseek-ai/libreoffice-kit-wasm', version,
      ...(kind === 'kit' ? { dependencies: { '@deepseek-ai/libreoffice-kit-wasm': version } } : {}),
      publishConfig: { access: 'public' }, repository: `git+https://github.com/${sourceRepository}.git` });
    const file = tarballName(manifest);
    writeFileSync(join(directory, file), npmFixture(manifest, { 'package/lib/index.js': 'export const fixture = true;' }));
    return [kind, { name: manifest.name, version, file, bytes: statSync(join(directory, file)).size, sha256: sha256(join(directory, file)) }];
  }));
  const candidate = { schemaVersion: 1, kind: 'browser-preview', sourceCommit: '1'.repeat(40), sourceDirty: false, packages };
  const receipt = previewRuntimeFixture(packages.kit.sha256, packages.wasm.sha256, candidate.sourceCommit);
  const save = () => {
    writeFileSync(join(directory, 'browser-preview.json'), JSON.stringify(candidate));
    writeFileSync(join(directory, 'preview-runtime.json'), JSON.stringify(receipt));
  };
  save();
  return { directory, candidate, receipt, save, tag };
}

test('browser staging validates only the exact portable archives and records npm integrity', t => {
  const f = fixture(t);
  const result = validateBrowserNpmCandidate(f.directory, f.tag);
  assert.deepEqual(result.packages.map(record => record.name), ['@deepseek-ai/libreoffice-kit-wasm', '@deepseek-ai/libreoffice-kit']);
  for (const record of result.packages) assert.equal(record.integrity, `sha512-${createHash('sha512').update(readFileSync(record.path)).digest('base64')}`);
  assert.equal(result.sourceCommit, f.candidate.sourceCommit);
});

test('browser staging rejects dirty source, mismatched receipt, missing format evidence and coupled engines', t => {
  for (const change of [
    f => f.candidate.sourceDirty = true,
    f => f.receipt.sourceCommit = '2'.repeat(40),
    f => f.receipt.archiveSha256 = '2'.repeat(64),
    f => f.receipt.externalNetworkRequests = 1,
    f => f.receipt.kind = 'browser-editor',
    f => f.receipt.formats.xlsx.modelUnchanged = false,
    f => f.receipt.formats.pptx.disposed = false,
    f => f.receipt.formats.docx.layout.reflowed = false,
    f => f.receipt.formats.xlsx.rejectedOperations['ime-input'] = false,
    f => f.candidate.packages.native = {},
    f => f.candidate.packages.kit.file = '../other.tgz',
  ]) {
    const f = fixture(t); change(f); f.save();
    assert.throws(() => validateBrowserNpmCandidate(f.directory, f.tag));
  }
  const f = fixture(t);
  writeFileSync(join(f.directory, f.candidate.packages.kit.file), 'changed');
  assert.throws(() => validateBrowserNpmCandidate(f.directory, f.tag), /checksum/);
  for (const tag of ['libreoffice-kit-v0.0.2', 'libreoffice-kit-browser-v0.0.2', '../other'])
    assert.throws(() => validateBrowserNpmCandidate(f.directory, tag), /prerelease source tag/);
});

test('browser staging rejects archives that would publish privately, to another registry or with a native dependency', t => {
  for (const alter of [
    value => ({ ...value, private: true }),
    value => ({ ...value, publishConfig: { access: 'public', registry: 'https://example.com/' } }),
    value => ({ ...value, repository: 'https://github.com/other/repository' }),
    value => ({ ...value, os: ['darwin'] }),
    value => ({ ...value, optionalDependencies: { '@deepseek-ai/libreoffice-kit-darwin-arm64': '0.0.2-editor.1' } }),
  ]) {
    const f = fixture(t, alter);
    assert.throws(() => validateBrowserNpmCandidate(f.directory, f.tag));
  }
});

function cliReceipts(f) {
  const directory = join(f.directory, 'cli');
  mkdirSync(directory);
  for (const platform of ['darwin', 'linux', 'win32']) {
    writeFileSync(join(directory, `cli-${platform}-x64.json`), JSON.stringify({
      schemaVersion: 1, kind: 'installed-cli', passed: true, platform, arch: 'x64',
      sourceCommit: f.candidate.sourceCommit, archiveSha256: f.candidate.packages.kit.sha256, wasmSha256: f.candidate.packages.wasm.sha256,
      installedOutsideRepository: true, npmOffline: true, nativeEngines: false,
      recalculation: { formulasPreserved: true, cachesRefreshed: true },
      formats: Object.fromEntries(['docx', 'xlsx', 'pptx', 'pdf'].map(format => [format,
        { rasterEngine: format === 'pdf' ? 'pdfium' : 'libreoffice', images: 1, dimensions: [[100, 200]] }])),
    }));
  }
  return directory;
}

test('installed CLI receipts reject a different candidate or absent platform', t => {
  const f = fixture(t), directory = cliReceipts(f);
  validateCliReceipts(directory, f.candidate);
  const receiptFile = join(directory, 'cli-win32-x64.json');
  const receipt = JSON.parse(readFileSync(receiptFile));
  for (const field of ['formulasPreserved', 'cachesRefreshed']) {
    const changed = structuredClone(receipt);
    changed.recalculation[field] = false;
    writeFileSync(receiptFile, JSON.stringify(changed));
    assert.throws(() => validateCliReceipts(directory, f.candidate), /recalculation evidence/);
  }
  receipt.wasmSha256 = '0'.repeat(64);
  writeFileSync(receiptFile, JSON.stringify(receipt));
  assert.throws(() => validateCliReceipts(directory, f.candidate), /released archives/);
  rmSync(receiptFile);
  assert.throws(() => validateCliReceipts(directory, f.candidate), /Missing or duplicate/);
});

function workflow(t) {
  const f = fixture(t);
  const destination = join(f.directory, 'download');
  const files = ['browser-preview.json', 'preview-runtime.json', ...Object.values(f.candidate.packages).map(record => record.file)];
  const release = { tag_name: f.tag, draft: false, prerelease: true,
    assets: files.map(name => ({ name, state: 'uploaded', size: statSync(join(f.directory, name)).size, digest: `sha256:${sha256(join(f.directory, name))}` })) };
  const calls = [];
  let sourceReads = 0;
  const options = {
    env: { CLI_RECEIPTS_DIR: cliReceipts(f), GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: sourceRepository, GITHUB_EVENT_NAME: 'workflow_dispatch' },
    run(args) {
      calls.push(args);
      if (args[0] === 'release') {
        for (const name of files) cpSync(join(f.directory, name), join(destination, name));
        return { status: 0 };
      }
      if (args[1].includes('/releases/tags/')) return { status: 0, stdout: JSON.stringify(release) };
      sourceReads++;
      return { status: 0, stdout: JSON.stringify({ object: { type: 'commit', sha: f.candidate.sourceCommit } }) };
    },
    async verifyTrust({ packages }) { calls.push(['trust', ...packages]); },
    async publish(publication, { tag }) {
      assert.equal(sourceReads, 2);
      assert.equal(tag, 'next');
      calls.push(['stage', ...publication.packages.map(record => record.name)]);
      return { staged: 2 };
    },
  };
  return { ...f, destination, release, options, calls };
}

test('manual browser workflow authenticates assets and source twice, then uses npm staging without a build', async t => {
  const f = workflow(t);
  const result = await stageBrowserNpmRelease(f.tag, f.destination, f.options);
  assert.equal(result.staged, 2);
  assert.deepEqual(f.calls.at(-1), ['stage', '@deepseek-ai/libreoffice-kit-wasm', '@deepseek-ai/libreoffice-kit']);
  assert.equal(f.calls.filter(args => args[0] === 'trust').length, 1);
  assert.ok(!f.calls.some(args => args.includes('workflow') || args.includes('build')));
});

test('unpublished releases, changed downloads and moved tags cannot reach npm staging', async t => {
  for (const kind of ['draft', 'duplicate', 'digest', 'tag', 'trust', 'context']) {
    const f = workflow(t);
    if (kind === 'draft') f.release.draft = true;
    if (kind === 'duplicate') f.release.assets.push(f.release.assets[0]);
    if (kind === 'digest') f.release.assets[0].digest = `sha256:${'0'.repeat(64)}`;
    if (kind === 'context') f.options.env.GITHUB_EVENT_NAME = 'pull_request';
    if (kind === 'trust') f.options.verifyTrust = async () => { throw new Error('No npm trust'); };
    if (kind === 'tag') {
      const run = f.options.run;
      f.options.run = args => args[1]?.includes('/git/ref/tags/')
        ? { status: 0, stdout: JSON.stringify({ object: { type: 'commit', sha: '2'.repeat(40) } }) } : run(args);
    }
    await assert.rejects(stageBrowserNpmRelease(f.tag, f.destination, f.options));
    assert.ok(!f.calls.some(args => args[0] === 'stage'));
  }
});
