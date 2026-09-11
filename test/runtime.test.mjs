import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platformTarget, resolveEngine } from '../packages/entry/src/engine.js';
import { resolveOptions } from '../packages/entry/src/options.js';
import { inspectDocument } from '../packages/entry/src/ooxml.js';
import { createRequire } from 'node:module';
import { documentFixture } from './runtime-fixture.mjs';

test('platform matrix distinguishes glibc, musl, and unsupported architectures', () => {
  assert.equal(platformTarget('linux', 'arm64', () => ({ header: { glibcVersionRuntime: '2.36' } })), 'linux-arm64-glibc');
  assert.equal(platformTarget('linux', 'x64', () => ({ header: {}, sharedObjects: ['/lib/ld-musl-x86_64.so.1'] })), 'linux-x64-musl');
  assert.equal(platformTarget('linux', 'x64', () => ({ header: {}, sharedObjects: ['/lib/libc.so.6'] })), undefined);
  assert.equal(platformTarget('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(platformTarget('freebsd', 'x64'), undefined);
  assert.equal(platformTarget('linux', 'riscv64'), undefined);
});

test('option validation rejects missing limits, timer overflow, and unknown switches', () => {
  assert.equal(resolveOptions({ gpu: 'off', fontDirectories: [] }).maxImageResolution, 144);
  for (const gpu of ['webgpu', 'webgl2', 'webgl1']) assert.equal(resolveOptions({ gpu }).gpu, gpu);
  for (const option of [{ maxInputBytes: 0 }, { timeoutMs: 2 ** 31 }, { maxOutputBytes: NaN }, { gpu: 'metal' }, { backend: 'wasm' }, { fontFallbacks: [[]] }]) assert.throws(() => resolveOptions(option));
});

test('OOXML inspection rejects wrong membership and ZIP budgets, and reads declared fonts', () => {
  const bytes = documentFixture('汉字 Hello', 'Absent Family');
  const defaults = resolveOptions();
  const result = inspectDocument(bytes, 'docx', defaults);
  assert.deepEqual([...result.families.values()], ['Absent Family']);
  assert.ok(result.codePoints.includes('汉'.codePointAt(0)));
  assert.throws(() => inspectDocument(bytes, 'xlsx', defaults), /xlsx/);
  assert.throws(() => inspectDocument(bytes, 'docx', { ...defaults, maxArchiveEntries: 2 }), /bounded OOXML/);
  assert.throws(() => inspectDocument(bytes, 'docx', { ...defaults, maxUncompressedBytes: 10 }), /bounded OOXML/);
  assert.throws(() => inspectDocument(new Uint8Array([0, 1, 2]), 'docx', defaults), /bounded OOXML/);
});

test('an absent native package selects required WASM; corrupt installed native never falls back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'libreoffice-resolver-test-'));
  try {
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/libreoffice-kit-wasm', version: '0.1.0' }));
    for (const file of ['soffice.cjs', 'soffice.wasm', 'soffice.data', 'soffice.data.js.metadata']) await writeFile(join(root, 'assets', file), 'fixture');
    await writeFile(join(root, 'prebuilds.json'), JSON.stringify({ schemaVersion: 1, version: '0.1.0', platform: 'wasm', status: 'built', engine: {
      kind: 'wasm', loader: 'assets/soffice.cjs', wasm: 'assets/soffice.wasm', data: 'assets/soffice.data', metadata: 'assets/soffice.data.js.metadata', programDirectory: '/instdir/program',
    } }));
    let wasmResolutions = 0;
    const absent = name => {
      if (name.endsWith('-wasm')) { wasmResolutions++; return join(root, 'package.json'); }
      const error = new Error(`Cannot find module '${name}/package.json'`);
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    };
    assert.equal((await resolveEngine(absent, () => false)).backend, 'wasm');
    assert.equal(wasmResolutions, 1);
    if (platformTarget()) {
      await assert.rejects(resolveEngine(() => join(root, 'package.json')), /incompatible or incomplete/);
      await assert.rejects(resolveEngine(absent, () => true), /package is incomplete/);
      await assert.rejects(resolveEngine(() => { const error = new Error('Package exports is malformed'); error.code = 'ERR_PACKAGE_PATH_NOT_EXPORTED'; throw error; }), /malformed/);
    }
    await writeFile(join(root, 'prebuilds.json'), JSON.stringify({ ...JSON.parse(await readFile(join(root, 'prebuilds.json'))), status: 'unbuilt' }));
    await assert.rejects(resolveEngine(absent, () => false), /incompatible or incomplete/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('font notices exclude theme inventories and unresolved theme aliases', () => {
  const { unzipSync, zipSync, strToU8 } = createRequire(new URL('../packages/entry/package.json', import.meta.url))('fflate');
  const files = unzipSync(documentFixture('Visible content', 'Missing Content Face'));
  files['word/theme/theme1.xml'] = strToU8('<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:font typeface="Unused Theme Face"/></a:theme>');
  files['word/fontTable.xml'] = strToU8('<a:font xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" typeface="Font Inventory Only"/>');
  files['word/drawing.xml'] = strToU8('<a:rPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:latin typeface="+mn-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="Missing Drawing Face"/></a:rPr>');
  assert.deepEqual([...inspectDocument(zipSync(files), 'docx', resolveOptions()).families.values()], ['Missing Content Face', 'Missing Drawing Face']);
});
