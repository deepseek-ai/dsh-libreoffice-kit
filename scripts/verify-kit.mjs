/** Refuse an adapter manifest that names the wrong family, Node baseline, or engine dependencies. */
import { join, resolve } from 'node:path';
import { enginePrefix, isMain, kitDirectory, kitManifest, kitNativeTargets, kitPackageName, nodeRange, readJson, root, wasmName } from './platform-matrix.mjs';
import { assert, regularFile } from './verify-artifacts.mjs';

/** The engine family version a packed adapter pins its installed engines to. */
export function engineFamilyVersion(repo = root) {
  return readJson(join(repo, 'package.json')).version;
}

/**
 * Check the adapter's identity, Node baseline, and engine dependency ranges.
 * @param manifest - Adapter package manifest.
 * @param packed - Whether pnpm has resolved workspace dependencies to exact engine versions.
 * @param nativeTargets - Released native targets; defaults to the declaration the source manifest carries.
 * @returns the verified manifest.
 */
export function verifyKitMetadata(manifest, packed = false, nativeTargets) {
  assert(manifest.name === kitPackageName && manifest.type === 'module' && manifest.engines?.node === nodeRange, 'Invalid adapter identity/Node baseline');
  const version = engineFamilyVersion();
  assert(manifest.version === version, 'The Node API version must equal the kit family version');
  const declared = packed ? version : 'workspace:*';
  assert(manifest.dependencies?.[wasmName] === undefined, 'The WASM engine must be optional');
  const expected = (nativeTargets ?? kitNativeTargets(packed ? kitManifest() : manifest))
    .map((target) => `${enginePrefix}-${target}`).concat(wasmName).sort();
  assert(JSON.stringify(Object.keys(manifest.optionalDependencies ?? {}).sort()) === JSON.stringify(expected), 'Optional dependency matrix is incomplete');
  for (const name of expected) assert(manifest.optionalDependencies[name] === declared, 'Optional engine dependency ranges must equal the engine family version');
  return manifest;
}

/**
 * Check one installed or staged adapter directory.
 * @param directory - Package directory holding the adapter manifest.
 * @param packed - Whether the manifest came from `pnpm pack`.
 * @returns the verified manifest.
 */
export function verifyKitPackage(directory, packed = false) {
  for (const file of ['LICENSE', 'NOTICE']) regularFile(directory, file);
  return verifyKitMetadata(readJson(regularFile(directory, 'package.json')), packed);
}

if (isMain(import.meta.url)) {
  console.log(`Verified adapter ${verifyKitPackage(resolve(process.argv[2] ?? kitDirectory())).name}`);
}
