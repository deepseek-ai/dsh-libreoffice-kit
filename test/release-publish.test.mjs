import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { enginePrefix, kitManifest, readJson, root, releaseRepository, sourceRepository, releaseTag, releaseTargets, tarballName } from '../scripts/platform-matrix.mjs';
import {
  publicationAssets,
  publishRelease,
  validatePublication,
  writePublicationIndex,
  writeReleaseNotes,
} from '../scripts/release-publish.mjs';
import { sha256 } from '../scripts/verify-artifacts.mjs';
import { engineArchiveName } from '../scripts/engine-archive.mjs';
import { githubMatrix } from '../scripts/github-matrix.mjs';

test('release host verification selects adapter-declared engines, not every unfinished native recipe', () => {
  const platforms = githubMatrix(['--released-only']).include.map(row => row.platform);
  assert.deepEqual(platforms.sort(), releaseTargets([]).sort());
  assert.equal(githubMatrix([]).include.length, 7);
});

// These bytes exercise publication metadata checks; they are not engine qualification receipts.
function fixture(t, platforms = releaseTargets([])) {
  const directory = mkdtempSync(join(tmpdir(), 'libreoffice-kit-publication-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));
  const version = readJson(join(root, 'package.json')).version;
  const env = { GITHUB_REF: `refs/tags/${releaseTag(version)}`, GITHUB_SHA: '1'.repeat(40) };
  const packages = platforms.map(platform => {
    const file = engineArchiveName({ name: `${enginePrefix}-${platform}`, version });
    writeFileSync(join(directory, file), `publication test bytes: ${platform}`);
    return { name: `${enginePrefix}-${platform}`, platform, version, file, bytes: Buffer.byteLength(`publication test bytes: ${platform}`), sha256: sha256(join(directory, file)), install: { file: file.replace(/\.xz$/, ''), bytes: 1, sha256: '0'.repeat(64) } };
  });
  const release = { schemaVersion: 1, version, platforms, packages, dependencies: [] };
  const save = (file, value) => writeFileSync(join(directory, file), `${JSON.stringify(value)}\n`);
  save('release.json', release);
  const releaseManifestSha256 = sha256(join(directory, 'release.json'));
  const adapterFile = tarballName(kitManifest());
  writeFileSync(join(directory, adapterFile), 'qualified Node API bytes');
  const adapter = { sha256: sha256(join(directory, adapterFile)) };
  const evidence = { sourceCommit: env.GITHUB_SHA, releaseManifestSha256, platforms: platforms.map(platform => ({
    platform, sourceCommit: env.GITHUB_SHA, releaseManifestSha256, nativeInstalled: platform !== 'wasm', wasmInstalled: true, passed: true,
    wasm: { adapter }, ...(platform === 'wasm' ? {} : { native: { adapter } }),
  })) };
  save('verification.json', evidence);
  return { directory, release, evidence, env, save };
}

test('publication accepts the complete adapter-declared engine inventory with matching verification metadata', t => {
  const { directory, release, env } = fixture(t);
  assert.deepEqual(validatePublication(directory, env), release);
});

test('publication rejects adapter bytes changed after the conversion receipts', t => {
  const { directory, env } = fixture(t);
  writeFileSync(join(directory, tarballName(kitManifest())), 'different adapter archive');
  assert.throws(() => validatePublication(directory, env), /different adapter bytes/);
});

test('publication rejects partial, duplicate and undeclared development targets', t => {
  const complete = releaseTargets([]);
  for (const platforms of [complete.slice(0, -1), [...complete, ...complete], ['wasm'],
    [...complete, 'linux-x64-glibc'], [...complete, 'darwin-arm64']]) {
    const { directory, env } = fixture(t, platforms);
    assert.throws(() => validatePublication(directory, env), /every declared release platform/);
  }
});

test('publication requires the matching tag and source commit', t => {
  const { directory, env, evidence, save } = fixture(t);
  assert.throws(() => validatePublication(directory, { ...env, GITHUB_REF: 'refs/heads/main' }), /matching release tag/);
  assert.throws(() => validatePublication(directory, { ...env, GITHUB_REF: `refs/tags/${releaseTag('99.0.0')}` }), /matching release tag/);
  assert.throws(() => validatePublication(directory, { ...env, GITHUB_REF: 'refs/tags/v0.1.0' }), /matching release tag/);
  evidence.sourceCommit = '2'.repeat(40);
  save('verification.json', evidence);
  assert.throws(() => validatePublication(directory, env), /this release commit/);
});

test('publication rejects changed candidate and tarball bytes', t => {
  const { directory, env, release, evidence, save } = fixture(t);
  evidence.releaseManifestSha256 = '0'.repeat(64);
  save('verification.json', evidence);
  assert.throws(() => validatePublication(directory, env), /different release bytes/);
  writeFileSync(join(directory, release.packages[0].file), 'different archive bytes');
  assert.throws(() => validatePublication(directory, env), /Invalid release tarball/);
});

test('publication rejects a transfer size that differs from the pinned archive', t => {
  const { directory, env, release, save } = fixture(t);
  release.packages[0].bytes += 1;
  save('release.json', release);
  assert.throws(() => validatePublication(directory, env), /Invalid release tarball/);
});

test('publication requires the canonical engine order and matching package versions', t => {
  const { directory, env, release, save } = fixture(t);
  release.packages.reverse();
  save('release.json', release);
  assert.throws(() => validatePublication(directory, env), /package order/);
  release.packages.reverse();
  release.packages[0].version = '99.0.0';
  release.packages[0].file = engineArchiveName(release.packages[0]);
  release.packages[0].install.file = release.packages[0].file.replace(/\.xz$/, '');
  save('release.json', release);
  assert.throws(() => validatePublication(directory, env), /Invalid release tarball/);
});

test('publication rejects noncanonical filenames, platform identities and family versions', t => {
  const { directory, env, release, save } = fixture(t);
  const first = { ...release.packages[0] };
  for (const change of [{ file: '../different.tgz' }, { platform: 'wasm' }]) {
    release.packages[0] = { ...first, ...change };
    save('release.json', release);
    assert.throws(() => validatePublication(directory, env), /canonical engine asset|transfer filename/);
  }
  release.packages[0] = first;
  release.version = '99.0.0';
  save('release.json', release);
  assert.throws(() => validatePublication(directory, { ...env, GITHUB_REF: `refs/tags/${releaseTag(release.version)}` }), /engine workspace/);
});

test('every declared native and shared WASM receipt must establish successful installed conversions', t => {
  const { directory, env, evidence, save } = fixture(t);
  for (const platform of releaseTargets([])) {
    for (const mutation of ['missing', 'nativeInstalled', 'wasmInstalled', 'passed']) {
      const invalid = structuredClone(evidence);
      const record = invalid.platforms.find(entry => entry.platform === platform);
      if (mutation === 'missing') invalid.platforms = invalid.platforms.filter(entry => entry.platform !== platform);
      else record[mutation] = !record[mutation];
      save('verification.json', invalid);
      assert.throws(() => validatePublication(directory, env), /Missing native\/WASM installed conversion evidence/);
    }
  }
});

/** A runner that records every GitHub CLI call and answers the release API with the given assets. */
function runner(t, assets) {
  const calls = [];
  const run = (args, capture) => {
    calls.push({ args, capture });
    if (args[0] === 'api' && args[1] === `repos/${releaseRepository}`) return { status: 0, stdout: JSON.stringify({ full_name: releaseRepository, visibility: 'internal', permissions: { push: true } }) };
    if (args[0] === 'api' && args[1].startsWith(`repos/${sourceRepository}/git/ref`)) return { status: 0, stdout: JSON.stringify({ object: { type: 'commit', sha: '1'.repeat(40) } }) };
    if (args.includes('POST')) return { status: 0, stdout: JSON.stringify({ sha: '2'.repeat(40) }) };
    if (args[0] === 'api' && args[1].includes('/git/ref/')) return { status: 1, stderr: 'HTTP 404' };
    if (args[0] === 'api') return assets === undefined ? { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' } : { status: 0, stdout: JSON.stringify({ assets, draft: false }) };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, run };
}

test('the artifact index describes every engine tarball and the assets list receipts last', t => {
  const { directory, release } = fixture(t);
  const manifest = writePublicationIndex(directory, release, releaseRepository);
  assert.equal(manifest.source.repository, sourceRepository);
  assert.equal(manifest.source.commit, '1'.repeat(40));
  assert.equal(manifest.source.verificationSha256, sha256(join(directory, 'verification.json')));
  assert.deepEqual(manifest.packages.map(record => record.file), release.packages.map(record => record.file));
  for (const record of [...manifest.packages, manifest.adapter]) {
    assert.equal(record.sha256, sha256(join(directory, record.file)));
    assert.ok(record.bytes > 0);
  }
  assert.deepEqual(publicationAssets(release), [
    ...release.packages.map(record => record.file), tarballName(kitManifest()),
    'artifact-manifest.json', 'SHA256SUMS', 'release.json', 'verification.json',
  ]);
  assert.match(readFileSync(join(directory, 'SHA256SUMS'), 'utf8'), new RegExp(`^${manifest.packages[0].sha256}  ${manifest.packages[0].file}$`, 'm'));
  const notes = writeReleaseNotes(directory, manifest);
  assert.match(readFileSync(notes, 'utf8'), /artifact-manifest\.json/);
  assert.match(readFileSync(notes, 'utf8'), new RegExp(manifest.packages[0].sha256));
});

test('publication creates the tagged release with every verified asset', t => {
  const { directory, env } = fixture(t);
  const { calls, run } = runner(t, undefined);
  const notesFile = join(directory, 'notes.md');
  const published = publishRelease(directory, { repository: releaseRepository, env, notesFile, run });
  assert.equal(published.tag, env.GITHUB_REF.slice('refs/tags/'.length));
  const create = calls.find(call => call.args[1] === 'create');
  assert.ok(create);
  assert.deepEqual(create.args.slice(0, 8), ['release', 'create', published.tag, '--repo', releaseRepository, '--verify-tag', '--title', `LibreOffice Kit ${readJson(join(root, 'package.json')).version}`]);
  assert.deepEqual(create.args.slice(8, 10), ['--notes-file', notesFile]);
  assert.equal(create.args[10], '--draft');
  const paths = published.assets.map(file => join(directory, file));
  assert.deepEqual(create.args.slice(-paths.length), paths);
  assert.deepEqual(calls.at(-1).args, ['release', 'edit', published.tag, '--repo', releaseRepository, '--draft=false', '--latest=false']);
});

test('publication uploads only assets the release is missing and leaves identical bytes alone', t => {
  const { directory, env, release } = fixture(t);
  const uploaded = release.packages[0].file;
  const { calls, run } = runner(t, [{ name: uploaded, size: readFileSync(join(directory, uploaded)).length, digest: `sha256:${sha256(join(directory, uploaded))}` }]);
  publishRelease(directory, { repository: releaseRepository, env, notesFile: join(directory, 'notes.md'), run });
  const upload = calls.find(call => call.args[1] === 'upload');
  assert.ok(upload);
  assert.ok(!upload.args.includes(join(directory, uploaded)));
  assert.ok(upload.args.includes(join(directory, 'artifact-manifest.json')));
  assert.equal(calls.some(call => call.args[1] === 'create'), false);
});

test('publication refuses a same-named asset carrying different bytes', t => {
  const { directory, env, release } = fixture(t);
  const existing = { name: release.packages[0].file, size: 1 };
  const { calls, run } = runner(t, [existing]);
  assert.throws(() => publishRelease(directory, { repository: releaseRepository, env, run }),
    /already carries different .* bytes/);
  assert.equal(calls.some(call => call.args[1] === 'upload' || call.args[1] === 'create'), false);
  existing.size = readFileSync(join(directory, release.packages[0].file)).length;
  assert.throws(() => publishRelease(directory, { repository: releaseRepository, env, run }), /no checksum/);
  existing.digest = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => publishRelease(directory, { repository: releaseRepository, env, run }),
    /already carries different .* bytes/);
});

test('publication stops on the first failed upload and rejects an invalid repository slug', t => {
  const { directory, env } = fixture(t);
  const { run: success } = runner(t, undefined);
  const failing = (args, capture) => args[0] === 'api' ? success(args, capture) : { status: 1, stdout: '', stderr: 'gh: upload failed' };
  const notesFile = join(directory, 'notes.md');
  assert.throws(() => publishRelease(directory, { repository: releaseRepository, env, notesFile, run: failing }), /Publication failed/);
  assert.throws(() => publishRelease(directory, { repository: releaseRepository, env, run: failing }), /requires release notes/);
  const { run } = runner(t, undefined);
  assert.throws(() => publishRelease(directory, { repository: 'not-a-slug', env, run }), /Invalid GitHub repository/);
});

test('authentication and network errors never become permission to create a release', t => {
  const { directory, env } = fixture(t);
  for (const error of ['HTTP 401', 'HTTP 403', 'HTTP 404', 'network unavailable']) {
    const calls = [];
    assert.throws(() => publishRelease(directory, { env, run: args => {
      calls.push(args);
      return { status: 1, stderr: error };
    } }), /Cannot inspect/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'api');
  }
});

test('publication rejects a public destination, wrong repository or read-only credential', t => {
  const { directory, env } = fixture(t);
  for (const destination of [
    { full_name: releaseRepository, visibility: 'public', permissions: { push: true } },
    { full_name: 'someone/else', visibility: 'internal', permissions: { push: true } },
    { full_name: releaseRepository, visibility: 'internal', permissions: { push: false } },
  ]) {
    const calls = [];
    assert.throws(() => publishRelease(directory, { env, run: args => {
      calls.push(args);
      return { status: 0, stdout: JSON.stringify(destination) };
    } }), /write access to the internal engine repository/);
    assert.deepEqual(calls, [['api', `repos/${releaseRepository}`]]);
  }
});
