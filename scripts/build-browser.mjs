#!/usr/bin/env node
/** Build and qualify the OS-independent browser API with a receipted WASM engine. */
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { buildKitSources } from './build-kit.mjs';
import { root, isMain, readJson } from './platform-matrix.mjs';
import { pnpm } from './pack-utils.mjs';
import { assert, regularFile, sha256, verifyEnginePackage } from './verify-artifacts.mjs';

const directory = join(root, 'packages/browser');
const assetPaths = { worker: 'lib/worker.js', loader: 'assets/soffice.js', wasm: 'assets/soffice.wasm', data: 'assets/soffice.data', metadata: 'assets/soffice.data.js.metadata' };
const renderExports = ['dsh_lok_document_initialize_rendering', 'dsh_lok_document_type', 'dsh_lok_document_parts', 'dsh_lok_document_page_rectangles', 'dsh_lok_document_size', 'dsh_lok_document_tile_mode', 'dsh_lok_document_paint'];

/** Compile the public adapter and a self-contained classic Worker. */
export function buildBrowserSources() {
  buildKitSources();
  pnpm(['exec', 'tsc', '-b', 'packages/browser'], { cwd: root });
  pnpm(['exec', 'tsdown'], { cwd: directory });
  for (const file of ['lib/index.js', 'lib/worker.js', 'lib/types/index.d.ts']) regularFile(directory, file);
  return directory;
}

/** Check checksums, direct-render exports and required source/license payloads. */
export function verifyBrowserPackage(target = directory, expectedVersion = readJson(join(root, 'package.json')).version) {
  const manifest = readJson(join(target, 'package.json'));
  assert(manifest.name === '@deepseek-ai/libreoffice-kit-browser' && manifest.version === expectedVersion, 'Browser and engine family versions differ');
  assert(manifest.os === undefined && manifest.cpu === undefined && manifest.libc === undefined, 'Browser assets must be OS-independent');
  for (const path of ['lib/index.js', 'lib/worker.js', 'lib/types/index.d.ts']) regularFile(target, path);
  const assets = readJson(join(target, 'assets.json'));
  assert(assets.schemaVersion === 1 && assets.programDirectory === '/instdir/program', 'Unsupported browser asset manifest');
  assert(JSON.stringify(Object.keys(assets.files).sort()) === JSON.stringify(Object.keys(assetPaths).sort()), 'Browser assets must declare the five fixed resources');
  for (const [name, path] of Object.entries(assetPaths)) {
    const entry = assets.files[name];
    assert(entry.path === path, `Unexpected browser resource path: ${name}`);
    const file = regularFile(target, entry.path);
    assert(entry.bytes === statSync(file).size && entry.sha256 === sha256(file), `Browser resource checksum differs: ${name}`);
  }
  const module = new WebAssembly.Module(readFileSync(join(target, assetPaths.wasm)));
  const exports = new Set(WebAssembly.Module.exports(module).map(value => value.name));
  for (const name of renderExports) assert(exports.has(name) || exports.has(`_${name}`), `WASM has no direct-render export: ${name}`);
  for (const path of ['sources/engine/wasm-source/lok.cxx', 'sources/engine/wasm-source/build.mjs', 'sources/source-changes.patch', 'licenses/LICENSE', 'licenses/NOTICE', 'licenses/javascript/fflate-LICENSE', 'licenses/javascript/saxes-LICENSE', 'licenses/javascript/xmlchars-LICENSE']) regularFile(target, path);
  return assets;
}

/** Copy a verified Node WASM package's matching source and engine into the browser package. */
export function stageBrowserAssets(engineDirectory = join(root, 'packages/wasm')) {
  verifyEnginePackage(engineDirectory);
  buildBrowserSources();
  mkdirSync(join(directory, 'assets'), { recursive: true });
  for (const [key, source] of Object.entries({ loader: 'soffice.cjs', wasm: 'soffice.wasm', data: 'soffice.data', metadata: 'soffice.data.js.metadata' })) cpSync(join(engineDirectory, 'assets', source), join(directory, assetPaths[key]));
  for (const name of ['sources', 'licenses']) cpSync(join(engineDirectory, name), join(directory, name), { recursive: true });
  for (const path of ['packages/browser/src', 'packages/browser/package.json', 'packages/browser/tsconfig.json', 'packages/browser/tsdown.config.ts', 'packages/entry/src', 'packages/entry/package.json', 'packages/entry/tsconfig.json', 'packages/entry/tsdown.config.ts', 'tsconfig.base.json', 'scripts/build-browser.mjs']) {
    const target = join(directory, 'sources', path);
    mkdirSync(join(target, '..'), { recursive: true });
    cpSync(join(root, path), target, { recursive: true });
  }
  const entryRequire = createRequire(join(root, 'packages/entry/package.json'));
  const saxesRequire = createRequire(entryRequire.resolve('saxes'));
  mkdirSync(join(directory, 'licenses/javascript'), { recursive: true });
  for (const [name, resolver] of [['fflate', entryRequire], ['saxes', entryRequire], ['xmlchars', saxesRequire]]) {
    let folder = dirname(resolver.resolve(name));
    while (!existsSync(join(folder, 'package.json')) || readJson(join(folder, 'package.json')).name !== name) {
      const parent = dirname(folder); assert(parent !== folder, `Missing bundled dependency manifest: ${name}`); folder = parent;
    }
    const license = name === 'saxes' ? join(directory, 'third-party/saxes-6.0.0-LICENSE') : join(folder, 'LICENSE');
    if (name === 'saxes') assert(readJson(join(folder, 'package.json')).version === '6.0.0', 'Update the pinned saxes license with its version');
    cpSync(license, join(directory, 'licenses/javascript', `${name}-LICENSE`));
  }
  const files = Object.fromEntries(Object.entries(assetPaths).map(([name, path]) => [name, { path, sha256: sha256(join(directory, path)), bytes: statSync(join(directory, path)).size }]));
  writeFileSync(join(directory, 'assets.json'), `${JSON.stringify({ schemaVersion: 1, programDirectory: '/instdir/program', files }, null, 2)}\n`);
  verifyBrowserPackage();
  return directory;
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { stage: { type: 'boolean' }, verify: { type: 'boolean' }, 'engine-package': { type: 'string' } } });
  if (values.verify) verifyBrowserPackage();
  else if (values.stage) stageBrowserAssets(values['engine-package'] ? resolve(values['engine-package']) : undefined);
  else buildBrowserSources();
  console.log(`Browser package: ${directory}${existsSync(join(directory, 'assets.json')) ? ' (engine assets present)' : ' (sources built; stage a receipted engine to render)'}`);
}
