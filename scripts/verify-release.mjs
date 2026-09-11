/** A metadata check permits planned targets; a release check requires real payloads. */
import { join } from 'node:path';
import { assert, verifyEngineMetadata, verifyEnginePackage } from './verify-artifacts.mjs';
import { verifyEntryMetadata, verifyEntryPackage } from './verify-entry.mjs';
import { isMain, packageMatrix, readJson, releaseTargets, root, targets } from './platform-matrix.mjs';

export function verifyRelease({ repo = root, platforms = [...Object.keys(targets), 'wasm'], metadataOnly = false } = {}) {
  const workspace = readJson(join(repo, 'package.json'));
  const entry = readJson(join(repo, 'packages/entry/package.json'));
  assert(workspace.private === true && workspace.version === entry.version && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(entry.version), 'Workspace and entry must share one release version');
  verifyEntryMetadata(entry);
  const matrix = packageMatrix(repo);
  assert(JSON.stringify(matrix.map((row) => row.prebuild.platform).sort()) === JSON.stringify([...Object.keys(targets), 'wasm'].sort()), 'Declared engine package matrix is incomplete or duplicated');
  for (const row of matrix) {
    assert(row.manifest.version === entry.version, `Version mismatch: ${row.manifest.name}`);
    verifyEngineMetadata(row.manifest, row.prebuild);
  }
  const ref = process.env.GITHUB_REF ?? '';
  if (ref.startsWith('refs/tags/v')) assert(ref === `refs/tags/v${entry.version}`, 'Release tag/version mismatch');
  if (process.env.RELEASE_PUBLISH === 'true') assert(ref === `refs/tags/v${entry.version}`, 'Publishing requires the matching v* release tag');
  if (!metadataOnly) {
    for (const platform of platforms) {
      const row = matrix.find((entry) => entry.prebuild.platform === platform);
      assert(row, `Unknown release target: ${platform}`);
      verifyEnginePackage(row.dir);
    }
    verifyEntryPackage(join(repo, 'packages/entry'));
  }
  return { version: entry.version, check: metadataOnly ? 'metadata-only' : 'staged-artifacts', platforms: matrix.map((row) => ({ platform: row.prebuild.platform, status: row.prebuild.status })) };
}

if (isMain(import.meta.url)) {
  console.log(JSON.stringify(verifyRelease({ platforms: releaseTargets(process.argv.slice(2)), metadataOnly: process.argv.includes('--metadata-only') }), null, 2));
}
