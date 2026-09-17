#!/usr/bin/env node
/** Stage the shared font implementation as a portable package without LibreOffice engines. */
import { cpSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildKitSources } from './build-kit.mjs';
import { verifyFontSubset } from './build-font-subset.mjs';
import { isMain, nodeRange, readJson, root } from './platform-matrix.mjs';
import { assert, regularFile, sha256, verifyNoInstallHooks } from './verify-artifacts.mjs';

const directory = join(root, 'packages/fonts');
const runtimeFiles = ['lib/font-source.js', 'lib/font-worker.js', ...['font-source', 'font-source-types', 'font-request'].map(name => `lib/types/${name}.d.ts`)];
const sourcePaths = ['packages/entry/src', 'packages/entry/package.json', 'packages/entry/tsconfig.json', 'packages/entry/tsdown.config.ts',
  'tsconfig.base.json', 'scripts/build-kit.mjs', 'scripts/build-fonts.mjs'];

function inventory(target, relative) {
  return readdirSync(join(target, relative), { withFileTypes: true }).flatMap(entry => {
    const path = `${relative}/${entry.name}`;
    assert(entry.isFile() || entry.isDirectory(), `Nonregular font package file: ${path}`);
    return entry.isDirectory() ? inventory(target, path) : [path];
  });
}

/** Require only the two portable JavaScript dependencies used by the font Worker. */
export function verifyFontMetadata(manifest, expectedVersion = readJson(join(root, 'package.json')).version) {
  verifyNoInstallHooks(manifest);
  assert(manifest.name === '@deepseek-ai/libreoffice-kit-fonts' && manifest.version === expectedVersion
    && manifest.type === 'module' && manifest.engines?.node === nodeRange, 'Invalid portable font package identity/version');
  assert(manifest.os === undefined && manifest.cpu === undefined && manifest.libc === undefined, 'Portable fonts must be OS-independent');
  assert(manifest.optionalDependencies === undefined && manifest.peerDependencies === undefined, 'Portable fonts must not depend on LibreOffice engines');
  const dependencies = readJson(join(root, 'packages/entry/package.json')).dependencies;
  assert(JSON.stringify(manifest.dependencies) === JSON.stringify(Object.fromEntries(['@unicode/unicode-17.0.0', 'fontkit'].map(name => [name, dependencies[name]]))),
    'Portable font dependencies must match the shared font implementation');
  assert(manifest.exports?.['.']?.import === './lib/font-source.js' && manifest.exports?.['.']?.types === './lib/types/font-source.d.ts', 'Invalid portable font entry');
  return manifest;
}

/** Validate every staged runtime, declaration, source, subset and license file. */
export function verifyFontPackage(target = directory, expectedVersion) {
  const manifest = verifyFontMetadata(readJson(regularFile(target, 'package.json')), expectedVersion);
  const subset = verifyFontSubset(target);
  const receipt = readJson(regularFile(target, 'font-api.json'));
  const paths = [...inventory(target, 'lib'), ...inventory(target, 'sources/font-api'), 'LICENSE', 'NOTICE'].sort();
  assert(receipt.schemaVersion === 1 && JSON.stringify(Object.keys(receipt.files).sort()) === JSON.stringify(paths), 'Incomplete portable font source/runtime receipt');
  for (const path of [...runtimeFiles, 'sources/font-api/packages/entry/src/font-source.ts',
    ...sourcePaths.filter(path => path !== 'packages/entry/src').map(path => `sources/font-api/${path}`)]) regularFile(target, path);
  for (const path of paths) {
    const file = regularFile(target, path);
    assert(receipt.files[path].bytes === statSync(file).size && receipt.files[path].sha256 === sha256(file), `Portable font checksum differs: ${path}`);
  }
  const payload = ['lib', 'assets', 'sources', 'licenses'].flatMap(path => inventory(target, path)).sort();
  const expected = [...paths.filter(path => path.includes('/')), ...Object.keys(subset.files), 'assets/font-subset.json'].sort();
  assert(JSON.stringify(payload) === JSON.stringify(expected), 'Portable font package contains missing or undeclared payloads');
  return manifest;
}

/** Copy built shared entries and their matching source receipts without copying an engine. */
export function stageFontPackage() {
  const entry = join(root, 'packages/entry');
  verifyFontSubset(entry);
  verifyFontMetadata(readJson(join(directory, 'package.json')));
  for (const path of ['lib', 'assets', 'sources', 'licenses']) rmSync(join(directory, path), { recursive: true, force: true });
  for (const path of [...runtimeFiles, 'assets/font-subset.wasm', 'assets/font-subset.json', 'sources/font-subset', 'licenses/font-subset', 'LICENSE', 'NOTICE']) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    cpSync(join(entry, path), join(directory, path), { recursive: true });
  }
  for (const path of sourcePaths) {
    const target = join(directory, 'sources/font-api', path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(root, path), target, { recursive: true });
  }
  const paths = [...inventory(directory, 'lib'), ...inventory(directory, 'sources/font-api'), 'LICENSE', 'NOTICE'];
  const files = Object.fromEntries(paths.map(path => [path, { bytes: statSync(join(directory, path)).size, sha256: sha256(join(directory, path)) }]));
  writeFileSync(join(directory, 'font-api.json'), `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`);
  verifyFontPackage();
  return directory;
}

if (isMain(import.meta.url)) {
  if (process.argv.includes('--verify')) verifyFontPackage(process.argv[3] ? resolve(process.argv[3]) : directory);
  else { buildKitSources(); stageFontPackage(); }
  console.log(`Portable font package: ${directory}`);
}
