import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { npmFixture } from './archive-fixture.mjs';
import { sourceRepository, tarballName } from '../scripts/platform-matrix.mjs';
import { sha256 } from '../scripts/verify-artifacts.mjs';
import { stageBrowserNpmRelease, validateBrowserNpmCandidate } from '../scripts/stage-browser-npm.mjs';

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
  const receipt = { schemaVersion: 1, kind: 'browser-editor', sourceCommit: candidate.sourceCommit, sourceDirty: false,
    passed: true, installedOutsideRepository: true, npmOffline: true, externalNetworkRequests: 0,
    crossOriginIsolated: true, workerDisposal: true, newCharacterFonts: true,
    archiveSha256: packages.kit.sha256, wasmSha256: packages.wasm.sha256,
    formats: Object.fromEntries(['docx', 'xlsx', 'pptx'].map(format => [format, { saveReopen: true, nativeReopen: true, disposed: true, bytes: 100 }])) };
  const save = () => {
    writeFileSync(join(directory, 'browser-preview.json'), JSON.stringify(candidate));
    writeFileSync(join(directory, 'editor.json'), JSON.stringify(receipt));
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
    f => f.receipt.formats.docx.nativeReopen = false,
    f => f.receipt.formats.xlsx.saveReopen = false,
    f => f.receipt.formats.pptx.disposed = false,
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

function workflow(t) {
  const f = fixture(t);
  const destination = join(f.directory, 'download');
  const files = ['browser-preview.json', 'editor.json', ...Object.values(f.candidate.packages).map(record => record.file)];
  const release = { tag_name: f.tag, draft: false, prerelease: true,
    assets: files.map(name => ({ name, state: 'uploaded', size: statSync(join(f.directory, name)).size, digest: `sha256:${sha256(join(f.directory, name))}` })) };
  const calls = [];
  let sourceReads = 0;
  const options = {
    env: { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: sourceRepository, GITHUB_EVENT_NAME: 'workflow_dispatch' },
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
