#!/usr/bin/env node
/** Build a pinned HarfBuzz subset module with a growing heap and stage its redistribution receipt. */
import { cpSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isMain, readJson, root } from './platform-matrix.mjs';
import { run } from './pack-utils.mjs';
import { assert, regularFile, sha256 } from './verify-artifacts.mjs';

const specPath = 'engine/font-subset/source.json';
const spec = readJson(join(root, specPath));
const wasmPath = 'assets/font-subset.wasm';
const receiptPath = 'assets/font-subset.json';
const recipePath = 'scripts/build-font-subset.mjs';
const recipeFiles = [specPath, recipePath, 'scripts/platform-matrix.mjs', 'scripts/pack-utils.mjs', 'scripts/verify-artifacts.mjs', 'engine/font-subset/README.md', 'engine/font-subset/README.zh.md'];
const required = [wasmPath, ...recipeFiles.map(path => `sources/font-subset/${path}`),
  'sources/font-subset/harfbuzzjs/config-override-subset.h', 'sources/font-subset/harfbuzzjs/harfbuzz-subset.symbols',
  'licenses/font-subset/harfbuzzjs-LICENSE', 'licenses/font-subset/harfbuzz-COPYING'];

/** Verify a staged subset module, recipe, exact source pins, and redistribution notices. */
export function verifyFontSubset(target = join(root, 'packages/entry')) {
  const receipt = readJson(regularFile(target, receiptPath));
  assert(receipt.schemaVersion === 1 && JSON.stringify(receipt.source) === JSON.stringify(spec), 'Font subset source receipt differs');
  assert(receipt.recipe === sha256(join(root, recipePath)), 'Font subset build recipe changed; rebuild the module');
  assert(JSON.stringify(Object.keys(receipt.files).sort()) === JSON.stringify(required.slice().sort()), 'Font subset receipt has an incomplete payload');
  for (const path of required) {
    const file = regularFile(target, path);
    assert(receipt.files[path].bytes === statSync(file).size && receipt.files[path].sha256 === sha256(file), `Font subset payload checksum differs: ${path}`);
  }
  const module = new WebAssembly.Module(readFileSync(join(target, wasmPath)));
  const names = new Set(WebAssembly.Module.exports(module).map(entry => entry.name));
  for (const name of ['memory', '_initialize', 'malloc', 'hb_subset_or_fail', 'hb_subset_input_set']) assert(names.has(name), `Missing font subset export: ${name}`);
  return receipt;
}

/** Compile explicit checked-out commits; this command never fetches or modifies upstream sources. */
export function buildFontSubset({ source = join(root, '.build/font-subset/harfbuzzjs'), emsdk = join(root, '.build/font-subset/emsdk'), target = join(root, 'packages/entry') } = {}) {
  for (const [path, expected] of [[source, spec.harfbuzzjs.commit], [join(source, 'harfbuzz'), spec.harfbuzz.commit], [emsdk, spec.emsdk.commit]]) {
    assert(run('git', ['rev-parse', 'HEAD'], { cwd: path }).trim() === expected, `Font subset checkout has the wrong commit: ${path}`);
    assert(run('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: path }).trim() === '', `Font subset checkout has tracked changes: ${path}`);
  }
  const invoke = (args) => run('bash', ['-c', 'set -e\nsource "$1" >/dev/null\nshift\nexec em++ "$@"', 'font-subset-build', join(emsdk, 'emsdk_env.sh'), ...args], { cwd: source });
  assert(invoke(['--version']).split('\n')[0].includes(` ${spec.emsdk.version} `), 'Font subset Emscripten version differs');
  mkdirSync(join(target, 'assets'), { recursive: true });
  invoke(['-std=c++11', '-fno-exceptions', '-fno-rtti', '-fno-threadsafe-statics', '-fvisibility-inlines-hidden', '-Oz', '-I.',
    '-DHB_TINY', '-DHB_USE_INTERNAL_QSORT', '-DHB_EXPERIMENTAL_API', '-DHB_CONFIG_OVERRIDE_H="config-override-subset.h"',
    '--no-entry', '-sEXPORTED_FUNCTIONS=@harfbuzz-subset.symbols', '-sINITIAL_MEMORY=68157440',
    '-sALLOW_MEMORY_GROWTH=1', '-sMAXIMUM_MEMORY=2147483648', '-sABORTING_MALLOC=0',
    '-o', join(target, wasmPath), 'harfbuzz/src/harfbuzz-subset.cc']);
  const copies = [...recipeFiles.map(path => [join(root, path), `sources/font-subset/${path}`]),
    [join(source, 'config-override-subset.h'), 'sources/font-subset/harfbuzzjs/config-override-subset.h'],
    [join(source, 'harfbuzz-subset.symbols'), 'sources/font-subset/harfbuzzjs/harfbuzz-subset.symbols'],
    [join(source, 'LICENSE'), 'licenses/font-subset/harfbuzzjs-LICENSE'], [join(source, 'harfbuzz/COPYING'), 'licenses/font-subset/harfbuzz-COPYING']];
  for (const [from, path] of copies) { mkdirSync(join(target, path, '..'), { recursive: true }); cpSync(from, join(target, path)); }
  const files = Object.fromEntries(required.map(path => [path, { bytes: statSync(join(target, path)).size, sha256: sha256(join(target, path)) }]));
  writeFileSync(join(target, receiptPath), `${JSON.stringify({ schemaVersion: 1, source: spec, recipe: sha256(join(root, recipePath)), files }, null, 2)}\n`);
  return verifyFontSubset(target);
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { verify: { type: 'boolean' }, source: { type: 'string' }, emsdk: { type: 'string' }, target: { type: 'string' } } });
  const options = Object.fromEntries(['source', 'emsdk', 'target'].filter(key => values[key]).map(key => [key, resolve(values[key])]));
  console.log(JSON.stringify(values.verify ? verifyFontSubset(options.target) : buildFontSubset(options)));
}
