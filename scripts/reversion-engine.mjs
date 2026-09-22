/** Change package identity only when every engine byte and source recipe still matches. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { kitManifest, readJson, root } from './platform-matrix.mjs';
import { assert, verifyEnginePackage } from './verify-artifacts.mjs';
import { verifyPreparedEngine } from './prepare-artifacts.mjs';

export function reversionEngine(platform, directory, fromVersion, repo = root) {
  assert(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(fromVersion), 'Reuse requires an explicit package version');
  const manifestFile = join(directory, 'package.json');
  const prebuildFile = join(directory, 'prebuilds.json');
  const originalManifest = readFileSync(manifestFile);
  const originalPrebuild = readFileSync(prebuildFile);
  const manifest = JSON.parse(originalManifest);
  const prebuild = JSON.parse(originalPrebuild);
  const target = readJson(join(repo, 'packages', platform, 'package.json'));
  assert(manifest.version === fromVersion && target.version === kitManifest(repo).version,
    'Reused engine version differs from the explicit source or target');
  assert(JSON.stringify({ ...manifest, version: target.version }) === JSON.stringify(target),
    'Only the package version may differ when reusing an engine');
  verifyEnginePackage(directory);
  try {
    writeFileSync(manifestFile, `${JSON.stringify(target, null, 2)}\n`);
    writeFileSync(prebuildFile, `${JSON.stringify({ ...prebuild, version: target.version }, null, 2)}\n`);
    // This checks the pinned Core, patch set, configure flags and recipe hashes.
    // Executables, WASM assets, licenses and source receipts are never rewritten.
    return verifyPreparedEngine(platform, directory, repo);
  } catch (error) {
    writeFileSync(manifestFile, originalManifest);
    writeFileSync(prebuildFile, originalPrebuild);
    throw error;
  }
}
