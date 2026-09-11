/** Build optional WebGL assets explicitly; this script is never an install hook. */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { hostTarget, root } from './platform-matrix.mjs';
import { assert } from './verify-artifacts.mjs';
import { npmCli } from './pack-utils.mjs';
import { stageWebGL } from './stage-webgl.mjs';

const platform = hostTarget();
assert(platform && !platform.endsWith('-musl'), 'The pinned ANGLE package has no musl build');
const work = join(root, '.build/webgl');
mkdirSync(work, { recursive: true });
writeFileSync(join(work, 'package.json'), `${JSON.stringify({ private: true, dependencies: { 'node-gles-webgl2': '0.5.0', 'node-gyp': '11.5.0' } }, null, 2)}\n`);
function run(command, args, cwd = work) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  assert(!result.error && result.status === 0, `${command} failed (${result.status}, ${result.signal}): ${result.error?.message ?? ''}`);
}
run(process.execPath, [npmCli(), 'install', '--ignore-scripts', '--no-audit', '--no-fund']);
const source = join(work, 'node_modules/node-gles-webgl2');
for (const name of readdirSync(join(root, 'engine/webgl/patches')).filter(file => file.endsWith('.patch')).sort()) {
  const patch = join(root, 'engine/webgl/patches', name);
  const args = ['apply', '--unsafe-paths', `--directory=${source}`];
  const check = reverse => spawnSync('git', [...args, '--check', ...(reverse ? ['--reverse'] : []), patch], { cwd: tmpdir(), encoding: 'utf8' });
  const forward = check(false);
  if (forward.status === 0) run('git', [...args, patch], tmpdir());
  else {
    const reverse = check(true);
    const details = [forward, reverse].map(result => (result.error?.message ?? result.stderr ?? '').trim().slice(0, 4096)).join('\n');
    assert(reverse.status === 0, `WebGL source differs from ${name}:\n${details}`);
  }
}
run(process.execPath, [join(work, 'node_modules/node-gyp/bin/node-gyp.js'), 'rebuild'], source);
console.log(JSON.stringify(stageWebGL({ source })));
