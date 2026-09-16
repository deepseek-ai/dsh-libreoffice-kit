/** Exact engine recipes and independent download/toolchain caches for reproducible builds. */
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readCoreSource } from '../engine/core-source.mjs';
import { isMain, root, targets } from './platform-matrix.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const commonRecipes = [
  'engine/build-identity.mjs', 'engine/ui-resource-policy.mjs', 'engine/core-source.mjs', 'scripts/core-checkout.mjs',
  'scripts/pack-utils.mjs', 'scripts/platform-matrix.mjs', 'scripts/verify-artifacts.mjs',
  'scripts/prepare-artifacts.mjs', 'scripts/archive-engine.mjs', 'scripts/engine-archive.mjs',
  'scripts/ci-build-cache.mjs', 'NOTICE',
];
const nativeRecipes = [
  'scripts/checkout-core.mjs', 'scripts/build-native.mjs', 'scripts/rebuild-native-helper.mjs',
  'scripts/stage-native.mjs', 'scripts/slim-native.mjs', 'scripts/stage-linux-runtime.mjs',
];
const wasmRecipes = ['scripts/checkout-wasm.mjs'];

function filesBelow(repo, directory) {
  return readdirSync(join(repo, directory), { withFileTypes: true }).flatMap(entry => {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return filesBelow(repo, file);
    if (!entry.isFile()) throw new Error(`Build recipe must contain regular files: ${file}`);
    return [file];
  });
}

export function buildCacheKeys(platform, { repo = root } = {}) {
  if (platform !== 'wasm' && !Object.hasOwn(targets, platform)) throw new Error(`Unknown build platform: ${platform}`);
  const wasm = platform === 'wasm';
  const source = readCoreSource(repo); // Reads the staged gitlink, never the optional submodule worktree.
  const packageDirectory = `packages/${platform}`;
  // Only package metadata lives at this level. Never hash staged assets, sources or licenses.
  const packageFiles = readdirSync(join(repo, packageDirectory), { withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => `${packageDirectory}/${entry.name}`);
  const recipeDirectory = wasm ? 'engine/wasm-source' : 'engine/native';
  const ownedFiles = filesBelow(repo, recipeDirectory);
  const hashes = files => Object.fromEntries([...new Set(files)].sort().map(file => [file,
    createHash('sha256').update(readFileSync(join(repo, file))).digest('hex')]));
  const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
  const engine = digest({ source, platform, version,
    files: hashes([...commonRecipes, ...packageFiles, ...ownedFiles, ...(wasm ? wasmRecipes : nativeRecipes)]) });
  const download = digest({ source, platform, files: hashes([
    wasm ? 'engine/wasm-source/autogen.input' : 'engine/native/configure.mjs',
    ...ownedFiles.filter(file => file.endsWith('.patch')),
  ]) });
  const keys = { 'engine-key': `office-engine-v2-${platform}-${engine}`, 'download-key': `office-download-v1-${platform}-${download}` };
  if (wasm) {
    const { emsdk } = JSON.parse(readFileSync(join(repo, 'engine/wasm-source/source.json'), 'utf8'));
    keys['toolchain-key'] = `office-emsdk-v1-${digest({ emsdk, files: hashes(['scripts/checkout-wasm.mjs']) })}`;
  }
  return keys;
}

if (isMain(import.meta.url)) {
  const keys = buildCacheKeys(process.argv[2]);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    Object.entries(keys).map(([name, value]) => `${name}=${value}\n`).join(''));
  console.log(JSON.stringify(keys));
}
