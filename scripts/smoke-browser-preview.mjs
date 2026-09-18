#!/usr/bin/env node
/** Qualify retained read-only Office previews from isolated npm archives, with no external network requests. */
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { previewFixture, presentationPreviewText } from '../test/browser-preview-fixture.mjs';
import { previewMutationProbes, verifyPreviewRuntime } from './verify-preview-runtime.mjs';
import { verifyBrowserPreview } from './verify-browser-preview.mjs';
import { verifyBrowserPackage } from './build-browser.mjs';
import { verifyFontSubset } from './build-font-subset.mjs';
import { npm } from './pack-utils.mjs';
import { root } from './platform-matrix.mjs';
import { assert } from './verify-artifacts.mjs';

const { values } = parseArgs({ options: {
  candidate: { type: 'string' }, output: { type: 'string' }, executable: { type: 'string' },
  format: { type: 'string' }, screenshots: { type: 'string' },
} });
assert(values.candidate, 'Usage: smoke-browser-preview.mjs --candidate <packed-browser-directory> [--executable <chromium>]');
const candidateDirectory = resolve(values.candidate);
const candidate = verifyBrowserPreview(candidateDirectory);
const output = resolve(values.output ?? join(root, '.release/evidence/preview-runtime.json'));
const temporary = await mkdtemp(join(tmpdir(), 'office-preview-install-'));
const consumer = join(temporary, 'consumer');
const formats = values.format ? [values.format] : ['docx', 'xlsx', 'pptx'];
assert(formats.every(format => ['docx', 'xlsx', 'pptx'].includes(format)), 'Unknown preview fixture');
const fixtures = Object.fromEntries(formats.map(format => [format, previewFixture(format)]));
let browser;
let source;
let server;
try {
  await mkdir(consumer);
  const packages = [...Object.values(candidate.packages), ...candidate.dependencies];
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'office-preview-smoke', private: true, type: 'module',
    dependencies: Object.fromEntries(packages.map(pkg => [pkg.name, `file:${join(candidateDirectory, pkg.file)}`])),
  }));
  npm(['install', '--offline', '--ignore-scripts', '--package-lock=false', '--omit=optional'], consumer, temporary);
  const directory = join(consumer, 'node_modules/@deepseek-ai/libreoffice-kit');
  const engineDirectory = join(consumer, 'node_modules/@deepseek-ai/libreoffice-kit-wasm');
  verifyBrowserPackage(directory, engineDirectory);
  verifyFontSubset(directory);
  const { createFontSource } = await import(pathToFileURL(join(directory, 'lib/font-source.js')));
  const { resolveBrowserAssets } = await import(pathToFileURL(join(directory, 'lib/browser-assets.js')));
  const browserAssets = await resolveBrowserAssets();
  source = createFontSource();
  const fontRequests = [];
  server = createServer(async (request, response) => {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    response.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><head><link rel="icon" href="data:,"></head><body><canvas id="document"></canvas></body></html>');
      } else if (url.pathname === '/resolve-fonts') {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks).toString());
        const result = await source.resolve(input);
        fontRequests.push(input);
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result));
      } else if (url.pathname.startsWith('/fonts/')) {
        response.end(await source.read(url.pathname.slice(7)));
      } else if (url.pathname.startsWith('/fixture/')) {
        const bytes = fixtures[url.pathname.slice(9)];
        assert(bytes, 'Unknown preview fixture');
        response.end(bytes);
      } else if (url.pathname === '/assets.json') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ programDirectory: browserAssets.programDirectory,
          files: Object.fromEntries(Object.keys(browserAssets.files).map(key => [key, { path: key }])) }));
      } else if (url.pathname.startsWith('/asset/')) {
        const key = url.pathname.slice(7);
        const file = browserAssets.files[key];
        assert(file, 'Unknown browser asset');
        response.setHeader('Content-Type', ['worker', 'loader'].includes(key) ? 'text/javascript' : key === 'wasm' ? 'application/wasm' : 'application/octet-stream');
        response.end(await readFile(file.path));
      } else if (url.pathname.startsWith('/browser/')) {
        const file = resolve(directory, url.pathname.slice(9));
        assert(file.startsWith(`${directory}/`), 'Browser resource escapes the package');
        response.setHeader('Content-Type', ({ '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' })[extname(file)] ?? 'application/octet-stream');
        response.end(await readFile(file));
      } else { response.statusCode = 404; response.end(); }
    } catch (error) { response.statusCode = 500; response.end(String(error)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, chromiumSandbox: true,
    ...(values.executable ? { executablePath: resolve(values.executable) } : {}) });
  const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
  const external = [];
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(origin + '/') || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    external.push(url); return route.abort();
  });
  const page = await context.newPage();
  const processInfo = await browser.newBrowserCDPSession();
  const memory = [];
  await page.exposeFunction('observePreviewMemory', async (format, phase) => {
    if (!['darwin', 'linux'].includes(process.platform)) return;
    const { processInfo: processes } = await processInfo.send('SystemInfo.getProcessInfo');
    const pids = processes.map(process => process.id).filter(Number.isSafeInteger);
    const rss = execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' });
    memory.push({ format, phase, browserProcessRssBytes: rss.trim().split(/\s+/).reduce((sum, value) => sum + Number(value) * 1024, 0) });
  });
  const pageErrors = [], consoleErrors = [];
  page.on('pageerror', error => { pageErrors.push(error.message); console.error(error); });
  page.on('console', event => { if (event.type() === 'error') { consoleErrors.push(event.text()); console.error(event.text()); } });
  const workers = new Set();
  page.on('worker', worker => { workers.add(worker); worker.once('close', () => workers.delete(worker)); });
  await page.addInitScript(() => {
    const OriginalWorker = globalThis.Worker;
    globalThis.__previewWorkers = [];
    globalThis.Worker = class extends OriginalWorker {
      constructor(...args) { super(...args); globalThis.__previewWorkers.push(this); }
    };
  });
  await page.goto(origin);
  const results = {};
  for (const format of formats) {
    console.log(`Reading ${format}`);
    const result = await page.evaluate(async ({ origin, format, fontFallbacks, mutationProbes, presentationText }) => {
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
      check(crossOriginIsolated, 'Preview is not cross-origin isolated');
      const api = await import(`${origin}/browser/lib/browser/index.js`);
      check(typeof api.openOfficeDocument === 'function' && !('openEditor' in api), 'Installed package still exposes the editing SDK');
      const manifest = await (await fetch(`${origin}/assets.json`)).json();
      const assets = { programDirectory: manifest.programDirectory };
      for (const [name, file] of Object.entries(manifest.files)) assets[`${name}Url`] = `${origin}/asset/${file.path}`;
      const options = { extension: format, assets, fontFallbacks, timeoutMs: 120000,
        maxLoadedFontBytes: 256 * 1024 * 1024, maxArchiveEntries: 20000, maxUncompressedBytes: 512 * 1024 * 1024,
        resolveFonts: async (input, signal) => {
          const response = await fetch(`${origin}/resolve-fonts`, { method: 'POST', body: JSON.stringify(input), signal });
          if (!response.ok) throw new Error(await response.text());
          const result = await response.json();
          return { ...result, fonts: await Promise.all(result.fonts.map(async font => {
            const file = await fetch(`${origin}/fonts/${font.id}`, { signal });
            if (!file.ok) throw new Error(await file.text());
            return { ...font, data: new Uint8Array(await file.arrayBuffer()) };
          })) };
        },
      };
      const input = new Uint8Array(await (await fetch(`${origin}/fixture/${format}`)).arrayBuffer());
      const sourceSha256 = await digest(input);
      await globalThis.observePreviewMemory(format, 'before-open');
      const started = performance.now();
      const workerCount = globalThis.__previewWorkers.length;
      const reader = await api.openOfficeDocument({ ...options, data: input });
      const openMs = performance.now() - started;
      check(globalThis.__previewWorkers.length === workerCount + 1, 'Opening one reader did not own exactly one document Worker');
      const worker = globalThis.__previewWorkers.at(-1);
      const mutationsAbsent = ['input', 'dispatch', 'paste', 'save', 'capture'].every(name => !(name in reader));
      check(mutationsAbsent, `${format} exposes an editing operation`);
      const settled = async () => {
        let stable = 0;
        for (let attempt = 0; attempt < 100; attempt++) {
          const generation = reader.state.renderGeneration;
          await new Promise(resolve => setTimeout(resolve, 50));
          stable = generation === reader.state.renderGeneration ? stable + 1 : 0;
          if (stable >= 3) return;
        }
        throw new Error(`${format} layout never stabilized`);
      };
      const selectionText = async () => {
        if (format === 'xlsx') await reader.goToCell('A1:B1');
        else if (format === 'docx') await reader.selectAll();
        return reader.copy();
      };
      const click = async (x, y) => {
        for (const action of ['down', 'up']) await reader.pointer({ action, x, y, buttons: 1, modifiers: 0, clicks: 1 });
      };
      const paint = async () => {
        const part = reader.state.parts[reader.state.part];
        const tile = await reader.renderTile({ part: reader.state.part, x: 0, y: 0,
          width: Math.min(512, part.width), height: Math.min(256, part.height), scale: 1 });
        const canvas = document.getElementById('document'); canvas.width = tile.width; canvas.height = tile.height;
        canvas.getContext('2d').putImageData(new ImageData(tile.rgba, tile.width, tile.height), 0, 0);
        let paintedPixels = 0;
        for (let i = 0; i < tile.rgba.length; i += 4) if (tile.rgba[i + 3] && tile.rgba[i] < 240 && tile.rgba[i + 1] < 240 && tile.rgba[i + 2] < 240) paintedPixels++;
        check(paintedPixels > 10, `${format} rendered blank pixels`);
        return { paintedPixels, rgbaSha256: await digest(tile.rgba) };
      };
      let probeId = 1_000_000;
      // Every document owns this Worker. The id is only the request correlation id,
      // not a document handle; valid copy controls prove the raw probes hit this model.
      const workerMessage = message => new Promise((resolve, reject) => {
        const id = ++probeId;
        const listener = event => {
          if (event.data.id !== id) return;
          clearTimeout(timer); worker.removeEventListener('message', listener);
          resolve(event.data);
        };
        const timer = setTimeout(() => { worker.removeEventListener('message', listener); reject(new Error('Worker boundary probe timed out')); }, 10000);
        worker.addEventListener('message', listener); worker.postMessage({ ...message, id });
      });
      try {
        await reader.setViewport({ x: 0, y: 0, width: 800, height: 700 }, 1);
        if (format === 'pptx') await click(150, 120);
        const originalText = await selectionText();
        check(format === 'xlsx' ? /2\s+6/.test(originalText) : originalText.includes('Office preview original'), `${format} selection did not copy its original text`);
        if (format === 'pptx') check(originalText.trim().replace(/\r\n?/g, '\n') === presentationText, 'Impress did not copy the clicked object\'s complete paragraphs');
        const selection = { selected: true, copied: true, characters: [...originalText].length,
          textSha256: await digest(new TextEncoder().encode(originalText)), mode: format === 'pptx' ? 'whole-object-text' : 'text-range' };
        await settled(); const before = await paint();
        const messages = {
          'key-input': { type: 'office-operation', operation: { type: 'input', event: { type: 'key', action: 'down', character: 65, key: 0 } } },
          'ime-input': { type: 'office-operation', operation: { type: 'input', event: { type: 'composition', action: 'end', text: 'must-not-save' } } },
          paste: { type: 'office-operation', operation: { type: 'paste', text: 'must-not-save' } },
          command: { type: 'office-operation', operation: { type: 'command', command: '.uno:Delete' } },
          save: { type: 'office-operation', operation: { type: 'save' } },
          'legacy-edit': { type: 'edit', operation: { type: 'paste', text: 'must-not-save' } },
          'legacy-capture': { type: 'capture', request: { maxPixels: 1, tiles: [] } },
          'invalid-navigation': { type: 'office-operation', operation: { type: 'navigate', event: { key: 'Delete' } } },
        };
        const rejectedOperations = {};
        const confirmActiveWorker = async () => {
          const response = await workerMessage({ type: 'office-operation', operation: { type: 'copy' } });
          check(response.type === 'office-result' && response.text === originalText, `${format} raw Worker control did not address the active reading model`);
        };
        await confirmActiveWorker();
        for (const name of mutationProbes) {
          const response = await workerMessage(messages[name]);
          const reason = name.startsWith('legacy-') ? 'Unsupported Office Worker request.'
            : name === 'invalid-navigation' ? 'Invalid Office navigation key.' : 'Unsupported Office reading operation.';
          check(response.type === 'error' && response.code === 'render-failed' && response.fatal === false && response.message === reason,
            `Worker did not explicitly reject forbidden operation: ${name}`);
          rejectedOperations[name] = true;
        }
        // This positive response is serialized after every completed rejection.
        await confirmActiveWorker();
        const afterText = await reader.copy();
        check(afterText === originalText, `${format} rejection probes changed the selected text`);
        selection.afterTextSha256 = await digest(new TextEncoder().encode(afterText));
        await settled(); const after = await paint();
        check(after.rgbaSha256 === before.rgbaSha256, `${format} rejection probes changed document pixels`);
        let layout, worksheets;
        if (format === 'docx') {
          const originalPages = JSON.stringify(reader.state.pages);
          check(reader.state.layout === 'paginated' && reader.state.pages.length > 0, 'Writer did not start paginated');
          const firstPage = reader.state.pages[0];
          const wideStarted = performance.now();
          const wideResult = await reader.setLayout({ mode: 'continuous', width: 700, anchor: { x: firstPage.x + 100, y: firstPage.y + 110 } });
          const wideLayoutMs = performance.now() - wideStarted;
          check(wideResult.changed && reader.state.layout === 'continuous', 'Writer did not enable continuous layout');
          const dimensions = () => ({ width: Math.round(reader.state.parts[0].width), height: Math.round(reader.state.parts[0].height) });
          const wide = dimensions(), generation = reader.state.layoutGeneration;
          check(Math.abs(wide.width - 700) <= 1, 'Writer wide layout exceeds the requested document width');
          check(await reader.copy() === originalText, 'Writer wide layout changed the text selection');
          const widePaint = await paint();
          const equal = await reader.setLayout({ mode: 'continuous', width: 700 });
          check(!equal.changed && reader.state.layoutGeneration === generation, 'Equal width performed another layout');
          await reader.setViewport({ x: 0, y: 50, width: 1000, height: 500 }, 2);
          check(reader.state.layoutGeneration === generation && JSON.stringify(dimensions()) === JSON.stringify(wide), 'Viewport or DPR changed Writer reading width');
          const narrowStarted = performance.now();
          const narrowResult = await reader.setLayout({ mode: 'continuous', width: 360, anchor: { x: 20, y: 120 } });
          const narrowLayoutMs = performance.now() - narrowStarted;
          const narrow = dimensions();
          check(narrowResult.changed && narrow.width < wide.width && narrow.height > wide.height, 'Writer continuous text did not reflow with width');
          check(Math.abs(narrow.width - 360) <= 1, 'Writer narrow layout exceeds the requested document width');
          check(await reader.copy() === originalText, 'Writer narrow layout changed the text selection');
          const narrowPaint = await paint();
          check(narrowPaint.rgbaSha256 !== widePaint.rgbaSha256, 'Writer reflow reused stale pixels');
          await reader.setLayout({ mode: 'paginated' });
          check(reader.state.layout === 'paginated' && JSON.stringify(reader.state.pages) === originalPages, 'Writer failed to restore original page geometry');
          check(await reader.copy() === originalText, 'Writer layout changed body text or its selection');
          layout = { paginated: true, continuous: true, reflowed: true, sameWidthStable: true, viewportIndependent: true,
            paginatedRestored: true, widthMatched: true, selectionPreserved: true, wide, narrow,
            wideRgbaSha256: widePaint.rgbaSha256, narrowRgbaSha256: narrowPaint.rgbaSha256,
            wideLayoutMs, narrowLayoutMs, anchorMapped: Boolean(wideResult.anchor || narrowResult.anchor) };
        } else if (format === 'xlsx') {
          check(reader.state.parts.map(part => part.name).join(',') === 'First,Second', 'Worksheet names differ');
          await reader.setPart(1); await reader.goToCell('A1:B1');
          check(/7\s+21/.test(await reader.copy()), 'Second worksheet copy differs');
          await settled();
          const selectedState = () => JSON.stringify({ part: reader.state.part, cursor: reader.state.cursor,
            selection: reader.state.selection, cellAddress: reader.state.cellAddress, cellFormula: reader.state.cellFormula });
          const beforeOtherPart = selectedState(), copiedBeforeOtherPart = await reader.copy();
          await reader.renderTile({ part: 0, x: 0, y: 0, width: 100, height: 100, scale: 1 });
          await settled();
          check(await reader.copy() === copiedBeforeOtherPart && selectedState() === beforeOtherPart,
            'Painting another worksheet changed the active worksheet or its selection');
          await reader.setPart(0); await reader.goToCell('B1');
          check(reader.state.cellFormula.includes('A1'), 'Reading lost the formula');
          worksheets = { selected: true, formulaPreserved: true, crossPartSelectionPreserved: true };
        }
        const sourceAfterSha256 = await digest(input);
        check(sourceAfterSha256 === sourceSha256, 'Borrowed input bytes were changed or detached');
        check(await digest(await (await fetch(`${origin}/fixture/${format}`)).arrayBuffer()) === sourceSha256, 'Source fixture changed during preview');
        await globalThis.observePreviewMemory(format, 'read');
        return { opened: true, disposed: true, bytes: input.length, sourceSha256, sourceAfterSha256, openMs,
          modelUnchanged: true, workerBoundaryVerified: true, rejectedOperations, selection, ...before, afterRgbaSha256: after.rgbaSha256,
          ...(layout ? { layout } : {}), ...(worksheets ? { worksheets } : {}) };
      } finally { await reader.dispose(); await reader.dispose(); }
    }, { origin, format, fontFallbacks: source.fontFallbacks, mutationProbes: previewMutationProbes, presentationText: presentationPreviewText });
    await Promise.all([...workers].map(worker => once(worker, 'close', { signal: AbortSignal.timeout(10000) })));
    assert(workers.size === 0, `Disposal retained ${workers.size} Workers`);
    if (values.screenshots) {
      await mkdir(resolve(values.screenshots), { recursive: true });
      await page.locator('canvas').screenshot({ path: join(resolve(values.screenshots), `${format}.png`) });
    }
    results[format] = result;
    console.log(`${format}: ${result.paintedPixels} painted pixels, ${result.selection.characters} copied characters`);
  }
  assert(external.length === 0, 'Preview attempted external network access');
  assert(pageErrors.length === 0 && consoleErrors.length === 0, 'Preview reported browser errors');
  const fontDemand = fontRequests.some(request => request.codePoints.some(point => point >= 0x4e00 && point <= 0x9fff));
  const fontSubsets = fontRequests.length > 0 && fontRequests.every(request => request.mode === undefined);
  const receipt = { schemaVersion: 1, kind: 'preview-runtime', passed: formats.length === 3,
    sourceCommit: candidate.sourceCommit, sourceDirty: candidate.sourceDirty,
    archiveSha256: candidate.packages.kit.sha256, wasmSha256: candidate.packages.wasm.sha256,
    installedOutsideRepository: true, npmOffline: true, externalNetworkRequests: external.length,
    crossOriginIsolated: true, workerDisposal: true, publicMutationApiAbsent: true, fontSubsets, fontDemand, formats: results,
    memory: { platform: process.platform, architecture: process.arch,
      method: 'Sum of resident bytes for this Chromium instance from ps; includes browser overhead and double-counts shared pages; sequential fixtures share caches', samples: memory } };
  if (formats.length === 3) verifyPreviewRuntime(receipt, { sourceCommit: candidate.sourceCommit,
    kitSha256: candidate.packages.kit.sha256, wasmSha256: candidate.packages.wasm.sha256, allowDirty: true });
  await processInfo.detach();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
  console.log(`Office preview qualification: ${output}`);
} finally {
  await browser?.close(); await source?.dispose();
  server?.closeAllConnections();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
