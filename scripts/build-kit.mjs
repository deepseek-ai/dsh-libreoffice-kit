/** Build the Node API from this checkout for engine release rehearsals. */
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isMain, kitDirectory, kitManifest, root, tarballName } from './platform-matrix.mjs';
import { npmEnvironment, pnpm } from './pack-utils.mjs';
import { auditNpmArchive } from './publication-privacy.mjs';
import { assert } from './verify-artifacts.mjs';
import { verifyFontSubset } from './build-font-subset.mjs';

/** Runtime entries every adapter build must produce; `files` publishes exactly these bundles. */
const BUILT_ENTRIES = ['lib/index.js', 'lib/worker.js', 'lib/font-source.js', 'lib/font-worker.js', 'lib/font-config.js', 'lib/document.js'];

/**
 * Compile the adapter's leaf TypeScript project and bundle its two ESM entries.
 * Engine rehearsals install this build, so they never depend on an npm
 * publication of the adapter.
 * @returns the adapter package directory and manifest the build produced.
 */
export function buildKitSources() {
  const directory = kitDirectory();
  pnpm(['exec', 'tsc', '-b', join(directory, 'tsconfig.json')], { cwd: root });
  pnpm(['exec', 'tsdown'], { cwd: directory });
  for (const entry of BUILT_ENTRIES) assert(existsSync(join(directory, entry)), `The adapter build produced no ${entry}`);
  return { directory, manifest: kitManifest() };
}

/**
 * Build the adapter and pack it beside the engine tarballs a rehearsal
 * installs. `pnpm pack` substitutes the `workspace:*` engine ranges with the
 * exact engine versions; installation supplies prepared local archives through the repository's pack hook.
 * @param destination - Release candidate directory to pack into.
 * @param work - Scratch directory holding the isolated npm configuration; omit for the caller's environment.
 * @returns the adapter manifest and the packed tarball.
 */
export function packKit(destination, work) {
  const { directory, manifest } = buildKitSources();
  verifyFontSubset(directory);
  const target = resolve(destination);
  mkdirSync(target, { recursive: true });
  pnpm(['--dir', directory, 'pack', '--pack-destination', target],
    { cwd: directory, ...(work === undefined ? {} : { env: { ...process.env, ...npmEnvironment(work) } }) });
  const file = join(target, tarballName(manifest));
  assert(existsSync(file), `The adapter pack produced no ${file}`);
  auditNpmArchive(file);
  return { manifest, file };
}

if (isMain(import.meta.url)) {
  const packIndex = process.argv.indexOf('--pack');
  if (packIndex === -1) console.log(JSON.stringify(buildKitSources()));
  else {
    const destination = process.argv[packIndex + 1];
    assert(destination !== undefined && !destination.startsWith('--'), '--pack requires a destination directory');
    console.log(JSON.stringify(packKit(destination)));
  }
}
