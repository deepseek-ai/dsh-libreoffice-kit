/** Exercise persistent editing and event-loop layouts after WASM resource pruning. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { withWasmSession } from '../packages/entry/src/wasm.ts';
import { resolveOptions } from '../packages/entry/src/options.ts';
import { indexSystemFonts } from '../packages/entry/src/fonts.ts';
import { inspectDocument } from '../packages/entry/src/ooxml.ts';
import { documentFixture } from '../test/runtime-fixture.mjs';
const directory = resolve(process.argv[2]);
const declared = JSON.parse(readFileSync(join(directory, 'prebuilds.json'))).engine;
const engine = { backend: 'wasm', programDirectory: declared.programDirectory,
  ...Object.fromEntries(['loader', 'wasm', 'data', 'metadata'].map(key => [key, join(directory, declared[key])])) };
const options = resolveOptions({ timeoutMs: 90000, fontMetadataCacheDirectory: false });
const faces = indexSystemFonts({ directories: options.fontDirectories, maxFiles: options.maxFontFiles, maxFileBytes: options.maxFontFileBytes });
assert.ok(faces.length > 0, 'Editor verification needs installed fonts');
for (const extension of ['docx', 'xlsx', 'pptx']) {
  const bytes = extension === 'docx' ? documentFixture('Before editing') : readFileSync(new URL(`../test/fixtures/${extension === 'xlsx' ? 'one-sheet.xlsx' : 'one-slide.pptx'}`, import.meta.url));
  await withWasmSession({ engine, bytes, extension, options, document: inspectDocument(bytes, extension, options), faces }, async session => {
    const { module, document } = session;
    const call = (name, types = [], args = []) => module.ccall(name, 'number', types, args);
    const action = command => assert.equal(call('dsh_lok_document_command', ['number', 'string', 'string'], [document, command, '']), 1);
    assert.equal(call('dsh_lok_document_initialize_rendering', ['number'], [document]), 1);
    assert.equal(call('dsh_lok_document_listen', ['number'], [document]), 1);
    await session.idle();
    if (extension === 'pptx') {
      const before = call('dsh_lok_document_parts', ['number'], [document]);
      action('.uno:DuplicatePage');
      await session.idle();
      assert.equal(call('dsh_lok_document_parts', ['number'], [document]), before + 1);
      action('.uno:Undo');
      await session.idle();
      assert.equal(call('dsh_lok_document_parts', ['number'], [document]), before);
    } else {
      if (extension === 'docx') action('.uno:GoToEndOfDoc');
      const marker = 'SIZE_RELEASE_EDIT_CHECK';
      assert.equal(call('dsh_lok_document_paste', ['number', 'string', 'string', 'number'], [document, 'text/plain;charset=utf-8', marker, marker.length]), 1);
      await session.idle();
      const format = extension === 'docx' ? 'txt' : 'csv';
      assert.equal(call('dsh_lok_document_save', ['number', 'string', 'string'], [document, `file:///dsh/check.${format}`, format]), 1);
      assert.ok(Buffer.from(module.FS.readFile(`/dsh/check.${format}`)).toString().includes(marker), `${extension} saved text lost the edit`);
    }
    assert.equal(call('dsh_lok_document_save_pdf', ['number', 'string', 'string'], [document, 'file:///dsh/edited.pdf', '']), 1);
    const pdf = Buffer.from(module.FS.readFile('/dsh/edited.pdf'));
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.match(pdf.subarray(-2048).toString('latin1'), /%%EOF/);
    console.log(JSON.stringify({ extension, editing: true, idle: true, pdfBytes: pdf.length }));
  });
}
