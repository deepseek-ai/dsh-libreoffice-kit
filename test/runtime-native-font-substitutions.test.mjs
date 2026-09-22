import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { documentFixture } from './runtime-fixture.mjs';

const exec = promisify(execFile);
const entry = process.env.LIBREOFFICE_RUNTIME_ENTRY;
// The font catalog lives with the adapter; this suite runs against the built package it imports by URL.
const fontsModule = new URL('../packages/entry/lib/types/fonts.js', import.meta.url);

test('real native PDF uses configured missing-family substitutions and preserves installed originals', { skip: !entry, timeout: 180_000 }, async t => {
  const { normalize } = await import(fontsModule.href);
  const { scanFontSnapshot } = await import(new URL('../packages/entry/lib/types/font-snapshot.js', import.meta.url).href);
  const { resolveOptions } = await import(new URL('../packages/entry/lib/types/options.js', import.meta.url).href);
  // Installed originals include Office supplemental fonts as well as normal system roots.
  const { faces } = scanFontSnapshot(resolveOptions());
  const select = families => families.map(family => faces.find(face => face.family === family && face.weight === 400 && !face.italic)).find(Boolean);
  const substitute = select(['Courier New', 'Liberation Mono', 'DejaVu Sans Mono', 'Menlo', 'Monaco']);
  const original = select(['Arial', 'Helvetica', 'Liberation Sans', 'DejaVu Sans', 'Times New Roman']);
  if (!substitute || !original) { t.skip('This host needs distinct readable Latin text and monospace families.'); return; }
  const missing = 'DSH Missing Configured Typeface';
  assert.ok(!faces.some(face => face.aliases.includes(normalize(missing))));
  const { createConverter } = await import(pathToFileURL(entry).href);
  const root = await mkdtemp(join(tmpdir(), 'libreoffice-native-font-substitution-'));
  let converter;
  t.after(async () => { await converter?.dispose(); await rm(root, { recursive: true, force: true }); });
  converter = await createConverter({ timeoutMs: 90_000, fontFallbacks: [
    [missing, substitute.family], ['Calibri', substitute.family], [original.family, substitute.family],
    ['微软雅黑', substitute.family],
  ] });
  if (converter.backend !== 'native') { t.skip('This check requires an installed native engine.'); return; }
  const cases = [[missing, substitute.postscriptName], [original.family, original.postscriptName]];
  if (!faces.some(face => face.aliases.includes('calibri') || face.aliases.includes('carlito'))) cases.push(['Calibri', substitute.postscriptName]);
  if (!faces.some(face => face.aliases.includes('微软雅黑') || face.aliases.includes('microsoftyahei'))) cases.push(['微软雅黑', substitute.postscriptName]);
  for (const [index, [family, expected]] of cases.entries()) {
    const inputPath = join(root, `${index}.docx`);
    const outputPath = join(root, `${index}.pdf`);
    await writeFile(inputPath, documentFixture('Font substitution ABC xyz 0123', family), { flag: 'wx', mode: 0o600 });
    await converter.render({ inputPath, outputPath });
    assert.equal((await readFile(outputPath)).subarray(0, 5).toString(), '%PDF-');
    const { stdout } = await exec('pdffonts', [outputPath]);
    const names = stdout.split('\n').slice(2).map(line => line.trim().split(/\s+/)[0]?.replace(/^[A-Z]{6}\+/, '')).filter(Boolean);
    assert.deepEqual(names, [expected], `${family}: ${stdout}`);
  }
});
