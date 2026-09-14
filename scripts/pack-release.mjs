/** Pack prevalidated engine payloads with npm, preserving native executable modes. */
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assert, sha256 } from './verify-artifacts.mjs';
import { verifyRelease } from './verify-release.mjs';
import { npm, scratch } from './pack-utils.mjs';
import { isMain, kitDirectory, readJson, releaseTargets, root, tarballName } from './platform-matrix.mjs';
import { packDependencies } from './pack-dependencies.mjs';

/** Resolve npm's repository identity from the workflow environment, or retain local source metadata. */
export function workflowRepositoryUrl(env = process.env) {
  const repository = env.GITHUB_REPOSITORY;
  if (repository === undefined && env.GITHUB_ACTIONS !== 'true') return undefined;
  assert(repository !== undefined && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository), 'GITHUB_REPOSITORY must identify the workflow owner/repository');
  const server = new URL(env.GITHUB_SERVER_URL ?? 'https://github.com');
  assert(server.protocol === 'https:' && server.pathname === '/' && !server.search && !server.hash
    && !server.username && !server.password, 'GITHUB_SERVER_URL must be an HTTPS origin');
  return `git+${server.origin}/${repository}.git`;
}

/** Copy declared payloads and project workflow metadata without modifying the source package. */
export function stagePackage(dir, destination, manifest, repositoryUrl) {
  mkdirSync(destination);
  for (const file of manifest.files) cpSync(join(dir, file), join(destination, file), { recursive: true });
  const packed = repositoryUrl === undefined ? manifest : { ...manifest, repository: { ...manifest.repository, url: repositoryUrl } };
  writeFileSync(join(destination, 'package.json'), `${JSON.stringify(packed, null, 2)}\n`);
}

/**
 * Pack every declared engine plus the adapter's installed dependency closure.
 * @param destination - Empty absolute directory receiving the tarballs.
 * @param platforms - Released platforms, native targets followed by `wasm`.
 * @param repo - Engine workspace root.
 * @returns the release manifest written to `release.json`.
 */
export function packRelease(destination, platforms, repo = root) {
  const repositoryUrl = workflowRepositoryUrl();
  const checked = verifyRelease({ repo, platforms });
  mkdirSync(destination, { recursive: true });
  assert(readdirSync(destination).length === 0, 'Pack destination must be empty; existing artifacts are never overwritten');
  const work = scratch('pack-release-');
  const packages = [];
  try {
    for (const platform of platforms) {
      const dir = join(repo, 'packages', platform);
      const manifest = readJson(join(dir, 'package.json'));
      let packDirectory = dir;
      if (repositoryUrl !== undefined) {
        packDirectory = join(work, platform);
        stagePackage(dir, packDirectory, manifest, repositoryUrl);
      }
      npm(['pack', '--json', '--ignore-scripts', '--pack-destination', destination], packDirectory, work);
      const file = tarballName(manifest);
      packages.push({ name: manifest.name, version: manifest.version, platform, file, sha256: sha256(join(destination, file)) });
    }
    const dependencies = packDependencies(kitDirectory(repo), join(destination, 'dependencies'), work);
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
