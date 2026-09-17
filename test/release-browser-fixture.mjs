/** Synthetic browser archives and receipts for publication validation, never engine qualification. */
import { writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, root, tarballName } from '../scripts/platform-matrix.mjs';
import { sha256 } from '../scripts/verify-artifacts.mjs';
import { npmFixture } from './archive-fixture.mjs';

export function browserFixture(directory) {
  const manifest = readJson(join(root, 'packages/browser/package.json'));
  const file = tarballName(manifest);
  writeFileSync(join(directory, file), npmFixture(manifest, { 'package/lib/index.js': 'export const fixture = true;' }));
  return { name: manifest.name, version: manifest.version, file, sha256: sha256(join(directory, file)), bytes: statSync(join(directory, file)).size };
}

export function browserReceiptFixture(browser, adapterSha256, sourceCommit) {
  return { sourceCommit, sourceDirty: false, archiveSha256: browser.sha256, adapterSha256, passed: true, isolated: true, fontSubsets: true, disposed: true,
    formats: Object.fromEntries(['doc', 'docx', 'ppt', 'pptx'].map(format => [format, { pages: 1, paintedPixels: 100 }])) };
}
