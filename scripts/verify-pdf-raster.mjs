#!/usr/bin/env node
/** Run the installed CLI against synthetic PDFs and compare with a supplied PDF.js distribution.
 * node scripts/verify-pdf-raster.mjs --entry /install/node_modules/@deepseek-ai/libreoffice-kit/lib/index.js \
 *   --pdfjs /path/to/pdfjs-dist --output .build/pdf-qa --chrome /path/to/chrome \
 *   --font-directory /System/Library/Fonts --font-family 'Songti SC' --embedded-pdf /path/to/export.pdf
 * PNGs/HTML require visual review; pixel differences are not a PDF fidelity acceptance threshold.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { chromium } from 'playwright';
import { pdfRasterFixtures } from '../test/pdf-raster-fixture.mjs';

const { values } = parseArgs({ options: {
  entry: { type: 'string' }, pdfjs: { type: 'string' }, output: { type: 'string' }, chrome: { type: 'string' },
  'embedded-pdf': { type: 'string' }, 'font-directory': { type: 'string', multiple: true }, 'font-family': { type: 'string', multiple: true },
} });
for (const key of ['entry', 'pdfjs', 'output']) if (!values[key]) throw new Error(`--${key} is required.`);
const entry = await realpath(values.entry), output = resolve(values.output), pdfjs = await realpath(values.pdfjs);
await mkdir(output); // Refuse an existing directory so stale evidence cannot pass.
const fixtures = pdfRasterFixtures();
if (values['embedded-pdf']) {
  const bytes = await readFile(values['embedded-pdf']);
  assert.match(bytes.toString('latin1'), /\/FontFile[23]?\b/, 'The embedded-font sample must contain a font file.');
  fixtures.push({ name: 'embedded', bytes });
}
const fonts = join(output, 'ttc-fonts'), emptyFonts = join(output, 'empty-fonts');
await mkdir(fonts); await mkdir(emptyFonts);
const ttcFile = join(fonts, 'Faces.ttc');
await copyFile(new URL('../packages/entry/tests/fixtures/fonts/Faces.ttc', import.meta.url), ttcFile);
const fontArgs = [...(values['font-directory'] ?? []).flatMap(path => ['--font-directory', resolve(path)]),
  ...(values['font-family'] ?? []).flatMap(family => ['--initial-font-family', family])];
const ttcArgs = directory => ['--font-directory', directory, '--initial-font-family', 'Roboto', '--font-fallbacks', '[["sans-serif","Roboto"]]'];
const cli = join(dirname(entry), 'cli.js');
const manifests = new Map();
const files = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function render(fixture, name = fixture.name, args = fontArgs) {
  const input = join(output, `${fixture.name}.pdf`), destination = join(output, `pdfium-${name}`);
  const { stdout } = await promisify(execFile)(process.execPath, [cli, 'render', '--input', input, '--output-dir', destination,
    '--dpi', '144', '--timeout-ms', '120000', ...args], { timeout: 130000, maxBuffer: 4 * 1024 * 1024 });
  const manifest = JSON.parse(stdout);
  assert.equal(manifest.backend, 'wasm'); assert.equal(manifest.rasterEngine, 'pdfium'); assert.equal(manifest.source, 'saved');
  assert.equal(manifest.sourceSha256, hash(fixture.bytes));
  if (fixture.sizes) assert.deepEqual(manifest.images.map(image => [image.width, image.height]), fixture.sizes);
  for (const image of manifest.images) files.set(`/pdfium/${name}/${image.index}.png`, image.path);
  manifests.set(name, manifest);
}
for (const fixture of fixtures) {
  const file = join(output, `${fixture.name}.pdf`);
  await writeFile(file, fixture.bytes); files.set(`/fixtures/${fixture.name}.pdf`, file);
  await render(fixture, fixture.name, fixture.name === 'ttc' ? ttcArgs(fonts) : fontArgs);
}
await render(fixtures.find(fixture => fixture.name === 'ttc'), 'ttc-empty', ttcArgs(emptyFonts));

const require = createRequire(entry);
const { createFontSource } = await import(pathToFileURL(require.resolve('@deepseek-ai/libreoffice-kit/fonts')).href);
const source = createFontSource({ fontDirectories: [fonts], fontFallbacks: [['sans-serif', 'Roboto']] });
let fontEvidence;
try {
  const result = await source.resolve({ family: 'Roboto', style: '', weight: 5, width: 5, italic: 0, pitch: 0, language: 'en', codePoints: [65, 66, 97, 98, 99, 102, 105], mode: 'full' });
  const originalSha256 = hash(await readFile(ttcFile)), assets = [];
  assert(result.fonts.length > 0);
  for (const asset of result.fonts) {
    const bytes = await source.read(asset.id);
    assert.equal(asset.format, 'ttc'); assert.equal(asset.mode, 'full'); assert.equal(hash(bytes), originalSha256);
    assets.push({ ...asset, sha256: hash(bytes) });
  }
  fontEvidence = { originalSha256, assets, fixtureScope: 'Small checked-in collection; Roboto covers all text in ttc.pdf, not a full production alphabet.' };
} finally { await source.dispose(); }

files.set('/comparison.mjs', fileURLToPath(new URL('./pdf-raster-comparison.mjs', import.meta.url)));
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><canvas></canvas>'); return; }
    if (path === '/favicon.ico') { response.statusCode = 204; response.end(); return; }
    let file = files.get(path);
    if (!file && path.startsWith('/pdfjs/')) {
      const candidate = resolve(pdfjs, path.slice(7)), inside = relative(pdfjs, candidate);
      if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('Invalid PDF.js resource.');
      file = candidate;
    }
    if (!file) { response.statusCode = 404; response.end(); return; }
    response.setHeader('Content-Type', extname(file) === '.mjs' ? 'text/javascript' : extname(file) === '.wasm' ? 'application/wasm' : 'application/octet-stream');
    response.end(await readFile(file));
  } catch (error) { response.statusCode = 500; response.end(String(error)); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const comparisons = [], warnings = [];
try {
  browser = await chromium.launch({ headless: true, ...(values.chrome ? { executablePath: resolve(values.chrome) } : {}) });
  const page = await browser.newPage();
  page.on('console', message => { if (['warning', 'error'].includes(message.type()) && warnings.length < 100) warnings.push(message.text()); });
  await page.goto(origin);
  for (const fixture of fixtures) {
    const results = await page.evaluate(async ({ origin, name, landmarks }) => {
      const pdfjs = await import(origin + '/pdfjs/build/pdf.mjs');
      const { comparePdfRasters } = await import(origin + '/comparison.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = origin + '/pdfjs/build/pdf.worker.mjs';
      const loading = pdfjs.getDocument({ url: `${origin}/fixtures/${name}.pdf`, cMapUrl: origin + '/pdfjs/cmaps/', cMapPacked: true,
        standardFontDataUrl: origin + '/pdfjs/standard_fonts/', wasmUrl: origin + '/pdfjs/wasm/', useSystemFonts: true });
      const pdf = await loading.promise, results = [];
      const imageData = async url => {
        const image = new Image(); image.src = url; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, canvas.width, canvas.height);
      };
      try {
        for (let number = 1; number <= pdf.numPages; number++) {
          const pdfPage = await pdf.getPage(number), viewport = pdfPage.getViewport({ scale: 2 });
          const canvas = document.querySelector('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
          const context = canvas.getContext('2d');
          await pdfPage.render({ canvasContext: context, viewport, background: 'rgb(255,255,255)' }).promise;
          const actual = await imageData(`${origin}/pdfium/${name}/${number}.png`);
          const comparison = comparePdfRasters(actual, context.getImageData(0, 0, canvas.width, canvas.height), { landmarks });
          if (name === 'ttc') {
            comparison.withoutHostTtc = comparePdfRasters(actual, await imageData(`${origin}/pdfium/ttc-empty/${number}.png`));
            if (!comparison.withoutHostTtc.changedPixelFraction) throw new Error('The TTC does not affect PDFium output.');
          }
          results.push({ page: number, rotation: pdfPage.rotate, ...comparison, png: canvas.toDataURL('image/png').split(',')[1] });
        }
      } finally { await loading.destroy(); }
      return results;
    }, { origin, name: fixture.name, landmarks: Boolean(fixture.landmarks) });
    assert.equal(results.length, manifests.get(fixture.name).images.length);
    await mkdir(join(output, `pdfjs-${fixture.name}`));
    for (const { png, ...result } of results) {
      await writeFile(join(output, `pdfjs-${fixture.name}`, `page-${String(result.page).padStart(4, '0')}.png`), Buffer.from(png, 'base64'));
      comparisons.push({ fixture: fixture.name, ...result });
    }
  }
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
const wasmRoot = dirname(require.resolve('@deepseek-ai/libreoffice-kit-wasm/package.json'));
const prebuilds = JSON.parse(await readFile(join(wasmRoot, 'prebuilds.json'), 'utf8'));
const report = { automatedChecksPassed: true, visualReviewRequired: true, entry,
  version: JSON.parse(await readFile(join(dirname(entry), '..', 'package.json'), 'utf8')).version,
  wasmSha256: hash(await readFile(join(wasmRoot, prebuilds.engine.wasm))),
  pdfjsVersion: JSON.parse(await readFile(join(pdfjs, 'package.json'), 'utf8')).version,
  fontEvidence, warnings, comparisons, manifests: Object.fromEntries(manifests),
  limitations: ['Pixel metrics are descriptive, not a fidelity guarantee.', 'TTC is isolated for PDFium; PDF.js may use a different system fallback.', 'CJK appearance depends on supplied Host fonts.', 'Annotations, encrypted PDFs and arbitrary production PDFs are outside these fixtures.'] };
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
await writeFile(join(output, 'comparison.html'), '<!doctype html><meta charset="utf-8"><title>PDFium / PDF.js QA</title><style>body{font:16px system-ui;background:#eee}article{display:flex;gap:16px}figure{width:48%;margin:0}img{width:100%;background:white}h2{margin-top:36px}</style><h1>PDFium / PDF.js — visual review required</h1>'
  + comparisons.map(item => `<h2>${item.fixture} / page ${item.page}</h2><article><figure><figcaption>PDFium</figcaption><img src="pdfium-${item.fixture}/page-${String(item.page).padStart(4, '0')}.png"></figure><figure><figcaption>PDF.js</figcaption><img src="pdfjs-${item.fixture}/page-${String(item.page).padStart(4, '0')}.png"></figure></article>`).join(''));
console.log(JSON.stringify({ automatedChecksPassed: true, visualReviewRequired: true, version: report.version, wasmSha256: report.wasmSha256, pages: comparisons.length, report: join(output, 'report.json') }));
