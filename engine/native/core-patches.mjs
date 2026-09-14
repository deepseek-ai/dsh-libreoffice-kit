/** Native Core patches included in every build and source receipt. */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../../scripts/platform-matrix.mjs';

/** Return ordered repository-relative native patch paths. */
export function corePatchFiles(repo = root) {
  const directory = 'engine/native/patches';
  return readdirSync(join(repo, directory)).filter(file => file.endsWith('.patch')).sort().map(file => `${directory}/${file}`);
}
