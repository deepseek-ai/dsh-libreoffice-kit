/** Validate engine versions after pnpm resolves workspace dependencies. */
import { join } from 'node:path';
import { enginePrefix, kitManifest, kitNativeTargets, kitPackageName, readJson, root, wasmName } from './platform-matrix.mjs';
import { assert } from './verify-artifacts.mjs';

/**
 * Application builds override these exact versions with authenticated local engine archives.
 * @param manifest - Exportable manifest after pnpm has resolved workspace ranges.
 * @returns The validated adapter manifest, or the unchanged unrelated manifest.
 */
export function packKitManifest(manifest) {
  if (manifest.name !== kitPackageName) return manifest;
  const version = readJson(join(root, 'package.json')).version;
  const native = kitNativeTargets(kitManifest()).map(target => `${enginePrefix}-${target}`);
  assert(manifest.dependencies?.[wasmName] === version, 'Packed adapter WASM dependency must match the engine family version');
  assert(JSON.stringify(Object.keys(manifest.optionalDependencies ?? {}).sort()) === JSON.stringify([...native].sort()), 'Packed adapter native targets differ from the release declaration');
  for (const name of native) {
    assert(manifest.optionalDependencies[name] === version, 'Packed adapter native dependency must match the engine family version');
  }
  return manifest;
}
