#!/usr/bin/env node
/** Build and verify the font entry in the existing main package. */
import { join } from 'node:path';
import { buildKitSources } from './build-kit.mjs';
import { verifyFontSubset } from './build-font-subset.mjs';
import { isMain, readJson, root } from './platform-matrix.mjs';
import { assert, regularFile } from './verify-artifacts.mjs';
const directory = join(root, 'packages/entry');
export function verifyFontMetadata(manifest) {
  assert(manifest.name === '@deepseek-ai/libreoffice-kit' && manifest.version === readJson(join(root, 'package.json')).version,
    'Fonts belong to the matching main package');
  assert(manifest.exports?.['./fonts']?.default === './lib/font-source.js', 'Missing main-package font entry');
  return manifest;
}
export function verifyFontPackage(target = directory) {
  const manifest = verifyFontMetadata(readJson(regularFile(target, 'package.json')));
  for (const file of ['lib/font-source.js', 'lib/font-worker.js', 'lib/types/font-source.d.ts']) regularFile(target, file);
  verifyFontSubset(target);
  return manifest;
}
export function stageFontPackage() { verifyFontPackage(); return directory; }
if (isMain(import.meta.url)) {
  if (!process.argv.includes('--verify')) buildKitSources();
  verifyFontPackage();
}
