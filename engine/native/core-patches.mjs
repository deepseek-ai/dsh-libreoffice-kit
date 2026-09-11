/** Native Core patches selected for each target's build and source receipts. */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { root, targets } from '../../scripts/platform-matrix.mjs';

/** Return ordered repository-relative patch paths; musl additions do not affect other targets. */
export function corePatchFiles(platform, repo = root) {
  if (!Object.hasOwn(targets, platform)) throw new Error(`Unknown Core patch platform: ${platform}`);
  return ['engine/native/patches', ...(platform.endsWith('-musl') ? ['engine/native/patches/musl'] : [])]
    .flatMap(directory => readdirSync(join(repo, directory)).filter(file => file.endsWith('.patch')).sort().map(file => `${directory}/${file}`));
}
