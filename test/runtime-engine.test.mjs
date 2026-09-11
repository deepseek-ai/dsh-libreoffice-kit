import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { documentFixture } from './runtime-fixture.mjs';

const enabled = process.env.LIBREOFFICE_RUNTIME_ENTRY;
test('real engine converts disk OOXML, rejects unsafe inputs, and drains cancellation', { skip: !enabled, timeout: 240_000 }, async () => {
  const { createConverter } = await import(pathToFileURL(enabled).href);
  const root = await mkdtemp(join(tmpdir(), 'libreoffice-real-runtime-test-'));
  const converter = await createConverter({ gpu: 'off', timeoutMs: 90_000 });
  try {
    const inputPath = join(root, 'document.docx');
    const outputPath = join(root, 'document.pdf');
    await writeFile(inputPath, documentFixture('Node worker conversion 中文', 'Unavailable Test Font'));
    const result = await converter.render({ inputPath, outputPath });
    assert.equal((await readFile(outputPath)).subarray(0, 5).toString(), '%PDF-');
    assert.ok((await stat(outputPath)).size > 100);
    assert.ok(result.missingFonts.includes('Unavailable Test Font'));
    await assert.rejects(converter.render({ inputPath, outputPath }), error => error.code === 'EEXIST');
    assert.equal((await readFile(outputPath)).subarray(0, 5).toString(), '%PDF-');
    const wrong = join(root, 'invalid.docx');
    const invalidOutput = join(root, 'invalid.pdf');
    await writeFile(wrong, 'not a zip');
    await assert.rejects(converter.render({ inputPath: wrong, outputPath: invalidOutput }), /bounded OOXML/);
    await assert.rejects(stat(invalidOutput), error => error.code === 'ENOENT');
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
    console.log(JSON.stringify({ backend: converter.backend, pdfBytes: (await stat(outputPath)).size, missingFonts: result.missingFonts, imageScaling: result.imageScaling }));
  } finally { await converter.dispose(); await rm(root, { recursive: true, force: true }); }
});
