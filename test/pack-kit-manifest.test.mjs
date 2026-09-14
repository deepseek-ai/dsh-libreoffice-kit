import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { hooks } from '../.pnpmfile.mjs';
import { packKitManifest } from '../scripts/pack-kit-manifest.mjs';
import { kitManifest, releaseAssetUrl, root, tarballName, wasmName } from '../scripts/platform-matrix.mjs';
import { engineFamilyVersion, verifyKitMetadata } from '../scripts/verify-kit.mjs';

function resolvedManifest() {
  const manifest = structuredClone(kitManifest());
  const version = engineFamilyVersion();
  manifest.dependencies[wasmName] = version;
  for (const name of Object.keys(manifest.optionalDependencies)) manifest.optionalDependencies[name] = version;
  return manifest;
}

test('pnpm packs the adapter with versioned GitHub engine assets and keeps development manifests unchanged', () => {
  const manifest = resolvedManifest();
  const before = structuredClone(manifest);
  const packed = packKitManifest(manifest);
  const version = engineFamilyVersion();
  for (const name of [wasmName, ...Object.keys(manifest.optionalDependencies)]) {
    assert.equal((name === wasmName ? packed.dependencies : packed.optionalDependencies)[name], releaseAssetUrl(version, tarballName({ name, version })));
  }
  assert.equal(packed.dependencies.fflate, manifest.dependencies.fflate);
  assert.deepEqual(manifest, before);
  assert.equal(kitManifest().dependencies[wasmName], 'workspace:*');
  assert.equal(verifyKitMetadata(packed, true), packed);
});

test('packing rejects stale engine versions and an altered native target set', () => {
  const wasm = resolvedManifest();
  wasm.dependencies[wasmName] = '0.0.0';
  assert.throws(() => packKitManifest(wasm), /WASM dependency/);
  const native = resolvedManifest();
  native.optionalDependencies[Object.keys(native.optionalDependencies)[0]] = '0.0.0';
  assert.throws(() => packKitManifest(native), /native dependency/);
  const missing = resolvedManifest();
  delete missing.optionalDependencies[Object.keys(missing.optionalDependencies)[0]];
  assert.throws(() => packKitManifest(missing), /native targets/);
  assert.throws(() => verifyKitMetadata(resolvedManifest(), true), /WASM engine/);
});

test('the workspace enables the narrow pack hook and unrelated packages retain their dependencies', () => {
  assert.equal(hooks.beforePacking, packKitManifest);
  assert.match(readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8'), /^pnpmfile: \.pnpmfile\.mjs$/m);
  const other = { name: '@deepseek-ai/dsh-unrelated', dependencies: { [wasmName]: '0.1.1' } };
  assert.equal(packKitManifest(other), other);
});
