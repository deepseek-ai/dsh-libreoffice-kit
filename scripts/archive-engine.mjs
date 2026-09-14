/** Preserve executable modes when moving staged engines through CI artifact storage. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { assert } from './verify-artifacts.mjs';
import { verifyPreparedEngine } from './prepare-artifacts.mjs';
import { root, targets } from './platform-matrix.mjs';
import { run } from './pack-utils.mjs';

const platform = process.argv[2];
assert(platform === 'wasm' || Object.hasOwn(targets, platform), 'Unknown engine archive platform');
verifyPreparedEngine(platform);
mkdirSync(join(root, '.release'), { recursive: true });
run('tar', [...(process.platform === 'darwin' ? ['--no-xattrs'] : []), '-czf', join(root, '.release', `core-payload-${platform}.tar.gz`), '-C', root, `packages/${platform}`], {
  timeout: 900_000,
  env: { ...process.env, COPYFILE_DISABLE: '1' },
});
