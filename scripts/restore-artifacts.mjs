/** Restore CI archives, preserving executable modes, before any consumer packs its workspace. */
import { join, resolve } from 'node:path';
import { artifactPlan, verifyPreparedEngine } from './prepare-artifacts.mjs';
import { root } from './platform-matrix.mjs';
import { regularFile } from './verify-artifacts.mjs';
import { run } from './pack-utils.mjs';

const [selection, input = join(root, '.release/prepared')] = process.argv.slice(2);
for (const platform of artifactPlan(selection)) {
  const archive = regularFile(resolve(input), `core-payload-${platform}.tar.gz`);
  run('tar', ['-xzf', archive, '-C', root], { timeout: 900_000 });
  console.log(JSON.stringify(verifyPreparedEngine(platform)));
}
