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
  for (const name of Object.keys(manifest.optionalDependencies)) manifest.optionalDependencies[name] = version;
  return manifest;
}

test('pnpm packs exact engine versions for prepared local archives and keeps development manifests unchanged', () => {
  const manifest = resolvedManifest();
  const before = structuredClone(manifest);
  const packed = packKitManifest(manifest);
  const version = engineFamilyVersion();
  for (const name of Object.keys(manifest.optionalDependencies)) {
    assert.equal(packed.optionalDependencies[name], version);
  }
  assert.equal(packed.dependencies.fflate, manifest.dependencies.fflate);
  assert.deepEqual(manifest, before);
  assert.equal(kitManifest().optionalDependencies[wasmName], 'workspace:*');
  assert.equal(verifyKitMetadata(packed, true), packed);
});

test('packing rejects stale engine versions and an altered native target set', () => {
  const wasm = resolvedManifest();
  wasm.optionalDependencies[wasmName] = '0.0.0';
  assert.throws(() => packKitManifest(wasm), /engine family version/);
  const native = resolvedManifest();
  native.optionalDependencies[Object.keys(native.optionalDependencies)[0]] = '0.0.0';
  assert.throws(() => packKitManifest(native), /engine family version/);
  const missing = resolvedManifest();
  delete missing.optionalDependencies[Object.keys(missing.optionalDependencies)[0]];
  assert.throws(() => packKitManifest(missing), /Optional dependency matrix/);
  assert.equal(verifyKitMetadata(resolvedManifest(), true).optionalDependencies[wasmName], engineFamilyVersion());
});

test('the workspace enables the narrow pack hook and unrelated packages retain their dependencies', () => {
  assert.equal(hooks.beforePacking, packKitManifest);
  assert.match(readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8'), /^pnpmfile: \.pnpmfile\.mjs$/m);
  const other = { name: '@deepseek-ai/dsh-unrelated', dependencies: { [wasmName]: '0.1.1' } };
  assert.equal(packKitManifest(other), other);
});
