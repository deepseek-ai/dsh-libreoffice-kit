/** Reuse verified Core bytes only when its pin, configure recipe, and patches match. */
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { source } from '../engine/native/configure.mjs';
import { corePatchFiles } from '../engine/native/core-patches.mjs';
import { buildHelper } from '../engine/native/build-helper.mjs';
import { glibcMinimum } from '../engine/native/glibc-minimum.mjs';
import { assert, sha256, verifyEnginePackage, verifyNativeImage } from './verify-artifacts.mjs';
import { hostTarget, isMain, readJson, root } from './platform-matrix.mjs';
import { run } from './pack-utils.mjs';
import { stageLinuxRuntime } from './stage-linux-runtime.mjs';

export function verifyCoreReuse(directory, core, repo = root) {
  const prebuild = readJson(join(directory, 'prebuilds.json'));
  assert(prebuild.source?.repository === source.repository && prebuild.source?.revision === source.revision, 'Reusable Core source pin differs from the current recipe');
  const patches = corePatchFiles(prebuild.platform, repo);
  const receipts = prebuild.source.files.filter(file => file.startsWith('sources/engine/native/patches/')).sort();
  assert(JSON.stringify(receipts) === JSON.stringify(patches.map(file => `sources/${file}`)), 'Reusable Core patch receipt set differs from the current recipe');
  for (const file of ['engine/native/configure.mjs', ...patches]) {
    const hash = sha256(join(directory, 'sources', file));
    assert(hash === prebuild.files[`sources/${file}`] && hash === sha256(join(repo, file)), `Reusable Core source receipt changed: ${file}`);
  }
  assert(sha256(join(directory, 'sources/core-changes.patch')) === prebuild.files['sources/core-changes.patch'], 'Reusable Core diff receipt hash changed');
  const changes = run('git', ['diff', '--binary', 'HEAD', '--'], { cwd: core });
  assert(changes === readFileSync(join(directory, 'sources/core-changes.patch'), 'utf8'), 'Reusable Core changes differ from the current applied patch set');
  return { prebuild, patches };
}

export function rebuildNativeHelper({ platform = hostTarget(), core = join(root, '.build/core'), repo = root } = {}) {
  assert(platform && platform === hostTarget(), 'Reusable Core requires its matching host');
  const directory = join(repo, 'packages', platform);
  verifyEnginePackage(directory);
  const priorManifestSha256 = sha256(join(directory, 'prebuilds.json'));
  const patches = corePatchFiles(platform, repo);
  assert(run('git', ['rev-parse', 'HEAD'], { cwd: core }).trim() === source.revision, 'Core headers do not match the pinned revision');
  for (const file of patches) {
    const patch = join(repo, file);
    if (spawnSync('git', ['apply', '--check', patch], { cwd: core, stdio: 'ignore' }).status === 0) run('git', ['apply', patch], { cwd: core });
    else assert(spawnSync('git', ['apply', '--reverse', '--check', patch], { cwd: core, stdio: 'ignore' }).status === 0, `Core headers differ from ${file}`);
  }
  const { prebuild } = verifyCoreReuse(directory, core, repo);
  const build = join(repo, '.build', `helper-${platform}`);
  mkdirSync(build, { recursive: true });
  const executable = join(build, platform.startsWith('win32-') ? 'libreoffice-kit.exe' : 'libreoffice-kit');
  const compilation = buildHelper({ platform, core, executable, cwd: build, repo });
  verifyNativeImage(executable, platform);
  copyFileSync(executable, join(directory, prebuild.engine.executable));
  if (!platform.startsWith('win32-')) chmodSync(join(directory, prebuild.engine.executable), 0o755);
  const updated = ['engine/native/worker.cxx', 'engine/native/build-helper.mjs', 'engine/native/core-environment.mjs', 'engine/native/core-patches.mjs', 'engine/native/glibc-minimum.mjs', 'scripts/build-native.mjs', 'scripts/rebuild-native-helper.mjs', 'scripts/stage-linux-runtime.mjs', 'scripts/pack-utils.mjs', ...patches];
  for (const file of updated) {
    const destination = `sources/${file}`;
    mkdirSync(join(directory, destination, '..'), { recursive: true });
    copyFileSync(join(repo, file), join(directory, destination));
    if (!prebuild.source.files.includes(destination)) prebuild.source.files.push(destination);
    prebuild.files[destination] = sha256(join(directory, destination));
  }
  const receipt = 'sources/helper-build.json';
  writeFileSync(join(directory, receipt), `${JSON.stringify({ priorManifestSha256, coreRevision: source.revision, coreRebuilt: false, compilation }, null, 2)}\n`);
  if (!prebuild.source.files.includes(receipt)) prebuild.source.files.push(receipt);
  prebuild.files[receipt] = sha256(join(directory, receipt));
  prebuild.files[prebuild.engine.executable] = sha256(join(directory, prebuild.engine.executable));
  stageLinuxRuntime(directory, prebuild);
  if (platform.endsWith('-glibc')) prebuild.engine.glibcMinimum = glibcMinimum(directory, Object.keys(prebuild.files));
  writeFileSync(join(directory, 'prebuilds.json'), `${JSON.stringify(prebuild, null, 2)}\n`);
  return verifyEnginePackage(directory);
}

if (isMain(import.meta.url)) console.log(JSON.stringify(rebuildNativeHelper({ platform: process.argv[2], core: process.argv[3] ? resolve(process.argv[3]) : undefined })));
