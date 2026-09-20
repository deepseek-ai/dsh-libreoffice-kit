#!/usr/bin/env node
/** Build browser entries into the existing main package; the engine stays in the WASM dependency. */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { buildKitSources } from './build-kit.mjs';
import { root, isMain, readJson } from './platform-matrix.mjs';
import { pnpm } from './pack-utils.mjs';
import { assert, regularFile, sha256, verifyEnginePackage } from './verify-artifacts.mjs';

const source = join(root, 'packages/browser');
const directory = join(root, 'packages/entry');
const helpers = ['rendering', 'engine-rendering', 'sheet-geometry'];

/** Compile browser-only JavaScript without copying any engine bytes into the main package. */
export function buildBrowserSources(buildEntry = true) {
  if (buildEntry) buildKitSources();
  // TypeScript does not remove declarations for deleted source files.
  rmSync(join(source, 'lib/types'), { recursive: true, force: true });
  rmSync(join(source, 'lib/tsconfig.tsbuildinfo'), { force: true });
  pnpm(['exec', 'tsc', '-b', 'packages/browser'], { cwd: root });
  pnpm(['exec', 'tsdown'], { cwd: source });
  const target = join(directory, 'lib/browser');
  rmSync(target, { recursive: true, force: true });
  mkdirSync(join(target, 'types'), { recursive: true });
  for (const name of ['index.js', 'worker.js']) cpSync(regularFile(source, `lib/${name}`), join(target, name));
  for (const name of readdirSync(join(source, 'lib/types')).filter(name => name.endsWith('.d.ts')))
    cpSync(join(source, 'lib/types', name), join(target, 'types', name));
  rmSync(join(directory, 'sources/browser'), { recursive: true, force: true });
  for (const path of ['packages/browser/src', 'packages/browser/package.json', 'packages/browser/tsconfig.json', 'packages/browser/tsdown.config.ts', 'scripts/build-browser.mjs']) {
    const dest = join(directory, 'sources/browser', path);
    mkdirSync(dirname(dest), { recursive: true }); cpSync(join(root, path), dest, { recursive: true });
  }
  const entryRequire = createRequire(join(directory, 'package.json'));
  const saxesRequire = createRequire(entryRequire.resolve('saxes'));
  mkdirSync(join(directory, 'licenses/javascript'), { recursive: true });
  for (const [name, resolver] of [['fflate', entryRequire], ['saxes', entryRequire], ['xmlchars', saxesRequire]]) {
    let folder = dirname(resolver.resolve(name));
    while (!existsSync(join(folder, 'package.json')) || readJson(join(folder, 'package.json')).name !== name) {
      const parent = dirname(folder); assert(parent !== folder, `Missing bundled dependency: ${name}`); folder = parent;
    }
    const license = name === 'saxes' ? join(source, 'third-party/saxes-6.0.0-LICENSE') : join(folder, 'LICENSE');
    cpSync(license, join(directory, 'licenses/javascript', `${name}-LICENSE`));
  }
  const path = 'lib/browser/worker.js';
  writeFileSync(join(target, 'assets.json'), `${JSON.stringify({ schemaVersion: 1, files: { worker: { path, bytes: statSync(join(directory, path)).size, sha256: sha256(join(directory, path)) } } }, null, 2)}\n`);
  return directory;
}

/** Require main-package browser entries and the direct-drawing ABI in the separately staged engine. */
export function verifyBrowserPackage(target = directory, engineDirectory = join(root, 'packages/wasm')) {
  const manifest = readJson(regularFile(target, 'package.json'));
  assert(manifest.name === '@deepseek-ai/libreoffice-kit' && manifest.version === readJson(join(root, 'package.json')).version,
    'Browser entry must be in the matching main package');
  for (const file of ['lib/browser/index.js', 'lib/browser/worker.js', 'lib/browser/types/index.d.ts', 'lib/browser-assets.js']) regularFile(target, file);
  for (const helper of helpers) regularFile(target, `lib/${helper}.js`);
  const declarations = join(target, 'lib/browser/types');
  const declarationText = readdirSync(declarations).filter(name => name.endsWith('.d.ts')).map(name => readFileSync(join(declarations, name), 'utf8')).join('\n');
  assert(declarationText.includes('openOfficeDocument') && declarationText.includes('prepareOfficeBrowser') && !declarationText.includes('openEditor')
    && !readdirSync(declarations).some(name => name.startsWith('editor')), 'Browser package retains a removed editing SDK');
  const receipt = readJson(regularFile(target, 'lib/browser/assets.json'));
  const worker = receipt.files?.worker;
  assert(receipt.schemaVersion === 1 && worker?.path === 'lib/browser/worker.js'
    && worker.bytes === statSync(join(target, worker.path)).size && worker.sha256 === sha256(join(target, worker.path)), 'Browser Worker receipt differs');
  verifyEnginePackage(engineDirectory);
  const engine = readJson(join(engineDirectory, 'prebuilds.json')).engine;
  const module = new WebAssembly.Module(readFileSync(join(engineDirectory, engine.wasm)));
  const exports = new Set(WebAssembly.Module.exports(module).map(entry => entry.name));
  for (const name of ['dsh_lok_document_paint', 'dsh_lok_document_configure_view', 'dsh_lok_document_composition', 'dsh_lok_document_create_view', 'dsh_lok_document_part_info', 'dsh_pdf_open', 'dsh_pdf_paint'])
    assert(exports.has(name) || exports.has(`_${name}`), `WASM has no browser export: ${name}`);
  return receipt;
}

/** Compatibility build command; payload remains exclusively in the existing WASM package. */
export function stageBrowserAssets(engineDirectory = join(root, 'packages/wasm')) {
  buildBrowserSources(); verifyBrowserPackage(directory, engineDirectory); return directory;
}
if (isMain(import.meta.url)) {
  if (process.argv.includes('--verify')) verifyBrowserPackage();
  else if (process.argv.includes('--stage')) stageBrowserAssets();
  else buildBrowserSources();
}
