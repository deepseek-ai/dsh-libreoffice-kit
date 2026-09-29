import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { documentFixture, officeFuzzFixture } from './runtime-fixture.mjs';
import { renderOfficeCliContent, renderOfficeContent, verifyFontCacheContent } from './runtime-render-content.mjs';

const enabled = process.env.LIBREOFFICE_RUNTIME_ENTRY;
test('real engine paints visible DOCX, XLSX, and PPTX content with the expected colors', { skip: !enabled, timeout: 240_000 }, async () => {
  const { createConverter } = await import(pathToFileURL(enabled).href);
  const root = await mkdtemp(join(tmpdir(), 'libreoffice-real-render-'));
  const converter = await createConverter({ timeoutMs: 90_000 });
  try {
    const rendering = await renderOfficeContent(converter, join(root, 'rendering'), process.env.LIBREOFFICE_RUNTIME_EXPECT_BACKEND ?? converter.backend);
    console.log(JSON.stringify({ rendering }));
  } finally { await converter.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('real CLI paints visible DOCX, XLSX, and PPTX content with literal arguments', { skip: !enabled, timeout: 360_000 }, async () => {
  const { discoverRuntime } = await import(pathToFileURL(enabled).href);
  const root = await mkdtemp(join(tmpdir(), 'libreoffice CLI 渲染 & '));
  try {
    const expectedBackend = process.env.LIBREOFFICE_RUNTIME_EXPECT_BACKEND ?? (await discoverRuntime()).backend;
    const cliRendering = await renderOfficeCliContent(join(dirname(enabled), 'cli.js'), join(root, 'rendering'), expectedBackend);
    console.log(JSON.stringify({ cliRendering }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real engine keeps Office pixels and font reports identical across metadata cache states', { skip: !enabled, timeout: 720_000 }, async () => {
  const { createConverter, discoverRuntime } = await import(pathToFileURL(enabled).href);
  const root = await mkdtemp(join(tmpdir(), 'libreoffice-font-cache-content-'));
  try {
    const backend = process.env.LIBREOFFICE_RUNTIME_EXPECT_BACKEND ?? (await discoverRuntime()).backend;
    const fontCacheContent = await verifyFontCacheContent(createConverter, join(root, 'rendering'), backend);
    console.log(JSON.stringify({ fontCacheContent }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real engine converts disk DOCX, XLSX, and PPTX, rejects unsafe inputs, and drains cancellation', { skip: !enabled, timeout: 240_000 }, async () => {
  const { createConverter, ConversionError } = await import(pathToFileURL(enabled).href);
  const root = await mkdtemp(join(tmpdir(), 'libreoffice-real-runtime-test-'));
  const converter = await createConverter({ timeoutMs: 90_000 });
  try {
    if (process.env.LIBREOFFICE_RUNTIME_EXPECT_BACKEND) assert.equal(converter.backend, process.env.LIBREOFFICE_RUNTIME_EXPECT_BACKEND);
    const inputPath = join(root, '文档 😀.docx');
    const outputPath = join(root, '输出 😀.pdf');
    await writeFile(inputPath, documentFixture('Node worker conversion 中文', 'Unavailable Test Font'));
    const result = await converter.render({ inputPath, outputPath });
    assert.equal((await readFile(outputPath)).subarray(0, 5).toString(), '%PDF-');
    assert.ok((await stat(outputPath)).size > 100);
    assert.ok(result.missingFonts.includes('Unavailable Test Font'));
    const formats = { docx: { backend: result.backend, pdfBytes: (await stat(outputPath)).size } };
    for (const [extension, fixture] of [['xlsx', 'one-sheet.xlsx'], ['pptx', 'one-slide.pptx']]) {
      const input = join(root, `document.${extension}`);
      const output = join(root, `document.${extension}.pdf`);
      await writeFile(input, await readFile(new URL(`./fixtures/${fixture}`, import.meta.url)));
      const converted = await converter.render({ inputPath: input, outputPath: output });
      const bytes = await readFile(output);
      assert.equal(converted.backend, converter.backend);
      assert.equal(bytes.subarray(0, 5).toString('ascii'), '%PDF-', `${extension} output is not PDF`);
      assert.match(bytes.subarray(-2048).toString('latin1'), /%%EOF/, `${extension} PDF is incomplete`);
      assert.ok(bytes.length > 100, `${extension} PDF is empty`);
      formats[extension] = { backend: converted.backend, pdfBytes: bytes.length };
    }
    await assert.rejects(converter.render({ inputPath, outputPath }), error => error.code === 'EEXIST');
    assert.equal((await readFile(outputPath)).subarray(0, 5).toString(), '%PDF-');
    const wrong = join(root, 'invalid.docx');
    const invalidOutput = join(root, 'invalid.pdf');
    await writeFile(wrong, 'not a zip');
    await assert.rejects(converter.render({ inputPath: wrong, outputPath: invalidOutput }), error => error instanceof ConversionError && error.code === 'invalid-document');
    await assert.rejects(stat(invalidOutput), error => error.code === 'ENOENT');
    await assert.rejects(converter.render({ inputPath: join(root, 'wrong.txt'), outputPath: invalidOutput }), error => error.code === 'unsupported-format');
    for (const [options, code] of [[{ maxInputBytes: 1 }, 'input-too-large'], [{ maxOutputBytes: 1 }, 'output-too-large'], [{ timeoutMs: 1 }, 'timeout'],
      ...(converter.backend === 'wasm' ? [[{ fontDirectories: [] }, 'unavailable']] : [])]) {
      const bounded = await createConverter({ timeoutMs: 90_000, ...options });
      const path = join(root, `${code}.pdf`);
      try { await assert.rejects(bounded.render({ inputPath, outputPath: path }), error => error instanceof ConversionError && error.code === code, `Expected ${code} for ${JSON.stringify(options)}`); }
      finally { await bounded.dispose(); }
      await assert.rejects(stat(path), error => error.code === 'ENOENT');
    }
    const cancelledOutput = join(root, 'cancelled.pdf');
    const controller = new AbortController();
    const cancel = converter.render({ inputPath, outputPath: cancelledOutput }, controller.signal);
    const queuedController = new AbortController();
    const queued = converter.render({ inputPath, outputPath: join(root, 'queued.pdf') }, queuedController.signal);
    const queuedCheck = assert.rejects(queued, /queued cancellation/);
    queuedController.abort(new Error('queued cancellation'));
    await queuedCheck;
    controller.abort(new Error('active cancellation'));
    await assert.rejects(cancel, /active cancellation/);
    await assert.rejects(stat(cancelledOutput), error => error.code === 'ENOENT');
    await converter.dispose();
    await assert.rejects(converter.render({ inputPath, outputPath: join(root, 'disposed.pdf') }), /disposed/);
    console.log(JSON.stringify({ backend: converter.backend, pdfBytes: (await stat(outputPath)).size, missingFonts: result.missingFonts, formats }));
  } finally { await converter.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('real engine converts a deterministic generated DOCX, PPTX, and XLSX corpus', { skip: !enabled, timeout: 240_000 }, async () => {
  const { createConverter } = await import(pathToFileURL(enabled).href);
  const root = await mkdtemp(join(tmpdir(), 'libreoffice-generated-corpus-'));
  const converter = await createConverter({ timeoutMs: 90_000 });
  try {
    for (const extension of ['docx', 'pptx', 'xlsx']) {
      for (let seed = 0; seed < 4; seed++) {
        const inputPath = join(root, `${extension}-${seed}.${extension}`);
        const outputPath = join(root, `${extension}-${seed}.pdf`);
        await writeFile(inputPath, officeFuzzFixture(extension, seed));
        const result = await converter.render({ inputPath, outputPath });
        const output = await readFile(outputPath);
        assert.equal(result.backend, converter.backend);
        assert.equal(output.subarray(0, 5).toString('ascii'), '%PDF-');
        assert.match(output.subarray(-2048).toString('latin1'), /%%EOF/);
        assert.ok(output.length > 100);
      }
    }
  } finally { await converter.dispose(); await rm(root, { recursive: true, force: true }); }
});
