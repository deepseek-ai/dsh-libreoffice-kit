/** Compile only the private worker against the pinned Core headers. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildPathFlags, publicBuildValue } from '../build-identity.mjs';
import { root } from '../../scripts/platform-matrix.mjs';
import { verifyNativeImage } from '../../scripts/verify-artifacts.mjs';
import { verifyBuildPlatform } from './build-platform.mjs';

export function buildHelper({ platform, core, executable, cwd, env = process.env, repo = root, crossCompile = false }) {
  verifyBuildPlatform(platform, { crossCompile, env });
  const windows = platform.startsWith('win32-');
  const command = windows ? 'cl.exe' : 'c++';
  const args = windows
    ? ['/nologo', '/std:c++17', '/EHsc', '/MD', '/DNOMINMAX', `/I${join(core, 'include')}`, join(repo, 'engine/native/worker.cxx'), `/Fe:${executable}`, 'gdi32.lib']
    : ['-std=c++17', '-O2', `-I${join(core, 'include')}`, join(repo, 'engine/native/worker.cxx'), '-o', executable,
      ...(platform.startsWith('darwin-') ? ['-mmacosx-version-min=11.0', '-framework', 'CoreFoundation', '-framework', 'CoreText'] : ['-ldl'])];
  const paths = { workspace: repo, source: core, build: cwd };
  args.unshift(...buildPathFlags(platform, paths));
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Native helper compiler exited ${result.status}, signal ${result.signal}`);
  verifyNativeImage(executable, platform);
  return { ...publicBuildValue({ command, args }, paths),
    commandSha256: createHash('sha256').update(JSON.stringify({ command, args })).digest('hex') };
}
