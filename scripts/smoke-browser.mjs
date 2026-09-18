#!/usr/bin/env node
/** Qualify packed original-byte Office rendering in a sandboxed, isolated Chromium. */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve, extname, join } from 'node:path';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { chromium, _electron } from 'playwright';
import { documentFixture } from '../test/runtime-fixture.mjs';
import { writerLayoutFixture } from '../test/browser-fixture.mjs';
import { verifyBrowserPackage } from './build-browser.mjs';
import { assert, sha256 } from './verify-artifacts.mjs';
import { root, readJson, kitManifest, tarballName } from './platform-matrix.mjs';
import { verifyFontSubset } from './build-font-subset.mjs';
import { materializeEngineArchive } from './engine-archive.mjs';
import { verifyKitPackage } from './verify-kit.mjs';
import { run, npm } from './pack-utils.mjs';

const { values } = parseArgs({ options: {
  candidate: { type: 'string' }, output: { type: 'string' },
  executable: { type: 'string' }, electron: { type: 'string' }, screenshots: { type: 'string' },
} });
const output = resolve(values.output ?? join(root, '.release/evidence/browser.json'));
assert(values.candidate, 'Usage: smoke-browser.mjs --candidate <general-release-directory> [--output <receipt.json>]');
const candidateDirectory = resolve(values.candidate);
const candidate = readJson(join(candidateDirectory, 'release.json'));
assert(candidate.schemaVersion === 1 && candidate.platforms?.join(',') === 'wasm'
  && candidate.browser === undefined && candidate.fonts === undefined, 'Browser qualification requires the existing main and WASM packages');
