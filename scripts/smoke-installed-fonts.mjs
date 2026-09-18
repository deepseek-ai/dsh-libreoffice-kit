/** Exercise the installed portable font package without a LibreOffice API or engine. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { create } from 'fontkit';
import { createFontSource } from '@deepseek-ai/libreoffice-kit/fonts';

const require = createRequire(import.meta.url);
assert.deepEqual(readdirSync('node_modules/@deepseek-ai').sort(), ['libreoffice-kit', 'libreoffice-kit-wasm']);
const entry = realpathSync(require.resolve('@deepseek-ai/libreoffice-kit/package.json'));
assert(entry.startsWith(`${resolve('node_modules')}/`));
const source = createFontSource({ fontDirectories: [resolve('fixtures')], fontFallbacks: [['sans-serif', 'Roboto']] });
const points = [0x41, 0x42, 0x03a9];
const coverage = new Set();
let totalBytes = 0;
try {
  const result = await source.resolve({ family: 'Roboto', style: '', weight: 5, width: 5, italic: 0, pitch: 0, language: 'el', codePoints: points });
  assert(result.fonts.length > 0);
  assert.equal(result.missingFamily, undefined);
  for (const font of result.fonts) {
    const bytes = await source.read(font.id);
    assert.equal(bytes.byteLength, font.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), font.id);
    assert.equal(font.alias, `DSH_${font.id}`);
    for (const point of create(bytes).characterSet) coverage.add(point);
    totalBytes += bytes.byteLength;
  }
  assert(points.every(point => coverage.has(point)));
} finally { await source.dispose(); }
writeFileSync('font-smoke.json', `${JSON.stringify({ passed: true, package: '@deepseek-ai/libreoffice-kit/fonts', installedOutsideRepository: true,
  network: 'offline', wasmInstalled: true, coveredCodePoints: points, subsetBytes: totalBytes, disposed: true }, null, 2)}\n`);
