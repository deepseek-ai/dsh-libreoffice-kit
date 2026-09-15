import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { tarFixture } from './archive-fixture.mjs';
import { assemblePrebuiltRelease } from '../scripts/assemble-prebuilt-release.mjs';
import { materializeEngineArchive, packEngineArchive } from '../scripts/engine-archive.mjs';
import { visitTar } from '../scripts/publication-privacy.mjs';
import { enginePrefix, readJson, tarballName } from '../scripts/platform-matrix.mjs';
import { sha256 } from '../scripts/verify-artifacts.mjs';

test('version repacking includes supplemental engines omitted from the old release manifest', t => {
  const repo = mkdtempSync(join(tmpdir(), 'kit-supplemental-repack-'));
  t.after(() => rmSync(repo, { recursive: true, force: true, maxRetries: 3 }));
  const input = join(repo, 'download');
  const destination = join(repo, 'candidate');
  mkdirSync(input);
  const fromVersion = '0.0.1';
  const version = '0.0.1-1';
  const platforms = ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64', 'wasm'];
  const source = { repository: 'https://example.invalid/core.git', revision: 'a'.repeat(40) };
  const json = value => `${JSON.stringify(value, null, 2)}\n`;
  const save = (file, value) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, json(value));
  };
  save(join(repo, 'core-source.json'), source);
  save(join(repo, 'packages/entry/package.json'), {
    name: enginePrefix, version,
    optionalDependencies: Object.fromEntries(platforms.map(platform => [`${enginePrefix}-${platform}`, version])),
  });
  const recipes = {
    native: ['engine/native/worker.cxx', 'engine/native/build-helper.mjs', 'engine/native/patches/fixture.patch'],
    wasm: ['engine/wasm-source/lok.cxx', 'engine/wasm-source/build.mjs', 'engine/wasm-source/patches/fixture.patch'],
  };
  for (const file of Object.values(recipes).flat()) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), 'saved source recipe\n');
  }
  // Small payloads exercise actual archive/hash/assembly boundaries without compiling Core.
  const originals = new Map();
  const records = platforms.map(platform => {
    const manifest = { name: `${enginePrefix}-${platform}`, version: fromVersion };
    const prebuild = { version: fromVersion, platform, status: 'built', source };
    const bytes = tarFixture({
      'package/package.json': json(manifest),
      'package/prebuilds.json': json(prebuild),
      'package/bin/worker': `fixture payload for ${platform}\n`,
      ...Object.fromEntries(recipes[platform === 'wasm' ? 'wasm' : 'native']
        .map(file => [`package/sources/${file}`, readFileSync(join(repo, file))])),
    });
    originals.set(platform, bytes);
    const gzip = join(input, tarballName(manifest));
    writeFileSync(gzip, gzipSync(bytes));
    const record = { ...manifest, platform, ...packEngineArchive(gzip, input, manifest) };
    rmSync(gzip);
    return record;
  });
  const oldPlatforms = ['darwin-arm64', 'wasm'];
  const previous = { schemaVersion: 1, version: fromVersion, platforms: oldPlatforms,
    packages: records.filter(record => oldPlatforms.includes(record.platform)), dependencies: [] };
  save(join(input, 'release.json'), previous);
  const supplemental = [
    ['win32-x64', 'windows-verification.json'],
    ['win32-arm64', 'windows-arm64-verification.json'],
    ['darwin-x64', 'macos-x64-verification.json'],
  ];
  for (const [platform, file] of supplemental) {
    save(join(input, file), { version: fromVersion, platform, engines: [records.find(record => record.platform === platform)] });
  }
  const files = ['release.json', ...records.map(record => record.file), ...supplemental.map(([, file]) => file)];
  save(join(input, 'github-assets.json'), { assets: files.map(name => ({
    name, size: statSync(join(input, name)).size, digest: `sha256:${sha256(join(input, name))}`,
  })) });

  const result = assemblePrebuiltRelease(input, destination, [], { repackageFromVersion: fromVersion, repo });
  assert.deepEqual(readJson(join(destination, 'release.json')), result);
  assert.equal(result.version, version);
  assert.deepEqual(result.platforms, platforms);
  assert.deepEqual(result.dependencies, []);
  assert.deepEqual(result.repackagedFrom, { version: fromVersion, releaseManifestSha256: sha256(join(input, 'release.json')) });
  assert.equal(result.packages.length, platforms.length);
  for (const [index, record] of result.packages.entries()) {
    const original = records[index];
    assert.equal(record.platform, original.platform);
    assert.equal(record.version, version);
    assert.deepEqual(record.repackagedFrom, {
      version: fromVersion, file: original.file, sha256: original.sha256, install: original.install,
    });
    const before = originals.get(record.platform);
    const entries = new Map();
    visitTar(before, entry => entries.set(entry.name, entry));
    const after = readFileSync(materializeEngineArchive(destination, record, join(repo, 'unpacked')));
    visitTar(after, entry => {
      const previousEntry = entries.get(entry.name);
      assert.ok(previousEntry, `Unexpected repacked entry: ${entry.name}`);
      if (['package/package.json', 'package/prebuilds.json'].includes(entry.name)) {
        assert.deepEqual(JSON.parse(entry.data), { ...JSON.parse(previousEntry.data), version });
      } else {
        assert.deepEqual(after.subarray(entry.headerOffset, entry.endOffset),
          before.subarray(previousEntry.headerOffset, previousEntry.endOffset));
      }
      entries.delete(entry.name);
    });
    assert.equal(entries.size, 0, 'Repacking must retain every original entry');
  }
  assert.deepEqual(readJson(join(input, 'release.json')), previous);
});
