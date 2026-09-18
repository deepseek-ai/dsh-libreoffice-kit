#!/usr/bin/env node
/** Pack the two existing packages from staged WASM resources. */
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyBrowserPackage } from './build-browser.mjs';
import { verifyFontSubset } from './build-font-subset.mjs';
import { verifyEnginePackage } from './verify-artifacts.mjs';
import { packDependencies } from './pack-dependencies.mjs';
import { stagePackage, workflowRepositoryUrl } from './pack-release.mjs';
import { npm, run, scratch } from './pack-utils.mjs';
import { isMain, readJson, root, tarballName } from './platform-matrix.mjs';
import { assert, sha256 } from './verify-artifacts.mjs';

/** The two archives are the main API and its exact, portable WASM dependency. */
export function packBrowserPreview(destination) {
  verifyBrowserPackage();
  verifyFontSubset();
  verifyEnginePackage(join(root, 'packages/wasm'));
  mkdirSync(destination, { recursive: true });
  assert(readdirSync(destination).length === 0, 'Preview pack destination must be empty');
  const work = scratch('browser-preview-pack-');
  try {
    const packages = {};
    for (const kind of ['wasm', 'kit']) {
      const directory = join(root, 'packages', kind === 'kit' ? 'entry' : kind);
      const manifest = readJson(join(directory, 'package.json'));
      if (kind === 'kit') manifest.dependencies['@deepseek-ai/libreoffice-kit-wasm'] = manifest.version;
      const staged = join(work, kind);
      stagePackage(directory, staged, manifest, workflowRepositoryUrl());
      npm(['pack', '--json', '--ignore-scripts', '--pack-destination', destination], staged, work);
      const file = tarballName(manifest);
      packages[kind] = { name: manifest.name, version: manifest.version, file, bytes: statSync(join(destination, file)).size, sha256: sha256(join(destination, file)) };
    }
    const dependencies = packDependencies(join(root, 'packages/entry'), join(destination, 'dependencies'), work);
    const result = { schemaVersion: 1, kind: 'browser-preview',
      sourceCommit: run('git', ['rev-parse', 'HEAD'], { cwd: root }).trim(),
      sourceDirty: run('git', ['status', '--porcelain', '--', '.', ':(exclude)packages/*/prebuilds.json'], { cwd: root }).trim().length > 0,
      packages, dependencies };
    writeFileSync(join(destination, 'browser-preview.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (isMain(import.meta.url)) console.log(JSON.stringify(packBrowserPreview(resolve(process.argv[2] ?? join(root, '.release/browser-preview'))), null, 2));
