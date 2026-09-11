/** Pack prevalidated payloads with npm, preserving native executable modes. */
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assert, sha256 } from './verify-artifacts.mjs';
import { verifyRelease } from './verify-release.mjs';
import { npm, scratch } from './pack-utils.mjs';
import { isMain, readJson, releaseTargets, root, tarballName } from './platform-matrix.mjs';
import { packDependencies } from './pack-dependencies.mjs';

export function packRelease(destination, platforms, repo = root) {
  const checked = verifyRelease({ repo, platforms });
  mkdirSync(destination, { recursive: true });
  assert(readdirSync(destination).length === 0, 'Pack destination must be empty; existing artifacts are never overwritten');
  const work = scratch('pack-release-');
  const packages = [];
  try {
    for (const platform of [...platforms, 'entry']) {
      const dir = join(repo, 'packages', platform);
      const manifest = readJson(join(dir, 'package.json'));
      let packDirectory = dir;
      if (platform === 'entry') {
        packDirectory = join(work, 'entry');
        mkdirSync(packDirectory);
        for (const file of ['src', 'README.md', 'LICENSE', 'NOTICE']) cpSync(join(dir, file), join(packDirectory, file), { recursive: true });
        for (const field of ['dependencies', 'optionalDependencies']) {
          for (const [name, version] of Object.entries(manifest[field] ?? {})) if (version === 'workspace:*') manifest[field][name] = manifest.version;
        }
        writeFileSync(join(packDirectory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      }
      npm(['pack', '--json', '--ignore-scripts', '--pack-destination', destination], packDirectory, work);
      const file = tarballName(manifest);
      packages.push({ name: manifest.name, version: manifest.version, platform, file, sha256: sha256(join(destination, file)) });
    }
    const dependencies = packDependencies(join(repo, 'packages/entry'), join(destination, 'dependencies'), work);
    const result = { schemaVersion: 1, version: checked.version, platforms, packages, dependencies };
    writeFileSync(join(destination, 'release.json'), `${JSON.stringify(result, null, 2)}\n`);
    writeFileSync(join(destination, 'publish-order.txt'), `${packages.map((entry) => entry.file).join('\n')}\n`);
    return result;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const destination = args[0] && !args[0].startsWith('--') ? resolve(args.shift()) : join(root, '.release/npm');
  console.log(JSON.stringify(packRelease(destination, releaseTargets(args)), null, 2));
}
