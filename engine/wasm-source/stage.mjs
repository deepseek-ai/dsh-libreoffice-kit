#!/usr/bin/env node
/** Stage only a receipted Node WASM build, including its corresponding source and notices. */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { sha256, verifyEnginePackage } from '../../scripts/verify-artifacts.mjs';
import { readCoreSource } from '../core-source.mjs';
import { readWasmSource } from './source.mjs';

const owner = dirname(fileURLToPath(import.meta.url));
const root = resolve(owner, '../..');
const { values } = parseArgs({ options: {
  source: { type: 'string' }, emsdk: { type: 'string' }, build: { type: 'string' }, bundle: { type: 'string' },
} });
for (const name of ['source', 'emsdk', 'build', 'bundle']) {
  if (!values[name]) throw new Error(`Missing --${name} directory.`);
}
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)));
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, env: environment, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.signal ?? result.status}.`);
  return result.stdout;
};
const paths = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, resolve(value)]));
run(process.execPath, [join(owner, 'build.mjs'), '--stage', 'package', '--source', paths.source,
  '--emsdk', paths.emsdk, '--build', paths.build, '--output', paths.bundle]);
const published = join(root, 'packages/wasm');
const destination = mkdtempSync(join(dirname(published), '.wasm-stage-'));
try {
  for (const file of readdirSync(published, { withFileTypes: true })) {
    if (file.isFile() && file.name !== 'prebuilds.json') copyFileSync(join(published, file.name), join(destination, file.name));
  }
  for (const name of ['assets', 'sources', 'licenses']) mkdirSync(join(destination, name), { recursive: true });
  for (const name of readdirSync(paths.bundle)) copyFileSync(join(paths.bundle, name), join(destination, 'assets', name));
  for (const name of ['LICENSE', 'NOTICE']) copyFileSync(join(paths.build, 'instdir', name), join(destination, 'licenses', name));
  copyFileSync(join(root, 'NOTICE'), join(destination, 'licenses/DeepSeek-Harness-MIT.txt'));
  // Preserve repository-relative imports in the corresponding-source recipe.
  const sourceFiles = ['engine/core-source.mjs',
    ...['source.json', 'source.mjs', 'autogen.input', 'lok.cxx', 'build.mjs', 'stage.mjs',
      ...readdirSync(join(owner, 'patches')).map(name => `patches/${name}`)].map(name => `engine/wasm-source/${name}`),
    'scripts/checkout-wasm.mjs', 'scripts/core-checkout.mjs', 'scripts/pack-utils.mjs', 'scripts/platform-matrix.mjs', 'scripts/verify-artifacts.mjs'];
  for (const file of sourceFiles) {
    const target = join(destination, 'sources', file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, file), target);
  }
  writeFileSync(join(destination, 'sources/core-source.json'), `${JSON.stringify(readCoreSource(), null, 2)}\n`);
  const diff = run('git', ['diff', '--binary', 'HEAD', '--'], { cwd: paths.source, stdio: ['ignore', 'pipe', 'pipe'] });
  writeFileSync(join(destination, 'sources/source-changes.patch'), diff);
  copyFileSync(join(paths.build, 'autogen.input'), join(destination, 'sources/build-autogen.input'));
  const files = {};
  const visit = prefix => {
    for (const entry of readdirSync(join(destination, prefix), { withFileTypes: true })) {
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) files[name] = sha256(join(destination, name));
      else throw new Error(`Unexpected package file: ${name}`);
    }
  };
  for (const name of ['assets', 'sources', 'licenses']) visit(name);
  const pinned = readWasmSource().libreoffice;
  const prior = JSON.parse(readFileSync(join(published, 'prebuilds.json'), 'utf8'));
  const manifest = { ...prior, status: 'built', files,
    source: { repository: pinned.repository, revision: pinned.commit, version: pinned.version,
      files: Object.keys(files).filter(name => name.startsWith('sources/')) },
    licenses: [
      { component: 'LibreOffice', spdx: 'MPL-2.0', path: 'licenses/LICENSE' },
      { component: 'DeepSeek Harness portions', spdx: 'MIT', path: 'licenses/DeepSeek-Harness-MIT.txt' },
      { component: 'LibreOffice third-party notices', spdx: 'LicenseRef-LibreOffice-Notices', path: 'licenses/NOTICE' },
    ],
  };
  writeFileSync(join(destination, 'prebuilds.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  verifyEnginePackage(destination);
  const backup = `${destination}-previous`;
  renameSync(published, backup);
  try { renameSync(destination, published); }
  catch (error) {
    try { renameSync(backup, published); }
    catch (restoreError) { throw new AggregateError([error, restoreError], `Restore the previous package from ${backup}.`); }
    throw error;
  }
  rmSync(backup, { recursive: true });
  console.log(`Verified Node WASM package: ${published}`);
} finally { rmSync(destination, { recursive: true, force: true }); }
