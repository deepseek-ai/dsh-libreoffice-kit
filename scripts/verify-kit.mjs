/** Refuse an adapter manifest that names the wrong family, Node baseline, or engine dependencies. */
import { join, resolve } from 'node:path';
import { isMain, kitDirectory, kitManifest, kitPackageName, nodeRange, readJson, root, wasmName } from './platform-matrix.mjs';
import { assert, regularFile } from './verify-artifacts.mjs';

/** The engine family version a packed adapter pins its installed engines to. */
export function engineFamilyVersion(repo = root) {
  return readJson(join(repo, 'package.json')).version;
}

/**
 * Check the adapter's identity, Node baseline, and engine dependency ranges.
 * @param manifest - Adapter package manifest.
 * @param packed - Whether pnpm has resolved workspace dependencies to exact engine versions.
 * @returns the verified manifest.
 */
export function verifyKitMetadata(manifest, packed = false) {
  assert(manifest.name === kitPackageName && manifest.type === 'module' && manifest.engines?.node === nodeRange, 'Invalid adapter identity/Node baseline');
  const version = engineFamilyVersion();
  assert(manifest.version === version, 'The Node API version must equal the kit family version');
  const declared = packed ? version : 'workspace:*';
  assert(manifest.dependencies?.[wasmName] === declared, 'The WASM engine must be a required exact-version dependency');
  assert(Object.keys(manifest.dependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/libreoffice-kit')).every(name => name === wasmName), 'The released API must depend only on the shared WASM engine');
  assert(Object.keys(manifest.optionalDependencies ?? {}).length === 0, 'The released API must not declare optional engines');
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
