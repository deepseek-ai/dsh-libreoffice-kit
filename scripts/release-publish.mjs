/** Publish only an explicitly verified, complete family; leaf packages precede the entry. */
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assert, sha256 } from './verify-artifacts.mjs';
import { entryName, isMain, readJson, root, targets } from './platform-matrix.mjs';
import { npmCli } from './pack-utils.mjs';

export function validatePublication(directory, env = process.env) {
  const release = readJson(join(directory, 'release.json'));
  assert(release.schemaVersion === 1, 'Unsupported release manifest');
  assert(env.GITHUB_REF === `refs/tags/v${release.version}`, 'Publication requires the matching release tag');
  assert(JSON.stringify([...release.platforms].sort()) === JSON.stringify([...Object.keys(targets), 'wasm'].sort()), 'Publication requires every declared platform; a partial pack is only a development artifact');
  const expected = [...release.platforms.map((platform) => `${entryName}-${platform}`), entryName];
  assert(JSON.stringify(release.packages.map((record) => record.name)) === JSON.stringify(expected), 'Release package order is incomplete or the entry is not last');
  for (const record of release.packages) {
    assert(record.version === release.version && sha256(join(directory, record.file)) === record.sha256, `Invalid release tarball: ${record.file}`);
  }
  const evidence = readJson(join(directory, 'verification.json'));
  assert(evidence.sourceCommit === env.GITHUB_SHA && /^[a-f0-9]{40}$/.test(evidence.sourceCommit), 'Verification is not for this release commit');
  assert(evidence.releaseManifestSha256 === sha256(join(directory, 'release.json')), 'Verification belongs to different release bytes');
  for (const platform of release.platforms) {
    const record = evidence.platforms.find((entry) => entry.platform === platform);
    assert(record?.nativeInstalled === (platform !== 'wasm') && record?.wasmInstalled === true && record?.passed === true,
      `Missing native/WASM installed conversion evidence: ${platform}`);
  }
  return release;
}

if (isMain(import.meta.url)) {
  const directory = resolve(process.argv[2] ?? join(root, '.release/npm'));
  const release = validatePublication(directory);
  assert(process.argv.includes('--publish'), 'Pass --publish only after reviewing the verified release');
  for (const record of release.packages) {
    const result = spawnSync(process.execPath, [npmCli(), 'publish', join(directory, record.file), '--access', 'restricted', '--ignore-scripts'], { stdio: 'inherit' });
    if (result.error) throw result.error;
    assert(result.status === 0, `Publication failed for ${record.name}; later packages were not published`);
  }
}
