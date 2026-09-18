#!/usr/bin/env node
/** Qualify persistent editing from isolated npm archives, with no external network requests. */
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { editorFixture } from '../test/browser-editor-fixture.mjs';
import { verifyBrowserPreview } from './verify-browser-preview.mjs';
import { verifyBrowserPackage } from './build-browser.mjs';
import { verifyFontSubset } from './build-font-subset.mjs';
import { npm, run } from './pack-utils.mjs';
import { root, readJson } from './platform-matrix.mjs';
import { assert } from './verify-artifacts.mjs';

const { values } = parseArgs({ options: {
  candidate: { type: 'string' }, output: { type: 'string' }, executable: { type: 'string' },
  native: { type: 'string' }, format: { type: 'string' },
} });
assert(values.candidate, 'Usage: smoke-browser-editor.mjs --candidate <packed-browser-directory> [--native <soffice>]');
const candidateDirectory = resolve(values.candidate);
const candidate = verifyBrowserPreview(candidateDirectory);
const output = resolve(values.output ?? join(root, '.release/evidence/editor.json'));
const artifacts = join(dirname(output), 'editor-documents');
const temporary = await mkdtemp(join(tmpdir(), 'office-editor-install-'));
const consumer = join(temporary, 'consumer');
const require = createRequire(new URL('../packages/entry/package.json', import.meta.url));
const { unzipSync, strFromU8 } = require('fflate');
const formats = values.format ? [values.format] : ['docx', 'xlsx', 'pptx'];
assert(formats.every(format => ['docx', 'xlsx', 'pptx'].includes(format)), 'Unknown editor fixture');
let browser;
let source;
let server;
try {
  await mkdir(consumer);
  const packages = [...Object.values(candidate.packages), ...candidate.dependencies];
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'office-editor-smoke', private: true, type: 'module',
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
        response.end(editorFixture(url.pathname.slice(9)));
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
  await page.exposeFunction('captureEditorMemory', async (format, phase) => {
    if (!['darwin', 'linux'].includes(process.platform)) return;
    const { processInfo: processes } = await processInfo.send('SystemInfo.getProcessInfo');
    const pids = processes.map(process => process.id).filter(Number.isSafeInteger);
    const rss = execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' });
    memory.push({ format, phase, browserProcessRssBytes: rss.trim().split(/\s+/).reduce((sum, value) => sum + Number(value) * 1024, 0) });
  });
  page.on('pageerror', error => console.error(error));
  page.on('console', event => { if (event.type() === 'error') console.error(event.text()); });
  const workers = new Set();
  page.on('worker', worker => { workers.add(worker); worker.once('close', () => workers.delete(worker)); });
  await page.goto(origin);
  await mkdir(artifacts, { recursive: true });
  await page.exposeFunction('captureEditorExport', async (format, data) => {
    assert(formats.includes(format), 'Unexpected exported format');
    await writeFile(join(artifacts, `edited.${format}`), new Uint8Array(data));
  });
  const results = {};
  for (const format of formats) {
    console.log(`Editing ${format}`);
    const result = await page.evaluate(async ({ origin, format, fontFallbacks }) => {
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      check(crossOriginIsolated, 'Editor is not cross-origin isolated');
      const { openEditor } = await import(`${origin}/browser/lib/browser/index.js`);
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
      await globalThis.captureEditorMemory(format, 'before-open');
      const started = performance.now();
      const editor = await openEditor({ ...options, data: input });
      const openMs = performance.now() - started;
      const events = [];
      const stop = editor.subscribe(event => { events.push(event); });
      const wait = (predicate, message) => new Promise((resolve, reject) => {
        if (predicate()) { resolve(); return; }
        const timer = setTimeout(() => { unsubscribe(); reject(new Error(message + ': ' + JSON.stringify(editor.state))); }, 10000);
        const unsubscribe = editor.subscribe(() => { if (predicate()) { clearTimeout(timer); unsubscribe(); resolve(); } });
      });
      const key = async code => {
        await editor.input({ type: 'key', action: 'down', character: 0, key: code });
        await editor.input({ type: 'key', action: 'up', character: 0, key: code });
      };
      const click = async (x, y, clicks = 1) => {
        for (const action of ['down', 'up']) await editor.input({ type: 'pointer', action, x, y, buttons: 1, modifiers: 0, clicks });
      };
      const text = async () => { await editor.dispatch('.uno:SelectAll'); return editor.copy(); };
      const paint = async (scale = 1) => {
        const part = editor.state.parts[editor.state.part];
        const cursor = editor.state.cursor ?? { x: 0, y: 0 };
        const x = Math.max(0, Math.min(Math.floor(cursor.x / 256) * 256, part.width - 1));
        const y = Math.max(0, Math.min(Math.floor(cursor.y / 256) * 256, part.height - 1));
        const tile = await editor.renderTile({ part: editor.state.part, x, y,
          width: Math.min(512, part.width - x), height: Math.min(256, part.height - y), scale });
        const canvas = document.getElementById('document'); canvas.width = tile.width; canvas.height = tile.height;
        canvas.getContext('2d').putImageData(new ImageData(tile.rgba, tile.width, tile.height), 0, 0);
        return tile.rgba.some((value, index) => index % 4 !== 3 && value < 240);
      };
      const samePixels = (a, b) => a.width === b.width && a.height === b.height
        && a.rgba.length === b.rgba.length && a.rgba.every((value, index) => value === b.rgba[index]);
      const pixelHashes = async capture => Promise.all(capture.tiles.map(async tile =>
        Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', tile.rgba)), byte => byte.toString(16).padStart(2, '0')).join('')));
      const captureRequest = () => {
        const part = editor.state.parts[0];
        const width = Math.min(512, part.width), split = Math.floor(width / 2), height = Math.min(256, part.height);
        return { maxPixels: 512 * 256, tiles: [
          { request: { part: 0, x: 0, y: 0, width: split, height, scale: 1 } },
          { request: { part: 0, x: split, y: 0, width: width - split, height, scale: 1 } },
        ] };
      };
      const editingPosition = () => JSON.stringify({ part: editor.state.part, cellFormula: editor.state.cellFormula,
        cursor: editor.state.cursor, revision: editor.state.revision });
      const qualifyCapture = async initial => {
        const request = captureRequest();
        const unsaved = await editor.capture(request);
        check(unsaved.state.revision > 0, `${format} capture did not observe unsaved edits`);
        check(unsaved.tiles.some((tile, index) => !samePixels(tile, initial.tiles[index])), `${format} unsaved capture retained original pixels`);
        const cached = unsaved.tiles[0];
        const mixed = await editor.capture({ ...request, generation: unsaved.state.renderGeneration,
          tiles: [{ ...request.tiles[0], cached }, request.tiles[1]] });
        check(cached.rgba.byteLength === cached.width * cached.height * 4, `${format} capture detached the caller's cached tile`);
        check(samePixels(mixed.tiles[0], cached), `${format} capture changed valid cached tile bytes`);
        check(samePixels(mixed.tiles[1], unsaved.tiles[1]), `${format} capture did not paint the missing tile consistently`);
        check(mixed.state.renderGeneration === unsaved.state.renderGeneration, `${format} cached capture changed generations`);
        let sheetSelection;
        if (format === 'xlsx') {
          await editor.setPart(0);
          await editor.dispatch('.uno:GoToCell', { ToPoint: { type: 'string', value: 'B1' } });
          check(editor.state.cellFormula.includes('A1'), 'Calc capture fixture must retain a selected formula');
          const before = editingPosition(), selection = { sheet: 'Second', range: 'A1:C2', scale: 1 };
          const geometry = await editor.capture({ maxPixels: 512 * 256, selection, tiles: [] });
          check(geometry.regions.length === 1 && geometry.regions[0].part === 1
            && geometry.regions[0].sheet === 'Second' && geometry.regions[0].range === 'A1:C2', 'Calc capture selected a different worksheet/range');
          check(editingPosition() === before, 'Calc capture geometry changed the user part/formula/cursor/revision');
          const region = geometry.regions[0];
          const selected = await editor.capture({ generation: geometry.state.renderGeneration, maxPixels: 512 * 256, selection,
            tiles: [{ request: { part: region.part, ...region.rectangle, scale: 1 } }] });
          check(editingPosition() === before, 'Calc selected capture changed the user part/formula/cursor/revision');
          check(selected.tiles[0].rgba.some((value, index) => index % 4 !== 3 && value < 240), 'Calc Second!A1:C2 capture is blank');
          sheetSelection = { sheet: region.sheet, range: region.range, userSelectionPreserved: true, hashes: await pixelHashes(selected) };
        }
        // Queue these without awaiting: the first batch must finish before Undo,
        // and every tile in the later batch must observe the same post-Undo model.
        const before = await editor.capture(request);
        const earlierTask = editor.capture({ ...request, generation: before.state.renderGeneration });
        const editTask = editor.dispatch('.uno:Undo');
        const laterTask = editor.capture(request);
        const [earlier, , later] = await Promise.all([earlierTask, editTask, laterTask]);
        check(earlier.state.renderGeneration === before.state.renderGeneration
          && earlier.tiles.every((tile, index) => samePixels(tile, before.tiles[index])), `${format} earlier capture included a later edit`);
        check(later.state.renderGeneration > earlier.state.renderGeneration, `${format} queued edit did not advance the capture generation`);
        const after = await editor.capture(request);
        check(after.state.renderGeneration === later.state.renderGeneration
          && later.tiles.every((tile, index) => samePixels(tile, after.tiles[index])), `${format} capture mixed pixels from different generations`);
        let staleRejected = false;
        try { await editor.capture({ ...request, generation: earlier.state.renderGeneration,
          tiles: [{ ...request.tiles[0], cached: earlier.tiles[0] }, request.tiles[1]] }); }
        catch (error) { if (error.code !== 'snapshot-changed') throw error; staleRejected = true; }
        check(staleRejected, `${format} capture accepted an old generation`);
        await editor.dispatch('.uno:Redo');
        const restored = await editor.capture(request);
        check(restored.tiles.every((tile, index) => samePixels(tile, before.tiles[index])), `${format} Redo did not restore captured pixels`);
        return { unsavedPixels: true, cachedBytesReused: true, missingTilePainted: true, staleGenerationRejected: true,
          orderedAcrossEdit: true, initialHashes: await pixelHashes(initial), unsavedHashes: await pixelHashes(unsaved),
          generations: { unsaved: unsaved.state.renderGeneration, beforeEdit: earlier.state.renderGeneration, afterEdit: later.state.renderGeneration },
          ...(sheetSelection ? { sheetSelection } : {}) };
      };
      const latencies = [];
      let object;
      let geometryChanged = false;
      try {
        await editor.setViewport({ x: 0, y: 0, width: 1000, height: 800 }, 1);
        check(await paint(), `${format} initial tile is blank`);
        await globalThis.captureEditorMemory(format, 'opened');
        check(editor.state.revision === 0, 'Opening and painting marked the document edited');
        const initialCapture = await editor.capture(captureRequest());
        check(initialCapture.state.revision === 0, 'Initial capture marked the document edited');
        if (format === 'docx') {
          await editor.dispatch('.uno:SelectAll'); await editor.paste('Office editor ');
          await editor.input({ type: 'composition', action: 'update', text: '中' });
          await editor.input({ type: 'composition', action: 'update', text: '中文编辑' });
          await editor.input({ type: 'composition', action: 'end', text: '' });
          const selected = await text(); check(selected.includes('Office editor 中文编辑'), `IME text differs: ${selected}`);
          await editor.dispatch('.uno:Bold');
          await key(0x2405);
          const before = editor.state.parts[0].height;
          await editor.dispatch('.uno:InsertPagebreak');
          await wait(() => editor.state.parts[0].height > before, 'Writer did not publish changed page geometry');
          geometryChanged = true;
          await editor.dispatch('.uno:Undo');
          await wait(() => editor.state.parts[0].height <= before, 'Writer undo did not restore page geometry');
          await key(0x2405);
          for (const character of ' warm editing latency samples') {
            const begin = performance.now();
            await editor.paste(character); await paint();
            latencies.push(performance.now() - begin);
          }
          await editor.paste(' undo-marker'); await editor.dispatch('.uno:Undo');
          check(!(await text()).includes('undo-marker'), 'Writer undo retained inserted text');
          await editor.dispatch('.uno:Redo'); check((await text()).includes('undo-marker'), 'Writer redo lost inserted text');
        } else if (format === 'xlsx') {
          check(editor.state.parts.map(part => part.name).join(',') === 'First,Second', 'Calc worksheet names differ');
          await editor.setPart(1); await editor.dispatch('.uno:GoToCell', { ToPoint: { type: 'string', value: 'A1' } });
          await editor.dispatch('.uno:EnterString', { StringName: { type: 'string', value: '11' } });
          await editor.setPart(0);
          await editor.dispatch('.uno:GoToCell', { ToPoint: { type: 'string', value: 'A1' } });
          for (const value of [...Array.from({ length: 29 }, (_, index) => String(index + 1)), '10']) {
            const begin = performance.now();
            await editor.dispatch('.uno:EnterString', { StringName: { type: 'string', value } });
            await paint(); latencies.push(performance.now() - begin);
          }
          await editor.dispatch('.uno:Undo'); await editor.dispatch('.uno:Redo');
          await editor.dispatch('.uno:GoToCell', { ToPoint: { type: 'string', value: 'B1' } });
          await wait(() => editor.state.cellFormula.includes('A1'), 'Calc formula selection did not update');
          await editor.dispatch('.uno:EnterString', { StringName: { type: 'string', value: '=A1*4' } });
          await editor.dispatch('.uno:GoToCell', { ToPoint: { type: 'string', value: 'C1' } });
          await editor.paste('中文编辑');
          await key(0x500);
        } else {
          await click(180, 125, 2);
          await editor.dispatch('.uno:SelectAll'); await editor.paste('Office editor 中文编辑');
          for (const character of ' warm editing latency samples') {
            const begin = performance.now();
            await editor.paste(character); await paint();
            latencies.push(performance.now() - begin);
          }
          await editor.paste(' undo-marker'); await editor.dispatch('.uno:Undo'); await editor.dispatch('.uno:Redo');
          await key(0x501);
          await click(100, 100);
          await wait(() => editor.state.graphicSelection !== null, 'Impress did not select the text object');
          object = editor.state.graphicSelection;
          await editor.dispatch('.uno:TransformDialog', {
            TransformPosX: { type: 'long', value: Math.round((object.x + 24) * 15) },
            TransformPosY: { type: 'long', value: Math.round((object.y + 16) * 15) },
            TransformWidth: { type: 'long', value: Math.round((object.width + 32) * 15) },
            TransformHeight: { type: 'long', value: Math.round((object.height + 24) * 15) },
          });
          await editor.dispatch('.uno:Undo'); await editor.dispatch('.uno:Redo');
          await wait(() => editor.state.graphicSelection !== null && editor.state.graphicSelection.x > object.x + 20,
            'Impress move/resize did not change selected object geometry');
          object = editor.state.graphicSelection;
        }
        await wait(() => editor.state.revision > 0, 'Editing did not publish a document revision');
        check(await paint(1.5), 'Edited zoomed tile is blank');
        const invalidations = events.filter(event => event.type === 'invalidate');
        check(invalidations.length > 0, 'Editing emitted no tile invalidations');
        const capture = await qualifyCapture(initialCapture);
        const snapshot = await editor.save();
        await globalThis.captureEditorMemory(format, 'edited');
        await globalThis.captureEditorExport(format, Array.from(snapshot.data));
        check(snapshot.revision === editor.state.revision, 'Export acknowledged a different revision');
        const savedRevision = snapshot.revision;
        await paint();
        await editor.setViewport({ x: 0, y: 0, width: 900, height: 700 }, 1);
        check(editor.state.revision === savedRevision, 'Painting or viewport changes dirtied a saved document');
        if (format === 'docx') {
          await key(0x2405); await editor.paste(' later-unsaved');
          await wait(() => editor.state.revision > savedRevision, 'Input after export did not advance the revision');
        }
        stop(); await editor.dispose();
        const reopened = await openEditor({ ...options, data: snapshot.data });
        let reopenedSelection = '';
        try {
          check(reopened.state.revision === 0, 'Reopened document is already modified');
          if (format === 'docx') {
            await reopened.dispatch('.uno:SelectAll'); reopenedSelection = await reopened.copy();
            check(reopenedSelection.includes('中文编辑') && !reopenedSelection.includes('later-unsaved'), `Saved snapshot content differs after reopening: ${JSON.stringify(reopenedSelection)}`);
          } else if (format === 'xlsx') {
            await reopened.dispatch('.uno:GoToCell', { ToPoint: { type: 'string', value: 'B1' } });
            check(reopened.state.revision === 0, `Selecting a saved cell marked the document edited: ${JSON.stringify(reopened.state)}`);
          }
          const part = reopened.state.parts[0];
          const tile = await reopened.renderTile({ part: 0, x: 0, y: 0, width: Math.min(part.width, 1000), height: Math.min(part.height, 800), scale: 1 });
          check(tile.rgba.some((value, index) => index % 4 !== 3 && value < 240), 'Reopened document tile is blank');
          await reopened.setViewport({ x: 0, y: 0, width: 1000, height: 800 }, 1);
          await reopened.dispatch('.uno:ReportWhenIdle', { idleID: { type: 'string', value: 'reopened-painted' } });
          if (format === 'xlsx') {
            await reopened.input({ type: 'key', action: 'up', character: 13, key: 0x500 });
            check(reopened.state.revision === 0, `Viewing a saved workbook marked it edited: ${JSON.stringify(reopened.state)}`);
          }
        } finally { await reopened.dispose(); }
        latencies.sort((a, b) => a - b);
        return { data: Array.from(snapshot.data), revision: savedRevision, openMs, reopenedSelection, geometryChanged, object,
          invalidations: invalidations.length, localInvalidations: invalidations.filter(event => event.rectangle !== null).length,
          samples: latencies.length, p95Ms: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null,
          saveReopen: true, disposed: true, capture };
      } finally { stop(); await editor.dispose(); }
    }, { origin, format, fontFallbacks: source.fontFallbacks });
    const bytes = new Uint8Array(result.data);
    const entries = unzipSync(bytes);
    const xml = name => { assert(entries[name], `Missing exported part ${name}`); return strFromU8(entries[name]); };
    if (format === 'docx') {
      assert(xml('word/document.xml').includes('中文编辑') && !xml('word/document.xml').includes('later-unsaved'), 'DOCX snapshot contents differ');
      assert(/<w:b(?:\s|\/|>)/.test(xml('word/document.xml')), 'DOCX bold formatting was not saved');
    } else if (format === 'xlsx') {
      assert(/<c\b[^>]*r="A1"[^>]*>[\s\S]*?<v>10<\/v>/.test(xml('xl/worksheets/sheet1.xml')), 'Calc A1 edit was not saved');
      assert(/<f(?:\s[^>]*)?>A1\*4<\/f><v>40<\/v>/.test(xml('xl/worksheets/sheet1.xml')), 'Calc dependent formula was not recalculated');
      assert(/<c\b[^>]*r="A1"[^>]*>[\s\S]*?<v>11<\/v>/.test(xml('xl/worksheets/sheet2.xml')), 'Calc second sheet lost its edit');
    } else assert(xml('ppt/slides/slide1.xml').includes('中文编辑'), 'Impress text was not saved');
    const file = join(artifacts, `edited.${format}`);
    await writeFile(file, bytes);
    let native = false;
    if (values.native) {
      const destination = join(artifacts, `native-${format}`); await mkdir(destination, { recursive: true });
      const profile = pathToFileURL(join(temporary, `native-profile-${format}`)).href;
      run(resolve(values.native), [`-env:UserInstallation=${profile}`, '--headless', '--convert-to', format, '--outdir', destination, file], { timeout: 120000 });
      const nativeBytes = await readFile(join(destination, `edited.${format}`));
      const nativeEntries = unzipSync(nativeBytes);
      const main = format === 'docx' ? 'word/document.xml' : format === 'xlsx' ? 'xl/worksheets/sheet1.xml' : 'ppt/slides/slide1.xml';
      const text = strFromU8(nativeEntries[main]);
      assert(format === 'xlsx' ? /<v>40<\/v>/.test(text) : text.includes('中文编辑'), `Native LibreOffice lost ${format} edits`);
      native = true;
    }
    delete result.data;
    results[format] = { ...result, bytes: bytes.length, nativeReopen: native };
    await Promise.all([...workers].map(worker => once(worker, 'close', { signal: AbortSignal.timeout(10000) })));
    assert(workers.size === 0, `Disposal retained ${workers.size} Workers`);
    console.log(`${format}: ${bytes.length} bytes, revision ${result.revision}, p95 ${result.p95Ms?.toFixed(1) ?? 'n/a'} ms`);
  }
  assert(external.length === 0, 'Editor attempted external network access');
  const newCharacterFonts = fontRequests.some(request => request.codePoints.includes('编'.codePointAt(0)));
  assert(newCharacterFonts, 'Editing did not request a font for newly inserted Chinese text');
  const receipt = { schemaVersion: 1, kind: 'browser-editor', passed: formats.length === 3,
    sourceCommit: candidate.sourceCommit, sourceDirty: candidate.sourceDirty,
    archiveSha256: candidate.packages.kit.sha256, wasmSha256: candidate.packages.wasm.sha256,
    installedOutsideRepository: true, npmOffline: true, externalNetworkRequests: external.length,
    crossOriginIsolated: true, workerDisposal: true, newCharacterFonts, formats: results,
    memory: { platform: process.platform, architecture: process.arch,
      method: 'Sum of resident bytes for this Chromium instance from ps; includes browser overhead and double-counts shared pages; sequential fixtures share caches', samples: memory } };
  await processInfo.detach();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
  console.log(`Office editor qualification: ${output}`);
} finally {
  await browser?.close(); await source?.dispose();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
