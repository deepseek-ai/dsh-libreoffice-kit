#!/usr/bin/env node
/** Install the exact two-package candidate offline and exercise the real CLI on this host. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { verifyBrowserPreview } from './verify-browser-preview.mjs';
import { npm } from './pack-utils.mjs';
import { assert } from './verify-artifacts.mjs';
import { root } from './platform-matrix.mjs';
const directory = resolve(process.argv[2]);
const candidate = verifyBrowserPreview(directory);
const work = mkdtempSync(join(tmpdir(), 'kit-cli-installed-'));
const consumer = join(work, 'consumer');
mkdirSync(consumer);
try {
  const records = [...Object.values(candidate.packages), ...candidate.dependencies];
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'kit-cli-smoke', private: true, type: 'module',
    dependencies: Object.fromEntries(records.map(pkg => [pkg.name, `file:${join(directory, pkg.file)}`])),
  }));
  npm(['install', '--offline', '--ignore-scripts', '--package-lock=false', '--omit=optional'], consumer, work);
  const require = createRequire(join(consumer, 'package.json'));
  const cli = require.resolve('@deepseek-ai/libreoffice-kit/cli');
  process.env.LIBREOFFICE_RUNTIME_ENTRY = require.resolve('@deepseek-ai/libreoffice-kit');
  const { documentFixture, unzipSync } = await import('../test/runtime-fixture.mjs');
  const docx = join(work, 'sample.docx');
  writeFileSync(docx, documentFixture('Office CLI offline test 123'));
  const invoke = args => JSON.parse(execFileSync(process.execPath, [cli, ...args], {
    cwd: consumer, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
  }));
  const capabilities = invoke(['capabilities', '--json']);
  const results = {};
  const pdf = join(work, 'sample.pdf');
  invoke(['convert', '--input', docx, '--output', pdf]);
  for (const [format, input] of [['docx', docx], ['xlsx', join(root, 'test/fixtures/one-sheet.xlsx')],
    ['pptx', join(root, 'test/fixtures/one-slide.pptx')], ['pdf', pdf]]) {
    const result = invoke(['render', '--input', input, '--output-dir', join(work, `images-${format}`)]);
    assert(result.backend === 'wasm' && result.rasterEngine === (format === 'pdf' ? 'pdfium' : 'libreoffice')
      && result.dpi === 144 && result.images.length > 0, `Wrong CLI image backend: ${format}`);
    for (const image of result.images) {
      const png = readFileSync(image.path);
      assert(png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
        && png.readUInt32BE(16) === image.width && png.readUInt32BE(20) === image.height,
      `Invalid rendered PNG: ${format}`);
    }
    results[format] = { images: result.images.length, rasterEngine: result.rasterEngine,
      dimensions: result.images.map(image => [image.width, image.height]) };
  }
  const calculated = join(work, 'calculated.xlsx');
  invoke(['recalculate', '--input', join(root, 'test/fixtures/cross-sheet-formulas.xlsx'), '--output', calculated]);
  const sheet = new TextDecoder().decode(unzipSync(readFileSync(calculated))['xl/worksheets/sheet2.xml']);
  for (const [cell, value] of [['A1', 16], ['A2', 48]]) {
    const body = sheet.match(new RegExp(`<c\\b[^>]*r="${cell}"[^>]*>(.*?)</c>`, 's'))?.[1];
    assert(body && /<f\b[^>]*>.+<\/f>/.test(body)
      && Number(body.match(/<v>(.*?)<\/v>/)?.[1]) === value, `CLI recalculation did not preserve and refresh ${cell}`);
  }
  const output = join(directory, `cli-${process.platform}-${process.arch}.json`);
  writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, kind: 'installed-cli', passed: true,
    platform: process.platform, arch: process.arch, sourceCommit: candidate.sourceCommit,
    archiveSha256: candidate.packages.kit.sha256, wasmSha256: candidate.packages.wasm.sha256,
    installedOutsideRepository: true, npmOffline: true, nativeEngines: false,
    recalculation: { formulasPreserved: true, cachesRefreshed: true }, capabilities, formats: results }, null, 2)}\n`);
  console.log(output);
} finally { rmSync(work, { recursive: true, force: true }); }
