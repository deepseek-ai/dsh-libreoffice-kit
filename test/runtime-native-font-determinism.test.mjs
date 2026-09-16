import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { documentFixture } from './runtime-fixture.mjs';

const exec = promisify(execFile);
const entry = process.env.LIBREOFFICE_RUNTIME_ENTRY;
const { zipSync, unzipSync, strToU8, strFromU8 } = createRequire(new URL('../packages/entry/package.json', import.meta.url))('fflate');

// Exercise both attribute matching for a missing theme font and the configured
// MS Mincho -> Hiragino alias chain, without installing additional fonts.
function themedDocument() {
  const parts = unzipSync(documentFixture('Font matching ABC xyz 0123 中文文档 日本語 ไทย'));
  parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace(
    '<w:rFonts w:ascii="Arial" w:hAnsi="Arial"/>',
    '<w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi" w:eastAsia="ＭＳ 明朝"/>',
  ));
  parts['word/_rels/document.xml.rels'] = strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="theme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>');
  parts['word/theme/theme1.xml'] = strToU8('<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Test"><a:themeElements><a:fontScheme name="Test"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme></a:themeElements></a:theme>');
  parts['[Content_Types].xml'] = strToU8(strFromU8(parts['[Content_Types].xml']).replace('</Types>', '<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>'));
  return zipSync(parts);
}

test('real native conversions keep fonts, text and word coordinates across fresh processes', { skip: !entry, timeout: 360_000 }, async t => {
  const { createConverter } = await import(pathToFileURL(entry).href);
  const saved = process.env.LIBREOFFICE_VALIDATION_DIR;
  if (saved) await mkdir(resolve(saved), { recursive: true });
  const root = await mkdtemp(join(saved ? resolve(saved) : tmpdir(), 'native-font-determinism-'));
  let converter;
  t.after(async () => { await converter?.dispose(); if (!saved) await rm(root, { recursive: true, force: true }); });
  converter = await createConverter({ timeoutMs: 90_000 });
  if (converter.backend !== 'native') { t.skip('This check requires an installed native engine.'); return; }
  await exec('pdftotext', ['-v']);
  await exec('pdffonts', ['-v']);
  const themed = join(root, 'theme.docx');
  await writeFile(themed, themedDocument());
  const inputs = [themed, ...['one-page.doc', 'one-sheet.xls', 'one-sheet.xlsx', 'one-slide.ppt', 'one-slide.pptx'].map(name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)))];
  for (const [index, input] of inputs.entries()) {
    const inputPath = join(root, `input-${index}${extname(input)}`);
    await writeFile(inputPath, await readFile(input));
    let baseline;
    for (let run = 0; run < 6; run++) {
      const outputPath = join(root, `${index}-${run}.pdf`);
      // Each render owns a new native helper and user profile, including when
      // the public converter is reused. Comparing PDF bytes would include time.
      await converter.render({ inputPath, outputPath });
      const [{ stdout: bbox }, { stdout: fontReport }] = await Promise.all([
        exec('pdftotext', ['-bbox', outputPath, '-']), exec('pdffonts', [outputPath]),
      ]);
      const layout = bbox.match(/<doc>[\s\S]*?<\/doc>/)?.[0];
      assert.ok(layout?.includes('<word '), `No words in ${inputPath}`);
      const fonts = fontReport.trimEnd().split(/\r?\n/).slice(2).map(line => line.trim().split(/\s+/).slice(0, -2).join(' ').replace(/^[A-Z]{6}\+/, '')).sort();
      assert.ok(fonts.length, `No fonts in ${inputPath}`);
      await Promise.all([
        writeFile(join(root, `${index}-${run}.bbox.xml`), bbox),
        writeFile(join(root, `${index}-${run}.fonts.txt`), fontReport),
      ]);
      const actual = { layout, fonts };
      baseline ??= actual;
      assert.deepEqual(actual, baseline, `Fonts or word coordinates changed: input ${index}, run ${run}; evidence: ${root}`);
    }
  }
});
