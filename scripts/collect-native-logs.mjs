/** Preserve readable compiler logs without following external-project symlinks. */
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { isMain, root, targets } from './platform-matrix.mjs';

export function collectNativeLogs(platform, repo = root) {
  if (!Object.hasOwn(targets, platform)) throw new Error(`Unsupported native log target: ${platform}`);
  const build = join(repo, '.build', `native-${platform}`);
  const output = join(repo, '.build', `ci-logs-${platform}`);
  const warnings = [];
  const files = [];
  function attempt(path, operation) {
    try { return operation(); }
    catch (error) {
      if (!['EACCES', 'EPERM', 'ENOENT', 'ELOOP'].includes(error.code)) throw error;
      warnings.push({ path: relative(build, path), code: error.code });
      return undefined;
    }
  }
  function visit(directory, recursive) {
    const names = attempt(directory, () => readdirSync(directory)) ?? [];
    for (const name of names.sort()) {
      const path = join(directory, name);
      const entry = attempt(path, () => lstatSync(path));
      if (!entry || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (recursive) visit(path, true);
      } else if (entry.isFile() && (recursive ? name === 'config.log' : name.endsWith('.log'))) {
        const bytes = attempt(path, () => readFileSync(path));
        if (bytes === undefined) continue;
        const file = relative(build, path);
        const destination = join(output, file);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, bytes);
        files.push(file);
      }
    }
  }
  mkdirSync(output, { recursive: true });
  visit(build, false);
  for (const directory of ['workdir', 'workdir_for_build']) visit(join(build, directory, 'UnpackedTarball'), true);
  const receipt = { platform, files, warnings };
  writeFileSync(join(output, 'collection.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

if (isMain(import.meta.url)) console.log(JSON.stringify(collectNativeLogs(process.argv[2]), null, 2));
