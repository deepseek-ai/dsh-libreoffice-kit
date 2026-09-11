/** Stage an already compiled N-API WebGL binding and relocatable ANGLE libraries. */
import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { hostTarget, isMain, readJson, root } from './platform-matrix.mjs';
import { assert, regularFile, sha256, verifyEnginePackage, verifyNativeImage } from './verify-artifacts.mjs';

function command(name, args) {
  const result = spawnSync(name, args, { encoding: 'utf8' });
  assert(!result.error && result.status === 0, `${name} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

export function stageWebGL({ source, destination = join(root, 'packages/wasm') }) {
  const platform = `${process.platform}-${process.arch}`;
  const nativeTarget = hostTarget();
  assert(nativeTarget && !nativeTarget.endsWith('-musl'), 'WebGL payload must be built on matching Darwin, Windows, or glibc Linux');
  verifyEnginePackage(destination);
  const packageInfo = readJson(regularFile(source, 'package.json'));
  assert(packageInfo.name === 'node-gles-webgl2' && packageInfo.version === '0.5.0', 'Expected pinned node-gles-webgl2@0.5.0');
  const patches = readdirSync(join(root, 'engine/webgl/patches')).filter(file => file.endsWith('.patch')).sort();
  for (const patch of patches) {
    const result = spawnSync('git', ['apply', '--reverse', '--check', '--unsafe-paths', `--directory=${source}`, join(root, 'engine/webgl/patches', patch)], { cwd: tmpdir(), encoding: 'utf8' });
    assert(!result.error && result.status === 0, `WebGL source is missing ${patch}: ${result.stderr}`);
  }
  const require = createRequire(join(source, 'package.json'));
  const angle = dirname(require.resolve(`@dsafdsaf132/node-gles-webgl2-${platform}/package.json`));
  const anglePackage = readJson(join(angle, 'package.json'));
  assert(anglePackage.version === packageInfo.version, 'ANGLE package version mismatch');
  const angleBuild = readJson(regularFile(source, 'deps/angle/angle-build.json'));
  assert(angleBuild.angleCommit === 'aa5f0107c9db735e9bcdc2f2c5abebfbfa939e17', 'ANGLE source revision mismatch');
  const assetRoot = `assets/graphics/${platform}`;
  const sourceRoot = `sources/graphics/${platform}`;
  const licenseRoot = `licenses/graphics/${platform}`;
  const prebuild = readJson(join(destination, 'prebuilds.json'));
  for (const prefix of [assetRoot, sourceRoot, licenseRoot]) {
    rmSync(join(destination, prefix), { recursive: true, force: true });
    mkdirSync(join(destination, prefix), { recursive: true });
    for (const file of Object.keys(prebuild.files)) if (file.startsWith(`${prefix}/`)) delete prebuild.files[file];
  }
  prebuild.source.files = prebuild.source.files.filter(file => !file.startsWith(`${sourceRoot}/`));
  prebuild.licenses = prebuild.licenses.filter(license => !license.path.startsWith(`${licenseRoot}/`));
  const copy = (from, to) => { mkdirSync(dirname(join(destination, to)), { recursive: true }); copyFileSync(from, join(destination, to)); };
  const binding = `${assetRoot}/nodejs_gl_binding.node`;
  copy(regularFile(source, 'build/Release/nodejs_gl_binding.node'), binding);
  const extension = process.platform === 'darwin' ? '.dylib' : process.platform === 'win32' ? '.dll' : '.so';
  const libraryNames = ['libEGL', 'libGLESv2'].map(name => `${name}${extension}`);
  if (process.platform === 'win32' && readdirSync(angle).includes('d3dcompiler_47.dll')) libraryNames.push('d3dcompiler_47.dll');
  const libraries = libraryNames.map(name => `${assetRoot}/${name}`);
  for (const name of libraryNames) copy(regularFile(angle, name), `${assetRoot}/${name}`);
  for (const file of [binding, ...libraries]) {
    const path = join(destination, file);
    if (process.platform !== 'win32') chmodSync(path, 0o755);
    if (process.platform === 'darwin') {
      const rpaths = [...command('otool', ['-l', path]).matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+) \(offset \d+\)/g)].map(match => match[1]);
      for (const rpath of rpaths) command('install_name_tool', ['-delete_rpath', rpath, path]);
      command('install_name_tool', ['-add_rpath', '@loader_path', path]);
      const dependencies = command('otool', ['-L', path]).split('\n').slice(1).filter(Boolean).map(line => line.trim().split(' (')[0]);
      for (const dependency of dependencies) assert(dependency.startsWith('/System/Library/') || dependency.startsWith('/usr/lib/')
        || (dependency.startsWith('@rpath/') && libraryNames.includes(basename(dependency))), `Nonportable WebGL dependency: ${dependency}`);
      command('codesign', ['--force', '--sign', '-', path]);
    } else if (process.platform === 'linux') command('patchelf', ['--set-rpath', '$ORIGIN', path]);
    verifyNativeImage(path, nativeTarget, true);
  }
  // Load from the relocated directory before recording a usable binary payload.
  command(process.execPath, ['-e', 'const m=require(process.argv[1]); if(typeof m.createWebGLRenderingContext!=="function") process.exit(1)', join(destination, binding)]);
  function copySources(directory, prefix) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = `${prefix}/${entry.name}`;
      assert(entry.isFile() || entry.isDirectory(), `Unexpected WebGL source special file: ${relative}`);
      if (entry.isDirectory()) copySources(join(directory, entry.name), relative);
      else copy(join(directory, entry.name), `${sourceRoot}/${relative}`);
    }
  }
  for (const directory of ['binding', 'deps/angle/include']) copySources(join(source, directory), directory);
  for (const file of ['package.json', 'binding.gyp', 'scripts/resolve-angle-path.js', 'deps/angle/angle-build.json']) copy(regularFile(source, file), `${sourceRoot}/${file}`);
  for (const patch of patches) copy(join(root, 'engine/webgl/patches', patch), `${sourceRoot}/patches/${patch}`);
  copy(join(root, 'scripts/stage-webgl.mjs'), `${sourceRoot}/stage-webgl.mjs`);
  copy(join(root, 'scripts/build-webgl.mjs'), `${sourceRoot}/build-webgl.mjs`);
  const receipt = { package: packageInfo.name, version: packageInfo.version, repository: packageInfo.repository.url,
    angle: { repository: 'https://github.com/google/angle', revision: angleBuild.angleCommit, release: angleBuild.release, package: anglePackage.name, version: anglePackage.version },
    platform, nodeVersion: process.version, nodeApiVersion: process.versions.napi,
    build: 'node-gyp rebuild against the pinned package sources; stage-webgl.mjs relocates libraries and verifies addon loading',
    inputFiles: Object.fromEntries([['binding', join(source, 'build/Release/nodejs_gl_binding.node')], ...libraryNames.map(name => [name, join(angle, name)])].map(([name, file]) => [name, sha256(file)])) };
  writeFileSync(join(destination, sourceRoot, 'build.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  for (const [component, spdx, path] of [['node-gles-webgl2', 'Apache-2.0', join(source, 'LICENSE')], ['ANGLE', 'BSD-3-Clause', join(angle, 'LICENSE')]]) {
    const license = `${licenseRoot}/${component}.txt`;
    copy(path, license);
    prebuild.licenses.push({ component, spdx, path: license });
  }
  function inventory(prefix) {
    return readdirSync(join(destination, prefix), { withFileTypes: true }).flatMap(entry => entry.isDirectory()
      ? inventory(`${prefix}/${entry.name}`) : [`${prefix}/${entry.name}`]);
  }
  const sourceFiles = inventory(sourceRoot);
  for (const file of [...inventory(assetRoot), ...sourceFiles, ...inventory(licenseRoot)]) prebuild.files[file] = sha256(join(destination, file));
  prebuild.source.files.push(...sourceFiles);
  prebuild.graphics ??= {};
  prebuild.graphics[platform] = { status: 'built', binding, libraries, sourceFiles, receipt: `${sourceRoot}/build.json` };
  writeFileSync(join(destination, 'prebuilds.json'), `${JSON.stringify(prebuild, null, 2)}\n`);
  return verifyEnginePackage(destination);
}

if (isMain(import.meta.url)) {
  assert(process.argv[2], 'Usage: node scripts/stage-webgl.mjs <built-node-gles-webgl2-directory> [wasm-package-directory]');
  console.log(JSON.stringify(stageWebGL({ source: resolve(process.argv[2]), ...(process.argv[3] ? { destination: resolve(process.argv[3]) } : {}) })));
}
