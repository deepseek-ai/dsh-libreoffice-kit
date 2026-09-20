/** A metadata check permits planned targets; a release check requires real payloads. */
import { verifyBrowserPackage } from './build-browser.mjs';
import { verifyKitMetadata } from './verify-kit.mjs';
import { join } from 'node:path';
import { assert, verifyEngineMetadata, verifyEnginePackage } from './verify-artifacts.mjs';
import { isMain, kitManifest, kitNativeTargets, packageMatrix, readJson, releaseTag, releaseTargets, root, targets } from './platform-matrix.mjs';

/**
 * Check the engine workspace and, unless metadata-only, every staged engine payload.
 * @param options - Repository root, optional platform selection, and whether payloads must be present.
 * @returns the verified release version, check kind, and declared platform statuses.
 */
export function verifyRelease({ repo = root, platforms, metadataOnly = false } = {}) {
  const workspace = readJson(join(repo, 'package.json'));
  const adapter = verifyKitMetadata(kitManifest(repo));
  platforms ??= releaseTargets([], kitNativeTargets(adapter));
  assert(Array.isArray(platforms) && platforms.length > 0 && new Set(platforms).size === platforms.length,
    'Release platform selection must be nonempty and unique');
  for (const platform of platforms) assert(platform === 'wasm' || Object.hasOwn(targets, platform), `Unknown release target: ${platform}`);
  assert(workspace.private === true && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(workspace.version), 'The engine workspace must carry the family release version');
  const browser = readJson(join(repo, 'packages/browser/package.json'));
  assert(browser.private === true && browser.name === '@deepseek-ai/libreoffice-kit-browser-internal' && browser.version === workspace.version, 'Browser and engine family versions differ');
  assert(browser.os === undefined && browser.cpu === undefined && browser.libc === undefined, 'Browser assets must be OS-independent');
  const matrix = packageMatrix(repo);
  assert(JSON.stringify(matrix.map((row) => row.prebuild.platform).sort()) === JSON.stringify([...Object.keys(targets), 'wasm'].sort()), 'Declared engine package matrix is incomplete or duplicated');
  for (const row of matrix) {
    assert(row.manifest.version === workspace.version, `Version mismatch: ${row.manifest.name}`);
    verifyEngineMetadata(row.manifest, row.prebuild);
  }
  const ref = process.env.GITHUB_REF ?? '';
  const tag = `refs/tags/${releaseTag(workspace.version)}`;
  if (ref.startsWith('refs/tags/libreoffice-kit-v')) assert(ref === tag, `Release tag/version mismatch; expected ${releaseTag(workspace.version)}`);
  if (process.env.RELEASE_PUBLISH === 'true') assert(ref === tag, 'Publishing requires the matching libreoffice-kit-v* release tag');
  if (!metadataOnly) {
    for (const platform of platforms) {
      const row = matrix.find((entry) => entry.prebuild.platform === platform);
      assert(row, `Unknown release target: ${platform}`);
      verifyEnginePackage(row.dir);
    }
    verifyBrowserPackage(join(repo, 'packages/entry'), join(repo, 'packages/wasm'));
  }
  return { version: workspace.version, check: metadataOnly ? 'metadata-only' : 'staged-artifacts', platforms: matrix.map((row) => ({ platform: row.prebuild.platform, status: row.prebuild.status })) };
}

if (isMain(import.meta.url)) {
  console.log(JSON.stringify(verifyRelease({ platforms: releaseTargets(process.argv.slice(2)), metadataOnly: process.argv.includes('--metadata-only') }), null, 2));
}
