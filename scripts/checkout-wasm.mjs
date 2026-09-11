/** Fetch the pinned Core/emsdk sources and install the recorded WASM toolchain. */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, root } from './platform-matrix.mjs';
import { run } from './pack-utils.mjs';

const pinned = readJson(join(root, 'engine/wasm-source/source.json'));
for (const [name, spec] of [['core', pinned.libreoffice], ['emsdk', pinned.emsdk]]) {
  const directory = join(root, '.build/wasm', name);
  if (!existsSync(join(directory, '.git'))) {
    mkdirSync(directory, { recursive: true });
    run('git', ['init'], { cwd: directory });
    run('git', ['remote', 'add', 'origin', spec.repository], { cwd: directory });
    run('git', ['fetch', '--depth=1', 'origin', spec.commit], { cwd: directory, timeout: 900_000 });
    run('git', ['checkout', '--detach', 'FETCH_HEAD'], { cwd: directory });
  }
  if (run('git', ['rev-parse', 'HEAD'], { cwd: directory }).trim() !== spec.commit) throw new Error(`Existing ${name} checkout has a different revision`);
}
const sdk = join(root, '.build/wasm/emsdk');
run('python3', [join(sdk, 'emsdk.py'), 'install', pinned.emsdk.version], { cwd: sdk, timeout: 900_000 });
run('python3', [join(sdk, 'emsdk.py'), 'activate', pinned.emsdk.version], { cwd: sdk });
