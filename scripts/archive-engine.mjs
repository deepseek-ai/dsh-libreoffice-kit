/** Preserve executable modes when moving staged engines through CI artifact storage. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { assert, verifyEnginePackage } from './verify-artifacts.mjs';
import { root, targets } from './platform-matrix.mjs';
import { run } from './pack-utils.mjs';

const platform = process.argv[2];
assert(platform === 'wasm' || Object.hasOwn(targets, platform), 'Unknown engine archive platform');
verifyEnginePackage(join(root, 'packages', platform));
mkdirSync(join(root, '.release'), { recursive: true });
run('tar', ['-czf', join(root, '.release', `core-payload-${platform}.tar.gz`), '-C', root, `packages/${platform}`], { timeout: 900_000 });
