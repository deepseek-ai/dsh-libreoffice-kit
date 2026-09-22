/** Keep patchable build trees separate from the pristine upstream submodule. */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { coreSubmodule, readCoreSource } from '../engine/core-source.mjs';
import { root } from './platform-matrix.mjs';
import { run } from './pack-utils.mjs';

export function checkoutCore(directory, repo = root) {
  const source = readCoreSource(repo);
  const verify = cwd => {
    if (run('git', ['rev-parse', 'HEAD'], { cwd }).trim() !== source.revision)
      throw new Error(`Existing Core checkout has a different revision: ${cwd}`);
  };
  if (existsSync(join(directory, '.git'))) {
    verify(directory);
    return;
  }
  mkdirSync(dirname(directory), { recursive: true });
  if (existsSync(join(repo, '.git'))) {
    const upstream = join(repo, coreSubmodule);
    if (!existsSync(join(upstream, '.git')))
      run('git', ['submodule', 'update', '--init', '--checkout', '--depth=1', '--', coreSubmodule], { cwd: repo, timeout: 900_000 });
    verify(upstream);
    if (run('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: upstream }).trim())
      throw new Error('Core submodule must be clean; apply patches only in disposable build checkouts');
    run('git', ['clone', '--no-checkout', '--', upstream, directory], { timeout: 900_000 });
    run('git', ['remote', 'set-url', 'origin', source.repository], { cwd: directory });
  } else {
    // Corresponding-source receipts can also prepare a build without a superproject.
    mkdirSync(directory, { recursive: true });
    run('git', ['init'], { cwd: directory });
    run('git', ['remote', 'add', 'origin', source.repository], { cwd: directory });
    run('git', ['fetch', '--depth=1', 'origin', source.revision], { cwd: directory, timeout: 900_000 });
  }
  run('git', ['checkout', '--detach', source.revision], { cwd: directory });
  verify(directory);
}
