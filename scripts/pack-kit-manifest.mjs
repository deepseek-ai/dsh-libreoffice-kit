/** Project workspace engine dependencies to immutable GitHub Release asset URLs during pnpm pack. */
import { join } from 'node:path';
import { enginePrefix, kitManifest, kitNativeTargets, kitPackageName, readJson, releaseAssetUrl, root, tarballName, wasmName } from './platform-matrix.mjs';
import { assert } from './verify-artifacts.mjs';

/**
 * Record internal release locations; application builds supply authenticated local engine archives.
 * @param manifest - Exportable manifest after pnpm has resolved workspace ranges.
 * @returns The adapter manifest with pinned release URLs, or the unchanged unrelated manifest.
 */
export function packKitManifest(manifest) {
  if (manifest.name !== kitPackageName) return manifest;
  const version = readJson(join(root, 'package.json')).version;
  const native = kitNativeTargets(kitManifest()).map(target => `${enginePrefix}-${target}`);
  assert(manifest.dependencies?.[wasmName] === version, 'Packed adapter WASM dependency must match the engine family version');
  assert(JSON.stringify(Object.keys(manifest.optionalDependencies ?? {}).sort()) === JSON.stringify([...native].sort()), 'Packed adapter native targets differ from the release declaration');
  const url = name => releaseAssetUrl(version, tarballName({ name, version }));
  const optionalDependencies = {};
  for (const name of native) {
    assert(manifest.optionalDependencies[name] === version, 'Packed adapter native dependency must match the engine family version');
    optionalDependencies[name] = url(name);
  }
  return { ...manifest, dependencies: { ...manifest.dependencies, [wasmName]: url(wasmName) }, optionalDependencies };
}
