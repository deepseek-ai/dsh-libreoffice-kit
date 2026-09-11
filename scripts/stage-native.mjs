/** Preserve Core's installed relative layout and record every redistributed byte. */
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { source } from '../engine/native/configure.mjs';
import { isMain, readJson, root, targets } from './platform-matrix.mjs';
import { assert, sha256, verifyEnginePackage } from './verify-artifacts.mjs';

export function stageNative({ platform, core, build, repo = root }) {
  assert(targets[platform], `Unknown native platform: ${platform}`);
  const config = readFileSync(join(build, 'config_host.mk'), 'utf8');
  const setting = (name) => {
    const match = config.match(new RegExp(`^(?:export )?${name}=(.*)$`, 'm'));
    assert(match && match[1], `Core build is missing ${name}`);
    return match[1];
  };
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: core, encoding: 'utf8' });
  assert(revision.status === 0 && revision.stdout.trim() === source.revision, 'Core source does not match the pinned revision');
  const instdir = setting('INSTDIR');
  const libraryDirectory = join(setting('INSTROOT'), setting('LIBO_LIB_FOLDER'));
  const relativeLibrary = relative(instdir, libraryDirectory).replaceAll('\\', '/');
  assert(relativeLibrary && !relativeLibrary.startsWith('..'), 'Core library directory escapes instdir');
  const dir = join(repo, 'packages', platform);
  const manifest = readJson(join(dir, 'package.json'));
  const prebuild = readJson(join(dir, 'prebuilds.json'));
  for (const part of ['bin', 'program', 'sources', 'licenses']) rmSync(join(dir, part), { recursive: true, force: true });
  for (const part of ['bin', 'sources', 'licenses']) mkdirSync(join(dir, part), { recursive: true });
  cpSync(instdir, join(dir, 'program'), { recursive: true, dereference: true });
  copyFileSync(join(build, `libreoffice-kit${targets[platform].os === 'win32' ? '.exe' : ''}`), join(dir, prebuild.engine.executable));
  if (targets[platform].os !== 'win32') chmodSync(join(dir, prebuild.engine.executable), 0o755);
  const sourceFiles = ['engine/native/worker.cxx', 'engine/native/configure.mjs', 'engine/native/build-alpine.sh',
    'scripts/build-native.mjs', 'scripts/stage-native.mjs', 'scripts/platform-matrix.mjs', 'scripts/verify-artifacts.mjs',
    ...readdirSync(join(repo, 'engine/native/patches')).filter((name) => name.endsWith('.patch')).map((name) => `engine/native/patches/${name}`)];
  const packagedSource = [];
  for (const file of sourceFiles) {
    const destination = `sources/${file}`;
    mkdirSync(join(dir, destination, '..'), { recursive: true });
    copyFileSync(join(repo, file), join(dir, destination));
    packagedSource.push(destination);
  }
  const version = ['MAJOR', 'MINOR', 'MICRO', 'PATCH'].map((part) => setting(`LIBO_VERSION_${part}`)).join('.');
  const changes = spawnSync('git', ['diff', '--binary', 'HEAD', '--'], { cwd: core, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert(changes.status === 0, 'Cannot record corresponding Core source changes');
  writeFileSync(join(dir, 'sources/core-changes.patch'), changes.stdout);
  packagedSource.push('sources/core-changes.patch');
  writeFileSync(join(dir, 'sources/core.json'), `${JSON.stringify({ ...source, version, configure: readFileSync(join(build, 'autogen.input'), 'utf8').trim().split('\n') }, null, 2)}\n`);
  packagedSource.push('sources/core.json');
  copyFileSync(join(core, 'COPYING.MPL'), join(dir, 'licenses/LibreOffice-MPL-2.0.txt'));
  copyFileSync(join(repo, 'NOTICE'), join(dir, 'licenses/DeepSeek-Harness-MIT.txt'));
  const combinedLicense = join(build, 'workdir/CustomTarget/readlicense_oo/license/LICENSE.html');
  assert(existsSync(combinedLicense), 'Core build has not generated its dependency license notices');
  copyFileSync(combinedLicense, join(dir, 'licenses/LibreOffice-third-party.html'));
  function inventory(prefix) {
    return readdirSync(join(dir, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
      const file = `${prefix}/${entry.name}`;
      assert(entry.isDirectory() || entry.isFile(), `Unexpected staged special file: ${file}`);
      return entry.isDirectory() ? inventory(file) : [[file, sha256(join(dir, file))]];
    });
  }
  const result = {
    ...prebuild, version: manifest.version, status: 'built',
    engine: { ...prebuild.engine, programDirectory: `program/${relativeLibrary}` },
    source: { ...source, version, files: packagedSource },
    licenses: [
      { component: 'LibreOffice', spdx: 'MPL-2.0', path: 'licenses/LibreOffice-MPL-2.0.txt' },
      { component: 'DeepSeek Harness', spdx: 'MIT', path: 'licenses/DeepSeek-Harness-MIT.txt' },
      { component: 'LibreOffice bundled dependencies', spdx: 'LicenseRef-LibreOffice-Third-Party', path: 'licenses/LibreOffice-third-party.html' },
    ],
    files: Object.fromEntries(['bin', 'program', 'sources', 'licenses'].flatMap(inventory)),
  };
  writeFileSync(join(dir, 'prebuilds.json'), `${JSON.stringify(result, null, 2)}\n`);
  return verifyEnginePackage(dir);
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name) => { const index = args.indexOf(name); assert(index !== -1 && args[index + 1], `Required ${name}`); return args[index + 1]; };
  console.log(JSON.stringify(stageNative({ platform: value('--platform'), core: resolve(value('--source')), build: resolve(value('--build')) })));
}
