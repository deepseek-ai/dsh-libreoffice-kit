/** Add verified platform graphics overlays to one shared WASM package. */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isMain, readJson } from './platform-matrix.mjs';
import { assert, regularFile, verifyEnginePackage, verifyGraphicsOverlay } from './verify-artifacts.mjs';

export function mergeWebGL(destination, baseDirectory, overlays) {
  assert(overlays.length > 0 && !existsSync(destination), 'Graphics merge requires overlays and a new destination');
  verifyEnginePackage(baseDirectory);
  const result = readJson(join(baseDirectory, 'prebuilds.json'));
  assert(result.platform === 'wasm' && Object.keys(result.graphics ?? {}).length === 0
    && !Object.keys(result.files).some(path => /^(assets|sources|licenses)\/graphics\//.test(path)), 'Base must be a WASM package without graphics');
  result.graphics = {};
  const loaded = overlays.map(dir => {
    const { platform } = verifyGraphicsOverlay(dir);
    const prebuild = readJson(join(dir, 'prebuilds.json'));
    assert(prebuild.version === result.version, 'Graphics overlay and WASM package versions differ');
    assert(!Object.hasOwn(result.graphics, platform), `Duplicate graphics platform: ${platform}`);
    result.graphics[platform] = prebuild.graphics[platform];
    return { dir, prebuild };
  });
  const copy = (dir, path) => { mkdirSync(dirname(join(destination, path)), { recursive: true }); copyFileSync(regularFile(dir, path), join(destination, path)); };
  mkdirSync(destination, { recursive: true });
  copy(baseDirectory, 'package.json');
  for (const path of Object.keys(result.files)) copy(baseDirectory, path);
  for (const { dir, prebuild } of loaded) {
    for (const [path, hash] of Object.entries(prebuild.files)) {
      copy(dir, path);
      result.files[path] = hash;
    }
    result.source.files.push(...prebuild.source.files);
    result.licenses.push(...prebuild.licenses);
  }
  writeFileSync(join(destination, 'prebuilds.json'), `${JSON.stringify(result, null, 2)}\n`);
  return verifyEnginePackage(destination);
}

if (isMain(import.meta.url)) {
  assert(process.argv.length >= 5, 'Usage: node scripts/merge-webgl.mjs <new-output-package-directory> <base-wasm-package-directory> <graphics-overlay-directory>...');
  console.log(JSON.stringify(mergeWebGL(resolve(process.argv[2]), resolve(process.argv[3]), process.argv.slice(4).map(path => resolve(path)))));
}
