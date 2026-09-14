/** Fetch exactly the recorded upstream Core revision into the disposable build directory. */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { source } from '../engine/native/configure.mjs';
import { root } from './platform-matrix.mjs';
import { run } from './pack-utils.mjs';

const directory = join(root, '.build/core');
if (existsSync(join(directory, '.git'))) {
  if (run('git', ['rev-parse', 'HEAD'], { cwd: directory }).trim() !== source.revision) throw new Error('Existing Core checkout has a different revision');
} else {
  mkdirSync(directory, { recursive: true });
  run('git', ['init'], { cwd: directory });
  run('git', ['remote', 'add', 'origin', source.repository], { cwd: directory });
  run('git', ['fetch', '--depth=1', 'origin', source.revision], { cwd: directory, timeout: 900_000 });
  run('git', ['checkout', '--detach', 'FETCH_HEAD'], { cwd: directory });
}