const wasm = candidate.packages.find(record => record.platform === 'wasm');
assert(wasm, 'The candidate has no WASM archive');
const archive = join(candidateDirectory, tarballName(kitManifest()));
const temporary = await mkdtemp(join(tmpdir(), 'libreoffice-browser-smoke-'));
const directory = join(temporary, 'consumer/node_modules/@deepseek-ai/libreoffice-kit');
let browserAssets;
let createFontSource;
let parseFont;
try {
  const engineTar = materializeEngineArchive(candidateDirectory, wasm, join(temporary, 'engines'));
  const dependencies = candidate.dependencies.map(record => {
    const file = join(candidateDirectory, record.file);
    assert(sha256(file) === record.sha256, `Qualification dependency checksum differs: ${record.name}`);
    return [record.name, `file:${file}`];
  });
  const consumer = join(temporary, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'office-browser-install-smoke', private: true, type: 'module',
    overrides: { [wasm.name]: `$${wasm.name}` },
    dependencies: Object.fromEntries([...dependencies, [wasm.name, `file:${engineTar}`], [kitManifest().name, `file:${archive}`]]),
  }));
  npm(['install', '--offline', '--ignore-scripts', '--package-lock=false', '--omit=optional'], consumer, temporary);
  const engineDirectory = join(consumer, 'node_modules/@deepseek-ai/libreoffice-kit-wasm');
  verifyKitPackage(directory, true);
  verifyFontSubset(directory);
  verifyBrowserPackage(directory, engineDirectory);
  ({ createFontSource } = await import(pathToFileURL(join(directory, 'lib/font-source.js'))));
  const { resolveBrowserAssets } = await import(pathToFileURL(join(directory, 'lib/browser-assets.js')));
  browserAssets = await resolveBrowserAssets();
  ({ create: parseFont } = createRequire(join(directory, 'package.json'))('fontkit'));
} catch (error) {
  await rm(temporary, { recursive: true, force: true });
  throw error;
}
const source = createFontSource();
const requests = [];
const fontCoverage = new Map();
const fixtureTexts = {
  docx: 'Browser native Office rendering - ABC 123',
  mixed: 'Latin ABC 123 — العربية مرحبا — हिन्दी नमस्ते — বাংলা স্বাগতম — ไทย สวัสดี — עברית שלום — 中文测试',
};
const fixtures = {
  docx: documentFixture(fixtureTexts.docx), mixed: documentFixture(fixtureTexts.mixed),
  doc: await readFile(join(root, 'test/fixtures/one-page.doc')),
  ppt: await readFile(join(root, 'test/fixtures/one-slide.ppt')),
  pptx: await readFile(join(root, 'test/fixtures/one-slide.pptx')),
  oddPage: writerLayoutFixture('oddPage'), evenPage: writerLayoutFixture('evenPage'), blankPage: writerLayoutFixture('blankPage'),
};
const expectedPageInk = { oddPage: [true, true], evenPage: [true, true, true], blankPage: [true, false, true] };
let currentFormat;
const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  response.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html><head><link rel="icon" href="data:,"></head><body style="margin:0;background:#ddd"><canvas id="page"></canvas></body></html>');
    } else if (url.pathname === '/resolve-fonts') {
      const parts = []; for await (const part of request) parts.push(part);
      const input = JSON.parse(Buffer.concat(parts).toString());
      const result = await source.resolve(input);
      assert(!input.family.startsWith('DSH_'), 'An internal font alias escaped to the Host');
      requests.push({ format: currentFormat, input, result });
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
    } else if (url.pathname.startsWith('/fonts/')) {
      const id = url.pathname.slice(7);
      const bytes = await source.read(id);
      if (!fontCoverage.has(id)) fontCoverage.set(id, new Set(parseFont(bytes).characterSet));
      response.setHeader('Content-Type', 'font/ttf'); response.end(bytes);
    } else if (url.pathname.startsWith('/fixture/')) {
      const bytes = fixtures[url.pathname.slice(9)];
      assert(bytes !== undefined, 'Unknown fixture');
      response.setHeader('Content-Type', 'application/octet-stream'); response.end(bytes);
    } else if (url.pathname === '/assets.json') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ programDirectory: browserAssets.programDirectory,
        files: Object.fromEntries(Object.keys(browserAssets.files).map(key => [key, { path: key }])) }));
    } else if (url.pathname.startsWith('/asset/')) {
      const key = url.pathname.slice(7);
      const file = browserAssets.files[key];
      assert(file, 'Unknown engine asset');
      response.setHeader('Content-Type', ['worker', 'loader'].includes(key) ? 'text/javascript' : key === 'wasm' ? 'application/wasm' : 'application/octet-stream');
      response.end(await readFile(file.path));
    } else if (url.pathname.startsWith('/browser/')) {
      const file = resolve(directory, url.pathname.slice(9));
      assert(file.startsWith(`${directory}/`), 'Resource path escapes the browser package');
      response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' })[extname(file)] ?? 'application/octet-stream');
      response.end(await readFile(file));
    } else { response.statusCode = 404; response.end(); }
  } catch (error) { response.statusCode = 500; response.end(String(error)); }
});
let browser;
const formats = {};
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let origin = `http://127.0.0.1:${server.address().port}`;
  let page;
  if (values.electron) {
    const main = join(temporary, 'electron.cjs');
    await writeFile(main, `
      const {app,BrowserWindow,protocol}=require('electron');
      const upstream=process.argv.find(value=>value.startsWith('--upstream=')).slice(11);
      app.setPath('userData',require('node:path').join(__dirname,'profile'));
      protocol.registerSchemesAsPrivileged([{scheme:'dsh-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);
      app.whenReady().then(async()=>{
        protocol.handle('dsh-app',async request=>{const response=await fetch(upstream+new URL(request.url).pathname,{method:request.method,...(request.method==='POST'?{body:await request.arrayBuffer()}:{})});return new Response(await response.arrayBuffer(),{status:response.status,headers:{'content-type':response.headers.get('content-type'),'cross-origin-opener-policy':'same-origin','cross-origin-embedder-policy':'credentialless'}});});
        const window=new BrowserWindow({show:false,width:1300,height:1300,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
        await window.loadURL('dsh-app://app/');
      });
      app.on('window-all-closed',()=>app.quit());
    `);
    browser = await _electron.launch({ executablePath: resolve(values.electron), args: [main, `--upstream=${origin}`] });
    page = await browser.firstWindow();
    origin = 'dsh-app://app';
  } else {
    browser = await chromium.launch({ headless: true, chromiumSandbox: true, ...(values.executable ? { executablePath: resolve(values.executable) } : {}) });
    const context = await browser.newContext({ viewport: { width: 1300, height: 1300 } });
    page = await context.newPage();
  }
  page.on('console', event => { if (event.type() === 'error') console.error(event.text()); });
  page.on('pageerror', error => console.error(error));
  const workers = new Set();
  page.on('worker', worker => { workers.add(worker); worker.once('close', () => workers.delete(worker)); });
  await page.goto(origin);
  for (const format of ['doc', 'docx', 'ppt', 'pptx', 'mixed', 'oddPage', 'evenPage', 'blankPage']) {
    currentFormat = format;
    formats[format] = await page.evaluate(async ({ origin, format, fontFallbacks, expectedInk }) => {
      if (!crossOriginIsolated) throw new Error('Browser is not cross-origin isolated');
      const { openDocument } = await import(`${origin}/browser/lib/browser/index.js`);
      const manifest = await (await fetch(`${origin}/assets.json`)).json();
      const assets = { programDirectory: manifest.programDirectory };
      for (const [name, file] of Object.entries(manifest.files)) assets[`${name}Url`] = `${origin}/asset/${file.path}`;
      const data = new Uint8Array(await (await fetch(`${origin}/fixture/${format}`)).arrayBuffer());
      const started = performance.now();
      let missingFonts = [];
      const doc = await openDocument({ data, extension: ['doc', 'ppt', 'pptx'].includes(format) ? format : 'docx', assets,
        timeoutMs: 120000, maxLoadedFontBytes: 256 * 1024 * 1024, maxArchiveEntries: 20000, maxUncompressedBytes: 512 * 1024 * 1024, fontFallbacks,
        onMissingFonts: families => { missingFonts = [...families]; },
        resolveFonts: async (request, signal) => {
          const response = await fetch(`${origin}/resolve-fonts`, { method: 'POST', body: JSON.stringify(request), signal });
          if (!response.ok) throw new Error(await response.text());
          const result = await response.json();
          return { ...result, fonts: await Promise.all(result.fonts.map(async font => {
            const file = await fetch(`${origin}/fonts/${font.id}`, { signal });
            if (!file.ok) throw new Error(await file.text());
            return { ...font, data: new Uint8Array(await file.arrayBuffer()) };
          })) };
        },
      });
      const opened = performance.now();
      try {
        const first = doc.pages[0];
        const region = { pageIndex: 0, x: 0, y: 0, width: first.width, height: first.height, scale: 1 };
        const cancelled = new AbortController(); cancelled.abort();
        await doc.renderTile(region, cancelled.signal).then(() => { throw new Error('Cancelled tile unexpectedly rendered'); }, error => { if (error.name !== 'AbortError') throw error; });
        const tile = await doc.renderTile(region);
        const rendered = performance.now();
        const canvas = document.getElementById('page'); canvas.width = tile.width; canvas.height = tile.height;
        canvas.getContext('2d').putImageData(new ImageData(tile.rgba, tile.width, tile.height), 0, 0);
        const countInk = pixels => {
          let count = 0;
          for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 240 && pixels[i + 1] < 240 && pixels[i + 2] < 240 && pixels[i + 3] > 0) count++;
          return count;
        };
        const paintedPixels = countInk(tile.rgba);
        if (paintedPixels < 10) throw new Error('Rendered tile contains no visible content');
        const pageInk = [];
        if (expectedInk !== undefined) {
          if (doc.pages.length !== expectedInk.length) throw new Error('Writer visible page count differs from the fixture');
          for (let pageIndex = 0; pageIndex < doc.pages.length; pageIndex++) {
            const page = doc.pages[pageIndex];
            const pixels = pageIndex === 0 ? tile : await doc.renderTile({ pageIndex, x: 0, y: 0, width: page.width, height: page.height, scale: 1 });
            pageInk.push(countInk(pixels.rgba) >= 10);
            if (pageInk[pageIndex] !== expectedInk[pageIndex]) throw new Error('Writer page ink differs from the fixture');
          }
        }
        const rgbaSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', tile.rgba))).map(b => b.toString(16).padStart(2, '0')).join('');
        return { pages: doc.pages.length, pageSizes: doc.pages, width: tile.width, height: tile.height, paintedPixels, rgbaSha256,
          openMs: Math.round(opened - started), renderMs: Math.round(rendered - opened), cancelledTile: true, missingFonts,
          ...(expectedInk === undefined ? {} : { pageInk }) };
      } finally { await doc.dispose(); await doc.dispose(); }
    }, { origin, format, fontFallbacks: source.fontFallbacks, expectedInk: expectedPageInk[format] });
    if (format === 'doc' || format === 'ppt') assert(formats[format].missingFonts.length === 0, 'Binary documents must not report engine bootstrap families');
    if (format === 'docx' || format === 'mixed') assert(formats[format].missingFonts.every(family => family === 'Arial'), 'Font notice includes an engine-only fallback family');
    for (let attempts = 0; workers.size > 0 && attempts < 250; attempts++) await new Promise(resolve => setTimeout(resolve, 20));
    assert(workers.size === 0, `Document disposal retained Workers: ${[...workers].map(worker => worker.url()).join(', ')}`);
    if (values.screenshots) {
      await mkdir(resolve(values.screenshots), { recursive: true });
      await page.locator('canvas').screenshot({ path: join(resolve(values.screenshots), `${format}.png`) });
    }
    if (fixtureTexts[format]) {
      const ids = new Set(requests.filter(request => request.format === format).flatMap(request => request.result.fonts.map(font => font.id)));
      const points = new Set([...fixtureTexts[format]].map(char => char.codePointAt(0)));
      for (const point of points) assert([...ids].some(id => fontCoverage.get(id)?.has(point)), `No delivered font covers ${format} U+${point.toString(16)}`);
    }
    console.log(`${format}: ${formats[format].pages} pages, ${formats[format].paintedPixels} painted pixels`);
  }
  const laterScriptRequests = requests.filter(request => request.format === 'mixed' && request.input.codePoints.length > 0);
  assert(laterScriptRequests.length >= 3, 'Mixed-script fixture did not exercise font-demand resolution');
  const receipt = { schemaVersion: 1, passed: true, archiveSha256: sha256(archive), wasmSha256: sha256(join(candidateDirectory, wasm.file)),
    installedOutsideRepository: true, network: 'offline',
    sourceCommit: run('git', ['rev-parse', 'HEAD'], { cwd: root }).trim(), sourceDirty: run('git', ['status', '--porcelain', '--', '.', ':(exclude)packages/*/prebuilds.json'], { cwd: root }).trim().length > 0, isolated: true, fontSubsets: true, disposed: true,
    engine: 'libreofficekit-tiles', runtime: values.electron ? 'electron' : 'chromium', crossOriginIsolated: true, hostOriginalBytes: true, workerDisposal: true,
    formats, fontRequests: requests.length, mixedScriptRequests: laterScriptRequests.length };
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`Browser qualification: ${output}`);
} finally {
  await browser?.close(); await source.dispose();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
