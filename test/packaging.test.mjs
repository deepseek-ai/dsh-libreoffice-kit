import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { packageMatrix, readJson, root } from '../scripts/platform-matrix.mjs';
import { regularFile, safePath, verifyEngineMetadata, verifyEnginePackage, verifyNativeHeader, verifyNativeImage, verifyNoInstallHooks } from '../scripts/verify-artifacts.mjs';
import { verifyEntryMetadata } from '../scripts/verify-entry.mjs';
import { configureFlags } from '../engine/native/configure.mjs';

const row = packageMatrix().find((row) => row.prebuild.platform === 'darwin-arm64');
const unbuilt = () => ({ ...structuredClone(row.prebuild), status: 'unbuilt', files: {}, source: null, licenses: [] });
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'libreoffice-kit-packaging-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

test('declared metadata covers eight native packages and mandatory WASM', () => {
  const matrix = packageMatrix();
  assert.equal(matrix.length, 9);
  for (const row of matrix) verifyEngineMetadata(row.manifest, row.prebuild);
  const manifest = readJson(join(root, 'packages/entry/package.json'));
  verifyEntryMetadata(manifest);
  const missingWasm = structuredClone(manifest);
  delete missingWasm.dependencies['@deepseek-ai/libreoffice-kit-wasm'];
  assert.throws(() => verifyEntryMetadata(missingWasm), /required dependency/);
  assert.throws(() => verifyEntryMetadata(manifest, true), /published version/);
  for (const field of ['dependencies', 'optionalDependencies']) {
    for (const name of Object.keys(manifest[field])) if (manifest[field][name] === 'workspace:*') manifest[field][name] = manifest.version;
  }
  verifyEntryMetadata(manifest, true);
});

test('an unbuilt target cannot be packed even with valid metadata', (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, 'package.json'), JSON.stringify(row.manifest));
  writeFileSync(join(dir, 'prebuilds.json'), JSON.stringify(unbuilt()));
  assert.throws(() => verifyEnginePackage(dir), /unbuilt target cannot be packed/);
  const fake = unbuilt();
  fake.files['bin/libreoffice-kit'] = '0'.repeat(64);
  assert.throws(() => verifyEngineMetadata(row.manifest, fake), /Unbuilt target must not claim/);
});

test('native manifest rejects OS, CPU, libc, path and receipt mismatches', () => {
  assert.throws(() => verifyEngineMetadata({ ...row.manifest, cpu: ['x64'] }, unbuilt()), /os\/cpu\/libc/);
  const traversal = unbuilt(); traversal.engine.programDirectory = 'program/../../outside';
  assert.throws(() => verifyEngineMetadata(row.manifest, traversal), /Unsafe package path/);
  const built = unbuilt(); built.status = 'built';
  assert.throws(() => verifyEngineMetadata(row.manifest, built), /requires source/);
  const wasm = packageMatrix().find((entry) => entry.prebuild.platform === 'wasm');
  assert.throws(() => verifyEngineMetadata({ ...wasm.manifest, os: ['linux'] }, wasm.prebuild), /every host/);
});

test('paths reject escape sequences and symlinks', (t) => {
  for (const path of ['', '/absolute', '../escape', 'program/../../escape', 'program\\file', 'C:/file', 'program//file', 'program/./file', 'program/\0file'])
    assert.throws(() => safePath(path), /Unsafe package path/);
  assert.equal(safePath('program/LibreOffice.app/Contents/Frameworks/core.dylib'), 'program/LibreOffice.app/Contents/Frameworks/core.dylib');
  const dir = scratch(t);
  mkdirSync(join(dir, 'program'));
  writeFileSync(join(dir, 'regular'), 'bytes');
  assert.throws(() => regularFile(dir, 'program/missing'), /Missing package artifact/);
  if (process.platform !== 'win32') {
    symlinkSync('../regular', join(dir, 'program/link'));
    assert.throws(() => regularFile(dir, 'program/link'), /Not a regular/);
  }
});

test('installation has no compilation, downloads, or unresolved dependency ranges', () => {
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare'])
    assert.throws(() => verifyNoInstallHooks({ name: 'bad', scripts: { [hook]: 'node build.mjs' } }), /forbidden install/);
  assert.throws(() => verifyNoInstallHooks({ name: 'bad', gypfile: true }), /CLI bins/);
  assert.throws(() => verifyNoInstallHooks({ name: 'bad', dependencies: { library: '^1.0.0' } }), /pin a published version/);
});

test('minimal architecture headers do not pass executable release validation', (t) => {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(0x0100000c, 4); bytes.writeUInt32LE(2, 12);
  verifyNativeHeader(bytes, 'darwin-arm64');
  assert.throws(() => verifyNativeHeader(bytes, 'darwin-x64'), /Wrong Mach-O architecture/);
  const file = join(scratch(t), 'fake');
  writeFileSync(file, bytes); chmodSync(file, 0o755);
  assert.throws(() => verifyNativeImage(file, 'darwin-arm64'), /no load commands/);
});

test('native recipes preserve upstream platform differences', () => {
  assert.ok(configureFlags('linux-x64-glibc', '/build/tarballs', 8).includes('--disable-gui'));
  assert.ok(configureFlags('linux-arm64-musl', '/build/tarballs', 8).includes('--without-x'));
  assert.ok(!configureFlags('darwin-arm64', '/build/tarballs', 8).includes('--disable-gui'));
  assert.ok(!configureFlags('darwin-arm64', '/build/tarballs', 8).includes('--disable-skia'));
  assert.ok(!configureFlags('win32-arm64', '/build/tarballs', 8).includes('--disable-gui'));
});
