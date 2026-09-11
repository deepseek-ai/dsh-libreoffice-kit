/** Refuse an unbuilt or nonportable public ESM entry before pack. */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { builtinModules } from 'node:module';
import { assert, regularFile, verifyNoInstallHooks } from './verify-artifacts.mjs';
import { entryName, isMain, nodeRange, readJson, targets, wasmName } from './platform-matrix.mjs';

export function verifyEntryMetadata(manifest, packed = false) {
  verifyNoInstallHooks(manifest, !packed);
  assert(manifest.name === entryName && manifest.type === 'module' && manifest.engines?.node === nodeRange, 'Invalid ESM entry identity/Node baseline');
  assert(manifest.exports?.['.']?.types === './src/index.d.ts' && manifest.exports?.['.']?.import === './src/index.js'
    && manifest.exports?.['.']?.default === './src/index.js', 'Entry must export ESM .js and TypeScript declarations');
  const dependencyVersion = packed ? manifest.version : 'workspace:*';
  assert(manifest.dependencies?.[wasmName] === dependencyVersion, 'WASM fallback must be a required dependency at the workspace release version');
  const expected = Object.keys(targets).map((target) => `${entryName}-${target}`).sort();
  assert(JSON.stringify(Object.keys(manifest.optionalDependencies ?? {}).filter((name) => name !== 'webgpu').sort()) === JSON.stringify(expected), 'Optional dependency matrix is incomplete');
  assert(manifest.optionalDependencies.webgpu === '0.6.0', 'Optional Node GPU adapter must pin the verified version');
  for (const name of expected) assert(manifest.optionalDependencies[name] === dependencyVersion, 'Native dependency versions must equal the entry version');
  assert(manifest.optionalDependencies?.[wasmName] === undefined, 'WASM must not be optional');
}

export function verifyEntryPackage(dir, packed = false) {
  const manifest = readJson(regularFile(dir, 'package.json'));
  verifyEntryMetadata(manifest, packed);
  for (const file of ['src/index.js', 'src/index.d.ts', 'README.md', 'LICENSE', 'NOTICE']) {
    assert(readFileSync(regularFile(dir, file), 'utf8').trim().length > 0, `Entry is unbuilt: empty ${file}`);
  }
  const dependencies = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`), ...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})]);
  function visit(prefix) {
    for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
      const file = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) { visit(file); continue; }
      regularFile(dir, file);
      assert(/(?:\.m?js|\.d\.ts|\.json)$/.test(file), `Unexpected entry runtime payload: ${file}`);
      if (!/\.m?js$/.test(file)) continue;
      const source = readFileSync(join(dir, file), 'utf8');
      assert(!/\.cache\/libreoffice|native\/libreoffice|\.build\//.test(source), `Entry references a source checkout: ${file}`);
      for (const [, specifier] of source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g)) {
        if (specifier.startsWith('.')) {
          assert(/\.(?:m?js|json)$/.test(specifier), `Entry imports a non-JS runtime module: ${specifier}`);
          const relative = join(prefix, specifier).replaceAll('\\', '/');
          assert(relative.startsWith('src/'), `Entry import escapes src/: ${specifier}`);
          regularFile(dir, relative);
        } else {
          const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
          assert(dependencies.has(specifier) || dependencies.has(name), `Undeclared runtime import: ${specifier}`);
        }
      }
    }
  }
  visit('src');
  return manifest;
}

if (isMain(import.meta.url)) {
  console.log(`Verified ESM entry ${verifyEntryPackage(resolve(process.argv[2] ?? '.')).version}`);
}
