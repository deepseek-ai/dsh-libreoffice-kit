/** Combine separately built graphics platforms only when their base WASM bytes match. */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isMain, readJson } from './platform-matrix.mjs';
import { assert, regularFile, verifyEnginePackage } from './verify-artifacts.mjs';

export function mergeWebGL(destination, sources) {
  assert(sources.length > 0 && !existsSync(destination), 'Graphics merge requires sources and a new destination');
  const graphicsFile = path => /^(assets|sources|licenses)\/graphics\//.test(path);
  const loaded = sources.map(dir => {
    verifyEnginePackage(dir);
    const prebuild = readJson(join(dir, 'prebuilds.json'));
    assert(prebuild.platform === 'wasm' && Object.keys(prebuild.graphics ?? {}).length > 0, 'Source has no built WASM graphics payload');
    return { dir, prebuild, manifest: readJson(join(dir, 'package.json')) };
  });
  const base = loaded[0];
  const common = prebuild => JSON.stringify(Object.entries(prebuild.files).filter(([path]) => !graphicsFile(path)).sort(([a], [b]) => a.localeCompare(b)));
  const commonBytes = common(base.prebuild);
  const result = structuredClone(base.prebuild);
  result.files = Object.fromEntries(Object.entries(result.files).filter(([path]) => !graphicsFile(path)));
  result.source.files = result.source.files.filter(path => !graphicsFile(path));
  result.licenses = result.licenses.filter(license => !graphicsFile(license.path));
  result.graphics = {};
  const copy = (dir, path) => { mkdirSync(dirname(join(destination, path)), { recursive: true }); copyFileSync(regularFile(dir, path), join(destination, path)); };
  for (const { manifest, prebuild } of loaded) assert(JSON.stringify(manifest) === JSON.stringify(base.manifest)
    && common(prebuild) === commonBytes, 'Graphics builds use different package metadata or base WASM bytes');
  for (const { prebuild } of loaded) for (const platform of Object.keys(prebuild.graphics)) {
    assert(!Object.hasOwn(result.graphics, platform), `Duplicate graphics platform: ${platform}`);
    result.graphics[platform] = prebuild.graphics[platform];
  }
  mkdirSync(destination, { recursive: true });
  copy(base.dir, 'package.json');
  for (const path of Object.keys(result.files)) copy(base.dir, path);
  for (const { dir, prebuild } of loaded) {
    for (const [path, hash] of Object.entries(prebuild.files).filter(([path]) => graphicsFile(path))) {
      copy(dir, path);
      result.files[path] = hash;
    }
    result.source.files.push(...prebuild.source.files.filter(graphicsFile));
    result.licenses.push(...prebuild.licenses.filter(license => graphicsFile(license.path)));
  }
  writeFileSync(join(destination, 'prebuilds.json'), `${JSON.stringify(result, null, 2)}\n`);
  return verifyEnginePackage(destination);
}

if (isMain(import.meta.url)) {
  assert(process.argv.length >= 4, 'Usage: node scripts/merge-webgl.mjs <new-output-package-directory> <wasm-package-directory>...');
  console.log(JSON.stringify(mergeWebGL(resolve(process.argv[2]), process.argv.slice(3).map(path => resolve(path)))));
}
