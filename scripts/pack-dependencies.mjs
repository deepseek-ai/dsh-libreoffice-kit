/** Local npm tarballs provide the adapter's exact installed dependency closure for offline smokes. */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { npm } from './pack-utils.mjs';
import { enginePrefix, tarballName } from './platform-matrix.mjs';
import { assert, sha256 } from './verify-artifacts.mjs';

export function packDependencies(adapterDirectory, destination, work) {
  const found = new Map();
  function visit(directory) {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    for (const name of new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})])) {
      if (name.startsWith(enginePrefix)) continue;
      const require = createRequire(join(directory, 'package.json'));
      let located;
      try { located = require.resolve(`${name}/package.json`); }
      catch (error) {
        if (error.code === 'MODULE_NOT_FOUND' && manifest.optionalDependencies?.[name] !== undefined) continue;
        if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
        located = require.resolve(name);
      }
      let current = dirname(located);
      let dependency;
      for (;;) {
        const file = join(current, 'package.json');
        if (existsSync(file)) {
          const candidate = JSON.parse(readFileSync(file, 'utf8'));
          if (candidate.name === name) { dependency = candidate; break; }
        }
        assert(dirname(current) !== current, `Cannot locate installed dependency ${name}`);
        current = dirname(current);
      }
      if (found.has(name)) {
        assert(found.get(name).version === dependency.version, `Offline smoke requires one installed version of ${name}`);
        continue;
      }
      const record = { name, version: dependency.version, directory: current };
      found.set(name, record);
      visit(current);
    }
  }
  visit(adapterDirectory);
  mkdirSync(destination, { recursive: true });
  return [...found.values()].map(({ name, version, directory }) => {
    npm(['pack', '--json', '--ignore-scripts', '--pack-destination', destination], directory, work);
    const file = tarballName({ name, version });
    return { name, version, file: `dependencies/${file}`, sha256: sha256(join(destination, file)) };
  });
}
