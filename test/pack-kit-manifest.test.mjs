import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { hooks } from '../.pnpmfile.mjs';
import { packKitManifest } from '../scripts/pack-kit-manifest.mjs';
import { kitManifest, root, wasmName } from '../scripts/platform-matrix.mjs';
import { engineFamilyVersion, verifyKitMetadata } from '../scripts/verify-kit.mjs';

function resolvedManifest() {
  const manifest = structuredClone(kitManifest());
  const version = engineFamilyVersion();
  manifest.dependencies[wasmName] = version;
  return manifest;
}

test('pnpm packs exact engine versions for prepared local archives and keeps development manifests unchanged', () => {
  const manifest = resolvedManifest();
  const before = structuredClone(manifest);
  const packed = packKitManifest(manifest);
  const version = engineFamilyVersion();
  assert.equal(packed.dependencies[wasmName], version);
  assert.equal(packed.optionalDependencies, undefined);
  assert.equal(packed.dependencies.fflate, manifest.dependencies.fflate);
  assert.deepEqual(manifest, before);
  assert.equal(kitManifest().dependencies[wasmName], 'workspace:*');
  assert.equal(verifyKitMetadata(packed, true), packed);
});

test('packing rejects stale or missing required WASM and optional native engines', () => {
  const wasm = resolvedManifest();
  wasm.dependencies[wasmName] = '0.0.0';
  assert.throws(() => packKitManifest(wasm), /required exact-version dependency/);
  const native = resolvedManifest();
  native.optionalDependencies = { '@deepseek-ai/libreoffice-kit-darwin-arm64': engineFamilyVersion() };
  assert.throws(() => packKitManifest(native), /must not declare optional engines/);
  const missing = resolvedManifest();
  delete missing.dependencies[wasmName];
  assert.throws(() => packKitManifest(missing), /required exact-version dependency/);
  assert.equal(verifyKitMetadata(resolvedManifest(), true).dependencies[wasmName], engineFamilyVersion());
});

test('the workspace enables the narrow pack hook and unrelated packages retain their dependencies', () => {
  assert.equal(hooks.beforePacking, packKitManifest);
  assert.match(readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8'), /^pnpmfile: \.pnpmfile\.mjs$/m);
  const other = { name: '@deepseek-ai/dsh-unrelated', dependencies: { [wasmName]: '0.1.1' } };
  assert.equal(packKitManifest(other), other);
});
